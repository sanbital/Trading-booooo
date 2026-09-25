/** LE-SHADOW-2 orchestration: DISCOVERY (hook at the end of the LE-SHADOW-1 scan), PARITY (production
 * FD1 ENTRY snapshot re-asked to ALT GPT V2), V2 WAIT lifecycle, V2 outcomes, health.
 *
 * ORDER-FREE / POSITION-FREE / EXECUTION-FREE / PRODUCTION-STATE-FREE: this module has no order,
 * account, gateway, lease, CEC-RPC or production-ledger path. Binance access is public market data
 * through the guard only; the production snapshot is read, never written. */
import {cec0040Decision} from '../../_shared/leader-cec0040.mjs';
import {computeFacts,bookFacts} from '../../_shared/gpt-final-decision/facts.mjs';
import {readSources} from '../../_shared/gpt-final-decision/market.mjs';
import {createGuard,getJson} from '../guard.mjs';
import {readQuote} from '../features.mjs';
import {cycleNear,rankIn} from '../universe.mjs';
import {computeAxes,pickForGpt} from './axes.mjs';
import {v2Gate,buildPacketV2,callAlt2,promptHashV2,schemaHashV2,hashOf,BUDGET_V2} from './gpt.mjs';
import {MODEL} from './contract.mjs';
import {evaluateWaitV2,terminalResolution,recheckContextV2,ttlMs} from './wait.mjs';
import {labelV2,beyondAskBps,roundTripBps,KLINE_LIMIT,COSTS_V2} from './outcome.mjs';
import {buildMarketContext} from './market-context.mjs';

export const PATCH_V2='LE-SHADOW-2-MARKET-CONTEXT-1';
export const ORDER_NOTIONAL_BASIS_USDT=600;   // FD1 facts depth/slippage basis (facts.mjs SLOT_ORDER_NOTIONAL_USDT)
export const SNAPSHOT_MAX_AGE_MS=25_000;      // older book => refresh before GPT
export const SNAPSHOT_HARD_MAX_AGE_MS=120_000; // older candles/book => no GPT at all (STALE_SNAPSHOT)
export const PARITY_MAX_LAG_MS=5*60_000;
export const PARITY_LOOKBACK_MS=15*60_000;
export const V2_GUARD=Object.freeze({cycleWeightCap:60,abortAt:1000});
const MIN=60_000;
const iso=t=>new Date(t).toISOString();
const ms=x=>x instanceof Date?x.getTime():typeof x==='number'?x:Date.parse(x);
const fin=x=>typeof x==='number'&&Number.isFinite(x);
const num=x=>x===null||x===undefined?null:(Number.isFinite(Number(x))?Number(x):null);
const errText=e=>(e?.code?String(e.code):String(e?.message??e)).slice(0,120);
async function marketContextAt(store,t){
  try{return buildMarketContext(await store.marketRegimeAt(iso(t)),t);}
  catch{return buildMarketContext(null,t);}
}

// ------------------------------------------------------------------------------------ helpers
export function microFields(v){
  return {spread_bps:num(v?.spread_bps),bid_depth_25bps_usdt:num(v?.bid_depth_25bps_usdt),ask_depth_25bps_usdt:num(v?.ask_depth_25bps_usdt),
    bid_depth_to_order:num(v?.bid_depth_to_order),ask_depth_to_order:num(v?.ask_depth_to_order),book_imbalance_25bps:num(v?.book_imbalance_25bps),
    max_bid_wall_to_order:num(v?.max_bid_wall_to_order),max_ask_wall_to_order:num(v?.max_ask_wall_to_order),estimated_buy_slippage_bps:num(v?.est_buy_slippage_bps)};
}
export function costFromFacts(v){
  const beyond=beyondAskBps(num(v?.est_buy_slippage_bps),num(v?.spread_bps)),rt=roundTripBps(beyond);
  return {fee_entry_bps:COSTS_V2.feeEntryBps,fee_exit_bps:COSTS_V2.feeExitBps,assumed_exit_slippage_bps:COSTS_V2.exitSlipBps,
    entry_slippage_beyond_ask_bps:beyond,roundtrip_cost_bps_real:rt,breakeven_bps:rt,slippage_basis:'FD1 est_buy_slippage_bps at '+ORDER_NOTIONAL_BASIS_USDT+' USDT'};
}
/** Snapshot freshness: 'FRESH' | 'REFRESH_BOOK' | 'STALE'. */
export function snapshotFreshness(snapshotAt,now){
  const age=now-snapshotAt;
  if(!fin(age)||age<0)return 'STALE';
  if(age>SNAPSHOT_HARD_MAX_AGE_MS)return 'STALE';
  return age>SNAPSHOT_MAX_AGE_MS?'REFRESH_BOOK':'FRESH';
}
/** Rank context from shadow scan cycles strictly BEFORE `t` (no future data). */
export function rankContextAt(cycles,symbol,t,extra={}){
  const before=cycles.map(c=>({observedAt:ms(c.observed_at),rankOrder:c.rank_order})).filter(c=>c.observedAt<t).sort((a,b)=>a.observedAt-b.observedAt);
  const cur=before.at(-1)&&t-before.at(-1).observedAt<=6*MIN?before.at(-1):null;
  const rank=rankIn(cur,symbol);
  const at=m=>cur?rankIn(cycleNear(before,cur.observedAt-m*MIN),symbol):null;
  const r15=at(15),r30=at(30),r60=at(60);
  return {rank,rank_observed_at:cur?iso(cur.observedAt):null,rank15m:r15,rank30m:r30,rank60m:r60,
    velocity15:rank!==null&&r15!==null?r15-rank:null,velocity60:rank!==null&&r60!==null?r60-rank:null,source:'SHADOW_LE_SCAN_CYCLES',...extra};
}
function legacyFromProduction(mj){
  if(!mj)return null;
  return {b06133:mj.b06133?{allowed:mj.b06133.allowed===true,reason:mj.b06133.reason??null,factors:mj.b06133.factors??null}:null,
    v30:mj.v30?{admitted:mj.v30.admitted===true,failed:mj.v30.failed??[],negative_evidence:mj.v30.negative_evidence??[]}:null,
    cec0040:mj.cec0040?{action:mj.cec0040.action??null,prediction_usdt_per_trade:num(mj.cec0040.prediction_usdt_per_trade),ready:mj.cec0040.ready===true,
      note:'strategy-wide estimate from recent closed trades (not symbol specific)'}:null,
    semantics:'ADVISORY (strategy prediction). Execution hard safety is separate (hard_safety).'};
}
function legacyFromDiscovery(x,cecState){
  let cec=null;
  if(cecState){
    try{const d=cec0040Decision({ewmaUsdt:cecState.ewma_usdt===null?null:Number(cecState.ewma_usdt),trainingCount:Number(cecState.training_count),rejectRun:Number(cecState.reject_run)});
      cec={action:d.action,prediction_usdt_per_trade:d.prediction,ready:Number(cecState.training_count)>=10,
        note:'strategy-wide estimate from recent closed trades (not symbol specific); pure evaluation, production state not advanced'};}
    catch{cec={action:null,prediction_usdt_per_trade:num(cecState.ewma_usdt),ready:false,note:'CEC state unreadable'};}
  }
  return {b06133:x?.b06133?{allowed:x.b06133.allowed===true,reason:x.b06133.reason??null,factors:x.b06133.factors??null}:null,
    v30:x?.v30?{admitted:x.v30.admitted===true,failed:x.v30.failed??[]}:null,cec0040:cec,
    semantics:'ADVISORY (strategy prediction). Execution hard safety is separate (hard_safety).'};
}
function high60FromFacts(v,quality){
  const lc=num(quality?.last_close),dh=num(v?.distance_high_60m);
  return lc>0&&fin(dh)&&dh>-1?lc/(1+dh):null;
}
async function productionYield(store,now){
  const r=await store.prodScanLatest();
  if(!r)return null;
  const text=JSON.stringify([r.blocked??null,r.errors??null]);
  return now-ms(r.captured_at)<=10*MIN&&/WEIGHT|HTTP_429|HTTP_418|HTTP_451|RATE_LIMIT/i.test(text)?'SHADOW_YIELD_PRODUCTION_WEIGHT':null;
}
function gptRow(base,r,packet,hashes){
  const a=r.answer;
  return {...base,decision_source:'ALT_GPT',decision:r.decision,valid:r.valid,actual_trade:false,shadow_trade:r.decision==='BUY',
    phase:a?.phase??null,overheat_view:a?.overheat_view??null,reasons:a?.reasons??[],support:a?.support??[],override:a?.override??null,
    legacy_negatives:a?.legacy_negatives??null,expected_move_bps:a?.expected_move_bps??null,note:a?.note??null,
    packet,packet_hash:hashes.packet,model:MODEL,prompt_hash:hashes.prompt,schema_hash:hashes.schema,
    asked_at:iso(r.asked_at),answered_at:iso(r.answered_at),latency_ms:fin(r.latency_ms)?Math.round(r.latency_ms):null,
    tokens_in:r.tokens_in,tokens_out:r.tokens_out,cost_usd:r.cost_usd,request_id:r.request_id,error:r.error};
}
function waitSpec(a,{snapshotAt,mid,high60,rank,v}){
  const ttl=ttlMs(a.wait.ttl_min);
  return {spec:{trigger:a.wait.trigger,param:a.wait.param,ttl_min:a.wait.ttl_min,snapshot_at_ms:snapshotAt,expires_at_ms:snapshotAt+ttl,mid,high60,rank,
    init:{spread_bps:num(v.spread_bps),est_buy_slippage_bps:num(v.est_buy_slippage_bps),ask_depth_to_order:num(v.ask_depth_to_order),
      book_imbalance_25bps:num(v.book_imbalance_25bps)},oi_last:{v:num(v.open_interest_usdt)}},expires:snapshotAt+ttl};
}
async function askAlt({store,guard,apiKey,now,lane,packet}){
  const r=await callAlt2(packet,{lane,apiKey,fetchFn:guard.fetch,now,
    reserve:(l,usd,p)=>store.v2BudgetReserve(l,usd,p),settle:(id,usd)=>store.v2BudgetSettle(id,usd)});
  const hashes={packet:await hashOf(packet),prompt:await promptHashV2(),schema:await schemaHashV2(packet.attempt===2)};
  return {r,hashes};
}

// ------------------------------------------------------------------------------------ DISCOVERY
/**
 * Called by runScan after the LE-SHADOW-1 cycle is written. Records one V2 event per shortlisted
 * candidate with facts (RULE_BASELINE copied from LE-SHADOW-1), and asks ALT GPT V2 for at most
 * one LEADER and one EMERGING chosen by the non-monotone prescore.
 */
export async function v2Discovery({store2,guard,apiKey,now,health,cycleId,observedAt,written,rows,selected,rich,decisions}){
  const out={events:0,gpt_calls:0,asked:[],skipped:[],gate:null};
  if(!cycleId||!selected.length)return out;
  const ctl=await store2.controlV2();
  const gate=v2Gate({control:ctl,apiKey,health,lane:'DISCOVERY'});out.gate=gate;
  const idOf=new Map((written?.decisions??[]).map(d=>[d.symbol,d.candidate_id]));
  const cecState=await store2.cecState();
  const marketContext=await marketContextAt(store2,observedAt);
  const items=[];
  for(const sym of selected){
    const x=rich.get(sym),row=rows.find(r=>r.symbol===sym),cid=idOf.get(sym);
    if(!x?.facts||!row||!cid||!['LEADER','EMERGING'].includes(row.lane))continue;
    const v=x.facts.values,cost=costFromFacts(v);
    const rankContext={rank:row.rank,rank15m:row.rank15m,rank30m:row.rank30m,rank60m:row.rank60m,velocity15:row.velocity15,velocity60:row.velocity60,
      first_top10_today:row.firstTop10Today,minutes_in_top10_today:row.minutesInTop10Today,day_return_live:row.dayReturn,lane:row.lane,source:'SHADOW_LE_SCAN'};
    const axes=computeAxes(v,{...row,vr15:x.vr15,cost});
    const rb=decisions.find(d=>d.symbol===sym&&d.arm==='RULE_BASELINE');
    items.push({symbol:sym,lane:row.lane,row,x,cid,v,cost,rankContext,axes,rb,legacy:legacyFromDiscovery(x,cecState)});
  }
  const eligible=items.filter(i=>!(i.x.hardBlock??[]).length);
  const {selected:pick}=pickForGpt(eligible);
  const chosen=new Map(pick.map(p=>[p.symbol,p]));
  let calls=0;
  for(const it of items){
    const ask=num(it.rb?.hyp_entry_ask),mid=num(it.rb?.hyp_entry_mid),entryAt=it.rb?.hyp_entry_at?ms(it.rb.hyp_entry_at):null;
    let facts=it.v,source='SHADOW_LIVE_READ',snapshotAt=it.x.snapshotAt;
    const hard=it.x.hardBlock??[];
    const p=chosen.get(it.symbol);
    const prescore={gpt_gate:gate,selected_for_gpt:!!p,prescore:p?.prescore??null,prescore_rank:p?.prescore_rank??null,hard_block:hard,
      market_context:marketContext,
      rule:'<=1 LEADER + <=1 EMERGING; order: overheat count, continuation state, execution state, rank (strength is not a positive key)'};
    // freshness: refresh the book (not candles) if the snapshot aged past 25 s before the GPT call
    let stale=false;
    if(p&&gate===null&&!hard.length){
      const f=snapshotFreshness(snapshotAt,now());
      if(f==='STALE')stale=true;
      else if(f==='REFRESH_BOOK'){
        try{const book=await getJson(guard,'/fapi/v1/depth',{symbol:it.symbol,limit:100});const bf=bookFacts(book);
          if(bf){facts={...facts,...bf};source='SHADOW_LIVE_READ_BOOK_REFRESHED';prescore.book_refreshed_at=iso(now());}else stale=true;}
        catch{stale=true;}
      }
    }
    const cost=source==='SHADOW_LIVE_READ'?it.cost:costFromFacts(facts);
    const axes=source==='SHADOW_LIVE_READ'?it.axes:computeAxes(facts,{...it.row,vr15:it.x.vr15,cost});
    const event={lane:'DISCOVERY',symbol:it.symbol,cycle_id:cycleId,candidate_id:it.cid,scan_lane:it.lane,candidate_at:iso(observedAt),
      snapshot_at:iso(snapshotAt),snapshot_offset_ms:Math.round(snapshotAt-observedAt),snapshot_source:source,...microFields(facts),
      order_notional_basis_usdt:ORDER_NOTIONAL_BASIS_USDT,micro_complete:it.x.facts.quality?.micro_complete??null,
      entry_ref_at:entryAt?iso(entryAt):null,entry_ref_ask:ask,entry_ref_bid:ask&&mid?2*mid-ask:null,entry_ref_mid:mid,
      entry_beyond_ask_bps:cost.entry_slippage_beyond_ask_bps,roundtrip_cost_bps:cost.roundtrip_cost_bps_real,
      rank_context:it.rankContext,facts,axes,legacy:it.legacy,hard_safety:hard,prescore,patch:PATCH_V2};
    const eventId=await store2.insertEvent(event);
    if(!eventId)continue;
    out.events++;
    const base={event_id:eventId,lane:'DISCOVERY',symbol:it.symbol,attempt:1,parent_decision_id:null,hyp_entry_at:event.entry_ref_at,
      hyp_entry_ask:ask,hyp_entry_basis:ask?'EVENT_SNAPSHOT_ASK':null,hyp_entry_beyond_ask_bps:cost.entry_slippage_beyond_ask_bps};
    const rows2=[];
    if(it.rb){const d=it.rb.decision;
      rows2.push({...base,decision_source:'RULE_BASELINE',decision:d,valid:true,actual_trade:false,shadow_trade:d==='BUY',reasons:it.rb.reasons??[],
        note:'LE-SHADOW-1 RULE_BASELINE (LE_LANES_1)',asked_at:event.snapshot_at,answered_at:it.rb.answered_at??event.snapshot_at});}
    if(hard.length&&p===undefined&&gate===null){
      rows2.push({...base,decision_source:'ALT_GPT',decision:'SKIP_DETERMINISTIC',valid:true,actual_trade:false,shadow_trade:false,reasons:hard,gate:'HARD_SAFETY',
        note:'execution hard safety: GPT not asked'});
    }else if(p&&gate===null){
      if(stale){
        rows2.push({...base,decision_source:'ALT_GPT',decision:'ABSTAIN',valid:false,actual_trade:false,shadow_trade:false,gate:'STALE_SNAPSHOT',error:'STALE_SNAPSHOT'});
      }else if(calls<BUDGET_V2.DISCOVERY.perCycle){
        const packet=buildPacketV2({lane:'DISCOVERY',symbol:it.symbol,eventKey:'le2_d_'+eventId,facts,axes,rankContext:it.rankContext,
          marketContext,legacy:it.legacy,cost,hardSafety:hard});
        const {r,hashes}=await askAlt({store:store2,guard,apiKey,now,lane:'DISCOVERY',packet});
        if(r.attempted){calls++;out.gpt_calls++;}
        const row=gptRow(base,r,packet,hashes);
        if(r.decision==='WAIT'){
          const {spec,expires}=waitSpec(r.answer,{snapshotAt,mid:mid??num(it.x.facts.quality?.last_close),high60:high60FromFacts(facts,it.x.facts.quality),rank:it.row.rank,v:facts});
          Object.assign(row,{wait_reason:r.answer.wait.reason,recheck_trigger:spec,wait_expires_at:iso(expires)});
        }
        rows2.push(row);out.asked.push({s:it.symbol,d:r.decision,e:r.error});
      }
    }else out.skipped.push({s:it.symbol,why:gate??'NOT_SELECTED_BY_PRESCORE'});
    await store2.insertV2Decisions(rows2);
  }
  return out;
}

// ------------------------------------------------------------------------------------ PARITY
/** Build the parity event from one production FD1 ENTRY review row (its ANSWER is never used here). */
export function parityEvent(pr,cycles){
  const pk=pr.packet??{},facts=pk.facts?.values??{},quality=pk.facts?.quality??{},ex=pk.execution_ref??{};
  let identity={};try{identity=JSON.parse(pr.identity_json??'{}')??{};}catch{identity={};}
  const snapshotAt=num(pr.snapshot_at_ms)??ms(pr.snapshot_at);
  const candidateAt=num(identity.trigger_at_ms)??snapshotAt;
  const cost=costFromFacts(facts);
  const rankContext=rankContextAt(cycles,pr.symbol,snapshotAt,{production_signal_rank:num(facts.signal_rank),day_return:num(facts.day_return)});
  const axes=computeAxes(facts,{rank:rankContext.rank??num(facts.signal_rank),rank15m:rankContext.rank15m,rank30m:rankContext.rank30m,rank60m:rankContext.rank60m,
    velocity15:rankContext.velocity15,velocity60:rankContext.velocity60,cost});
  const hard=[];
  if(quality.micro_complete!==true)hard.push('MICRO_INCOMPLETE');
  if(fin(num(facts.spread_bps))&&facts.spread_bps>25)hard.push('SPREAD_GT_25BPS');
  if(fin(num(facts.ask_depth_to_order))&&facts.ask_depth_to_order<1.5)hard.push('ASK_DEPTH_LT_1_5X');
  if(fin(num(facts.est_buy_slippage_bps))&&facts.est_buy_slippage_bps>=25)hard.push('SLIPPAGE_GE_25BPS');
  const ask=num(ex.ask),bid=num(ex.bid),mid=num(ex.mid);
  return {snapshotAt,facts,quality,cost,rankContext,axes,hard,mid,legacy:legacyFromProduction(pk.model_judgments),
    event:{lane:'PARITY',symbol:pr.symbol,prod_job_key:pr.job_key,prod_signal_id:pr.signal_id??null,prod_candidate_id:pr.candidate_id??null,
      prod_snapshot_hash:pk.snapshot_hash??null,candidate_at:iso(candidateAt),snapshot_at:iso(snapshotAt),snapshot_offset_ms:Math.round(snapshotAt-candidateAt),
      snapshot_source:'PRODUCTION_PACKET',...microFields(facts),order_notional_basis_usdt:ORDER_NOTIONAL_BASIS_USDT,micro_complete:quality.micro_complete??null,
      entry_ref_at:num(ex.at)?iso(ex.at):null,entry_ref_ask:ask,entry_ref_bid:bid,entry_ref_mid:mid,
      entry_beyond_ask_bps:cost.entry_slippage_beyond_ask_bps,roundtrip_cost_bps:cost.roundtrip_cost_bps_real,
      rank_context:rankContext,facts,axes,legacy:legacyFromProduction(pk.model_judgments),hard_safety:hard,prescore:null,patch:PATCH_V2}};
}

export async function runParity({store2,now=Date.now,apiKey=null,health=null,guard=null,limit=3}){
  const started=now();
  const ctl=await store2.controlV2();
  if(ctl?.enabled!==true||ctl?.v2_parity_enabled!==true)return {ok:true,mode:'parity',status:'DISABLED'};
  const g=guard??createGuard({fetchFn:fetch,...V2_GUARD});
  const pending=await store2.prodEntryPending(iso(started-PARITY_LOOKBACK_MS),limit);
  if(!pending.length)return {ok:true,mode:'parity',status:'NOTHING_PENDING'};
  const gate=v2Gate({control:ctl,apiKey,health,lane:'PARITY'});
  const out=[],errors=[];let calls=0;
  for(const pr of pending){
    try{
      const snapAt=num(pr.snapshot_at_ms)??ms(pr.snapshot_at);
      const cycles=await store2.rankCycles(iso(snapAt-65*MIN),iso(snapAt));
      const pe=parityEvent(pr,cycles);
      const marketContext=await marketContextAt(store2,snapAt);
      pe.event.prescore={market_context:marketContext};
      const eventId=await store2.insertEvent(pe.event);
      if(!eventId){out.push({s:pr.symbol,state:'ALREADY_CLAIMED'});continue;}
      const base={event_id:eventId,lane:'PARITY',symbol:pr.symbol,attempt:1,parent_decision_id:null,hyp_entry_at:pe.event.entry_ref_at,
        hyp_entry_ask:pe.event.entry_ref_ask,hyp_entry_basis:pe.event.entry_ref_ask?'EVENT_SNAPSHOT_ASK':null,hyp_entry_beyond_ask_bps:pe.cost.entry_slippage_beyond_ask_bps};
      const prodDecision=['BUY','SKIP','ABSTAIN'].includes(pr.decision)?pr.decision:'ABSTAIN';
      const rows=[{...base,decision_source:'PRODUCTION_GPT',decision:prodDecision,valid:pr.valid===true,actual_trade:null,shadow_trade:false,
        error:pr.error??null,note:'production FD1 ENTRY decision (copied read-only; never shown to ALT)',answered_at:iso(ms(pr.created_at))}];
      const lag=now()-snapAt;
      let alt=null;
      if(gate!==null)alt={s:pr.symbol,gate};
      else if(lag>PARITY_MAX_LAG_MS){
        rows.push({...base,decision_source:'ALT_GPT',decision:'ABSTAIN',valid:false,actual_trade:false,shadow_trade:false,gate:'PARITY_LAG_EXCEEDED',error:'PARITY_LAG_EXCEEDED:'+Math.round(lag/1000)+'s'});
      }else if(calls<BUDGET_V2.PARITY.perRun){
        const packet=buildPacketV2({lane:'PARITY',symbol:pr.symbol,eventKey:'le2_p_'+eventId,facts:pe.facts,axes:pe.axes,rankContext:pe.rankContext,
          marketContext,legacy:pe.legacy,cost:pe.cost,hardSafety:pe.hard});
        const {r,hashes}=await askAlt({store:store2,guard:g,apiKey,now,lane:'PARITY',packet});
        if(r.attempted)calls++;
        const row=gptRow(base,r,packet,hashes);
        if(r.decision==='WAIT'){
          const {spec,expires}=waitSpec(r.answer,{snapshotAt:snapAt,mid:pe.mid,high60:high60FromFacts(pe.facts,pe.quality),rank:pe.rankContext.rank,v:pe.facts});
          Object.assign(row,{wait_reason:r.answer.wait.reason,recheck_trigger:spec,wait_expires_at:iso(expires)});
        }
        rows.push(row);alt={s:pr.symbol,prod:prodDecision,alt:r.decision,err:r.error,lag_ms:lag};
      }
      await store2.insertV2Decisions(rows);
      out.push(alt??{s:pr.symbol,prod:prodDecision});
    }catch(e){errors.push(pr.symbol+':'+errText(e));}
  }
  await store2.insertV2Cycle({mode:'PARITY',status:'OK',started_at:iso(started),finished_at:iso(now()),request_weight:g.state.weight,
    used_weight_max:g.state.usedMax,binance_status:g.state.dayHalt??g.state.abort??'OK',gpt_state:gate??'ENABLED',gpt_calls:calls,errors,
    detail:{events:out,openai_requests:g.state.openaiRequests},patch:PATCH_V2});
  return {ok:true,mode:'parity',status:'OK',gate,events:out,gpt_calls:calls,errors,orderCalls:0};
}

// ------------------------------------------------------------------------------------ V2 WAIT
export async function runV2Wait({store2,now=Date.now,apiKey=null,health=null,guard=null,limit=5}){
  const started=now();
  const ctl=await store2.controlV2();
  if(ctl?.enabled!==true)return {ok:true,mode:'v2wait',status:'DISABLED'};
  const waits=await store2.v2OpenWaits();
  if(!waits.length)return {ok:true,mode:'v2wait',status:'NO_OPEN_WAIT'};
  const g=guard??createGuard({fetchFn:fetch,...V2_GUARD});
  // a Binance 418/429/451 anywhere in the shadow today halts every shadow Binance read until 00:00Z
  const yieldReason=(await store2.haltedTodayV2())?'HALTED_TODAY':await productionYield(store2,now());
  const out=[],errors=[];let calls=0,live=0;
  for(const w of waits){
    const spec=w.recheck_trigger??{};
    try{
      let ev;
      if(now()>=Number(spec.expires_at_ms))ev={state:'EXPIRED',reason:'WAIT_TTL_NO_TRIGGER'};
      else{
        if(yieldReason||live>=limit){out.push({d:w.decision_id,state:'DEFERRED',why:yieldReason??'RUN_LIMIT'});continue;}
        live++;
        const bars=await getJson(g,'/fapi/v1/klines',{symbol:w.symbol,interval:'1m',limit:20});
        const book=await getJson(g,'/fapi/v1/depth',{symbol:w.symbol,limit:100});
        const oiHist=spec.trigger==='OI_CONFIRM'?await getJson(g,'/futures/data/openInterestHist',{symbol:w.symbol,period:'5m',limit:4}):null;
        const after=(await store2.cyclesAfterV2(iso(Number(spec.snapshot_at_ms)))).map(r=>({observedAt:ms(r.observed_at),rank:rankIn({rankOrder:r.rank_order},w.symbol)}));
        ev=evaluateWaitV2(spec,{now:now(),bars,book,oiHist,rankFirst:after[0]??null,rankLatest:after.at(-1)??null});
      }
      if(ev.state==='PENDING'){out.push({d:w.decision_id,state:'PENDING'});continue;}
      const claim=await store2.claimV2WaitEvent({decision_id:w.decision_id,symbol:w.symbol,event:ev.state,at:iso(now()),hyp_price:ev.price??null,
        detail:{reason:ev.reason,...(ev.detail??{})}});
      if(!claim){out.push({d:w.decision_id,state:'ALREADY_TERMINAL'});continue;}
      const base={event_id:w.event_id,lane:w.lane,symbol:w.symbol,attempt:2,parent_decision_id:w.decision_id};
      if(ev.state!=='TRIGGERED'){
        const t=terminalResolution(ev);
        await store2.insertV2Decisions([{...base,decision_source:'WAIT_RESOLUTION',decision:t.decision,valid:true,actual_trade:false,shadow_trade:false,
          reasons:t.reasons,note:'deterministic: time/invalidation never becomes a BUY',answered_at:iso(now())}]);
        out.push({d:w.decision_id,state:ev.state,resolution:t.decision});continue;
      }
      // TRIGGERED -> one GPT re-ask on fresh point-in-time facts (BUY / SKIP / ABSTAIN)
      const gate=v2Gate({control:ctl,apiKey,health,lane:w.lane});
      if(gate!==null){
        await store2.insertV2Decisions([{...base,decision_source:'ALT_GPT',decision:'ABSTAIN',valid:false,actual_trade:false,shadow_trade:false,gate,error:'ALT_GATE:'+gate,answered_at:iso(now())}]);
        out.push({d:w.decision_id,state:'TRIGGERED',resolution:'ABSTAIN',gate});continue;
      }
      const asOf=now(),{src}=await readSources(w.symbol,asOf,{mode:'LIVE',fetchFn:g.fetch,ms:3000});
      let facts=null;try{facts=computeFacts(src,{asOf,referenceClose:spec.mid,dayReturn:w.packet?.facts?.day_return??null,rank:w.rank_context?.rank??null});}catch{/* ABSTAIN below */}
      const v=facts?.values??{},cost=costFromFacts(v);
      const ctx=recheckContextV2(w.packet??{},facts,{price:ev.price,snapshotMid:spec.mid,elapsedMs:asOf-Number(spec.snapshot_at_ms),trigger:spec.trigger});
      const axes=computeAxes(v,{...(w.rank_context??{}),cost});
      const marketContext=await marketContextAt(store2,asOf);
      const packet=buildPacketV2({lane:w.lane,symbol:w.symbol,eventKey:(w.packet?.event_key??'le2')+'_r',facts:v,axes,rankContext:w.rank_context,
        marketContext,legacy:w.packet?.legacy??null,cost,hardSafety:[],attempt:2,...ctx});
      const {r,hashes}=await askAlt({store:store2,guard:g,apiKey,now,lane:w.lane,packet});
      if(r.attempted)calls++;
      let quote=null;try{quote=await readQuote(g,w.symbol,now);}catch{/* no entry */}
      const row={...gptRow(base,r,packet,hashes)};
      if(r.decision==='BUY'&&quote){Object.assign(row,{hyp_entry_at:iso(quote.at),hyp_entry_ask:quote.ask,hyp_entry_basis:'WAIT_TRIGGER_ASK',
        hyp_entry_beyond_ask_bps:cost.entry_slippage_beyond_ask_bps});}
      await store2.insertV2Decisions([row]);
      out.push({d:w.decision_id,state:'TRIGGERED',resolution:r.decision,err:r.error});
    }catch(e){errors.push(w.symbol+':'+errText(e));if(g.state.dayHalt||g.state.abort)break;}
  }
  await store2.insertV2Cycle({mode:'V2_WAIT',status:yieldReason??'OK',started_at:iso(started),finished_at:iso(now()),request_weight:g.state.weight,
    used_weight_max:g.state.usedMax,binance_status:g.state.dayHalt??g.state.abort??'OK',gpt_state:null,gpt_calls:calls,errors,
    detail:{waits:out,requests:g.state.requests,log:g.state.log.slice(0,40)},patch:PATCH_V2});
  return {ok:true,mode:'v2wait',status:'OK',waits:out,gpt_calls:calls,request_weight:g.state.weight,used_weight_max:g.state.usedMax,errors,orderCalls:0};
}

// ------------------------------------------------------------------------------------ V2 OUTCOME
export async function v2Outcome({store2,now=Date.now,guard=null,limit=15}){
  const g=guard??createGuard({fetchFn:fetch,...V2_GUARD});
  const out={labeled:0,errors:[],request_weight:0};
  if(await store2.haltedTodayV2()){out.status='HALTED_TODAY';return out;}
  if(await productionYield(store2,now())){out.status='SHADOW_YIELD_PRODUCTION_WEIGHT';return out;}
  const due=await store2.v2OutcomeDue(iso(now()-(KLINE_LIMIT+1)*MIN),limit);
  const rows=[];
  for(const d of due){
    try{
      const at=ms(d.entry_at);
      const raw=await getJson(g,'/fapi/v1/klines',{symbol:d.symbol,interval:'1m',startTime:Math.floor(at/MIN)*MIN,limit:KLINE_LIMIT});
      const l=labelV2({at,price:Number(d.entry_price),beyondAskBps:num(d.beyond)},raw);
      const snap=ms(d.snapshot_at);
      let reviewed=null,pos=null;
      if(d.lane==='PARITY'){reviewed=true;pos=d.prod_signal_id?await store2.prodTradeBySignal(d.prod_signal_id):null;}
      else{reviewed=await store2.prodReviewedWindow(d.symbol,iso(snap-15*MIN),iso(snap+30*MIN));
        pos=await store2.prodTradeBySymbol(d.symbol,iso(snap-15*MIN),iso(snap+30*MIN));}
      rows.push({...l,event_id:d.event_id,decision_id:d.decision_id,entry_basis:d.entry_basis,hyp_entry_at:iso(at),hyp_entry_price:Number(d.entry_price),
        prod_reviewed:reviewed,prod_actual_trade:!!pos,prod_position_id:pos?.id??null,prod_position_state:pos?.state??null,
        prod_realized_pnl_usdt:pos?.state==='CLOSED'?pos.realized_pnl_usdt:null});
    }catch(e){out.errors.push(d.symbol+':'+errText(e));if(g.state.dayHalt||g.state.abort)break;}
  }
  if(rows.length)out.labeled=(await store2.insertV2Outcomes(rows)).length;
  out.request_weight=g.state.weight;out.used_weight_max=g.state.usedMax;out.binance_status=g.state.dayHalt??g.state.abort??'OK';
  return out;
}

// ------------------------------------------------------------------------------------ HEALTH (no writes, no external calls)
export async function runHealth({store2,apiKey=null}){
  const ctl=await store2.controlV2();
  return {ok:true,mode:'health',writes:0,patch:PATCH_V2,control:ctl,shadow_key_present:!!apiKey,
    budget:{DISCOVERY:await store2.v2BudgetState('DISCOVERY'),PARITY:await store2.v2BudgetState('PARITY')},orderCalls:0};
}
