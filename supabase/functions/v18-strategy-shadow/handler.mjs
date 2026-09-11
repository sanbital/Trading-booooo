import {POLICY,M5,M15,STRATEGY,kstDayStart,entryReason,parseBars,confirm5} from '../_shared/leader-momentum-v17.mjs';
import {SHADOW_VERSION,VARIANTS,evaluateEntry,evaluateExit} from '../_shared/leader-strategy-shadow.mjs';
export const PROJECT_REF='etaajwpernzrcdrifdnw';
const reply=(status,data)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
const equal=(a,b)=>{if(!a||a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;};
const iso=t=>new Date(t).toISOString();
const publicTables=new Set(['edge_internal_tokens','v17_market_scan_runs','v11_long_regime_positions','v11_long_regime_decisions']);

/** Only public market GETs and DB reads; the sole write is an isolated analytics row.
 * No gateway URL, exchange secret, account controls, live signal or order writer exists.
 */
export function createHandler({url,key,fetchFn=fetch,now=Date.now,log=()=>{}}){
  async function rest(table,params={},write=null){
    if(write===null&&!publicTables.has(table))throw Error('DB_READ_NOT_ALLOWED');
    if(write!==null&&table!=='v18_strategy_shadow_runs')throw Error('DB_WRITE_NOT_ALLOWED');
    const response=await fetchFn(`${url}/rest/v1/${table}?${new URLSearchParams(params)}`,{
      method:write===null?'GET':'POST',signal:AbortSignal.timeout(5000),
      headers:{apikey:key,authorization:`Bearer ${key}`,'content-type':'application/json',
        ...(write!==null?{prefer:'resolution=ignore-duplicates,return=representation'}:{})},
      ...(write!==null?{body:JSON.stringify(write)}:{})});
    if(!response.ok)throw Error(`DB_${table}_${response.status}`);
    return response.json();
  }
  async function all(table,params){
    const out=[];
    for(let offset=0;offset<2000;offset+=200){
      const page=await rest(table,{...params,limit:'200',offset:String(offset)});
      if(!Array.isArray(page))throw Error('DB_PAGE_INVALID');
      out.push(...page);if(page.length<200)return out;
    }
    throw Error('HISTORY_PAGE_CAP');
  }
  async function market(path,params={}){
    if(!['/fapi/v1/time','/fapi/v1/klines'].includes(path))throw Error('PUBLIC_READ_NOT_ALLOWED');
    const r=await fetchFn('https://fapi.binance.com'+path+'?'+new URLSearchParams(params),
      {method:'GET',signal:AbortSignal.timeout(5000)});
    if(!r.ok)throw Error(`PUBLIC_MARKET_${r.status}`); // no retries or alternate hosts
    const used=Number(r.headers.get('x-mbx-used-weight-1m'));
    if(Number.isFinite(used)&&used>=2100)throw Error('PUBLIC_WEIGHT_HIGH');
    return r.json();
  }
  return async request=>{
    if(request.method!=='POST')return reply(405,{ok:false,error:'POST_ONLY'});
    if(url!==`https://${PROJECT_REF}.supabase.co`||!key)return reply(503,{ok:false,error:'ENV_PROJECT_MISMATCH'});
    const supplied=request.headers.get('x-v16-diagnostic-token')||'';
    if(!supplied)return reply(401,{ok:false,error:'UNAUTHORIZED'});
    try{
      const rows=await rest('edge_internal_tokens',{select:'token',name:'eq.v16-futures-position-diagnostic',limit:'1'});
      if(!equal(supplied,String(rows[0]?.token||'')))return reply(401,{ok:false,error:'UNAUTHORIZED'});
    }catch{return reply(401,{ok:false,error:'UNAUTHORIZED'});}
    let body;try{body=await request.json();}catch{return reply(400,{ok:false,error:'INVALID_JSON'});}
    if(body?.mode!=='evaluate'||Object.keys(body).some(k=>k!=='mode'))return reply(400,{ok:false,error:'INVALID_MODE'});
    const started=now();
    try{
      const server=await market('/fapi/v1/time'),asOf=Number(server.serverTime);
      if(!Number.isSafeInteger(asOf)||Math.abs(asOf-now())>5000)throw Error('SERVER_CLOCK_SKEW');
      const cut15=Math.floor(asOf/M15)*M15,cut5=Math.floor(asOf/M5)*M5;
      const [scans,history,positions]=await Promise.all([
        rest('v17_market_scan_runs',{select:'id,captured_at,signal_close_at,expected_symbols,evaluated_symbols,coverage,details',
          captured_at:`lte.${iso(asOf)}`,order:'captured_at.desc',limit:'1'}),
        all('v11_long_regime_positions',{select:'id,symbol,state,closed_at,updated_at,realized_pnl_usdt,exit_reason,metadata',
          state:'eq.CLOSED',closed_at:`gte.${iso(kstDayStart(asOf))}`,order:'id.asc'}),
        all('v11_long_regime_positions',{select:'id,symbol,state,entry_at,entry_price,entry_fee_usdt,remaining_quantity,peak_price,hard_stop_price,updated_at,metadata',
          state:'eq.OPEN',order:'id.asc'}),
      ]);
      const scan=scans[0],entryDecisions=[],baseRejections=[],confirmations=[],exitDecisions=[];
      const dataProblems=[];
      if(!scan||Date.parse(scan.signal_close_at)!==cut15||asOf-Date.parse(scan.captured_at)>6*60000)
        dataProblems.push('SCAN_MISSING_OR_STALE');
      if(scan&&(!(Number(scan.coverage)>=POLICY.minCoverage)||scan.details?.blocked))dataProblems.push('SCAN_BLOCKED_OR_INCOMPLETE');
      if(!Array.isArray(scan?.details?.top10))dataProblems.push('SCAN_TOP10_MISSING');
      if(!dataProblems.length){
        const seen=new Set();
        for(const f of scan.details.top10){
          if(now()-started>30000)throw Error('SHADOW_DEADLINE');
          if(!f.symbol||seen.has(f.symbol)||f.signal15Close!==cut15||
            ![f.rank,f.dayReturn,f.qv24,f.return15m,f.return30m,f.return60m,f.volumeRatio,f.atr].every(Number.isFinite))
            throw Error('SCAN_FEATURE_INVALID');
          seen.add(f.symbol);
          const reason=entryReason(f);
          if(reason!=='ELIGIBLE'){baseRejections.push({symbol:f.symbol,reason});continue;}
          // Signal creation does not depend on the live entry switch. Use the existing
          // scanner's top-10 snapshot and independently fetch completed 5m confirmations.
          try{
            const raw=await market('/fapi/v1/klines',{symbol:f.symbol,interval:'5m',limit:'14',endTime:String(cut5-1)});
            const bars=parseBars(raw,M5,cut5,14),feature=confirm5(f,bars,cut5);
            confirmations.push({symbol:f.symbol,raw,feature});
            if(!feature){baseRejections.push({symbol:f.symbol,reason:'NO_CLOSED_5M_CONFIRMATION'});continue;}
            for(const variant of Object.keys(VARIANTS))entryDecisions.push(evaluateEntry({symbol:f.symbol,features:feature,asOf,history,variant}));
          }catch(e){
            if(/PUBLIC_MARKET_(418|429|451)|PUBLIC_WEIGHT_HIGH/.test(e.message))throw e;
            dataProblems.push(`CONFIRMATION_${f.symbol}_${e.message}`);
          }
        }
      }
      for(const p of positions){
        if(p.metadata?.executionMode!==STRATEGY)continue;
        if(Date.parse(p.updated_at)>asOf){exitDecisions.push({positionId:p.id,unavailable:'POSITION_CHANGED_AFTER_SNAPSHOT'});continue;}
        const ds=await rest('v11_long_regime_decisions',{select:'id,decided_at,details',position_id:`eq.${p.id}`,
          decided_at:`lte.${iso(asOf)}`,order:'decided_at.desc',limit:'1'});
        const d=ds[0],bid=Number(d?.details?.bid);
        if(!d||asOf-Date.parse(d.decided_at)>90000||!(bid>0)){
          exitDecisions.push({positionId:p.id,unavailable:'NO_FRESH_RECORDED_BID'});continue;
        }
        const state={entryPrice:Number(p.entry_price),entryAt:Date.parse(p.entry_at),entryFee:Number(p.entry_fee_usdt),
          quantity:Number(p.remaining_quantity),peakPrice:Number(p.peak_price),stopPrice:Number(p.hard_stop_price),
          lastHighAt:Date.parse(p.metadata?.leaderLastHighAt||p.entry_at),policy:p.metadata?.leaderExitPolicy};
        for(const variant of ['BASELINE','LOCK_1P5'])exitDecisions.push({positionId:p.id,symbol:p.symbol,
          sourceDecisionId:d.id,quoteAgeMs:asOf-Date.parse(d.decided_at),...evaluateExit(state,bid,asOf,variant)});
      }
      const payload={ok:true,version:SHADOW_VERSION,readOnlyTrading:true,executionEnabled:false,projectRef:PROJECT_REF,
        asOf:iso(asOf),finishedAt:iso(now()),durationMs:now()-started,
        evaluationState:dataProblems.length?'DATA_UNAVAILABLE':'EVALUATED',dataProblems,
        entryDecisions,baseRejections,exitDecisions,
        source:{scan,confirmations,history,positions},
        livePromotion:false,fundingVerified:false,
        limitations:['Feature eligibility is not an order approval','No independently evolving shadow positions',
          'No cash or slot opportunity replay','Exit decisions use recorded live state and sampled bids']};
      const saved=await rest('v18_strategy_shadow_runs',{on_conflict:'policy_version,slot_at'},
        {policy_version:SHADOW_VERSION,slot_at:iso(Math.floor(asOf/60000)*60000),observed_at:iso(asOf),payload});
      log({event:'V18_STRATEGY_SHADOW_EVALUATION',version:SHADOW_VERSION,asOf:payload.asOf,
        scanId:scan?.id??null,entryEvaluations:entryDecisions.length,exitEvaluations:exitDecisions.length,
        evaluationState:payload.evaluationState,persistedNew:saved.length===1,executionEnabled:false});
      return reply(200,{...payload,persistedNew:saved.length===1});
    }catch(e){log({event:'V18_STRATEGY_SHADOW_FAILED',version:SHADOW_VERSION,error:String(e.message).slice(0,160)});
      return reply(503,{ok:false,version:SHADOW_VERSION,executionEnabled:false,error:String(e.message).slice(0,160)});}
  };
}
