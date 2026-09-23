// Order-free production dry run of the GPT final review path (operator/verification only).
// Builds an ISOLATED coordinator (purpose=DRYRUN): the live entry path's coordinator,
// control row, tickets and hints are never touched. It never claims signals, writes
// orders, positions, incidents or audit rows; the only writes are DRYRUN journal rows.
import {FinalReviewCoordinator,RELEASE} from '../_shared/gpt-final-review/coordinator.mjs';
import {SupabaseReviewStore} from '../_shared/gpt-final-review/supabase-store.mjs';
import {collectMarket} from '../_shared/gpt-final-review/market.mjs';
import {baselineAllowed} from '../_shared/gpt-final-review/contract.mjs';
export const DRYRUN_BUDGET=Object.freeze({capUsd:1.5,maxCalls:150});
/** A real engine-approved candidate is replayed on a clock shifted to trigger+offset so the
 * reviewer sees the point-in-time market and every TTL/freshness rule applies unchanged. */
export function replayClock(triggerAt,offsetMs,realNow=Date.now){
  const shift=realNow()-(triggerAt+offsetMs);return ()=>realNow()-shift;
}
export function dryRunCoordinator(db,{triggerAt,offsetMs=4000,runId,apiKey,fetchFn=fetch}){
  const now=replayClock(triggerAt,offsetMs);
  return new FinalReviewCoordinator({config:{mode:'ENFORCE',modeValid:true,approvalRef:'DRYRUN:'+String(runId).slice(0,60),
    apiBudgetUsd:DRYRUN_BUDGET.capUsd,maxCalls:DRYRUN_BUDGET.maxCalls,enforceApproved:true,source:'DRYRUN'},
    store:new SupabaseReviewStore(db),apiKey:()=>apiKey,fetchFn,now,purpose:'DRYRUN',
    market:(identity,opts)=>collectMarket(identity,{...opts,now})});
}
/** Phase 1, OUTSIDE any execution lease: claim + API + durable completion. */
export async function dryRunReviewPhase(c,s){
  const t0=Date.now(),first=await c.consider(s);
  const pending=[...c.pending.values()];
  await Promise.all(pending);
  return {first:first.reason,apiTaskCreated:pending.length>0,elapsedMs:Date.now()-t0,baselineAllowed:baselineAllowed(s),release:RELEASE};
}
/** ORDER-FREE live probe: a FIXTURE candidate on the CURRENT minute for a liquid symbol, so the
 * production coordinator collects live candles + a seconds-old book/funding/OI snapshot and
 * calls the real API. B06133 factors come from the production selector on live bars; the input
 * feature values and the CEC stamp are fixture-declared (labelled). No lease, no guards, no
 * orders; the only write is one DRYRUN journal row. */
export async function liveProbe(db,{symbol,apiKey,runId,fetchFn=fetch,evaluate,fetchInputs}){
  const MIN=60000,trigger=Math.floor(Date.now()/MIN)*MIN;
  const url='https://fapi.binance.com/fapi/v1/klines?'+new URLSearchParams({symbol,interval:'1m',limit:'61',endTime:String(trigger-1)});
  const r=await fetchFn(url,{signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error('LIVE_KLINES_'+r.status);
  const k=(await r.json()).filter(x=>Number(x[6])<trigger);if(k.length<61)throw Error('LIVE_KLINES_SHORT');
  const c=k.map(x=>Number(x[4])),q=k.map(x=>Number(x[7])),last=c.at(-1),ret=n=>last/c.at(-1-n)-1;
  const recent=q.slice(-15).reduce((a,b)=>a+b,0),prior=q.slice(-60,-15).reduce((a,b)=>a+b,0)/3;
  const features={volumeRatio:prior>0?recent/prior:null,return5m:ret(5),return15m:ret(15),return30m:ret(30),return60m:ret(60),referenceClose:last,
    exitPolicy:{stopPct:.01,trailArmPct:.008,trailGapPct:.004,maxHoldMs:3600000,staleMs:120000}};
  const b=evaluate({features,...await fetchInputs(symbol,trigger,fetchFn),decisionAt:trigger});
  const s={id:'dryrun-probe-'+symbol+'-'+trigger+'-'+String(runId).slice(0,20),symbol,status:'NEW',features:{...features,
    v17Setup:{state:'TRIGGERED',triggerAt:trigger},b06133:{...b,allowed:true,result:true,branch:b.allowed?b.branch:'R62'},
    cec0040:{version:'CEC0040_CAUSAL_EDGE_CONTROLLER_1',targetVersion:'CEC0040_P142_MEAN44_1',decisionAt:trigger,action:'PROBE',ready:true,effectiveAllowed:true,enforcementEnabled:true}}};
  const c2=new FinalReviewCoordinator({config:{mode:'ENFORCE',modeValid:true,approvalRef:'DRYRUN_PROBE:'+String(runId).slice(0,50),
    apiBudgetUsd:DRYRUN_BUDGET.capUsd,maxCalls:DRYRUN_BUDGET.maxCalls,enforceApproved:true,source:'DRYRUN'},
    store:new SupabaseReviewStore(db),apiKey:()=>apiKey,fetchFn,purpose:'DRYRUN'});
  const t0=Date.now(),first=await c2.consider(s);await Promise.all([...c2.pending.values()]);const second=await c2.consider(s);
  const row=second.jobKey?await c2.store.get(second.jobKey):null,rec=row?.record,cur=rec?.packet?.current_market;
  const pick=k=>cur?.metrics?.[k]?{value:cur.metrics[k].value,unit:cur.metrics[k].unit,missing:cur.metrics[k].missing_reason}:null;
  return {fixture:true,symbol,triggerAt:trigger,selectorAllowed:b.allowed===true,selectorBranch:b.branch??null,first:first.reason,final:second.reason,
    decision:second.decision??null,elapsedMs:Date.now()-t0,latencyMs:rec?.result?.latency_ms??null,error:rec?.result?.error??null,
    usage:rec?.result?.usage??null,costUsd:rec?.result?.api_cost_usd??null,jobKey:second.jobKey??null,
    quality:cur?.quality??null,microstructureAvailability:cur?.microstructure_availability??null,
    microstructure:Object.fromEntries(['spread','depth','bid_depth_25bps','book_imbalance_25bps','ask_depth_to_slot_notional','funding','mark_index_premium','open_interest_usdt','oi_change_5m','oi_change_60m'].map(k=>[k,pick(k)])),
    summary:second.decision?rec?.result?.answer?.summary??null:null,
    citedMicro:rec?.result?.answer?[...rec.result.answer.supporting_evidence,...rec.result.answer.opposing_evidence,...rec.result.answer.checked_claims.flatMap(x=>x.evidence_paths.map(p=>({field_path:p})))].map(e=>e.field_path).filter(p=>/spread|depth|imbalance|funding|premium|open_interest|oi_change/.test(p)):[]};
}
