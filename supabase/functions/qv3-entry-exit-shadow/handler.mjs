import {POLICY,M5,M15,STRATEGY,entryReason,entryFresh,parseBars,confirm5} from '../_shared/leader-momentum-v17.mjs';
import {QV3_VERSION,qv3Entry,qv3Exit,qv3Candles} from '../_shared/leader-qv3-runtime.mjs';
export const SHADOW_VERSION='QV3_ENTRY_EXIT_TWO_SHADOW_1';
export const SHADOW_START=Date.parse('2026-09-11T14:15:00Z');
const PROJECT='etaajwpernzrcdrifdnw';
const iso=x=>new Date(x).toISOString();
const reply=(status,b)=>new Response(JSON.stringify(b),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
const equal=(a,b)=>{if(!a||a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;};
const readTables=new Set(['edge_internal_tokens','v17_market_scan_runs','v11_long_regime_positions','v11_long_regime_orders','v11_long_regime_runtime','v17_operator_control','trading_settings','trading_asset_locks','trading_account_snapshots','v18_strategy_shadow_runs']);
/** Isolated analytics writer: never imports an order gateway or live executor. */
export function createHandler({url,key,fetchFn=fetch,now=Date.now}){
  async function rest(table,params={},row=null){
    if(!readTables.has(table)||(row!==null&&table!=='v18_strategy_shadow_runs'))throw Error('DB_SCOPE');
    const r=await fetchFn(`${url}/rest/v1/${table}?${new URLSearchParams(params)}`,{
      method:row===null?'GET':'POST',signal:AbortSignal.timeout(5000),
      headers:{apikey:key,authorization:`Bearer ${key}`,'content-type':'application/json',...(row?{prefer:'resolution=ignore-duplicates,return=representation'}:{})},
      ...(row?{body:JSON.stringify(row)}:{})});
    if(!r.ok)throw Error(`DB_${table}_${r.status}`);const data=await r.json();if(!Array.isArray(data))throw Error('DB_SHAPE');return data;
  }
  async function market(path,params={}){
    if(!['/fapi/v1/time','/fapi/v1/klines','/fapi/v1/ticker/bookTicker'].includes(path))throw Error('MARKET_SCOPE');
    const r=await fetchFn('https://fapi.binance.com'+path+'?'+new URLSearchParams(params),{method:'GET',signal:AbortSignal.timeout(3000)});
    if(!r.ok)throw Error(`PUBLIC_MARKET_${r.status}`);return r.json();
  }
  return async req=>{
    if(req.method!=='POST')return reply(405,{ok:false,error:'POST_ONLY'});
    if(url!==`https://${PROJECT}.supabase.co`||!key)return reply(503,{ok:false,error:'PROJECT_ENV'});
    try{
      const token=await rest('edge_internal_tokens',{select:'token',name:'eq.v16-futures-position-diagnostic',limit:'1'});
      if(!equal(req.headers.get('x-v16-diagnostic-token')||'',String(token[0]?.token||'')))return reply(401,{ok:false,error:'UNAUTHORIZED'});
    }catch{return reply(401,{ok:false,error:'UNAUTHORIZED'});}
    let body;try{body=await req.json();}catch{return reply(400,{ok:false,error:'INVALID_JSON'});}
    if(body?.mode!=='evaluate'||Object.keys(body).some(k=>k!=='mode'))return reply(400,{ok:false,error:'INVALID_MODE'});
    const started=now();
    try{
      const localBefore=now(),server=await market('/fapi/v1/time'),asOf=Number(server.serverTime),localAfter=now();
      if(!Number.isSafeInteger(asOf)||Math.abs(asOf-localAfter)>5000)throw Error('SERVER_CLOCK_SKEW');
      const cut15=Math.floor(asOf/M15)*M15,cut5=Math.floor(asOf/M5)*M5;
      const [scans,positions,orders,snapshots,runtime,control,settings,locks,previous]=await Promise.all([
        rest('v17_market_scan_runs',{select:'id,captured_at,signal_close_at,coverage,details',captured_at:`lte.${iso(asOf)}`,order:'captured_at.desc',limit:'1'}),
        rest('v11_long_regime_positions',{select:'*',state:'eq.OPEN',order:'id.asc',limit:'11'}),
        rest('v11_long_regime_orders',{select:'id,position_id,intent,state,exchange_order_id,request_payload',intent:'eq.OPEN_LONG',order:'created_at.desc',limit:'100'}),
        rest('trading_account_snapshots',{select:'captured_at,available_quote,positions,positions_complete',exchange:'eq.binance_futures',order:'captured_at.desc',limit:'1'}),
        rest('v11_long_regime_runtime',{select:'revision,live_enabled,circuit_open,circuit_reason,entry_block_reason',limit:'1'}),
        rest('v17_operator_control',{select:'entry_enabled,legacy_entries_retired',limit:'1'}),
        rest('trading_settings',{select:'mode,pause_new_entries,pause_lock_reason,manual_intervention_required,emergency_liquidation,scalp_kill_switch,withdrawal_mode,binance_futures_leverage,binance_futures_allocation_usdt',id:'eq.1'}),
        rest('trading_asset_locks',{select:'asset,metadata',exchange:'eq.binance_futures',state:'eq.LOCKED'}),
        rest('v18_strategy_shadow_runs',{select:'slot_at,payload',policy_version:`eq.${SHADOW_VERSION}`,slot_at:`lt.${iso(Math.floor(asOf/60000)*60000)}`,order:'slot_at.desc',limit:'1'}),
      ]);
      const dataProblems=[],entryDecisions=[],exitDecisions=[],scan=scans[0],snapshot=snapshots[0],states={};
      const s=settings[0],r=runtime[0],c=control[0];
      const liveBlocks=[];
      if(r?.live_enabled!==true||r?.circuit_open!==false)liveBlocks.push('RUNTIME_OR_CIRCUIT_BLOCK');
      if(c?.entry_enabled!==true||c?.legacy_entries_retired!==true)liveBlocks.push('OPERATOR_BLOCK');
      if(!s||s.mode!=='LIVE_LIMITED'||s.pause_new_entries||s.pause_lock_reason||s.manual_intervention_required||s.emergency_liquidation||s.scalp_kill_switch||s.withdrawal_mode)liveBlocks.push('SETTINGS_BLOCK');
      if(Number(s?.binance_futures_leverage)!==3||Number(s?.binance_futures_allocation_usdt)!==40)liveBlocks.push('RISK_CONFIG_MISMATCH');
      if(!snapshot||snapshot.positions_complete!==true||asOf-Date.parse(snapshot.captured_at)>90000||Date.parse(snapshot.captured_at)>asOf)liveBlocks.push('ACCOUNT_SNAPSHOT_UNAVAILABLE');
      if(!scan||Date.parse(scan.signal_close_at)!==cut15||asOf-Date.parse(scan.captured_at)>6*60000||Number(scan.coverage)<POLICY.minCoverage||scan.details?.blocked||!Array.isArray(scan.details?.top10))dataProblems.push('SCAN_MISSING_STALE_OR_BLOCKED');
      const manual=new Set(locks.filter(x=>x.metadata?.v17ManualPosition===true).map(x=>x.asset+'USDT'));
      if(!dataProblems.length){
        const seen=new Set();for(const f of scan.details.top10){if(!f.symbol||seen.has(f.symbol)||f.signal15Close!==cut15||![f.rank,f.dayReturn,f.qv24,f.return15m,f.return30m,f.return60m,f.volumeRatio,f.atr].every(Number.isFinite))throw Error('SCAN_FEATURE_INVALID');seen.add(f.symbol);}
        for(const f of scan.details.top10){
          if(now()-started>35000)throw Error('SHADOW_DEADLINE');
          const d={symbol:f.symbol,rank:f.rank,scanId:scan.id,asOf:iso(asOf),executionEnabled:false};
          const reason=entryReason(f);
          if(reason!=='ELIGIBLE'){entryDecisions.push({...d,baseReason:reason});continue;}
          try{
            const raw5=await market('/fapi/v1/klines',{symbol:f.symbol,interval:'5m',limit:'14',endTime:String(cut5-1)});
            const feature=confirm5(f,parseBars(raw5,M5,cut5,14),cut5);
            if(!feature){entryDecisions.push({...d,baseReason:'NO_CLOSED_5M_CONFIRMATION'});continue;}
            const book=await market('/fapi/v1/ticker/bookTicker',{symbol:f.symbol}),bid=Number(book.bidPrice),ask=Number(book.askPrice);
            const blockers=[];
            const fresh=entryFresh(feature,now(),ask);if(fresh)blockers.push(fresh);
            if(!(bid>0&&ask>=bid&&(ask/bid-1)*10000<=25))blockers.push('ENTRY_SPREAD');
            if(manual.has(f.symbol))blockers.push('MANUAL_SYMBOL_LOCKED');
            if(positions.length>=10)blockers.push('SLOT_FULL');
            if(positions.some(p=>p.symbol===f.symbol))blockers.push('DUPLICATE_SYMBOL');
            if(!(Number(snapshot?.available_quote)>=40.1))blockers.push('ENTRY_MARGIN_INSUFFICIENT');
            const raw1=await qv3Candles(f.symbol,asOf,Math.floor(asOf/60000)*60000-180000,fetchFn),assessment=qv3Entry(raw1,now());
            if(!assessment.available)dataProblems.push(`${f.symbol}:${assessment.reason}`);
            entryDecisions.push({...d,evaluatedAt:iso(now()),baseReason:blockers[0]??'ELIGIBLE',blockers,feature,book,raw1,raw5,qv3:assessment});
          }catch(e){if(/(?:418|429|451)$/.test(e.message))throw e;dataProblems.push(`${f.symbol}:${e.message}`);entryDecisions.push({...d,baseReason:'DATA_UNAVAILABLE',error:e.message});}
        }
      }
      for(const p of positions){
        const entryAt=Date.parse(p.entry_at),owned=p.metadata?.executionMode===STRATEGY&&p.metadata?.v17ManualPosition!==true&&p.side==='LONG'&&
          !manual.has(p.symbol)&&orders.some(o=>o.position_id===p.id&&o.exchange_order_id===p.metadata?.entryOrderId&&o.intent==='OPEN_LONG'&&o.request_payload?.order?.side==='BUY');
        if(!owned||entryAt<SHADOW_START){exitDecisions.push({positionId:p.id,symbol:p.symbol,reason:'PRESERVE_EXISTING_OR_UNOWNED'});continue;}
        if(Date.parse(p.updated_at)>asOf){dataProblems.push('POSITION_CHANGED_AFTER_SNAPSHOT');continue;}
        try{
          const prior=previous[0]?.payload?.states?.[p.id]??null;
          const start=prior?.favorableCandle?Math.floor(asOf/60000)*60000-120000:Math.ceil(entryAt/60000)*60000;
          const raw=await qv3Candles(p.symbol,asOf,start,fetchFn);
          const assessment=qv3Exit({id:p.id,entryAt,entryPrice:Number(p.entry_price),ownership:'AUTO',side:p.side,state:p.state},raw,asOf,prior);
          if(assessment.state)states[p.id]=assessment.state;
          else if(prior)states[p.id]=prior;
          exitDecisions.push({positionId:p.id,symbol:p.symbol,...assessment,raw,baselineManagement:'LIVE_EXECUTOR_REMAINS_AUTHORITATIVE'});
        }catch(e){dataProblems.push(`${p.symbol}:${e.message}`);}
      }
      const payload={ok:true,version:SHADOW_VERSION,ruleVersion:QV3_VERSION,variant:'ENTRY_EXIT_TWO',readOnlyTrading:true,executionEnabled:false,livePromotion:false,
        asOf:iso(asOf),finishedAt:iso(now()),shadowStart:iso(SHADOW_START),evaluationState:dataProblems.length?'DATA_UNAVAILABLE':'EVALUATED',dataProblems,
        sourceScanId:scan?.id??null,entryDecisions,exitDecisions,states,liveBlocks,runtime:r,
        clock:{exchangeMs:asOf,localBefore,localAfter,offsetEstimateMs:asOf-(localBefore+localAfter)/2},
        limitations:['Read-only candidate evaluations; no orders or account replay','Funding and independent profitability remain unverified','Live controls are recorded separately from hypothetical eligibility']};
      const saved=await rest('v18_strategy_shadow_runs',{on_conflict:'policy_version,slot_at'},
        {policy_version:SHADOW_VERSION,slot_at:iso(Math.floor(asOf/60000)*60000),observed_at:iso(asOf),payload});
      return reply(200,{...payload,persistedNew:saved.length===1});
    }catch(e){return reply(503,{ok:false,version:SHADOW_VERSION,executionEnabled:false,error:String(e.message).slice(0,160)});}
  };
}
