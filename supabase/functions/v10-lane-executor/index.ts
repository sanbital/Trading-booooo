// @ts-nocheck
import {entryExecutionWindow,normalizeEntryBook,gatewayTakerFeeRate,supportedFuturesMode,entryPriceEvidence} from "./entry-evidence.mjs";
import {gptFilterExecutable,gptFinalCheck,runWithGptReview,gptReviewReadyToResume} from "./gpt-final-review-adapter.mjs";
import {dryRunCoordinator,dryRunReviewPhase,liveProbe} from "./gpt-final-review-dryrun.mjs";
import {readReviewControl} from "../_shared/gpt-final-review/supabase-store.mjs";
import {fd1HoldTick,fd1Probe,FD1_HOLD_POLICY_VERSION,TIME_REASONS as FD1_TIME_REASONS} from "./gpt-final-decision-adapter.mjs";
import {FD1_ENTRY_ENGINE} from "../_shared/gpt-final-decision/engine.mjs";
import {finalRecheckStep,finalRecheckProbe,postRecheckSafety,markRecheckOutcome,withOrderTiming} from "./gpt-final-recheck-adapter.mjs";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {POLICY, STRATEGY, ENTRY_EXECUTION_POLICY_VERSION, entryFresh, postFillEntryGuard, nextExit, portfolioMatches as leaderPortfolioMatches} from "../_shared/leader-momentum-v17.mjs";
import {nextExitReviewed, EXIT_REVIEW_CANDIDATE, EXIT_REVIEW_R5, exitAttemptId, classifyExitResponse} from "../_shared/leader-exit-review.mjs";
import {protectNewLeaderPosition} from "../_shared/leader-entry-protection.mjs";
import {createGatewayProtection} from "../_shared/leader-protection-adapter.mjs";
import {classifyPortfolio, freshPortfolio, ownedEntry, riskOrders, classifyFailure, operatorAllowsRecovery, recoveryEvidence, confirmedLiveProtection, createBudget, boundedMap} from "../_shared/leader-ops-isolation.mjs";
import {entryReceipt,entryExposureMatches} from "../_shared/leader-entry-settlement.mjs";
import {applyExitReceipt} from "../_shared/leader-exit-settlement.mjs";
import {analyzeDbOnlyExit} from "../_shared/leader-db-only-reconciliation.mjs";
import {ENTRY_CONTROL_VERSION,CONTROL_SCOPE,evaluateEntryDecision,symbolRecoveryEvidence} from "../_shared/leader-entry-control.mjs";
import {QV3_ACTIVATION_BASIS,QV3_LIVE_CUTOVER,QV3_VERSION,qv3Entry,qv3Exit,qv3Scope,qv3Stamp,qv3Candles,qv3AuditEvidence} from "../_shared/leader-qv3-runtime.mjs";
import {E1_POLICY,advanceE1,e1QuoteEvidence,fetchE1AggTrades,startE1} from "../_shared/leader-e1-runtime.mjs";
import {V24_ADAPTER_VERSION,v24EntryGate} from "./v24-entry-adapter.mjs";
import {BOO_ADAPTER_VERSION,ENFORCEMENT as BOO_ENFORCEMENT,evaluateBooEntry,finalizeBooEntry,loadBooGateContext,openRiskSummary,recordBooVerdict} from "./boo-entry-adapter.mjs";
import {R1_VERSION} from "../_shared/boo/r1-strategy.mjs";
import {RISK_POLICY_VERSION} from "../_shared/boo/risk-policy.mjs";
import {RISK_BUDGET_VERSION} from "../_shared/boo/risk-budget.mjs";
import {SLOT_SIZING_CONTRACT,assertSlotSizingContract,floorStep,planSlotEntry,slotSizingBounds} from "../_shared/leader-slot-sizing.mjs";
import {SETUP_POLICY,SETUP_POLICY_VERSION,SETUP_REASON,SETUP_STATE,advancePullbackSetup,deserializeSetup,enterPullbackSetup,entryTriggerFresh,expirePullbackSetup,isTerminal as setupIsTerminal,serializeSetup,setupIdentity,startPullbackSetup} from "../_shared/leader-pullback-reaccel.mjs";
import {B06133_VERSION,evaluateB06133,fetchB06133Inputs} from "../_shared/leader-b06133-entry.mjs";
import {V30_FRONT_LIVE_VERSION,v30FrontDecision,entryBranchOf,baselineAllowedV30} from "../_shared/gpt-final-review/contract.mjs";
import {CEC0040_CONFIG,CEC0040_TARGET_VERSION,CEC0040_VERSION,P142_POLICY_VERSION,
  advanceP142Completed,nextExitP142,p142Mean44Target} from "../_shared/leader-cec0040.mjs";
const REVISION="V11-LONG-REGIME-1.0.1",PATCH="FD1-GPT-FINAL-RECHECK-1",OBSERVER_REVISION="MARKET-REGIME-OBSERVER-v2-C01-HYSTERESIS-v1-FULLMARKET",PROTOCOL="8.0.0-P10-DONCHIAN-SLOW4R";
const X1_POLICY_VERSION="X1_FAST_OBSERVATION_OVERRIDE_1",OPERATOR_OVERRIDE=Object.freeze({
  id:"2026-09-13-USER-PRIORITY-OVERRIDE",basis:"OPERATOR_OVERRIDE_UNVALIDATED",
  priorPerformanceVerdict:"DEFER",parametersValidatedByBacktest:false
});
// Bounded so a bar of refusals cannot stretch the run past the one-minute cadence.
const ENTRY_ATTEMPTS_PER_RUN=3;
// Wall-clock companion to the attempt count. A deferred candidate no longer ends the
// run (see runEntryQueue), so the attempt count alone no longer bounds it: an E1
// fast-weak watch can wait up to E1_POLICY.watchMs per attempt. Stop STARTING new
// attempts past this point; an attempt already running is never cut short.
const ENTRY_RUN_BUDGET_MS=40000;
// A soft defer hands the claim back. Whether it should also END THE RUN depends on
// WHOSE answer it was. An account-wide shortfall -- no free cash, the portfolio moved
// under us -- means no other candidate will do better this cycle, so stopping is
// right. A symbol's own tape, book, bars or gate verdict says nothing about the next
// candidate, and treating those as account-wide is what starved the queue: between
// 2026-09-16 23:09 and 2026-09-17 13:05 the first candidate of nearly every cycle
// deferred on E1_QUOTE_UNKNOWN, ended the run there, and left every other candidate
// untouched until it aged out of POLICY.maxEntryAgeMs -- 102 of 144 rejections.
// An UNLABELLED release still stops the run, so this is opt-in and fail-closed.
const RELEASE_SCOPE=Object.freeze({SYMBOL:"SYMBOL",ACCOUNT:"ACCOUNT"});
function releaseStopsRun(entry){return entry?.releaseScope!==RELEASE_SCOPE.SYMBOL}
// ENTRY_CONTROL carries its own scope; only symbol quarantine is per-symbol.
function controlReleaseScope(decision){
  return decision?.scope===CONTROL_SCOPE.SYMBOL_QUARANTINE?RELEASE_SCOPE.SYMBOL:RELEASE_SCOPE.ACCOUNT;
}
// Pre-dispatch refusals scoped to one symbol. Never includes STOP_POLICY_INVALID or
// STOP_INVALID, which are raised only AFTER a fill -- those are caught by the
// dispatched guard regardless, which is the check that actually protects the account.
// MIN_NOTIONAL_EXCEEDS_MARGIN_BUDGET / QTY_STEP_EXCEEDS_MARGIN_BUDGET /
// QTY_STEP_BELOW_SLOT_FLOOR / IOC_PRICE_CAP_EXCEEDED are the sizing contract's
// reasons: each is a property of ONE symbol's price and lot step, so none of them
// says anything about the next candidate in the queue. ENTRY_GRANULARITY_BPS and ENTRY_SLOT_GRANULARITY_MARGIN
// are kept so rows written by earlier revisions still classify the same way.
const ENTRY_SKIP_SYMBOL_SCOPED=/^(SIGNAL_STALE_OR_FUTURE|SUPERSEDED_BY_FRESHER_SIGNAL|V17_SETUP_BUDGET_EXHAUSTED|V17_TRIGGER_STALE|V17_TRIGGER_FUTURE|V17_SETUP_NOT_TRIGGERED|V17_SETUP_EXPIRED|V17_CHASE_EXPIRED|V17_ENTRY_DRIFT|V17_SETUP_INVALID_PRICE|V17_SETUP_POLICY_SLOT_LIMIT|B06133_REJECT|B06133_INPUT_UNKNOWN|V30_FRONT_REJECT|V30_SELECTION_INVALID|B06133_MARKET_UNAVAILABLE|B06133_SELECTION_INVALID|CEC0040_SELECTION_INVALID|ENTRY_DRIFT|WRONG_STRATEGY|INVALID_PRICE|V17_EXIT_POLICY_INVALID|MANUAL_SYMBOL_LOCKED|ENTRY_SPREAD|ENTRY_FEATURES_INVALID|QTY_INVALID|QTY_INPUT_INVALID|MIN_NOTIONAL_EXCEEDS_MARGIN_BUDGET|QTY_STEP_EXCEEDS_MARGIN_BUDGET|QTY_STEP_BELOW_SLOT_FLOOR|IOC_PRICE_CAP_EXCEEDED|ENTRY_GRANULARITY_BPS|ENTRY_SLOT_GRANULARITY_MARGIN|ENTRY_NOTIONAL_UNDERSIZED|V17_LIMIT_PRICE_MARGIN_OVERFLOW)/;
// Slot geometry is NOT declared here. MARGIN/LEV/NOTIONAL are views onto the one
// sizing contract (_shared/leader-slot-sizing.mjs) that the signal generator and
// the V17 policy also read, so the four copies that drifted apart during the
// 40 -> 30 cutover can no longer disagree. The DB half of the agreement stays a
// runtime fail-closed check: V17_MARGIN_CONFIG_MISMATCH.
const MARGIN=SLOT_SIZING_CONTRACT.targetMarginUsdt,LEV=SLOT_SIZING_CONTRACT.leverage,NOTIONAL=MARGIN*LEV;
const SLOT_BOUNDS=slotSizingBounds(SLOT_SIZING_CONTRACT),MAX_ORDER_MARGIN_USDT=SLOT_BOUNDS.maxOrderMarginUsdt;
// The price cap stays visible here because the E1 guard re-checks it; the base
// uplift is applied inside the contract and is not restated.
const IOC_MAX_BPS=SLOT_SIZING_CONTRACT.iocMaxBps;
const MAX_SLOTS=10,ENTRY_CASH_BUFFER_USDT=.10,SPREAD_MAX=25,MAX_GAP_ATR=.5,BULL_MAX_MS=30*86400000,T1_PRICE=.075,PARTIAL=.30,TRAIL=.0225,SNAP_MAX=90000;
// A leader signal no longer buys on sight; it arms a setup that watches for a
// pullback and a re-acceleration for up to SETUP_POLICY.setupTtlMs. The queue must
// therefore keep looking at a signal for that long, so the candidate window is the
// setup window plus one 5m bar of slack -- NOT an extension of the signal's
// EXECUTION lifetime, which is now the 60-second trigger TTL and is stricter than
// the 120 seconds V17 ran with.
const SIGNAL_MAX=SETUP_POLICY.setupTtlMs+300000;
// Fixed operator cutover, recorded so a position's entry timing can be reconstructed
// from its stamp alone. No env var or request can move it.
const SETUP_LIVE_CUTOVER=Date.parse("2026-09-17T00:00:00.000Z");
// Policy-scoped admission limit for the new entry timing, applied ONLY to positions
// carrying this policy's stamp. It is deliberately separate from MAX_SLOTS: the
// account-wide risk limit is the operator's, and this change does not touch it.
const SETUP_MAX_CONCURRENT=4;
// Each setup advance is one klines read. Bounding the pass on the wall clock keeps a
// full queue of watched setups from eating the run budget the entry attempts need.
const SETUP_ADVANCE_BUDGET_MS=12000;
function res(s,b){return new Response(JSON.stringify(b),{status:s,headers:{"content-type":"application/json","cache-control":"no-store"}})}function N(v,d=0){const x=Number(v);return Number.isFinite(x)?x:d}function rec(v){return v&&typeof v==="object"&&!Array.isArray(v)?v:{}}function eq(a,b){if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0}// Quantity rounding lives in the sizing contract now, so there is exactly one
// implementation of it; floorStep is what the exit path still needs directly.
// addStep is gone with the one-step bump it existed for: quantity is solved, not nudged.
function cid(p,x){return`tb-${p}-${String(x).toLowerCase().replace(/[^a-z0-9]/g,"").slice(0,24)}`.slice(0,36)}function terminal(z){return z.qty<=0&&["CANCELED","CANCELLED","REJECTED","EXPIRED","PARTIALLY_FILLED_CANCELED"].includes(z.status)}
const env=n=>(Deno.env.get(n)||"").trim(),GW=env("BINANCE_FUTURES_ORDER_GATEWAY_URL").replace(/\/$/,"")||env("BINANCE_ORDER_GATEWAY_URL").replace(/\/$/,"")||env("ORDER_GATEWAY_URL").replace(/\/$/,""),SEC=env("BINANCE_FUTURES_GATEWAY_SHARED_SECRET")||env("BINANCE_GATEWAY_SHARED_SECRET")||env("GATEWAY_SHARED_SECRET");
// This patch is the user's explicit operator override, so its two policies activate with
// the deployed bundle. Exact "false" values are independent emergency rollback kills and
// every preflight/run response reports their effective state.
const E1_ENABLED=env("V23_E1_ENTRY_OVERRIDE")!=="false",X1_ENABLED=env("V23_X1_FAST_OBSERVATION")!=="false";
// Exchange-resident protective stop. Default OFF: enabling it starts submitting real
// STOP_MARKET orders, so it is a deliberate operator action, not a deploy side effect.
const NATIVE_STOP_ENABLED=env("V17_NATIVE_STOP")==="true";
async function hmac(s,m){const k=await crypto.subtle.importKey("raw",new TextEncoder().encode(s),{name:"HMAC",hash:"SHA-256"},false,["sign"]),g=await crypto.subtle.sign("HMAC",k,new TextEncoder().encode(m));return[...new Uint8Array(g)].map(x=>x.toString(16).padStart(2,"0")).join("")}
async function gateway(cmd,tm=20000){if(!GW||!SEC)throw new Error("GATEWAY_CONFIG");const x=["create_order","v17_create_stop","v17_cancel_stop"].includes(cmd.action)?{...cmd,engine_version:PROTOCOL}:cmd,raw=JSON.stringify({exchange:"binance_futures",...x}),ts=String(Date.now()),nonce=crypto.randomUUID(),sig=await hmac(SEC,`${ts}\n${nonce}\n${raw}`),c=new AbortController,t=setTimeout(()=>c.abort(),tm);try{const r=await fetch(`${GW}/v1/command`,{method:"POST",signal:c.signal,headers:{"content-type":"application/json","x-gateway-ts":ts,"x-gateway-nonce":nonce,"x-gateway-signature":sig},body:raw}),txt=await r.text();let d;try{d=txt?JSON.parse(txt):null}catch{d={raw:txt}}if(!r.ok||!d?.ok)throw new Error(`GW_${r.status}:${d?.error||txt}`);return d.result}finally{clearTimeout(t)}}
function fill(p){const o=p?.order??p??{},f=p?.fill??{},q=Math.max(0,N(f.executedVolume??f.executed_quantity??o.executed_volume??o.executedQty)),a=Math.max(0,N(f.averagePrice??f.average_price??o.average_price??o.avgPrice));return{status:String(o?.status??p?.status??"UNKNOWN").toUpperCase(),exchangeOrderId:o?.exchange_order_id==null?o?.orderId==null?null:String(o.orderId):String(o.exchange_order_id),qty:q,avg:a,fee:Math.max(0,N(f.paidFeeQuote??f.paidFee??o.paid_fee??o.commission)),raw:p}}
function active(p){return(Array.isArray(p?.positions)?p.positions:[]).filter(x=>Math.abs(N(x?.quantity??x?.positionAmt??x?.position_amount))>1e-12)}function sym(p){return String(p?.market??p?.symbol??"").toUpperCase()}function qty(p){return Math.abs(N(p?.quantity??p?.positionAmt??p?.position_amount))}
async function auth(db,req){const p=(req.headers.get("x-v10-executor-token")||"").trim();const t=await db.from("edge_internal_tokens").select("token").eq("name","v10-lane-executor").maybeSingle();return!t.error&&p&&t.data?.token&&eq(p,String(t.data.token))}
function route(v){const x=String(v||"").toUpperCase();return x==="RISK_OFF"?"BEAR":x==="NEUTRAL"?"RANGE":x==="BULL"||x==="STRONG_BULL"?"BULL":"CASH"}
async function market(db){const o=await db.from("market_regime_observations").select("id,observed_at,predicted_regime,bull_score,confidence").eq("model_revision",OBSERVER_REVISION).eq("trading_influence",true).order("observed_at",{ascending:false}).limit(1).maybeSingle();if(o.error)throw new Error(`OBSERVER:${o.error.message}`);const age=o.data?Date.now()-Date.parse(o.data.observed_at):Infinity;return{route:age<=12*60000?route(o.data?.predicted_regime):"CASH",ageMs:age,observer:o.data||null}}
async function snap(db){const s=await db.from("trading_account_snapshots").select("captured_at,available_quote,positions,positions_complete").eq("exchange","binance_futures").order("captured_at",{ascending:false}).limit(1).maybeSingle();if(s.error||!s.data)throw new Error("SNAPSHOT_MISSING");const age=Date.now()-Date.parse(s.data.captured_at);if(s.data.positions_complete!==true||!Number.isFinite(age)||age<0||age>SNAP_MAX)throw new Error(`SNAPSHOT_INVALID:${age}`);return{...s.data,ageMs:age}}
async function incident(db,{reason,kind="UNKNOWN_ORDER_OUTCOME",controlScope=CONTROL_SCOPE.ACCOUNT_RISK_BLOCK,
  symbol=null,state={},evidence={}}){
  await verifyExecutionLease(db);
  const r=await db.rpc("v19_record_incident",{p_owner:leaseOwners.get(db),p_kind:kind,
    p_reason:String(reason).slice(0,500),p_control_scope:controlScope,p_symbol:symbol,
    p_state:state,p_evidence:evidence,p_evidence_version:ENTRY_CONTROL_VERSION});
  if(r.error)throw Error(`INCIDENT_WRITE:${r.error.message}`);
  return r.data;
}
async function circuit(db,reason,kind="UNKNOWN_ORDER_OUTCOME",evidence={}){
  const hold=["KNOWN_ORDER_PENDING_RECONCILIATION","INCOMPLETE_OR_STALE_SNAPSHOT","TRANSIENT_DEPENDENCY","DB_CAS_CONFLICT"].includes(kind);
  return incident(db,{reason,kind,controlScope:hold?CONTROL_SCOPE.ACCOUNT_ENTRY_HOLD:CONTROL_SCOPE.ACCOUNT_RISK_BLOCK,
    state:{exposureState:"UNKNOWN",accountingState:"ATTRIBUTION_INVESTIGATING",orderSource:evidence?.orderId?"BOT":"UNKNOWN",
      recheck:["QUERY_SAME_ORDER_IDENTITY","FRESH_COMPLETE_ACCOUNT_SNAPSHOT","FRESH_COMPLETE_OPEN_ORDERS"]},evidence});
}
// V24 entry gate. Reads its own operator control row every cycle so enabling/disabling and
// the edge assumption are auditable DB state, not a code constant or a hidden env var.
// Defaults are OFF with no edge, and a read failure disables the gate rather than leaving
// it enabled on stale state.
async function v24Control(db){
  const r=await db.from("v24_operator_control").select("*").eq("singleton",true).maybeSingle();
  if(r.error||!r.data)return{enabled:false,edge:null,reason:"V24_CONTROL_UNREADABLE"};
  const bps=Number(r.data.assumed_edge_bps),samples=Number(r.data.edge_samples);
  const edge=Number.isFinite(bps)&&Number.isFinite(samples)&&samples>0
    ?{expectedEdgeBps:bps,samples,basis:"OPERATOR_ASSUMED_UNVALIDATED",
      setReason:r.data.set_reason??null,setBy:r.data.set_by??null}:null;
  return{enabled:r.data.entry_enabled===true,edge,reason:null};
}
// Never lets a logging failure block or allow a trade.
async function recordV24(db,signalId,symbol,d){
  try{
    await db.from("v24_entry_decisions").insert({signal_id:signalId,symbol,
      decision:d.decision,reason:d.reason,reason_codes:d.reasonCodes??[],setup_type:d.setupType??null,
      trigger_level:d.triggerLevel??null,setup_low:d.setupLow??null,initial_stop:d.initialStop??null,
      cost_bps:d.costBps??null,net_edge_bps:d.netEdgeBps??null,
      buy_share_60s:d.buyShare60s??null,buy_share_180s:d.buyShare180s??null,
      imbalance_25:d.imbalance25??null,spread_bps:d.spreadBps??null,
      edge_basis:d.edgeBasis??null,adapter_version:V24_ADAPTER_VERSION,
      policy_version:d.version??"V24_UNKNOWN",evidence:d});
  }catch{/* decision logging is best-effort; it must not affect the trade path */}
}
async function audit(db,p,b,a,action,reason,details={}){await db.from("v11_long_regime_decisions").insert({revision:REVISION,position_id:p?.id||null,observed_regime:details.marketRoute||null,active_lane_before:b||null,active_lane_after:a||null,action,reason,details:{...details,executorPatch:PATCH}})}
async function manualPositionAllowances(db){
  const r=await db.from("trading_asset_locks").select("exchange,asset,state,metadata")
    .eq("exchange","binance_futures").eq("state","LOCKED");
  if(r.error)throw new Error(`MANUAL_POSITION_ALLOWLIST:${r.error.message}`);
  return (r.data||[]).filter(x=>rec(x.metadata).v17ManualPosition===true).map(x=>({
    symbol:`${String(x.asset||"").toUpperCase()}USDT`,
    side:String(rec(x.metadata).side||"").toUpperCase(),
    maxQuantity:N(rec(x.metadata).maxQuantity,Number.NaN)
  }));
}
function portfolioMatches(openPositions,pf,manual=[]){
  if(!pf||!Array.isArray(pf.positions)||pf.positions_complete===false)
    return {ok:false,reason:"INCOMPLETE_PORTFOLIO",ext:[]};
  const botSymbols=new Set(openPositions.map(p=>String(p.symbol||"").toUpperCase()));
  const remaining=[];
  for(const x of pf.positions){
    const symbol=sym(x),rawSide=String(x?.position_side??x?.positionSide??x?.side??"").toUpperCase();
    const signed=N(x?.positionAmt??x?.position_amount,Number.NaN),side=rawSide==="LONG"||rawSide==="SHORT"?rawSide:Number.isFinite(signed)&&signed!==0?(signed>0?"LONG":"SHORT"):"";
    const amount=qty(x),allow=manual.find(a=>a.symbol===symbol);
    if(!allow){remaining.push(x);continue;}
    if(botSymbols.has(symbol))return {ok:false,reason:`MANUAL_SYMBOL_CONFLICT:${symbol}`,ext:pf.positions};
    if(!side||side!==allow.side||!Number.isFinite(allow.maxQuantity)||allow.maxQuantity<=0||amount>allow.maxQuantity+Math.max(1e-10,allow.maxQuantity*1e-8))
      return {ok:false,reason:`MANUAL_POSITION_DRIFT:${symbol}`,ext:pf.positions};
  }
  return leaderPortfolioMatches(openPositions,{...pf,positions:remaining});
}
/** The exchange's real filters, read from the venue's own symbol info. */
function symbolFilters(info){return{quantityStep:N(info?.quantity_step??info?.step_size),
  priceTick:N(info?.price_tick??info?.tick_size),
  minNotionalUsdt:Math.max(1,N(info?.min_notional,5)),
  minQuantity:N(info?.min_quantity)}}
/**
 * One decision, not two: the quantity is solved against the very limit price the
 * order will carry. Previously quantity was ceiled to the target notional and the
 * remaining shortfall to a fixed 0.12 USDT buffer was bought with PRICE, which at a
 * 90 USDT notional demanded up to 13.33 bps against a 12 bps cap and refused
 * ordinary candidates by arithmetic. Price no longer funds sizing at all.
 *
 * `sizedMargin` is the margin the order needs if every lot fills at its own limit --
 * the worst case, and the figure every downstream budget check should see.
 */
function sizeEntry(ask,step,filters={}){
  const plan=planSlotEntry({ask,quantityStep:step,priceTick:N(filters.priceTick,0),
    minNotionalUsdt:N(filters.minNotionalUsdt,0),minQuantity:N(filters.minQuantity,0)});
  return{...plan,amount:plan.quantity,sizedNotional:plan.referenceNotionalUsdt,
    sizedMargin:plan.orderMarginUsdt};
}
// --- V17 pullback / re-acceleration setup lifecycle -------------------------
//
// The setup lives on the SIGNAL row, in features.v17Setup. That keeps it durable
// across restarts and shared between concurrent executors without a new table, and
// it keeps the whole lifecycle idempotent: the state machine refuses a candle it has
// already consumed, so a retried cycle cannot deepen a low or fire a second trigger.
//
// Nothing here creates an order intent. A setup that never triggers costs the
// account nothing and leaves no order lifecycle behind.
function signalSetup(row){
  return deserializeSetup(rec(rec(row?.features).v17Setup));
}
function setupGoverns(row){
  const close=N(rec(row?.features).signal5Close,NaN);
  return Number.isSafeInteger(SETUP_LIVE_CUTOVER)&&Number.isSafeInteger(close)&&close>=SETUP_LIVE_CUTOVER;
}
async function persistSetup(db,row,state,reason){
  const features={...rec(row.features),v17Setup:serializeSetup(state)};
  const patch={features,updated_at:new Date().toISOString()};
  if(setupIsTerminal(state)){patch.status="REJECTED";patch.reject_reason=String(state.terminalReason??reason).slice(0,500);}
  const w=await db.from("v11_long_regime_signals").update(patch).eq("id",row.id).eq("status","NEW");
  if(w.error)throw Error(`SETUP_WRITE:${w.error.message}`);
  return {...row,features,status:patch.status??row.status};
}
/**
 * Advance one signal's setup by every completed 1m candle it has not seen yet.
 * Returns the state; the caller decides whether it is executable.
 */
async function advanceSignalSetup(db,row,now,fetchCandles=qv3Candles){
  let state=signalSetup(row),justArmed=false;
  if(state&&setupIsTerminal(state))return {row,state,changed:false};
  if(!state){
    // Armed at the signal's OWN 5m close, not at wall-clock now. The observation
    // window is a property of the bar, so a row the executor happens to look at late
    // -- a backlog, a restart, the first cycle after this policy goes live -- must not
    // be handed a fresh 15 minutes. Arming at `now` would do exactly that, and a
    // 15-minute window measured from an old bar is the stale-signal extension this
    // policy is specifically not allowed to be.
    const armAt=N(rec(row.features).signal5Close,NaN);
    if(!Number.isSafeInteger(armAt))return {row,state:null,changed:false,reason:SETUP_REASON.INVALID_PRICE};
    const armed=startPullbackSetup({id:row.id,symbol:row.symbol,features:rec(row.features)},armAt,SETUP_POLICY);
    if(!armed.ok)return {row,state:null,changed:false,reason:armed.reason};
    state=armed.state;justArmed=true;
    await audit(db,null,"BULL","BULL","ENTRY_DEFER",SETUP_REASON.ARMED,
      {signalId:row.id,symbol:row.symbol,setup:{policyVersion:SETUP_POLICY_VERSION,
        identity:state.identity,referencePrice:state.referencePrice,expiresAt:state.expiresAt}});
    // Deliberately NOT a return. Arming used to end the cycle here, which cost a
    // whole minute before the first candle was ever read -- and the bar a setup is
    // armed FROM is already complete, so a setup whose pullback and re-acceleration
    // both sit on that bar triggered at armedAt + 60s and was only discovered on the
    // next cycle, by which time its 60-second trigger window had closed. Production,
    // 2026-09-18 UTC: GUSDT 08:20, UNIUSDT 03:15, OPUSDT 03:20, DRIFTUSDT 06:00 and
    // BABYUSDT 00:25 were all armed and then rejected V17_TRIGGER_STALE on a trigger
    // that was live at the moment they armed. Arming and reading the tape are one
    // cycle's work; nothing below is reached any earlier than the bar allows, because
    // completedCandle still refuses anything that has not closed.
  }
  if(now>state.expiresAt){
    const done=expirePullbackSetup(state,now);
    return {row:await persistSetup(db,row,done.state,done.reason),state:done.state,changed:true};
  }
  // Only completed candles, and only the ones after the last one consumed.
  const from=state.lastCandleOpenTime===null?state.armedAt:state.lastCandleOpenTime+60000;
  const start=Math.floor(from/60000)*60000-60000;
  let bars;
  const keep=async(reason)=>({row:justArmed?await persistSetup(db,row,state,SETUP_REASON.ARMED):row,
    state,changed:justArmed,reason});
  try{bars=await fetchCandles(row.symbol,now,start);}
  catch(e){return await keep(`V17_SETUP_MARKET:${String(e?.message??e)}`);}
  if(!Array.isArray(bars))return await keep("V17_SETUP_MARKET_INVALID");
  const sorted=[...bars].filter(Array.isArray).sort((a,b)=>Number(a[0])-Number(b[0]));
  let changed=false,lastReason=SETUP_REASON.HOLD;
  for(let i=0;i<sorted.length;i++){
    const out=advancePullbackSetup(state,sorted[i],i>0?sorted[i-1]:null,now,SETUP_POLICY);
    state=out.state;lastReason=out.reason;changed=changed||out.changed;
    if(setupIsTerminal(state)||state.state===SETUP_STATE.TRIGGERED)break;
  }
  if(!changed&&!justArmed)return {row,state,changed:false,reason:lastReason};
  if(state.state===SETUP_STATE.TRIGGERED||setupIsTerminal(state)){
    await audit(db,null,"BULL","BULL","ENTRY_DEFER",
      lastReason,{signalId:row.id,symbol:row.symbol,stage:"SETUP_TRANSITION",finalAdmission:false,orderDispatched:false,setup:{policyVersion:SETUP_POLICY_VERSION,
        state:state.state,identity:state.identity,referencePrice:state.referencePrice,
        pullbackLow:state.pullbackLow,triggerAt:state.triggerAt,triggerClose:state.triggerClose}});
  }
  return {row:await persistSetup(db,row,state,justArmed&&!changed?SETUP_REASON.ARMED:lastReason),
    state,changed:true,reason:justArmed&&!changed?SETUP_REASON.ARMED:lastReason};
}
/**
 * Apply B06133 to an already-triggered candidate.  The trigger timestamp, not the
 * executor wall clock, is the market-data cutoff.  This keeps live evaluation on
 * the same information set as the frozen research replay and makes a delayed or
 * retried cycle incapable of reading a later candle.
 */
async function applyB06133Selection(db,row,state){
  const decisionAt=Number(state?.triggerAt),evaluatedAt=Date.now();
  let stamp;
  try{
    const input=await fetchB06133Inputs(row.symbol,decisionAt);
    stamp={...evaluateB06133({features:rec(row.features),...input,decisionAt}),evaluatedAt};
  }catch(error){
    stamp={version:B06133_VERSION,result:null,allowed:false,branch:null,r62:null,rescue:null,
      reason:"B06133_MARKET_UNAVAILABLE",evaluatedAt,
      source:{decisionAt,featureValues:{volumeRatio:rec(row.features).volumeRatio??null,
        return5m:rec(row.features).return5m??null,return15m:rec(row.features).return15m??null,
        return30m:rec(row.features).return30m??null,return60m:rec(row.features).return60m??null},
        prebars:null,btc:{known:false,return30m:null,return2h:null,freshnessMs:null},btcBars:null},
      error:String(error?.message??error).slice(0,300)};
  }
  // V30 (operator decision 2026-09-24): B06133 is recorded exactly as evaluated and kept
  // as reference evidence; admission is the V30 score gate on those same factors.
  const v30=v30FrontDecision(stamp,V30_FRONT_LIVE_VERSION),admitted=v30.admitted===true;
  const features={...rec(row.features),b06133:stamp,v30Front:v30};
  const patch={features,updated_at:new Date(evaluatedAt).toISOString()};
  if(!admitted){patch.status="REJECTED";patch.reject_reason=stamp.result===null?stamp.reason:
    `V30_FRONT_REJECT:${[...v30.failed,...v30.unknown].join("+")||"UNKNOWN"}`;}
  const write=await db.from("v11_long_regime_signals").update(patch).eq("id",row.id).eq("status","NEW").select("*").maybeSingle();
  if(write.error)throw Error(`B06133_WRITE:${write.error.message}`);
  if(!write.data)return {allowed:false,row,stamp:{...stamp,reason:"B06133_CAS_RACE"}};
  const reason=admitted?"V30_FRONT_ADMIT":patch.reject_reason;
  await audit(db,null,"BULL","BULL",admitted?"ENTRY_ALLOW":"ENTRY_REJECT",reason,
    {signalId:row.id,symbol:row.symbol,stage:"V30_ENTRY_SELECTION",finalAdmission:false,
      orderDispatched:false,b06133:stamp,v30Front:v30});
  return {allowed:admitted,row:write.data,stamp:{...stamp,reason}};
}

/**
 * Atomic causal decision. Postgres serializes EWMA/reject-run updates and refuses a
 * decision while any older admitted target lacks completed-candle coverage through
 * this signal's cutoff. Shadow mode records the model action but preserves B06133.
 */
async function applyCec0040Selection(db,row,state){
  const b06133=rec(rec(row.features).b06133),decisionAt=Number(state?.triggerAt),branch=entryBranchOf(rec(row.features));
  if(b06133.version!==B06133_VERSION||!branch||Number(b06133.source?.decisionAt)!==decisionAt||!Number.isSafeInteger(decisionAt))
    throw Error("CEC0040_INPUT_INVALID");
  await verifyExecutionLease(db);
  const r=await db.rpc("v11_cec0040_decide",{p_signal_id:row.id,
    p_decision_at:new Date(decisionAt).toISOString(),p_symbol:String(row.symbol).toUpperCase(),
    p_branch:branch,p_bootstrap:false});
  if(r.error)throw Error(`CEC0040_DECISION:${r.error.message}`);
  const d=rec(r.data),evaluatedAt=Date.now(),stamp={version:CEC0040_VERSION,targetVersion:CEC0040_TARGET_VERSION,
    ready:d.ready===true,action:d.action??null,modelAllowed:d.modelAllowed===true,
    effectiveAllowed:d.effectiveAllowed===true,enforcementEnabled:d.enforcementEnabled===true,
    predictionUsdt:d.predictionUsdt??null,trainingCount:d.trainingCount??null,
    rejectRunBefore:d.rejectRunBefore??null,rejectRunAfter:d.rejectRunAfter??null,
    decisionAt,evaluatedAt,idempotent:d.idempotent===true,
    reason:d.ready!==true?String(d.reason??"CEC0040_STATE_NOT_READY"):
      d.effectiveAllowed===true?d.enforcementEnabled===true?`CEC0040_${d.action}`:`CEC0040_SHADOW_${d.action}`:"CEC0040_REJECT"};
  const features={...rec(row.features),cec0040:stamp},patch={features,updated_at:new Date(evaluatedAt).toISOString()};
  // CEC0040 is advisory evidence for GPT, not a hard admission gate.
  // Keep the exact causal stamp (including REJECT) without terminating the signal.
  // A not-ready CEC state still defers because its evidence is incomplete.
  const write=await db.from("v11_long_regime_signals").update(patch).eq("id",row.id).eq("status","NEW").select("*").maybeSingle();
  if(write.error)throw Error(`CEC0040_WRITE:${write.error.message}`);
  if(!write.data)return {allowed:false,row,stamp:{...stamp,reason:"CEC0040_CAS_RACE"}};
  await audit(db,null,"BULL","BULL",stamp.effectiveAllowed?"ENTRY_ALLOW":"ENTRY_REJECT",stamp.reason,
    {signalId:row.id,symbol:row.symbol,stage:"CEC0040_ENTRY_CONTROL",finalAdmission:false,
      orderDispatched:false,cec0040:stamp});
  return {allowed:stamp.ready,row:write.data,stamp};
}

async function registerCec0040Target(db,position,signal){
  const cec=rec(rec(signal.features).cec0040),branch=entryBranchOf(rec(signal.features));
  // Every ready CEC0040 decision that became a real position is tracked, whatever its
  // action: a CEC REJECT that GPT bought is exactly the outcome CEC must learn from.
  if(cec.version!==CEC0040_VERSION||cec.ready!==true||!["ADMIT","PROBE","REJECT"].includes(cec.action)||!branch)return null;
  await verifyExecutionLease(db);
  const r=await db.rpc("v11_cec0040_register_target",{p_position_id:position.id,p_signal_id:signal.id,
    p_symbol:String(position.symbol).toUpperCase(),p_branch:branch,p_entry_at:position.entry_at,
    p_actual_entry_price:Number(position.entry_price)});
  if(r.error)throw Error(`CEC0040_TARGET_REGISTER:${r.error.message}`);
  return r.data;
}

async function fetchCec0040Public(url,init={},fetchFn=fetch){
  const parsed=new URL(url),hosts=["fapi.binance.com","fapi1.binance.com","fapi2.binance.com"];
  if(parsed.protocol!=="https:"||!hosts.includes(parsed.hostname))throw Error("CEC0040_PUBLIC_HOST_INVALID");
  let last=null;
  for(let attempt=1;attempt<=hosts.length;attempt++){
    try{
      const candidate=new URL(parsed);candidate.hostname=hosts[attempt-1];
      const r=await fetchFn(candidate.toString(),{...init,signal:AbortSignal.timeout(10000)});
      if(r.ok||r.status<500&&r.status!==429)return r;
      last=Error(`CEC0040_PUBLIC_${candidate.hostname}_${r.status}`);
    }catch(error){last=error}
    if(attempt<hosts.length)await new Promise(resolve=>setTimeout(resolve,150*attempt));
  }
  throw last??Error("CEC0040_PUBLIC_UNAVAILABLE");
}

async function fetchCec0040Funding(symbol,start,end,fetchFn=fetchCec0040Public){
  if(!(Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&end>=start))throw Error("CEC0040_FUNDING_WINDOW");
  const p=new URLSearchParams({symbol,startTime:String(start),endTime:String(end),limit:"100"});
  const r=await fetchFn("https://fapi.binance.com/fapi/v1/fundingRate?"+p,{method:"GET"});
  if(!r.ok)throw Error(`CEC0040_FUNDING_${r.status}`);
  const rows=await r.json();if(!Array.isArray(rows)||rows.length>100)throw Error("CEC0040_FUNDING_INVALID");
  return rows.map(x=>({fundingTime:Number(x.fundingTime),fundingRate:Number(x.fundingRate),markPrice:Number(x.markPrice)}));
}

async function repairCec0040Targets(db){
  const q=await db.rpc("v11_cec0040_missing_targets");
  if(q.error)return {ok:false,reason:`CEC0040_TARGET_REPAIR_READ:${q.error.message}`,checked:0,results:[]};
  const rows=Array.isArray(q.data)?q.data:[],results=[];
  for(const row of rows){
    try{
      await verifyExecutionLease(db);
      const saved=await db.rpc("v11_cec0040_register_target",{p_position_id:row.position_id,
        p_signal_id:row.signal_id,p_symbol:row.symbol,p_branch:row.branch,p_entry_at:row.entry_at,
        p_actual_entry_price:Number(row.actual_entry_price)});
      if(saved.error)throw Error(saved.error.message);
      results.push({positionId:row.position_id,status:"REGISTERED"});
    }catch(error){results.push({positionId:row.position_id,status:"ERROR",reason:String(error?.message??error)})}
  }
  return {ok:results.every(x=>x.status==="REGISTERED"),checked:rows.length,results};
}

/** Resolve at most four target shadows per cycle; no authenticated exchange call. */
async function refreshCec0040Targets(db){
  const repair=await repairCec0040Targets(db);
  const q=await db.from("v11_cec0040_targets").select("*").eq("status","PENDING")
    .eq("policy_version",CEC0040_VERSION).order("entry_at",{ascending:true}).limit(4);
  if(q.error)return {ok:false,reason:`CEC0040_TARGET_READ:${q.error.message}`,repair,checked:0,results:[]};
  const rows=q.data||[],results=await boundedMap(rows,2,async target=>{
    const now=Date.now(),entryAt=Date.parse(target.entry_at),start=Math.floor(entryAt/60000)*60000,
      through=Math.floor(now/60000)*60000-1;
    if(through<start)return {positionId:target.position_id,status:"PENDING",reason:"NO_COMPLETED_CANDLE"};
    try{
      const bars=await qv3Candles(target.symbol,now,start,fetchCec0040Public);
      let out=p142Mean44Target({entryAt,actualEntryPrice:Number(target.actual_entry_price),
        branch:target.branch,bars,fundingEvents:[]});
      if(out.status==="RESOLVED"){
        const funding=await fetchCec0040Funding(target.symbol,entryAt+1,out.targetExitAt);
        out=p142Mean44Target({entryAt,actualEntryPrice:Number(target.actual_entry_price),
          branch:target.branch,bars,fundingEvents:funding});
      }
      const status=out.status==="UNKNOWN_GAP"?"ERROR":out.status;
      await verifyExecutionLease(db);
      const saved=await db.rpc("v11_cec0040_observe_target",{p_position_id:target.position_id,p_status:status,
        p_observed_through:new Date(through).toISOString(),p_target_exit_at:out.status==="RESOLVED"?new Date(out.targetExitAt).toISOString():null,
        p_target_net_usdt:out.status==="RESOLVED"?out.targetNetUsdt:null,
        p_replay:{version:out.version,style:out.style,status:out.status,pathNets:out.pathNets??null,
          outcomes:out.outcomes?.map(x=>({status:x.status,exitAt:x.exitAt??null,netBeforeFunding:x.netBeforeFunding??null,reason:x.reason??null}))??null}});
      if(saved.error)throw Error(`CEC0040_TARGET_WRITE:${saved.error.message}`);
      return {positionId:target.position_id,status,through,targetExitAt:out.targetExitAt??null,targetNetUsdt:out.targetNetUsdt??null};
    }catch(error){return {positionId:target.position_id,status:"UNAVAILABLE",reason:String(error?.message??error)}}
  });
  return {ok:repair.ok&&results.every(x=>x.status!=="UNAVAILABLE"&&x.status!=="ERROR"),repair,
    checked:rows.length,results};
}

/**
 * Replay only post-seed B06133 decisions that already exist in the production DB.
 * This writes controller/target ledgers, never signals, positions, orders or controls.
 * Existing positions retain their entry-time exit-policy stamp.
 */
async function bootstrapCec0040(db){
  await verifyExecutionLease(db);
  const stateRead=await db.from("v11_cec0040_state").select("*").eq("singleton",true).single();
  if(stateRead.error||!stateRead.data)throw Error("CEC0040_BOOTSTRAP_STATE_UNAVAILABLE");
  const state=stateRead.data;
  if(state.bootstrap_complete===true)return {ok:true,mode:"CEC0040_BOOTSTRAP",idempotent:true,
    processed:0,state};
  const cursor=Date.parse(state.last_decision_at??state.seeded_through),
    scanStart=new Date(Date.parse(state.seeded_through)-20*60000).toISOString(),signals=[];
  let scanTruncated=false;
  for(let page=0;page<10;page++){
    const signalsRead=await db.from("v11_long_regime_signals").select("id,symbol,status,features,entry_bar_at")
      .eq("revision",REVISION).gte("entry_bar_at",scanStart).order("entry_bar_at",{ascending:true})
      .order("id",{ascending:true}).range(page*1000,page*1000+999);
    if(signalsRead.error)throw Error(`CEC0040_BOOTSTRAP_SIGNALS:${signalsRead.error.message}`);
    signals.push(...(signalsRead.data??[]));
    if((signalsRead.data??[]).length<1000)break;
    if(page===9)scanTruncated=true;
  }
  const processedIds=new Set();
  for(let page=0;page<10;page++){
    const decisions=await db.from("v11_cec0040_decisions").select("signal_id")
      .gte("decision_at",state.seeded_through).order("decision_at",{ascending:true})
      .order("signal_id",{ascending:true}).range(page*1000,page*1000+999);
    if(decisions.error)throw Error(`CEC0040_BOOTSTRAP_DECISIONS:${decisions.error.message}`);
    for(const row of decisions.data??[])processedIds.add(row.signal_id);
    if((decisions.data??[]).length<1000)break;
    if(page===9)scanTruncated=true;
  }
  const candidates=signals.map(row=>({row,b:rec(rec(row.features).b06133)}))
    .filter(x=>x.b.version===B06133_VERSION&&x.b.allowed===true&&
      ["R62","BUYER_SHARE_RESCUE","BOTH"].includes(x.b.branch)&&
      Number.isSafeInteger(Number(x.b.source?.decisionAt))&&
      Number(x.b.source.decisionAt)>Date.parse(state.seeded_through)&&!processedIds.has(x.row.id))
    .sort((a,b)=>Number(a.b.source.decisionAt)-Number(b.b.source.decisionAt)||
      N(rec(a.row.features).rank,999)-N(rec(b.row.features).rank,999)||
      String(a.row.symbol).localeCompare(String(b.row.symbol))||String(a.row.id).localeCompare(String(b.row.id)));
  if(candidates.some(x=>Number(x.b.source.decisionAt)<cursor))throw Error("CEC0040_BOOTSTRAP_ORDER_GAP");
  const results=[];
  for(const item of candidates){
    await verifyExecutionLease(db);
    const decisionAt=Number(item.b.source.decisionAt),decided=await db.rpc("v11_cec0040_decide",{
      p_signal_id:item.row.id,p_decision_at:new Date(decisionAt).toISOString(),
      p_symbol:String(item.row.symbol).toUpperCase(),p_branch:item.b.branch,p_bootstrap:true});
    if(decided.error)throw Error(`CEC0040_BOOTSTRAP_DECISION:${decided.error.message}`);
    const decision=rec(decided.data);
    if(decision.ready!==true){
      const refresh=await refreshCec0040Targets(db);
      const retried=await db.rpc("v11_cec0040_decide",{p_signal_id:item.row.id,
        p_decision_at:new Date(decisionAt).toISOString(),p_symbol:String(item.row.symbol).toUpperCase(),
        p_branch:item.b.branch,p_bootstrap:true});
      if(retried.error||rec(retried.data).ready!==true){
        const refreshFailures=[...(refresh.results??[]),...(refresh.repair?.results??[])]
          .filter(x=>["UNAVAILABLE","ERROR"].includes(x.status))
          .map(x=>`${x.positionId??"UNKNOWN"}:${x.reason??x.status}`).join("|").slice(0,480);
        const reason=rec(retried.data).reason??retried.error?.message??"UNKNOWN";
        throw Error(`CEC0040_BOOTSTRAP_NOT_READY:${reason}${refreshFailures?`:REFRESH:${refreshFailures}`:
          refresh.reason?`:REFRESH:${refresh.reason}`:""}`);
      }
      Object.assign(decision,rec(retried.data),{refresh});
    }
    let target=null;
    if(decision.modelAllowed===true){
      const position=await db.from("v11_long_regime_positions").select("*").eq("signal_id",item.row.id).maybeSingle();
      if(position.error)throw Error(`CEC0040_BOOTSTRAP_POSITION:${position.error.message}`);
      if(position.data){
        target=await db.rpc("v11_cec0040_register_target",{p_position_id:position.data.id,
          p_signal_id:item.row.id,p_symbol:String(item.row.symbol).toUpperCase(),p_branch:item.b.branch,
          p_entry_at:position.data.entry_at,p_actual_entry_price:Number(position.data.entry_price)});
        if(target.error)throw Error(`CEC0040_BOOTSTRAP_TARGET:${target.error.message}`);
        await refreshCec0040Targets(db);
      }
    }
    results.push({signalId:item.row.id,symbol:item.row.symbol,decisionAt,action:decision.action,
      modelAllowed:decision.modelAllowed===true,targetRegistered:target!==null});
  }
  const targetRefresh=await refreshCec0040Targets(db);
  let completion=null;
  if(!scanTruncated&&targetRefresh.ok){
    completion=await db.rpc("v11_cec0040_complete_bootstrap",{
      p_expected_seeded_through:state.seeded_through,p_scanned_through:new Date().toISOString(),
      p_reason:"POST_SEED_B06133_DATABASE_REPLAY_COMPLETE"});
    if(completion.error)throw Error(`CEC0040_BOOTSTRAP_COMPLETE:${completion.error.message}`);
  }
  const after=await db.from("v11_cec0040_state").select("*").eq("singleton",true).single();
  if(after.error)throw Error(`CEC0040_BOOTSTRAP_STATE_VERIFY:${after.error.message}`);
  return {ok:true,mode:"CEC0040_BOOTSTRAP",processed:results.length,scanned:signals.length,scanTruncated,
    results,targetRefresh,completion:completion?.data??null,state:after.data};
}

async function cec0040RuntimeStatus(db){
  const [state,pending,resolved,applied,errors,missing]=await Promise.all([
    db.from("v11_cec0040_state").select("*").eq("singleton",true).maybeSingle(),
    db.from("v11_cec0040_targets").select("position_id",{count:"exact",head:true}).eq("status","PENDING"),
    db.from("v11_cec0040_targets").select("position_id",{count:"exact",head:true}).eq("status","RESOLVED"),
    db.from("v11_cec0040_targets").select("position_id",{count:"exact",head:true}).eq("status","APPLIED"),
    db.from("v11_cec0040_targets").select("position_id",{count:"exact",head:true}).eq("status","ERROR"),
    db.rpc("v11_cec0040_missing_targets")]);
  const failed=[state,pending,resolved,applied,errors,missing].find(x=>x.error);
  if(failed)return {available:false,version:CEC0040_VERSION,reason:String(failed.error.message)};
  const s=state.data;
  if(!s)return {available:false,version:CEC0040_VERSION,reason:"CEC0040_STATE_MISSING"};
  return {available:true,version:s.policy_version,targetVersion:s.target_version,
    p142PolicyVersion:P142_POLICY_VERSION,configHash:s.config_hash,
    identityValid:s.policy_version===CEC0040_VERSION&&s.target_version===CEC0040_TARGET_VERSION&&
      s.config_hash==="3b0ebe775334e24a020887532cec7b57d014a7a7383a06e217d0949b3113630f",
    mode:s.enforcement_enabled===true?"ENFORCED":"SHADOW",enforcementEnabled:s.enforcement_enabled===true,
    ewmaUsdt:s.ewma_usdt==null?null:Number(s.ewma_usdt),trainingCount:Number(s.training_count),
    rejectRun:Number(s.reject_run),seededThrough:s.seeded_through,lastDecisionAt:s.last_decision_at,
    bootstrapComplete:s.bootstrap_complete===true,bootstrapCompletedAt:s.bootstrap_completed_at??null,
    bootstrapScannedThrough:s.bootstrap_scanned_through??null,
    enforcementChangedAt:s.enforcement_changed_at??null,enforcementReason:s.enforcement_reason??null,
    targets:{pending:pending.count??0,resolved:resolved.count??0,applied:applied.count??0,
      error:errors.count??0,missing:(missing.data??[]).length}};
}
/**
 * Execution freshness for one entry attempt.
 *
 * Legacy signals keep the unchanged V17 rule: 120 seconds from the 5m close, and 1%
 * drift from the reference. A pullback-policy signal REPLACES the age half with the
 * trigger's own 60-second window -- it does not extend it, and 60 seconds is stricter
 * than the 120 the legacy path allows. The drift half is identical and is still
 * measured against the ORIGINAL signal reference, so a setup can never walk its own
 * chase ceiling upward by re-basing.
 */
function entryFreshFor(row,features,now,price){
  if(!setupGoverns(row))return entryFresh(rec(features),now,price);
  if(rec(features)?.strategy!==STRATEGY)return "WRONG_STRATEGY";
  const state=signalSetup(row);
  if(!state)return SETUP_REASON.NOT_TRIGGERED;
  const window=executionWindowFor(row);
  if(!window.valid)return window.reason;
  if(now<window.startsAt)return SETUP_REASON.TRIGGER_FUTURE;
  if(now>=window.expiresAt)return SETUP_REASON.TRIGGER_STALE;
  return entryTriggerFresh(state,now,price,POLICY.maxEntryDriftPct,SETUP_POLICY);
}
/** Positions opened under this entry timing, for the policy-scoped admission limit. */
function setupScopedOpen(positions){
  return (positions??[]).filter(p=>rec(p.metadata).entryTimingPolicyVersion===SETUP_POLICY_VERSION);
}
async function hashJson(value){const bytes=new TextEncoder().encode(JSON.stringify(value)),hash=new Uint8Array(await crypto.subtle.digest("SHA-256",bytes));return[...hash].map(x=>x.toString(16).padStart(2,"0")).join("")}
// --- BOO common entry gate (brief section 4) --------------------------------
// The identity the validation approval must match. BOO_POLICY_CODE_SHA256 is
// injected by the release workflow from the actual deployed file set; when it
// is absent the identity is incomplete and the gate refuses, which is the
// intended fail-closed behaviour rather than a soft default.
const BOO_POLICY_CODE_HASH=Deno.env.get("BOO_POLICY_CODE_SHA256")||"",
  BOO_COST_MODEL_VERSION=Deno.env.get("BOO_COST_MODEL_VERSION")||"",
  BOO_EXECUTION_MODEL_VERSION=Deno.env.get("BOO_EXECUTION_MODEL_VERSION")||"",
  BOO_DATASET_HASH=Deno.env.get("BOO_DATASET_SHA256")||"";
function booRunningIdentity(parameterHash){
  return{policyCodeHash:BOO_POLICY_CODE_HASH,parameterHash,datasetHash:BOO_DATASET_HASH,
    costModelVersion:BOO_COST_MODEL_VERSION,executionModelVersion:BOO_EXECUTION_MODEL_VERSION};
}
// Depth is mandatory for sizing: without a real book we cannot compute the VWAP
// the loss budget depends on, so an absent book is reported as unhealthy data
// rather than filled in from the top of book.
function booBook(q,maxAgeMs){return normalizeEntryBook(q,maxAgeMs,Date.now());}
function executionWindowFor(row){
  return entryExecutionWindow(row,setupGoverns(row),POLICY.maxEntryAgeMs,SETUP_POLICY);
}
function checkedEntryFresh(row,features,now,price,attempt,phase,quote=null){
  const reason=entryFreshFor(row,features,now,price);
  attempt.entryPriceCheck=entryPriceEvidence(row,price,now,phase,quote,
    executionWindowFor(row),POLICY.maxEntryDriftPct,reason);
  return reason;
}
function e1CurrentAssessment(s,q,step,at,filters={}){
  const bid=N(q?.best_bid),ask=N(q?.best_ask),spreadBps=bid>0&&ask>=bid?(ask/bid-1)*10000:Infinity;
  let sized=null,limitPrice=null,guardPassed=false,liquidityPassed=false,evidence=e1QuoteEvidence(q,0,at);
  try{
    sized=sizeEntry(ask,step,filters);evidence=e1QuoteEvidence(q,sized.amount,at);
    limitPrice=sized.limitPrice;
    guardPassed=!entryFreshFor(s,s.features,at,limitPrice)&&sized.iocBps<=IOC_MAX_BPS&&
      sized.orderMarginUsdt<=MAX_ORDER_MARGIN_USDT+1e-9;
    liquidityPassed=evidence.valid&&evidence.fullDepth&&spreadBps<=SPREAD_MAX;
  }catch{/* Invalid current sizing remains an explicit failed guard. */}
  return{quote:evidence,rawQuote:q,sized,limitPrice,spreadBps,guardPassed,liquidityPassed};
}
async function runE1Gate(s,initialQuote,step,gw,filters={},watchFastWeak=true){
  // E1 judges the quote against maxQuoteAgeMs = 1000. The admission-time quote is
  // already 1-2.5s old by the time it gets here -- the BOO gate, the account and
  // ownership reads and this function's own 10s tape fetch all sit in between --
  // so reusing it made E1_QUOTE_UNKNOWN unavoidable: 115 of 115 defers on
  // 2026-09-16/17 measured 1097-2596ms, not one inside the policy. The policy is
  // not the problem and is unchanged; the read is moved to the decision point and
  // issued alongside the tape so it costs no extra latency. A failed read falls
  // back to the admission quote, which E1 will then correctly refuse as stale.
  const window=executionWindowFor(s);
  if(!window.valid)throw Error(window.reason);
  const signalClose=N(s.features?.signal5Close,NaN),signalExpiresAt=window.expiresAt,
    tapeEnd=Date.now(),
    [tapeRead,freshQuoteRead]=await Promise.allSettled([
      fetchE1AggTrades(s.symbol,tapeEnd-10000,tapeEnd),
      gw({action:"quote",market:s.symbol},3000)]),
    initialTape=tapeRead.status==="fulfilled"?tapeRead.value
      :{available:false,reason:`E1_TAPE_FETCH:${String(tapeRead.reason)}`},
    decisionQuote=freshQuoteRead.status==="fulfilled"&&freshQuoteRead.value?freshQuoteRead.value:initialQuote,
    decisionAt=Date.now(),initial=e1CurrentAssessment(s,decisionQuote,step,decisionAt,filters),
    featureHash=await hashJson(rec(s.features)),initialRawHash=Array.isArray(initialTape.raw)?
      await hashJson({tape:initialTape.raw,quote:decisionQuote?.raw??null}):null;
  let state=startE1({decisionAt,signalId:s.id,symbol:s.symbol,signalExpiresAt,baselineEligible:true,
    tape:initialTape,quote:initial.quote,featureAsOf:Number.isFinite(signalClose)?signalClose:null,
    featureHash,rawHash:initialRawHash}),latest=initial;
  // `watchFastWeak` is false for setup-governed signals, and the caller then converts
  // the single E1_FAST_WEAK_WATCH defer into a recorded observation. Draining the
  // watch first and converting afterwards -- which is what this loop did -- made that
  // conversion unreachable (the final state is never the initial defer) while still
  // spending up to E1_POLICY.watchMs of a 60-second trigger window on an answer the
  // caller was always going to discard. Production, 2026-09-18 08:49 UTC: STRKUSDT
  // triggered at 08:49:00, E1 watched until 08:49:36, and the trigger expired at
  // 08:50:00. Skipping the watch changes no verdict; it stops paying for one.
  while(watchFastWeak&&state.confirmationState==="WATCH_FAST_WEAK"){
    const blockStart=state.watch.nextBlockStartAt,blockEnd=blockStart+E1_POLICY.blockMs,
      waitMs=Math.max(0,blockEnd-Date.now());
    if(waitMs>0)await new Promise(resolve=>setTimeout(resolve,waitMs));
    const beforeFetch=Date.now();
    if(beforeFetch>=state.watch.deadline){state=advanceE1(state,{observedAt:beforeFetch});break}
    const[tapeRead,quoteRead]=await Promise.allSettled([fetchE1AggTrades(s.symbol,blockStart,blockEnd),
      gw({action:"quote",market:s.symbol},3000)]),
      tape=tapeRead.status==="fulfilled"?tapeRead.value:{available:false,reason:`E1_TAPE_FETCH:${String(tapeRead.reason)}`},
      q=quoteRead.status==="fulfilled"?quoteRead.value:null,observedAt=Date.now(),
      assessment=e1CurrentAssessment(s,q,step,observedAt,filters),rawHash=Array.isArray(tape.raw)?
        await hashJson({tape:tape.raw,quote:q?.raw??null}):null;
    state=advanceE1(state,{observedAt,tape,quote:assessment.quote,
      entryGuardPassed:assessment.guardPassed,liquidityPassed:assessment.liquidityPassed,rawHash});
    latest=assessment;
  }
  return{decision:state,...latest};
}
// A stop can fill AFTER run() matched the portfolio, but BEFORE closePos reads it.
// Confirm that exact remembered stop and book its fill before treating flatness as an
// unexplained mismatch. This recovery only reads the exchange; it never resends a sell.
async function reconcileNativeCloseBeforeDispatch(db,p,fraction,gw=opsGateway(db)){
  const meta=rec(p.metadata);
  // A recovered native stop closes the WHOLE position. Reporting that back to a caller
  // that asked to sell a fraction would book a full close against a partial intent, so
  // the shortcut is only ever valid for a full close. V17 only ever exits in full today;
  // this keeps that assumption from breaking silently if a partial exit is ever wired in.
  if(!(fraction>=1))return null;
  if(!NATIVE_STOP_ENABLED||meta.executionMode!==STRATEGY||p.side!=="LONG"||
      p.state!=="OPEN"||meta.v17ManualPosition===true)return null;
  const orders=rec(meta.exitProtection).orders;
  if(!Array.isArray(orders)||!orders.some(o=>o&&o.terminal!==true))return null;
  try{
    const state=await createGatewayProtection(db,gw,()=>verifyExecutionLease(db)).refresh(p.id);
    const confirmed=(state.protection?.orders||[]).some(o=>o.actualOrderId&&o.terminal===true&&
      o.fillStatus==="FILLED"&&Number(o.appliedQuantity)>0&&Number(o.appliedFunds)>0&&
      Number.isFinite(o.appliedFee));
    if(!confirmed||state.position?.state!=="CLOSED"||state.position.remainingQuantity!==0)return null;
    const row=await db.from("v11_long_regime_positions").select("*").eq("id",p.id).single();
    if(row.error||!row.data||row.data.state!=="CLOSED"||Number(row.data.remaining_quantity)!==0)
      throw new Error("NATIVE_CLOSE_NOT_DURABLE");
    return {closed:true,position:row.data,exitPrice:row.data.exit_price,
      realizedPnlUsdt:Number(row.data.realized_pnl_usdt),nativeReconciled:true};
  }catch(e){
    if(classifyFailure(e).fatal)throw e;
    console.error("V17_NATIVE_CLOSE_RECONCILE_FAILED",p.id,String(e instanceof Error?e.message:e));
    return null;
  }
}
async function closePos(db,p,fraction,reason,ctx={}) {
  const gw=ctx.gateway??opsGateway(db);
  await verifyExecutionLease(db);
  const current=await db.from("v11_long_regime_positions").select("*").eq("id",p.id).single();
  if(current.error||!current.data)throw Error("EXIT_POSITION_READ");
  // A LEGACY/stale invocation cannot resurrect a closed position or create another exit.
  if(current.data.state!=="OPEN")return {closed:current.data.state==="CLOSED",position:current.data};
  p={...current.data,peak_price:Math.max(N(current.data.peak_price),N(p.peak_price))};
  const orders=await readOpsOrders(db,[p]);
  if(!ownedEntry(p,orders))throw Error("EXIT_OWNERSHIP_UNPROVEN");
  const pending=riskOrders(orders).find(o=>o.position_id===p.id&&o.intent!=="OPEN_LONG");
  if(pending){
    const raw=await gw({action:"get_order",market:p.symbol,identifier:pending.client_order_id,exchange_order_id:pending.exchange_order_id});
    return applyExitReceipt(db,p,pending,raw,await gw({action:"p10_portfolio"}),{verifyLease:()=>verifyExecutionLease(db)});
  }
  // Read the allowlist BEFORE the account observation: classifyPortfolio only accepts an
  // observation younger than 3s, and a DB round trip taken after the fetch spends that
  // budget on us rather than the exchange. On this path a false stale reading blocks an
  // exit, so the ordering matters more here than on entry.
  const manual=await manualPositionAllowances(db);
  let pf=await gw({action:"p10_portfolio"});
  const match=classifyPortfolio([p],{...pf,positions:pf?.positions?.filter(x=>sym(x)===p.symbol)},{manual,orders});
  if(!match.ok){
    if(match.issues.some(x=>x.kind==="KNOWN_EXIT_PENDING_RECONCILIATION")){
      const nativeClosed=await reconcileNativeCloseBeforeDispatch(db,p,1,gw);
      if(nativeClosed)return nativeClosed;
    }
    throw Error("EXIT_EXPOSURE_RECONCILIATION_PENDING");
  }
  const i=await gw({action:"symbol_info",market:p.symbol}),step=N(i?.quantity_step??i?.step_size);
  const amount=floorStep(N(p.remaining_quantity)*Math.max(0,Math.min(1,fraction)),step);
  if(!(amount>0))throw Error("EXIT_QTY_ZERO");
  const id=await exitAttemptId(p.id,crypto.randomUUID(),reason==="BULL_T1"?"v11p":"v11x");
  const rp={action:"create_order",order:{market:p.symbol,side:"SELL",type:"MARKET",quantity:amount,
    identifier:id,position_side:"LONG",position_effect:"CLOSE"},wait_for_final_ms:4000};
  await verifyExecutionLease(db);
  const oi=await db.from("v11_long_regime_orders").insert({revision:REVISION,signal_id:p.signal_id,position_id:p.id,
    symbol:p.symbol,intent:fraction<1?"PARTIAL_CLOSE":"CLOSE_LONG",reason,client_order_id:id,requested_quantity:amount,
    state:"PLANNED",request_payload:{...rp,quantity_step:step,fraction,executor_patch:PATCH}}).select("*").single();
  if(oi.error)throw Error(`EXIT_INTENT:${oi.error.message}`);
  try{
    await verifyExecutionLease(db);
    const raw=await gw(rp),z=fill(raw);
    await verifyExecutionLease(db);
    const wr=await db.from("v11_long_regime_orders").update({state:"RECONCILIATION_PENDING",exchange_order_id:z.exchangeOrderId,
      response_payload:raw,updated_at:new Date().toISOString()}).eq("id",oi.data.id);
    if(wr.error)throw Error("EXIT_ACK_WRITE");
    pf=await gw({action:"p10_portfolio"});
    return await applyExitReceipt(db,p,oi.data,raw,pf,{verifyLease:()=>verifyExecutionLease(db)});
  }catch(e){
    // Even HTTP 408 is ambiguous. Persist the same intent and only query its identity later.
    if(classifyFailure(e).fatal)throw e;
    await verifyExecutionLease(db);
    const wr=await db.from("v11_long_regime_orders").update({state:"RECONCILIATION_FAILED",
      reject_reason:String(e.message??e).slice(0,500),updated_at:new Date().toISOString()}).eq("id",oi.data.id);
    if(wr.error)throw Error("EXIT_UNKNOWN_WRITE");
    await circuit(db,`EXIT_PENDING:${p.symbol}`,"KNOWN_ORDER_PENDING_RECONCILIATION",{positionId:p.id,orderId:oi.data.id,clientOrderId:id,error:String(e.message??e)});
    throw e;
  }
}
async function manageBull(db,p,m,ctx){
if(rec(p.metadata).executionMode===STRATEGY)return await manageLeader(db,p,ctx);
const q=await gateway({action:"quote",market:p.symbol}),bid=N(q?.best_bid);if(!(bid>0))throw new Error("QUOTE_INVALID");const now=new Date().toISOString(),entry=N(p.entry_price),peak=Math.max(N(p.peak_price,entry),bid),peakWrite=await db.from("v11_long_regime_positions").update({peak_price:peak,last_evaluated_at:now,updated_at:now}).eq("id",p.id).select("*").single();if(peakWrite.error)throw new Error(`BULL_PEAK_WRITE:${peakWrite.error.message}`);p=peakWrite.data;const stop=N(p.hard_stop_price),deadline=Date.parse(p.hard_deadline);if(Number.isFinite(deadline)&&Date.now()>=deadline){await audit(db,p,"BULL","BULL","FULL_CLOSE","BULL_30D_SAFETY_DEADLINE",{marketRoute:m.route,bid,peak});return{action:"CLOSE",reason:"BULL_30D_SAFETY_DEADLINE",result:await closePos(db,p,1,"BULL_30D_SAFETY_DEADLINE")}}if(bid<=stop){await audit(db,p,"BULL","BULL","FULL_CLOSE","BULL_HARD_STOP",{marketRoute:m.route,bid,stop,peak});return{action:"CLOSE",reason:"BULL_HARD_STOP",result:await closePos(db,p,1,"BULL_HARD_STOP")}}if(m.route==="RANGE"||m.route==="BEAR"){const r=`REGIME_BULL_TO_${m.route}_REALIZE`;await audit(db,p,"BULL",m.route,"FULL_CLOSE",r,{marketRoute:m.route,bid,peak});return{action:"CLOSE",reason:r,result:await closePos(db,p,1,r)}}const t1=entry*(1+T1_PRICE);if(!p.t1_completed&&bid>=t1){await audit(db,p,"BULL","BULL","PARTIAL_CLOSE","BULL_T1",{marketRoute:m.route,bid,t1,peak});const frac=Math.min(1,N(p.original_quantity)*PARTIAL/Math.max(1e-12,N(p.remaining_quantity))),r=await closePos(db,p,frac,"BULL_T1");if(r?.position&&!r.closed){const ns=Math.max(N(r.position.hard_stop_price),entry),up=await db.from("v11_long_regime_positions").update({hard_stop_price:ns,peak_price:peak,last_evaluated_at:now,updated_at:now}).eq("id",p.id);if(up.error)throw new Error(`T1_PROTECT:${up.error.message}`)}return{action:"PARTIAL",reason:"BULL_T1",result:r}}let newStop=stop;if(p.t1_completed)newStop=Math.max(stop,entry,peak*(1-TRAIL));if(newStop>stop){const up=await db.from("v11_long_regime_positions").update({hard_stop_price:newStop,peak_price:peak,last_evaluated_at:now,updated_at:now}).eq("id",p.id);if(up.error)throw new Error(`BULL_TRAIL_WRITE:${up.error.message}`)}if(p.t1_completed&&bid<=newStop){await audit(db,p,"BULL","BULL","FULL_CLOSE","BULL_TRAIL_PROTECTION",{marketRoute:m.route,bid,newStop,peak});return{action:"CLOSE",reason:"BULL_TRAIL_PROTECTION",result:await closePos(db,{...p,hard_stop_price:newStop,peak_price:peak},1,"BULL_TRAIL_PROTECTION")}}await audit(db,p,"BULL","BULL","HOLD","BULL_TREND_HOLD",{marketRoute:m.route,bid,t1,t1Completed:p.t1_completed,peak,newStop,deadline:p.hard_deadline});return{action:"HOLD",lane:"BULL",bid,t1,peak,newStop,deadline:p.hard_deadline}}
// `attempt` is an out-param: openBull sets dispatched=true at the instant an order
// leaves this process. run() uses it to decide whether a failure is safe to move past.
/**
 * Assemble the executor's live state into the pure BOO entry gate.
 *
 * Every input that cannot be established is left ABSENT rather than defaulted,
 * because the gate treats absent as a refusal. In particular:
 *   - the account's own commission rate is read from the gateway, never
 *     substituted with a documentation constant (section 7);
 *   - the structural stop comes from the signal's exit policy, so the loss
 *     budget is computed against the stop that will actually be installed;
 *   - depth must be present, or `booBook` reports the data unhealthy.
 */
/**
 * Everything the BOO gate needs to READ, separated from the decision it makes.
 *
 * The split is not cosmetic. evaluateBooEntry is pure, so once these four reads
 * are in hand the verdict costs nothing; leaving them fused meant the pre-dispatch
 * verdict put two gateway round trips and two DB reads BETWEEN the quote the order
 * is priced from and the check that the quote is still fresh. That check uses
 * E1_POLICY.maxQuoteAgeMs = 1000ms, so it could not be met by construction: the
 * account's own controls, fee schedule and position mode take longer than a second
 * to fetch. Production, 2026-09-17/18 UTC: every one of the 7 candidates that
 * reached this point was refused E1_DISPATCH_QUOTE_AGED, released its claim and was
 * then refused V17_TRIGGER_STALE on the following cycle -- 0 order intents from 8
 * pre-dispatch attempts. The policy is not the problem and is unchanged; the reads
 * move off the critical path instead.
 */
async function booGateInputs(db,s){
  const parameterHash=await hashJson({strategy:STRATEGY,r1:R1_VERSION,riskPolicy:RISK_POLICY_VERSION,
    riskBudget:RISK_BUDGET_VERSION,exitPolicy:rec(s.features?.exitPolicy)});
  const identity=booRunningIdentity(parameterHash);
  const [gateContext,controls,feeRates,positionMode]=await Promise.all([
    loadBooGateContext(db,identity),
    opsControls(db),
    opsGateway(db)({action:"fees",market:s.symbol}).catch(()=>null),
    opsGateway(db)({action:"futures_position_mode"},2000).catch(()=>null)]);
  return {identity,gateContext,controls,feeRates,positionMode};
}
/** Pure. Same verdict as booGate, from inputs a caller already holds. */
function booVerdict(s,phase,inputs,{quote,info,snapshot,pair,orders}){
  const {identity,gateContext,controls,feeRates,positionMode}=inputs;
  const book=booBook(quote,E1_POLICY.maxQuoteAgeMs);
  const f=rec(s.features),ref=N(f.referenceClose),stopPct=N(rec(f.exitPolicy).stopPct);
  const {openRisk,grossNotional}=openRiskSummary({positions:pair.positions,
    pendingOrders:(orders?.orders??[]).filter(o=>o?.request_payload?.booRiskReservation)});
  // Taker rate from the account, as a fraction. A missing rate leaves the field
  // undefined so the sizing refuses rather than guessing.
  const taker=gatewayTakerFeeRate(feeRates,s.symbol);
  return evaluateBooEntry({
    phase,gateContext,runningIdentity:identity,
    settings:controls.settings,runtime:controls.runtime,operatorControl:controls.control,
    signal:{
      strategy:{eligible:String(f.strategy||"")===STRATEGY,setupId:s.id,
        reason:String(f.strategy||"")===STRATEGY?null:`WRONG_STRATEGY:${f.strategy}`},
      // The structural stop the position would actually carry.
      structuralStop:ref>0&&stopPct>0?String(ref*(1-stopPct)):"0",
      filters:{stepSize:String(N(info?.quantity_step??info?.step_size)),
        minQty:String(N(info?.min_quantity??info?.quantity_step??info?.step_size)),
        maxQty:String(N(info?.max_quantity,0))||undefined,
        minNotional:String(Math.max(1,N(info?.min_notional,5))),
        tickSize:String(N(info?.price_tick??info?.tick_size))}},
    book,
    account:{
      equity:String(N(snapshot?.total_equity_quote,N(pair.pf?.total_equity_quote,0))),
      availableMargin:String(Math.min(N(snapshot?.available_quote),N(pair.pf?.available_quote,NaN))||0),
      realizedToday:String(N(controls.runtime?.boo_realized_today,0)),
      realizedThisWeek:String(N(controls.runtime?.boo_realized_this_week,0)),
      highWaterEquity:controls.runtime?.boo_high_water_equity??null,
      consecutiveLosses:N(controls.runtime?.boo_consecutive_losses,0),
      reservedRisk:openRisk.toString(),openGrossNotional:grossNotional.toString(),
      leverage:String(LEV),
      // One-way vs hedge mode and protective-order support are proven by the
      // authenticated mode observation; anything short of an explicit yes blocks entry.
      modeSupported:supportedFuturesMode(positionMode,Date.now()),
      protectionSupported:NATIVE_STOP_ENABLED===true},
    fees:{takerFeeRate:taker,stopFeeRate:taker,
      stopSlippageFrac:"0.001",expectedFundingCost:"0"},
    lease:{held:true,fencingToken:String(N(controls.runtime?.incident_generation,0)),gatewayReady:true},
    // Edge evidence must be measured. The V24 row carries an ASSUMED figure,
    // which the gate refuses by design.
    costEvidence:{netEdgeBps:N(controls.settings?.boo_measured_net_edge_bps,NaN),
      requiredEdgeBps:N(controls.settings?.boo_required_edge_bps,NaN),
      source:String(controls.settings?.boo_edge_source??"ASSUMED")},
  });
}
async function booGate(db,s,phase,ctx){return booVerdict(s,phase,await booGateInputs(db,s),ctx)}
async function openBull(db,s,openPositions,manual=null,attempt={},managementFailures=[]){
const gateway=opsGateway(db);
const selection=rec(rec(s.features).b06133),cec=rec(rec(s.features).cec0040),selectedSetup=signalSetup(s);
// Under V30 the B06133 stamp must be intact and taken at this trigger, but its
// allowed/branch values are reference evidence: neither required nor rewritten.
if(selection.version!==B06133_VERSION||Number(selection.source?.decisionAt)!==Number(selectedSetup?.triggerAt))
  throw new Error("B06133_SELECTION_INVALID");
// The V30 stamp must equal what the policy recomputes from that unmodified stamp.
if(!baselineAllowedV30(s,V30_FRONT_LIVE_VERSION)||!entryBranchOf(rec(s.features)))
  throw new Error("V30_SELECTION_INVALID");
if(cec.version!==CEC0040_VERSION||cec.targetVersion!==CEC0040_TARGET_VERSION||cec.ready!==true||
  Number(cec.decisionAt)!==Number(selectedSetup?.triggerAt)||
  !["ADMIT","PROBE","REJECT"].includes(cec.action))
  throw new Error("CEC0040_SELECTION_INVALID");
const gptEntryCheck=gptFinalCheck(db,s);
if(!gptEntryCheck.allowed)return{entered:false,reason:gptEntryCheck.reason,releaseClaim:true,releaseScope:RELEASE_SCOPE.SYMBOL};
attempt.gptFinalReview=gptEntryCheck.review??null;
await requireLeaderEntryControls(db);
const exitPolicy=rec(s.features?.exitPolicy);
if(!Object.values(exitPolicy).every(v=>Number.isFinite(Number(v)))||!(Number(exitPolicy.stopPct)>0&&Number(exitPolicy.stopPct)<1&&Number(exitPolicy.trailArmPct)>0&&Number(exitPolicy.trailGapPct)>0&&Number(exitPolicy.trailGapPct)<1&&Number(exitPolicy.maxHoldMs)===POLICY.maxHoldMs&&Number(exitPolicy.staleMs)>0))throw new Error("V17_EXIT_POLICY_INVALID");
const initialFresh=checkedEntryFresh(s,s.features,Date.now(),Number(s.features?.referenceClose),attempt,"PRE_ADMISSION");
if(initialFresh)throw new Error(initialFresh);
let[sn,q,i,rawInitialPair,initialOrders]=await Promise.all([snap(db),gateway({action:"quote",market:s.symbol}),
  gateway({action:"symbol_info",market:s.symbol}),readOpsPair(db,gateway,s.symbol),gateway({action:"v18_open_orders"},5000)]),
  initialPair=rawInitialPair,manualRows=initialPair.manual;
await recordMismatch(db,initialPair.match);
const initialDecision=await decideEntry(db,initialPair,s.symbol,initialOrders,{managementFailures});
await persistDecisionRisk(db,initialPair,initialDecision);
if(!initialDecision.allowed){return{entered:false,
  reason:`ENTRY_CONTROL:${initialDecision.scope}:${initialDecision.reasons.join(",")}`,releaseClaim:true,releaseScope:controlReleaseScope(initialDecision),entryDecision:initialDecision}}
// BOO common entry gate, checkpoint 1 of 2 (admission). Section 4 requires a
// single gate that every new entry passes, evaluated here and again immediately
// before the send. It is additive: it can only refuse, never admit something
// the existing operational gate already refused.
const booAdmission=await booGate(db,s,"ADMISSION",{quote:q,info:i,snapshot:sn,pair:initialPair,orders:initialOrders});
attempt.booAdmission={enforcement:booAdmission.enforcement,blocks:booAdmission.blocks,
  verdictAllowed:booAdmission.verdict.allowed,reason:booAdmission.verdict.reason};
await recordBooVerdict(db,{signalId:s.id,symbol:s.symbol,phase:"ADMISSION",result:booAdmission});
if(booAdmission.blocks)return{entered:false,reason:`BOO_ENTRY_GATE:${booAdmission.verdict.reason}`,
  releaseClaim:true,releaseScope:RELEASE_SCOPE.SYMBOL,booGate:booAdmission.verdict};
if(manualRows.some(x=>x.symbol===String(s.symbol).toUpperCase()))throw new Error("MANUAL_SYMBOL_LOCKED");
if(active(initialPair.pf).length>=MAX_SLOTS)return{entered:false,reason:"V11_SLOT_FULL"};
if(initialPair.positions.some(p=>String(p.symbol).toUpperCase()===String(s.symbol).toUpperCase()))return{entered:false,reason:"DUPLICATE_SYMBOL_OPEN"};
let pf=initialPair.pf,bid=N(q?.best_bid),ask=N(q?.best_ask),sp=bid>0&&ask>0?(ask/bid-1)*10000:999;if(!(bid>0&&ask>0&&sp<=SPREAD_MAX))throw new Error(`ENTRY_SPREAD:${sp}`);const f=rec(s.features),ref=N(f.referenceClose),atr=N(f.atr);if(!(atr>0&&ref>0))throw new Error("ENTRY_FEATURES_INVALID");let filters=symbolFilters(i),step=filters.quantityStep,min=filters.minNotionalUsdt,sized=sizeEntry(ask,step,filters);if(sized.orderNotionalUsdt+1e-9<min)throw new Error("QTY_INVALID");let live=N(pf?.available_quote,NaN),avail=Math.min(N(sn.available_quote),live);if(!Number.isFinite(live))throw new Error("ENTRY_AVAILABLE_BALANCE_UNREADABLE");if(avail<sized.sizedMargin+ENTRY_CASH_BUFFER_USDT)return{entered:false,reason:`ENTRY_MARGIN_INSUFFICIENT:${avail.toFixed(4)}:${sized.sizedMargin.toFixed(4)}`,releaseClaim:true};// The plan already priced and budgeted itself; nothing re-derives either here.
let limitPrice=sized.limitPrice,iocBps=sized.iocBps,gap=Math.abs(limitPrice-ref)/atr;
let finalFresh=checkedEntryFresh(s,f,Date.now(),limitPrice,attempt,"ADMISSION_PRICE",q);if(finalFresh)throw new Error(finalFresh);
// Defensive: planSlotEntry already refuses anything over budget at its own limit.
if(sized.amount*limitPrice/LEV>MAX_ORDER_MARGIN_USDT+1e-9)throw new Error("V17_LIMIT_PRICE_MARGIN_OVERFLOW");
// V17 replaces pullback-specific ATR gap gating with a price-drift/age guard.
// Fixed operator-authorized cutover. No request/env can move or broaden it.
const qv3Active=Number.isSafeInteger(QV3_LIVE_CUTOVER)&&Date.now()>=QV3_LIVE_CUTOVER;
if(qv3Active){
  let result,bars=[],evaluatedAt=Date.now();
  try{bars=await qv3Candles(s.symbol,evaluatedAt,Math.floor(evaluatedAt/60000)*60000-180000);result=qv3Entry(bars,Date.now());}
  catch(e){result={available:false,wouldBlock:true,reason:String(e.message??e)};}
  attempt.qv3={...result,version:QV3_VERSION,basis:QV3_ACTIVATION_BASIS,activation:QV3_LIVE_CUTOVER,
    evaluatedAt,symbol:s.symbol,liveExecutionEnabled:true,completedBars:bars.map(b=>({openTime:Number(b[0]),closeTime:Number(b[6]),open:Number(b[1]),high:Number(b[2]),low:Number(b[3]),close:Number(b[4])}))};
  if(!result.available||result.wouldBlock){
    await audit(db,null,"BULL","BULL","ENTRY_DEFER",result.reason,{signalId:s.id,symbol:s.symbol,qv3:attempt.qv3});
    return {entered:false,reason:result.reason,releaseClaim:true,releaseScope:RELEASE_SCOPE.SYMBOL,qv3:attempt.qv3};
  }
  await requireLeaderEntryControls(db);
  const freshness=checkedEntryFresh(s,f,Date.now(),limitPrice,attempt,"AFTER_QV3",q);if(freshness)throw Error(freshness);
}
// V24 confirmation. Placed before E1 so a V24 refusal costs no extra gateway work, and
// scoped to entry only: it can refuse a V17 signal, never open one of its own, and it
// touches no protection, exit or reconciliation path. Disabled by default.
const v24Ctl=await v24Control(db);
if(v24Ctl.enabled){
  const v24=await v24EntryGate({symbol:s.symbol,features:{...f,volumeRatio:N(f.volumeRatio),
      notionalUsdt:sized.sizedNotional,probeQuantity:sized.amount},
    quote:q,quantityStep:step,priceTick:N(i?.price_tick??i?.tick_size),now:Date.now(),
    fetchAgg:(sym,a,b)=>fetchE1AggTrades(sym,a,b),edge:v24Ctl.edge});
  attempt.v24=v24;
  await recordV24(db,s.id,s.symbol,v24);
  await audit(db,null,"BULL","BULL",v24.allowed?"ENTRY_ALLOW":"ENTRY_DEFER",
    `V24:${v24.reason}`,{signalId:s.id,symbol:s.symbol,stage:"V24_CONFIRMATION",finalAdmission:false,v24});
  if(!v24.allowed)return{entered:false,reason:v24.reason,releaseClaim:true,releaseScope:RELEASE_SCOPE.SYMBOL,v24};
  const v24Fresh=checkedEntryFresh(s,f,Date.now(),limitPrice,attempt,"AFTER_V24",q);if(v24Fresh)throw Error(v24Fresh);
}
let e1Decision={policyVersion:E1_POLICY.policyVersion,confirmationState:"DISABLED",allowed:true,
  defer:false,reject:false,reasonCodes:["E1_OPERATOR_FLAG_DISABLED"],executionEnabled:false,
  parametersValidatedByBacktest:false,activationBasis:OPERATOR_OVERRIDE.basis};
if(E1_ENABLED){
  const e1=await runE1Gate(s,q,step,gateway,filters,!setupGoverns(s));e1Decision=e1.decision;attempt.e1=e1Decision;
  // E1's FAST-WEAK WATCH is a directional question: it waits up to E1_POLICY.watchMs
  // to see whether a 10-second slide recovers. Under the pullback policy that question
  // has already been answered, by a COMPLETED 1m candle that closed bullish, above the
  // previous close and back above the signal reference -- which is strictly more
  // evidence than a 10-second tape window. Re-asking it here would spend up to 30s of
  // a 60s trigger TTL to re-derive the same answer, and would usually expire the
  // trigger instead of improving it.
  //
  // So for setup-governed signals the watch is not entered at all (see runE1Gate) and
  // that ONE defer becomes a recorded observation here. Every other E1 outcome is
  // untouched: a rejection still rejects, and UNKNOWN -- an absent or stale quote, a
  // truncated tape, missing depth -- still defers. Unknown market data is never
  // converted into a pass, and a non-governed signal still serves the full watch.
  if(setupGoverns(s)&&e1Decision.defer===true&&!e1Decision.reject&&
     Array.isArray(e1Decision.reasonCodes)&&e1Decision.reasonCodes.length===1&&
     e1Decision.reasonCodes[0]==="E1_FAST_WEAK_WATCH"){
    e1Decision={...e1Decision,allowed:true,defer:false,
      reasonCodes:["E1_FAST_WEAK_OBSERVED_NOT_ENFORCED"],
      fastWeakObservation:{watched:false,supersededBy:SETUP_POLICY_VERSION,
        original:e1.decision.reasonCodes,observations:e1.decision.observations??[]}};
    attempt.e1=e1Decision;
  }
  await audit(db,null,"BULL","BULL",e1Decision.allowed?"ENTRY_ALLOW":e1Decision.reject?"ENTRY_REJECT":"ENTRY_DEFER",
    e1Decision.reasonCodes.join(","),{signalId:s.id,symbol:s.symbol,stage:"E1_CONFIRMATION",finalAdmission:false,e1:e1Decision,operatorOverride:OPERATOR_OVERRIDE});
  if(!e1Decision.allowed){
    const reason=`${e1Decision.confirmationState}:${e1Decision.reasonCodes.join(",")}`;
    if(e1Decision.reject){
      const terminal=await db.from("v11_long_regime_signals").update({status:"REJECTED",reject_reason:reason.slice(0,500),
        updated_at:new Date().toISOString()}).eq("id",s.id).eq("status","CLAIMED");
      if(terminal.error)throw Error("E1_SIGNAL_TERMINAL_WRITE");
      return{entered:false,reason,releaseClaim:false,e1:e1Decision,qv3:attempt.qv3};
    }
    return{entered:false,reason,releaseClaim:true,releaseScope:RELEASE_SCOPE.SYMBOL,e1:e1Decision,qv3:attempt.qv3};
  }
  q=e1.rawQuote;
  if(e1Decision.confirmationState==="RECOVERY_CONFIRMED"){
    // Waiting creates a new decision point. Refresh ownership, open orders, cash and
    // sizing, and price the IOC from the current ask rather than the old t0 quote.
    [sn,rawInitialPair,initialOrders,i]=await Promise.all([snap(db),readOpsPair(db,gateway,s.symbol),
      gateway({action:"v18_open_orders"},5000),gateway({action:"symbol_info",market:s.symbol},3000)]);
    initialPair=rawInitialPair;manualRows=initialPair.manual;
    await recordMismatch(db,initialPair.match);
    const refreshedDecision=await decideEntry(db,initialPair,s.symbol,initialOrders,{managementFailures});
    await persistDecisionRisk(db,initialPair,refreshedDecision);
    if(!refreshedDecision.allowed)return{entered:false,
      reason:`ENTRY_CONTROL:${refreshedDecision.scope}:${refreshedDecision.reasons.join(",")}`,
      releaseClaim:true,releaseScope:controlReleaseScope(refreshedDecision),entryDecision:refreshedDecision,e1:e1Decision};
    if(manualRows.some(x=>x.symbol===String(s.symbol).toUpperCase()))throw Error("MANUAL_SYMBOL_LOCKED");
    if(active(initialPair.pf).length>=MAX_SLOTS||initialPair.positions.some(p=>String(p.symbol).toUpperCase()===String(s.symbol).toUpperCase()))
      return{entered:false,reason:"PORTFOLIO_CHANGED_DURING_E1",releaseClaim:true,e1:e1Decision};
    pf=initialPair.pf;bid=N(q?.best_bid);ask=N(q?.best_ask);sp=bid>0&&ask>0?(ask/bid-1)*10000:999;
    if(!(bid>0&&ask>0&&sp<=SPREAD_MAX))throw Error(`ENTRY_SPREAD:${sp}`);
    filters=symbolFilters(i);step=filters.quantityStep;min=filters.minNotionalUsdt;sized=sizeEntry(ask,step,filters);
    if(sized.orderNotionalUsdt+1e-9<min)throw Error("QTY_INVALID");live=N(pf?.available_quote,NaN);avail=Math.min(N(sn.available_quote),live);
    if(!Number.isFinite(live))throw Error("ENTRY_AVAILABLE_BALANCE_UNREADABLE");
    if(avail<sized.sizedMargin+ENTRY_CASH_BUFFER_USDT)return{entered:false,
      reason:`ENTRY_MARGIN_INSUFFICIENT:${avail.toFixed(4)}:${sized.sizedMargin.toFixed(4)}`,releaseClaim:true,e1:e1Decision};
    limitPrice=sized.limitPrice;iocBps=sized.iocBps;
    gap=Math.abs(limitPrice-ref)/atr;finalFresh=checkedEntryFresh(s,f,Date.now(),limitPrice,attempt,"AFTER_E1",q);if(finalFresh)throw Error(finalFresh);
    if(sized.amount*limitPrice/LEV>MAX_ORDER_MARGIN_USDT+1e-9)throw Error("V17_LIMIT_PRICE_MARGIN_OVERFLOW");
    if(qv3Active){
      let result,bars=[],evaluatedAt=Date.now();
      try{bars=await qv3Candles(s.symbol,evaluatedAt,Math.floor(evaluatedAt/60000)*60000-180000);result=qv3Entry(bars,Date.now());}
      catch(error){result={available:false,wouldBlock:true,reason:String(error.message??error)};}
      attempt.qv3={...result,version:QV3_VERSION,basis:QV3_ACTIVATION_BASIS,activation:QV3_LIVE_CUTOVER,
        evaluatedAt,symbol:s.symbol,liveExecutionEnabled:true,recheckedAfterE1:true,
        completedBars:bars.map(b=>({openTime:Number(b[0]),closeTime:Number(b[6]),open:Number(b[1]),high:Number(b[2]),low:Number(b[3]),close:Number(b[4])}))};
      if(!result.available||result.wouldBlock)return{entered:false,reason:result.reason,releaseClaim:true,
        releaseScope:RELEASE_SCOPE.SYMBOL,qv3:attempt.qv3,e1:e1Decision};
    }
  }
}
// GPT FINAL RECHECK (2026-09-24). GPT's INITIAL BUY was judged on an earlier snapshot; E1
// has just read the current tape and book. The change detector compares the two (no I/O).
// Unchanged market: the initial BUY stands and nothing below changes. Meaningfully changed:
// GPT is asked once more with INITIAL/CURRENT/DELTA and only a valid FINAL BUY continues to
// the unchanged deterministic dispatch block; SKIP/ABSTAIN/timeout/error/invalid/expired or a
// second recheck of the same BUY place no order. E1 is the sensor here, GPT the decision maker.
{
  const recheck=await finalRecheckStep(db,s,{ticket:attempt.gptFinalReview,e1:E1_ENABLED?e1Decision:null,rawQuote:q});
  attempt.finalRecheck=recheck.record;
  if(!recheck.proceed){
    await audit(db,null,"BULL","BULL","ENTRY_REJECT",recheck.reason,{signalId:s.id,symbol:s.symbol,stage:"GPT_FINAL_RECHECK",finalAdmission:false,finalRecheck:recheck.record});
    const terminal=await db.from("v11_long_regime_signals").update({status:"REJECTED",reject_reason:recheck.reason.slice(0,500),
      updated_at:new Date().toISOString()}).eq("id",s.id).eq("status","CLAIMED");
    if(terminal.error)throw Error("FINAL_RECHECK_SIGNAL_TERMINAL_WRITE");
    return{entered:false,reason:recheck.reason,releaseClaim:false,finalRecheck:recheck.record,e1:e1Decision,qv3:attempt.qv3};
  }
  if(recheck.record.recheck_triggered)
    await audit(db,null,"BULL","BULL","ENTRY_ALLOW",recheck.reason,{signalId:s.id,symbol:s.symbol,stage:"GPT_FINAL_RECHECK",finalAdmission:false,finalRecheck:recheck.record});
}
// Final gateway check uses a new account observation and a new complete ordinary +
// conditional order observation.  No intent exists yet, so a denial cannot duplicate
// or strand an order identity.
//
// ORDERING IS LOAD-BEARING FROM HERE DOWN.
// -----------------------------------------
// The order is priced from a quote, and the last thing this function does before
// writing the intent is re-assert that that quote is younger than
// E1_POLICY.maxQuoteAgeMs (1000ms). Everything that sits BETWEEN the quote and that
// assertion is charged against the 1000ms, so this block is arranged so that nothing
// between them performs I/O: the ownership/orders/snapshot reads, the account
// snapshot and BOO's four reads all happen BEFORE or ALONGSIDE the quote, and the
// decisions taken after it -- sizing, the entry-control verdict, the BOO verdict,
// the drift and trigger-window checks -- are pure arithmetic over state already in
// hand. Re-introducing an await between the quote read and the dispatch check is
// exactly the defect this fixes; see booGateInputs for the production evidence.
await requireLeaderEntryControls(db);
const[rawFinalCheck,finalOrders,dispatchSnap,booInputs,dispatchQuote]=await Promise.all([
  readOpsPair(db,undefined,s.symbol),
  gateway({action:"v18_open_orders"},5000),
  E1_ENABLED?snap(db):Promise.resolve(sn),
  booGateInputs(db,s),
  E1_ENABLED?gateway({action:"quote",market:s.symbol},3000):Promise.resolve(q)]),finalCheck=rawFinalCheck;
if(E1_ENABLED){
  const dispatchAt=Date.now(),assessment=e1CurrentAssessment(s,dispatchQuote,step,dispatchAt,filters);
  attempt.entryPriceCheck=entryPriceEvidence(s,assessment.limitPrice,dispatchAt,"E1_DISPATCH_PRICE",
    dispatchQuote,executionWindowFor(s),POLICY.maxEntryDriftPct,
    entryFreshFor(s,s.features,dispatchAt,assessment.limitPrice));
  if(!assessment.quote.valid||!assessment.liquidityPassed||!assessment.guardPassed){
    const reason=!assessment.quote.valid?"E1_DISPATCH_QUOTE_UNKNOWN":!assessment.quote.fullDepth?
      "E1_DISPATCH_DEPTH_INSUFFICIENT":"E1_DISPATCH_GUARD_FAILED";
    await audit(db,null,"BULL","BULL","ENTRY_DEFER",reason,{signalId:s.id,symbol:s.symbol,
      entryPriceCheck:attempt.entryPriceCheck,
      e1:{...e1Decision,dispatchRecheck:assessment.quote},operatorOverride:OPERATOR_OVERRIDE});
    return{entered:false,reason,releaseClaim:true,releaseScope:RELEASE_SCOPE.SYMBOL,e1:{...e1Decision,dispatchRecheck:assessment.quote}};
  }
  q=dispatchQuote;sn=dispatchSnap;pf=finalCheck.pf;manualRows=finalCheck.manual;
  bid=N(q.best_bid);ask=N(q.best_ask);sp=(ask/bid-1)*10000;sized=assessment.sized;
  live=N(pf?.available_quote,NaN);avail=Math.min(N(sn.available_quote),live);
  if(!Number.isFinite(live))throw Error("ENTRY_AVAILABLE_BALANCE_UNREADABLE");
  if(avail<sized.sizedMargin+ENTRY_CASH_BUFFER_USDT)return{entered:false,
    reason:`ENTRY_MARGIN_INSUFFICIENT:${avail.toFixed(4)}:${sized.sizedMargin.toFixed(4)}`,releaseClaim:true,e1:e1Decision};
  limitPrice=sized.limitPrice;iocBps=sized.iocBps;gap=Math.abs(limitPrice-ref)/atr;
  e1Decision={...e1Decision,decisionAt:dispatchAt,quoteAgeMs:assessment.quote.quoteAgeMs,
    evaluatedPrice:ask,expectedEntryVWAP:assessment.quote.expectedEntryVWAP,
    expectedExitVWAP:assessment.quote.expectedExitVWAP,expectedCostBps:assessment.quote.expectedCostBps,
    dispatchRecheck:{at:dispatchAt,sourceTier:assessment.quote.sourceTier,quoteAgeMs:assessment.quote.quoteAgeMs,
      bookMode:assessment.quote.bookMode,fullDepth:assessment.quote.fullDepth,currentQuantity:sized.amount}};
}
// GPT FINAL RECHECK, deterministic part (pure, no I/O on the admit path): after a FINAL BUY the
// dispatch quote must be newer than that answer, not catastrophically wide, and not moved
// materially from the snapshot GPT answered on. Otherwise the answer is stale: no order.
if(attempt.finalRecheck?.recheck_triggered===true){
  const safety=postRecheckSafety({recheck:attempt.finalRecheck.final,quote:q,at:Date.now()});
  attempt.finalRecheck={...attempt.finalRecheck,postSafety:safety};
  if(!safety.ok){
    markRecheckOutcome(db,s,attempt.finalRecheck,"NO_ORDER_POST_RECHECK_SAFETY:"+safety.reason);
    await audit(db,null,"BULL","BULL","ENTRY_REJECT",safety.reason,{signalId:s.id,symbol:s.symbol,stage:"GPT_FINAL_RECHECK_SAFETY",finalRecheck:attempt.finalRecheck});
    const terminal=await db.from("v11_long_regime_signals").update({status:"REJECTED",reject_reason:safety.reason,
      updated_at:new Date().toISOString()}).eq("id",s.id).eq("status","CLAIMED");
    if(terminal.error)throw Error("FINAL_RECHECK_SIGNAL_TERMINAL_WRITE");
    return{entered:false,reason:safety.reason,releaseClaim:false,finalRecheck:attempt.finalRecheck,e1:e1Decision};
  }
}
// Pure: the controls were read alongside the quote above. A clean portfolio writes
// nothing here, so the happy path from the quote to the dispatch check stays I/O-free.
const finalDecision=decideEntryWith(booInputs.controls,finalCheck,s.symbol,finalOrders,{proposedMargin:sized.sizedMargin,cashBuffer:ENTRY_CASH_BUFFER_USDT,managementFailures});
await recordMismatch(db,finalCheck.match);await persistDecisionRisk(db,finalCheck,finalDecision);
if(!finalDecision.allowed){return{entered:false,
  reason:`ENTRY_CONTROL:${finalDecision.scope}:${finalDecision.reasons.join(",")}`,releaseClaim:true,releaseScope:controlReleaseScope(finalDecision),entryDecision:finalDecision,e1:e1Decision}}
if(finalCheck.positions.some(p=>p.symbol===s.symbol)||active(finalCheck.pf).length>=MAX_SLOTS)return{entered:false,reason:"PORTFOLIO_CHANGED",releaseClaim:true};
// BOO common entry gate, checkpoint 2 of 2 (immediately before dispatch).
// Re-evaluated from scratch against the state that will actually be traded -- the
// dispatch quote's own book and the quantity this order will carry. A cached
// admission verdict is explicitly not sufficient (section 4); what is cached here is
// only the account state BOO reads, taken in the same round trip as the quote.
const booPredispatch=booVerdict(s,"PRE_DISPATCH",booInputs,{quote:q,info:i,snapshot:sn,pair:finalCheck,orders:finalOrders});
const booFinal=finalizeBooEntry(booAdmission,booPredispatch);
attempt.booPredispatch={enforcement:booPredispatch.enforcement,blocks:booFinal.blocks,
  verdictAllowed:booPredispatch.verdict.allowed,reason:booFinal.reason};
if(booFinal.blocks){
  await recordBooVerdict(db,{signalId:s.id,symbol:s.symbol,phase:"PRE_DISPATCH",result:booPredispatch});
  return{entered:false,
    reason:`BOO_ENTRY_GATE:${booFinal.driftDetected?"STATE_DRIFT:":""}${booFinal.reason}`,
    releaseClaim:true,releaseScope:RELEASE_SCOPE.SYMBOL,booGate:booPredispatch.verdict};
}
if(E1_ENABLED){
  const checkedAt=Date.now(),receivedAt=N(q?.timing?.received_at_ms,NaN),quoteAge=checkedAt-receivedAt;
  if(!Number.isSafeInteger(receivedAt)||quoteAge<0||quoteAge>E1_POLICY.maxQuoteAgeMs)
    return{entered:false,reason:`E1_DISPATCH_QUOTE_AGED:${Number.isFinite(quoteAge)?Math.round(quoteAge):"UNKNOWN"}`,
      releaseClaim:true,releaseScope:RELEASE_SCOPE.SYMBOL,e1:e1Decision};
  // Waiting for recovery never extends the original signal lifetime. Recheck after
  // all account/ownership reads too, immediately before persisting the order intent.
  const freshness=checkedEntryFresh(s,f,checkedAt,limitPrice,attempt,"PRE_DISPATCH_PRICE",q);if(freshness)throw Error(freshness);
  e1Decision={...e1Decision,dispatchQuoteAgeAtIntentMs:quoteAge};
}
// Evidence, not a gate: the digest of the exact book this order was priced from.
// It is taken AFTER the freshness checks so it cannot spend their budget, and its
// failure cannot refuse an entry that every gate already admitted.
if(E1_ENABLED&&dispatchQuote?.raw){
  try{e1Decision={...e1Decision,rawHashes:[...(e1Decision.rawHashes??[]),
    await hashJson({quote:dispatchQuote.raw})]};}catch{/* evidence only */}
}
// The verdict is recorded once the trade decision is made, never in front of it:
// a dashboard write is not a trading decision and must not spend the quote's budget.
// recordBooVerdict swallows its own failures, so BOO logging can never block entry.
await recordBooVerdict(db,{signalId:s.id,symbol:s.symbol,phase:"PRE_DISPATCH",result:booPredispatch});
await verifyExecutionLease(db);
// Pure final check; no GPT/network call after the execution quote.
const gptDispatchCheck=gptFinalCheck(db,s,attempt.finalRecheck);
if(!gptDispatchCheck.allowed)return{entered:false,reason:gptDispatchCheck.reason,releaseClaim:true,releaseScope:RELEASE_SCOPE.SYMBOL};
const id=cid("v11e",s.id),rp={action:"create_order",leverage:LEV,order:{market:s.symbol,side:"BUY",type:"LIMIT",price:limitPrice,time_in_force:"IOC",quantity:sized.amount,identifier:id,position_side:"LONG",position_effect:"OPEN"},wait_for_final_ms:4000},
  oi=await db.from("v11_long_regime_orders").insert({revision:REVISION,signal_id:s.id,position_id:null,symbol:s.symbol,intent:"OPEN_LONG",reason:"V17_LEADER_ENTRY_IOC",client_order_id:id,requested_quantity:sized.amount,state:"PLANNED",request_payload:{...rp,quantity_step:step,price_tick:filters.priceTick,min_notional_usdt:filters.minNotionalUsdt,target_margin_usdt:MARGIN,sizing_contract_version:SLOT_SIZING_CONTRACT.version,entry_timing_policy:setupGoverns(s)?{version:SETUP_POLICY_VERSION,activation:SETUP_LIVE_CUTOVER,setup:serializeSetup(signalSetup(s),8)}:null,entry_selection:rec(s.features).b06133,entry_front:rec(s.features).v30Front??null,entry_branch:entryBranchOf(rec(s.features)),entry_controller:rec(s.features).cec0040,entry_gpt_decision:attempt.gptFinalReview??null,entry_final_recheck:withOrderTiming(attempt.finalRecheck),sized_margin_usdt:sized.sizedMargin,sized_notional_usdt:sized.sizedNotional,order_notional_usdt:sized.orderNotionalUsdt,sizing_bound_by:sized.boundBy,leverage:LEV,spread_bps:sp,entry_gap_atr:gap,ioc_bps:iocBps,max_slots:MAX_SLOTS,setup_max_concurrent:SETUP_MAX_CONCURRENT,executor_patch:PATCH,entry_execution_policy:{version:ENTRY_EXECUTION_POLICY_VERSION,max_entry_drift_pct:POLICY.maxEntryDriftPct},entry_control:finalDecision.evidence,e1:E1_ENABLED?e1Decision:null,x1:X1_ENABLED?{policyVersion:X1_POLICY_VERSION,baseExitPolicyVersion:EXIT_REVIEW_R5.policyVersion,...OPERATOR_OVERRIDE}:null,operator_override:E1_ENABLED||X1_ENABLED?OPERATOR_OVERRIDE:null,qv3:qv3Active?{version:QV3_VERSION,activation:QV3_LIVE_CUTOVER,basis:QV3_ACTIVATION_BASIS}:null}}).select("*").single();
if(oi.error)throw new Error(`ORDER_INTENT:${oi.error.message}`);
try{
  await verifyExecutionLease(db);attempt.dispatched=true;const initialRaw=await gateway(rp),initial=fill(initialRaw);
  let finalRaw=initialRaw,receipt=null,finalitySource="CREATE_RESPONSE";
  try{receipt=entryReceipt(initialRaw,oi.data);}catch{/* Query the exact persisted identity below. */}
  if(!receipt){
    // A gateway wait can return the terminal status before its normalized fill fields.
    // Persist the ambiguity first, then query this exact order identity immediately so
    // an actual position receives its resident stop in this invocation, not next minute.
    await verifyExecutionLease(db);
    const pending=await db.from("v11_long_regime_orders").update({state:"RECONCILIATION_PENDING",
      exchange_order_id:initial.exchangeOrderId,response_payload:{...initialRaw,v22ImmediateEntryQueryPending:true},
      reject_reason:`IOC_CONFIRMING:${initial.status}`,updated_at:new Date().toISOString()}).eq("id",oi.data.id);
    if(pending.error)throw Error("ENTRY_PENDING_WRITE");
    finalRaw=await gateway({action:"get_order",market:s.symbol,identifier:id,
      exchange_order_id:initial.exchangeOrderId},5000);
    receipt=entryReceipt(finalRaw,oi.data);finalitySource="SAME_ORDER_QUERY";
  }
  const evidence={source:finalitySource,initialStatus:initial.status,confirmedAt:new Date().toISOString()},
    settledRaw={...finalRaw,v22EntryFinality:evidence};
  if(receipt.quantity>0){
    const pos={data:await settleKnownEntry(db,oi.data,settledRaw,gateway)},stop=pos.data.hard_stop_price;
    const entryProtection=await protectNewLeaderPosition({enabled:NATIVE_STOP_ENABLED,position:pos.data,
      manualSymbols:manualRows.map(x=>x.symbol),readPortfolio:()=>gateway({action:"p10_portfolio"},5000),
      manage:ctx=>manageLeader(db,pos.data,{...ctx,gateway})});
    return{entered:true,positionId:pos.data.id,symbol:s.symbol,entryPrice:receipt.price,
      quantity:receipt.quantity,stopPrice:stop,hardDeadline:pos.data.hard_deadline,iocBps,
      sizedMarginUsdt:sized.sizedMargin,entryProtection,entryFinality:evidence,
      entryDecision:finalDecision,postFillEntryGuard:rec(pos.data.metadata).postFillEntryGuard,
      e1:e1Decision,x1PolicyVersion:rec(pos.data.metadata).exitObservationPolicyVersion,
      b06133:rec(pos.data.metadata).b06133,cec0040:rec(pos.data.metadata).cec0040,qv3:attempt.qv3};
  }
  await settleKnownEntry(db,oi.data,settledRaw,gateway);
  return{entered:false,reason:`IOC_NO_FILL:${receipt.status}`,entryFinality:evidence,
    entryDecision:finalDecision,e1:e1Decision,qv3:attempt.qv3};
}catch(e){
  if(classifyFailure(e).fatal)throw e;await verifyExecutionLease(db);
  const msg=e instanceof Error?e.message:String(e),explicit=false;
  await db.from("v11_long_regime_orders").update({state:explicit?"REJECTED":"RECONCILIATION_FAILED",
    reject_reason:msg.slice(0,500),updated_at:new Date().toISOString()}).eq("id",oi.data.id);
  if(explicit){
    await db.from("v11_long_regime_signals").update({status:"REJECTED",reject_reason:msg.slice(0,500),
      updated_at:new Date().toISOString()}).eq("id",s.id);
    return{entered:false,reason:msg,e1:e1Decision,qv3:attempt.qv3};
  }
  await db.from("v11_long_regime_signals").update({status:"ORDERED",updated_at:new Date().toISOString()}).eq("id",s.id);
  await circuit(db,`BULL_ENTRY_AMBIGUOUS:${msg}`,"KNOWN_ORDER_PENDING_RECONCILIATION",
    {orderId:oi.data.id,clientOrderId:id,error:msg});throw e;
}}
// Best-effort feed for the decision-only exit shadow. It must never be able to affect
// trading: every failure is swallowed, and the gateway ignores it unless the shadow is
// enabled there. quantity_step lives on the opening order, not on the position row.
async function pushShadowPositions(db,open){
  const mine=open.filter(p=>rec(p.metadata).executionMode===STRATEGY&&String(p.side||"LONG").toUpperCase()==="LONG"&&rec(p.metadata).v17ManualPosition!==true);
  if(!mine.length)return;
  const ord=await db.from("v11_long_regime_orders").select("position_id,intent,request_payload").in("position_id",mine.map(p=>p.id)).eq("intent","OPEN_LONG");
  const step=new Map();for(const o of ord.data||[]){const q=N(o.request_payload?.quantity_step);if(q>0&&!step.has(o.position_id))step.set(o.position_id,q)}
  const positions=mine.map(p=>({positionId:p.id,symbol:p.symbol,entryPrice:N(p.entry_price),entryAt:Date.parse(p.entry_at),
    quantity:N(p.original_quantity),entryFee:N(p.entry_fee_usdt),quantityStep:step.get(p.id)??0}))
    .filter(x=>x.entryPrice>0&&x.quantity>0&&x.quantityStep>0&&Number.isFinite(x.entryAt));
  if(positions.length)await gateway({action:"v17_shadow_positions",positions},5000);
}
async function settleKnownEntry(db,intent,raw,gw=opsGateway(db)) {
  const receipt=entryReceipt(raw,intent),sig=await db.from("v11_long_regime_signals").select("*").eq("id",intent.signal_id).single();
  if(sig.error||!sig.data||sig.data.features?.strategy!==STRATEGY||intent.request_payload?.order?.side!=="BUY"||intent.request_payload?.order?.position_effect!=="OPEN")throw Error("ENTRY_INTENT_OWNERSHIP_UNPROVEN");
  if(receipt.quantity===0){
    const pf=await gw({action:"p10_portfolio"});
    if(!freshPortfolio(pf)||pf.positions.some(p=>(p.market??p.symbol)===intent.symbol&&Number(p.quantity)!==0))throw Error("ENTRY_ZERO_EXPOSURE_UNPROVEN");
    await verifyExecutionLease(db);
    const wr=await db.from("v11_long_regime_orders").update({state:"REJECTED",exchange_order_id:receipt.id,response_payload:{...raw,v18ExposureFinal:true},reject_reason:`IOC_NO_FILL:${receipt.status}`,updated_at:new Date().toISOString()}).eq("id",intent.id);
    if(wr.error)throw Error("ENTRY_TERMINAL_WRITE");
    const sr=await db.from("v11_long_regime_signals").update({status:"REJECTED",reject_reason:`IOC_NO_FILL:${receipt.status}`,updated_at:new Date().toISOString()}).eq("id",intent.signal_id);
    if(sr.error)throw Error("ENTRY_SIGNAL_WRITE");return null;
  }
  const s=sig.data,f=rec(s.features),atr=N(f.atr),z={qty:receipt.quantity,avg:receipt.price,fee:receipt.fee,exchangeOrderId:receipt.id};
  const found=await db.from("v11_long_regime_positions").select("*").eq("signal_id",s.id).maybeSingle();
  if(found.error)throw Error("ENTRY_POSITION_LOOKUP");
  let position=found.data;
  if(position){
    if(position.metadata?.entryOrderId!==receipt.id||!Number.isFinite(N(position.original_quantity))||Math.abs(N(position.original_quantity)-receipt.quantity)>1e-8||Math.abs(N(position.entry_price)-receipt.price)>Math.max(1e-12,receipt.price*1e-7))throw Error("ENTRY_EXISTING_OWNERSHIP_MISMATCH");
    if(receipt.exact&&position.metadata?.v18EntryAccountingPending){
      const meta=rec(position.metadata),settled=N(meta.v18SettledPnl)-receipt.fee;
      const pending=(meta.exitProtection?.orders??[]).some(x=>x.accountingPending)||Object.values(meta.v18Exits??{}).some(x=>x.quantity>0&&!x.detailsComplete);
      await verifyExecutionLease(db);
      const up=await db.from("v11_long_regime_positions").update({entry_fee_usdt:receipt.fee,realized_pnl_usdt:pending?null:settled,
        metadata:{...meta,v18SettledPnl:settled,v18EntryAccountingPending:false,exitAccountingPending:pending},updated_at:new Date(Math.max(Date.now(),Date.parse(position.updated_at)+1)).toISOString()}).eq("id",position.id).eq("updated_at",position.updated_at).select("*").maybeSingle();
      if(up.error||!up.data)throw Error("ENTRY_ACCOUNTING_CAS_CONFLICT");position=up.data;
    }
  }else{
    const manual=await manualPositionAllowances(db);
    const pf=await gw({action:"p10_portfolio"});
    if(manual.some(x=>x.symbol===s.symbol)||!entryExposureMatches(pf,s.symbol,receipt.quantity))throw Error("ENTRY_EXPOSURE_UNPROVEN");
    const sized={sizedMargin:receipt.quantity*receipt.price/LEV};
    await verifyExecutionLease(db);
    const stopPct=Number(f.exitPolicy?.stopPct);if(!(stopPct>0&&stopPct<1))throw new Error("STOP_POLICY_INVALID");const stop=z.avg*(1-stopPct);if(!(stop>0&&stop<z.avg))throw new Error("STOP_INVALID");
    const settledAt=Date.now(),intentAt=Date.parse(intent.created_at),fillAt=Number(receipt.lastAt),
      entryAt=Number.isFinite(fillAt)&&fillAt>0&&fillAt<=settledAt+1000&&
        (!Number.isFinite(intentAt)||fillAt>=intentAt-30000)?fillAt:settledAt,
      now=new Date(entryAt),entryPolicy=intent.request_payload?.entry_execution_policy,
      // Stamped from the ORDER INTENT, so an already-open position can never be
      // opted into this policy by a later deploy: the stamp is fixed at entry.
      entryTiming=rec(intent.request_payload?.entry_timing_policy),
      entryController=rec(intent.request_payload?.entry_controller),
      fillGuard=entryPolicy?.version===ENTRY_EXECUTION_POLICY_VERSION?postFillEntryGuard(f,z.avg):null,
      pos=await db.from("v11_long_regime_positions").insert({signal_id:s.id,revision:REVISION,entry_lane:"BULL",active_lane:"BULL",transition_from:null,symbol:s.symbol,side:"LONG",original_quantity:z.qty,remaining_quantity:z.qty,entry_price:z.avg,entry_at:now.toISOString(),entry_atr:atr,entry_bb_pos:N(f.bbPos,0),hard_stop_price:stop,hard_deadline:new Date(now.getTime()+POLICY.maxHoldMs).toISOString(),active_since:now.toISOString(),active_ref_bb:N(f.bbPos,0),active_target_delta:null,t1_completed:false,peak_price:z.avg,last_evaluated_at:now.toISOString(),state:"OPEN",realized_pnl_usdt:receipt.exact?-receipt.fee:null,entry_fee_usdt:receipt.fee,metadata:{entrySelectionPolicyVersion:intent.request_payload?.entry_selection?.version??null,b06133:intent.request_payload?.entry_selection??null,v30Front:intent.request_payload?.entry_front??null,entryBranch:intent.request_payload?.entry_branch??null,entryControllerPolicyVersion:entryController?.version??null,cec0040:entryController?.version===CEC0040_VERSION?entryController:null,gptEntryDecision:intent.request_payload?.entry_gpt_decision??null,finalRecheck:intent.request_payload?.entry_final_recheck??null,qv3:entryTiming?.version===SETUP_POLICY_VERSION?null:(intent.request_payload?.qv3?.version===QV3_VERSION&&intent.request_payload.qv3.basis===QV3_ACTIVATION_BASIS&&Date.parse(intent.created_at)>=Number(intent.request_payload.qv3.activation)?qv3Stamp(intent.request_payload.qv3.activation,now.getTime()):null),entryTimingPolicyVersion:entryTiming?.version??null,entryTimingSetup:entryTiming?.setup??null,v18SettledPnl:receipt.exact?-receipt.fee:0,v18EntryAccountingPending:!receipt.exact,exitAccountingPending:!receipt.exact,executionMode:STRATEGY,leaderExitPolicy:f.exitPolicy,fd1HoldPolicyVersion:FD1_HOLD_POLICY_VERSION,leaderExitPolicyVersion:entryController?.version===CEC0040_VERSION&&entryController.enforcementEnabled===true?P142_POLICY_VERSION:EXIT_REVIEW_R5.policyVersion,entryExecutionPolicyVersion:fillGuard?.version??null,postFillEntryGuard:fillGuard,entryConfirmationPolicyVersion:intent.request_payload?.e1?.policyVersion??null,entryConfirmation:intent.request_payload?.e1??null,exitObservationPolicyVersion:intent.request_payload?.x1?.policyVersion??null,x1Observation:{observedBidPeak:z.avg,executableVwapPeak:null,lastObservationId:null,lastObservationAt:null,source:"P10_TOP_OF_BOOK_BATCH",maxQuoteAgeMs:1000},entryMarketRules:{priceTick:N(intent.request_payload?.price_tick),quantityStep:N(intent.request_payload?.quantity_step)},operatorOverride:intent.request_payload?.operator_override??null,leaderLastHighAt:now.toISOString(),entryFillAt:receipt.lastAt??null,entryRecordedAt:new Date(settledAt).toISOString(),executorPatch:PATCH,maxSlots:MAX_SLOTS,setupMaxConcurrent:SETUP_MAX_CONCURRENT,targetMarginUsdt:MARGIN,sizedMarginUsdt:sized.sizedMargin,lastAppliedOrderId:intent.id,entryOrderId:z.exchangeOrderId,entryFeatures:f}}).select("*").single();
    if(pos.error)throw Error(`POSITION:${pos.error.message}`);position=pos.data;
  }
  await verifyExecutionLease(db);
  const wr=await db.from("v11_long_regime_orders").update({state:receipt.exact?"FILLED":"RECONCILIATION_PENDING",exchange_order_id:receipt.id,
    response_payload:{...raw,v18ExposureFinal:true},position_id:position.id,reject_reason:null,updated_at:new Date().toISOString()}).eq("id",intent.id);
  if(wr.error)throw Error("ENTRY_ORDER_WRITE");
  const sr=await db.from("v11_long_regime_signals").update({status:position.state==="CLOSED"?"CLOSED":"FILLED",position_id:position.id,updated_at:new Date().toISOString()}).eq("id",s.id);
  if(sr.error)throw Error("ENTRY_SIGNAL_WRITE");
  // The exposure and accounting are already known and durable. A controller-ledger
  // outage must not rewrite that settled order as ambiguous; the next cycle repairs
  // the missing row, and the atomic decision RPC blocks new entries until it exists.
  try{await registerCec0040Target(db,position,s)}
  catch(error){console.error("CEC0040_TARGET_REGISTER_DEFERRED",position.id,String(error?.message??error))}
  return position;
}
async function readOpsPositions(db) {
  const r=await db.from("v11_long_regime_positions").select("*").eq("state","OPEN").order("entry_at",{ascending:true}).limit(101);
  if(r.error)throw Error(`POSITIONS:${r.error.message}`);if((r.data??[]).length>100)throw Error("POSITION_RECONCILIATION_BACKLOG_OVERFLOW");return r.data??[];
}
async function readOpsOrders(db,positions=[]) {
  const [pending,accounting,entries]=await Promise.all([
    db.from("v11_long_regime_orders").select("*").in("state",["PLANNED","DISPATCHED","RECONCILIATION_FAILED","RECONCILIATION_PENDING"]).or("response_payload->>v18ExposureFinal.is.null,response_payload->>v18ExposureFinal.neq.true").order("updated_at",{ascending:true}).limit(101),
    db.from("v11_long_regime_orders").select("*").in("state",["RECONCILIATION_FAILED","RECONCILIATION_PENDING"]).eq("response_payload->>v18ExposureFinal","true").order("updated_at",{ascending:true}).limit(3),
    positions.length?db.from("v11_long_regime_orders").select("*").in("position_id",positions.map(p=>p.id)):Promise.resolve({data:[]})]);
  if(pending.error||accounting.error||entries.error)throw Error("ORDERS_READ");
  if(pending.data?.length>100)throw Error("RECONCILIATION_BACKLOG_OVERFLOW");
  return [...new Map([...(pending.data??[]),...(accounting.data??[]),...(entries.data??[])].map(o=>[o.id,o])).values()];
}
// classifyPortfolio accepts an account observation only while it is younger than
// freshPortfolio's 3s budget. Every DB read this pair needs therefore runs BEFORE the
// fetch: reading first and fetching last leaves the whole budget for the exchange round
// trip instead of spending it on our own. Ordering the other way spent 3.5-5.0s of it on
// four DB round trips and failed healthy cycles as INCOMPLETE_OR_STALE_SNAPSHOT, which
// holds account entry and escalates to MANUAL_REVIEW_REQUIRED on repeat.
// candidateSymbol folds the entry candidate's open orders into the same batch so a
// candidate check costs no extra round trip against the observation's lifetime.
async function readOpsPair(db,gw=opsGateway(db),candidateSymbol=null) {
  const candidate=candidateSymbol==null?null:String(candidateSymbol).toUpperCase();
  const positions=await readOpsPositions(db);
  const [manual,baseOrders,quarantines,candidateOrders]=await Promise.all([manualPositionAllowances(db),readOpsOrders(db,positions),
    db.from("v18_ops_incidents").select("id,generation,kind,reason,symbol,status,control_scope,exposure_state,accounting_state,order_source,evidence_version,recheck_conditions,last_checked_at,evidence")
      .eq("exchange","binance_futures").eq("account_scope","futures").eq("control_scope","SYMBOL_QUARANTINE")
      .in("status",["OPEN","VERIFYING"]).order("last_checked_at",{ascending:true}).limit(101),
    candidate?db.from("v11_long_regime_orders").select("*").eq("symbol",candidate)
      .in("state",["PLANNED","DISPATCHED","RECONCILIATION_FAILED","RECONCILIATION_PENDING"])
      .order("updated_at",{ascending:true}).limit(101):Promise.resolve({data:[]})]);
  if(quarantines.error)throw Error("SYMBOL_QUARANTINE_READ");
  if((quarantines.data??[]).length>100)throw Error("SYMBOL_QUARANTINE_BACKLOG_OVERFLOW");
  if(candidateOrders.error)throw Error("CANDIDATE_ORDERS_READ");
  if((candidateOrders.data??[]).length>100)throw Error("CANDIDATE_ORDER_BACKLOG_OVERFLOW");
  const orders=candidate?[...new Map([...baseOrders,...(candidateOrders.data??[])].map(o=>[o.id,o])).values()]:baseOrders;
  const pf=await gw({action:"p10_portfolio"},3000);
  return {pf,positions,manual,orders,quarantines:quarantines.data??[],match:classifyPortfolio(positions,pf,{manual,orders})};
}
function opsGateway(db){return scopedGateway(db,cycleBudgets.get(db)??createBudget({ms:55000,calls:160}));}
function scopedGateway(db,budget) {
  return async(cmd,timeout=20000)=>{
    const cycle=cycleBudgets.get(db),cost=cmd.action==="v17_stop_fill"?3:["v18_open_orders","trade_history","order_history"].includes(cmd.action)?2:1;
    const left=Math.min(budget.take(cost),cycle&&cycle!==budget?cycle.take(cost):Infinity);
    await verifyExecutionLease(db);
    const write=["create_order","v17_create_stop","v17_cancel_stop"].includes(cmd.action);
    const result=await exchangeGateway(cmd,Math.max(1,Math.min(timeout,left,write?12000:2500)));
    await verifyExecutionLease(db);return result;
  };
}
async function readClosedProtectionBacklog(db,limit=100) {
  const r=await db.rpc("v18_closed_protection_backlog",{p_limit:limit});
  if(r.error)throw Error("CLOSED_PROTECTION_READ");
  if(!Array.isArray(r.data?.rows)||typeof r.data?.complete!=="boolean")throw Error("CLOSED_PROTECTION_RESPONSE");
  return {rows:r.data.rows,complete:r.data.complete};
}
async function reconcileDbOnlyPosition(db,p,gw,scopeIncident=null) {
  const start=new Date(Date.parse(p.entry_at)-5000).toISOString(),startMs=Date.parse(start),endMs=Date.now();
  const [fills,lifecycles,laneOrders,accountTrades,orderHistory,portfolio,openOrders]=await Promise.all([
    db.from("exchange_trade_fills").select("exchange,account_scope,market,exchange_trade_id,exchange_order_id,client_order_id,side,price,quantity,quote_amount,fee_quote_amount,realized_pnl_quote,accounting_status,executed_at,v17_order_id,v17_position_id,source")
      .eq("exchange","binance_futures").eq("account_scope","futures").eq("market",p.symbol).eq("side","SELL")
      .gte("executed_at",start).order("executed_at",{ascending:true}).limit(1001),
    db.from("v11_long_regime_positions").select("*").eq("symbol",p.symbol).order("entry_at",{ascending:true}).limit(101),
    db.from("v11_long_regime_orders").select("*").eq("position_id",p.id).order("created_at",{ascending:true}).limit(101),
    gw({action:"trade_history",market:p.symbol,limit:1000},5000),
    gw({action:"order_history",market:p.symbol,start_time:startMs,end_time:endMs,limit:1000},5000),
    gw({action:"p10_portfolio"},5000),gw({action:"v18_open_orders"},5000)
  ]);
  if(fills.error||lifecycles.error||laneOrders.error)throw Error("DB_ONLY_EVIDENCE_READ");
  const trades=Array.isArray(accountTrades)?accountTrades:[],orders=Array.isArray(orderHistory)?orderHistory:[];
  const after=trades.filter(x=>x?.isBuyer===false&&Number(x?.time)>Date.parse(p.entry_at));
  const ids=[...new Set(after.map(x=>String(x?.orderId??"")).filter(Boolean))];
  const exact=ids.length===1?orders.find(x=>String(x?.orderId??"")===ids[0]):null;
  let algo=null;
  if(exact?.clientOrderId){
    const owners=(lifecycles.data??[]).flatMap(position=>(position.metadata?.exitProtection?.orders??[])
      .filter(o=>String(o?.clientId??o?.spec?.params?.clientAlgoId??"")===String(exact.clientOrderId)).map(order=>({position,order})));
    if(owners.length===1){
      try{algo=await gw({action:"v17_query_stop",symbol:p.symbol,clientAlgoId:String(exact.clientOrderId)},5000);}
      catch(e){return {outcome:"UNRESOLVED",inspectionPerformed:true,evidenceSecured:false,quantityResolved:false,
        attributionComplete:false,accountingComplete:false,reason:`NATIVE_ALGO_QUERY:${String(e.message??e)}`};}
    }
  }
  const complete=(fills.data??[]).length<1001&&(lifecycles.data??[]).length<101&&(laneOrders.data??[]).length<101;
  const proof=analyzeDbOnlyExit({position:p,lifecyclePositions:lifecycles.data,laneOrders:laneOrders.data,
    ledgerFills:fills.data,accountTrades:trades,orderHistory:orders,algo,portfolio,openOrders,
    tradeHistoryComplete:complete&&trades.length<1000,orderHistoryComplete:complete&&orders.length<1000});
  if(!proof.settlementPermitted)return proof;
  const controls=await opsControls(db),selected=scopeIncident??(controls.runtime.circuit_open?{
    id:controls.runtime.incident_id,generation:controls.runtime.incident_generation}:null);
  if(!selected?.id||!Number.isFinite(Number(selected.generation)))return {...proof,outcome:"UNRESOLVED",
    accountingComplete:false,reason:"SETTLEMENT_INCIDENT_MISSING"};
  await verifyExecutionLease(db);
  const settled=await db.rpc("v18_settle_db_only_exit",{p_owner:leaseOwners.get(db),
    p_incident_id:selected.id,p_generation:Number(selected.generation),
    p_position_id:p.id,p_evidence:proof.evidence});
  if(settled.error)throw Error(`DB_ONLY_SETTLEMENT:${settled.error.message}`);
  if(settled.data?.settled!==true)return {...proof,outcome:"UNRESOLVED",accountingComplete:false,
    reason:settled.data?.reason??"SETTLEMENT_REJECTED"};
  return {...proof,outcome:"RESOLVED",accountingComplete:true,settlement:sortedRecord(settled.data),
    executedQuantity:proof.evidence.quantity};
}
function sortedRecord(x){return rec(x);}
async function recordMismatch(db,match) {
  const all=[...(match.issues??[]),...(match.accounting??[])];if(!all.length)return[];
  const rank=x=>x.controlScope===CONTROL_SCOPE.ACCOUNT_RISK_BLOCK?4:x.controlScope===CONTROL_SCOPE.ACCOUNT_ENTRY_HOLD?3:
    x.accountingState==="CONFLICT"?2:1,results=[];
  const account=all.filter(x=>[CONTROL_SCOPE.ACCOUNT_ENTRY_HOLD,CONTROL_SCOPE.ACCOUNT_RISK_BLOCK].includes(x.controlScope));
  if(account.length){
    const chosen=[...account].sort((a,b)=>rank(b)-rank(a)||String(a.kind).localeCompare(String(b.kind)))[0],
      kind=chosen.kind==="UNKNOWN_ORDER_OUTCOME"&&chosen.orderId?"KNOWN_ORDER_PENDING_RECONCILIATION":chosen.kind;
    results.push(await incident(db,{reason:account.map(x=>`${x.kind}:${x.symbol||"ACCOUNT"}`).sort().join(";"),kind,
      controlScope:chosen.controlScope,state:{exposureState:chosen.exposureState,accountingState:chosen.accountingState,
        orderSource:chosen.orderSource,recheck:chosen.recheck},evidence:{issues:account,observation:match.snapshot}}));
  }
  const bySymbol=new Map();
  for(const issue of all.filter(x=>x.controlScope===CONTROL_SCOPE.SYMBOL_QUARANTINE&&x.symbol)){
    const old=bySymbol.get(issue.symbol);if(!old||rank(issue)>rank(old))bySymbol.set(issue.symbol,issue);
  }
  for(const [symbol,issue] of [...bySymbol].sort(([a],[b])=>a.localeCompare(b))){
    const related=all.filter(x=>x.symbol===symbol&&x.controlScope===CONTROL_SCOPE.SYMBOL_QUARANTINE);
    results.push(await incident(db,{reason:related.map(x=>`${x.kind}:${symbol}`).sort().join(";"),kind:issue.kind,
      controlScope:CONTROL_SCOPE.SYMBOL_QUARANTINE,symbol,state:{exposureState:issue.exposureState,
        accountingState:issue.accountingState,orderSource:issue.orderSource,recheck:issue.recheck},
      evidence:{...issue,related,observation:match.snapshot}}));
  }
  return results;
}
/**
 * How long after an intent was written a definitive exchange "not found" can still be
 * read as proof that the order never existed.
 *
 * Binance answers a query by origClientOrderId with -2013 for BOTH "never accepted"
 * and "too old to still be queryable", and those must never be conflated. The window
 * is what separates them: inside it the exchange is still able to answer about any
 * order it accepted, so a not-found means it accepted none. Well inside Binance's own
 * retention, because the only orders this path is for are minutes old.
 */
const NEVER_PLACED_PROOF_MAX_AGE_MS=6*3600000;
/**
 * Settle an entry intent that the exchange proves it never accepted.
 *
 * This is the narrowest possible escape from the deadlock described at the call site,
 * and every condition below is load-bearing:
 *
 *   - OPEN_LONG only. An exit intent that cannot be reconciled must keep holding the
 *     account: a position may be live and unprotected, which is the opposite risk.
 *   - No exchange_order_id. If the gateway ever handed back an id, the exchange saw
 *     the order and this path is not applicable.
 *   - The reconciliation error is a DEFINITIVE not-found, not a timeout, a 5xx, an
 *     auth failure or an unreachable gateway. Unknown stays unknown.
 *   - The intent is younger than NEVER_PLACED_PROOF_MAX_AGE_MS, so the not-found
 *     cannot be Binance's retention window rather than the order's absence.
 *   - The gateway's own proof comes back `proven`: the exchange does not know the id,
 *     the account holds nothing in that symbol, and BOTH corroborating reads
 *     succeeded. A partial answer is not a proof.
 *
 * It writes no position, no fill and no exposure -- it records that an order which was
 * never sent was never sent. Returns null when anything is short of proven, and the
 * caller then reports the original error and the account keeps holding.
 */
async function settleNeverPlacedEntry(db,order,error,gw){
  const message=String(error?.message??error??"");
  if(order.intent!=="OPEN_LONG"||order.exchange_order_id!=null)return null;
  if(!/-2013|order does not exist/i.test(message))return null;
  const createdAt=Date.parse(order.created_at);
  if(!Number.isFinite(createdAt)||Date.now()-createdAt>NEVER_PLACED_PROOF_MAX_AGE_MS)return null;
  let proof;
  try{proof=await gw({action:"v18_entry_never_placed_proof",market:order.symbol,
    identifier:order.client_order_id},5000);}
  catch(e){
    if(classifyFailure(e).fatal)throw e;
    return {orderId:order.id,error:`NEVER_PLACED_PROOF_UNAVAILABLE:${String(e?.message??e)}`};
  }
  if(proof?.proven!==true||proof.found!==false||N(proof.position_quantity,NaN)!==0||
     proof.position_read_ok!==true||proof.trade_read_ok!==true){
    return {orderId:order.id,outcome:"UNRESOLVED",inspectionPerformed:true,evidenceSecured:false,
      reason:"NEVER_PLACED_NOT_PROVEN",proof:proof??null};
  }
  await verifyExecutionLease(db);
  const evidence={neverPlaced:true,provenAt:new Date().toISOString(),
    lookupCode:proof.lookup_code??null,positionQuantity:proof.position_quantity,
    recentTradeCount:proof.recent_trade_count,source:proof.source,
    observedAtMs:proof.observed_at_ms,gatewayRejection:order.reject_reason??null,
    // The flag riskOrders reads. Setting it is what lets the account resume, so it is
    // written only on the proven branch and only together with the evidence above.
    v18ExposureFinal:true};
  const wr=await db.from("v11_long_regime_orders").update({state:"REJECTED",
    reject_reason:`ORDER_NEVER_PLACED:${String(order.reject_reason??message).slice(0,400)}`,
    response_payload:{...rec(order.response_payload),v18EntryNeverPlaced:evidence,
      v18ExposureFinal:true},
    updated_at:new Date().toISOString()}).eq("id",order.id).eq("state",order.state);
  if(wr.error)throw Error(`NEVER_PLACED_WRITE:${wr.error.message}`);
  // The signal is retired with the same fact, so the candidate is not reopened and
  // re-refused on the next cycle.
  await db.from("v11_long_regime_signals").update({status:"REJECTED",
    reject_reason:`ORDER_NEVER_PLACED:${String(order.reject_reason??message).slice(0,400)}`,
    updated_at:new Date().toISOString()}).eq("id",order.signal_id).neq("status","REJECTED");
  await audit(db,null,"BULL","BULL","ENTRY_REJECT","ORDER_NEVER_PLACED",
    {signalId:order.signal_id,symbol:order.symbol,stage:"NEVER_PLACED_SETTLEMENT",
      finalAdmission:false,orderDispatched:false,orderId:order.id,evidence})
    .catch(()=>console.error("V17_NEVER_PLACED_AUDIT_FAILED",order.id));
  return {orderId:order.id,outcome:"RESOLVED",inspectionPerformed:true,evidenceSecured:true,
    quantityResolved:true,attributionComplete:true,accountingComplete:true,settled:true,
    executedQuantity:0,reason:"ORDER_NEVER_PLACED"};
}
async function reconcileOps(db,pair,budget=createBudget({ms:8000,calls:18})) {
  const gw=scopedGateway(db,budget),results=[];
  // Exposure-uncertain order identity gets the first reconciliation budget.
  // Closed native-stop cleanup remains bounded and runs immediately afterward.
  for(const o of pair.orders.filter(o=>["PLANNED","DISPATCHED","RECONCILIATION_PENDING","RECONCILIATION_FAILED"].includes(o.state)).slice(0,3)){
    if(budget.remaining()<500)break;
    try{
      await verifyExecutionLease(db);
      const touched=await db.from("v11_long_regime_orders").update({response_payload:{...rec(o.response_payload),v18LastReconcileAt:new Date().toISOString()},updated_at:new Date(Math.max(Date.now(),Date.parse(o.updated_at)+1)).toISOString()}).eq("id",o.id).eq("updated_at",o.updated_at).select("*").maybeSingle();
      if(touched.error||!touched.data)throw Error("ORDER_RECONCILE_CAS_CONFLICT");
      const raw=await gw({action:"get_order",market:o.symbol,identifier:o.client_order_id,exchange_order_id:o.exchange_order_id});
      if(o.intent==="OPEN_LONG") {
        const pos=await settleKnownEntry(db,o,raw,gw);
        if(pos?.state==="OPEN")await protectNewLeaderPosition({enabled:NATIVE_STOP_ENABLED,position:pos,manualSymbols:pair.manual.map(x=>x.symbol),readPortfolio:()=>gw({action:"p10_portfolio"}),manage:ctx=>manageLeader(db,pos,{...ctx,gateway:gw})});
        const complete=!pos||pos.metadata?.v18EntryAccountingPending!==true;
        results.push({orderId:o.id,outcome:complete?"RESOLVED":"UNRESOLVED",inspectionPerformed:true,evidenceSecured:true,
          quantityResolved:true,attributionComplete:true,accountingComplete:complete,settled:complete,
          reason:complete?null:"ACCOUNTING_DETAILS_PENDING"});continue;
      }
      const row=await db.from("v11_long_regime_positions").select("*").eq("id",o.position_id).single();
      if(row.error||!row.data)throw Error("RECONCILE_POSITION_READ");
      const settled=await applyExitReceipt(db,row.data,o,raw,await gw({action:"p10_portfolio"}),{verifyLease:()=>verifyExecutionLease(db)}),
        complete=settled.accountingPending!==true;
      results.push({orderId:o.id,outcome:complete?"RESOLVED":"UNRESOLVED",inspectionPerformed:true,evidenceSecured:true,
        quantityResolved:true,attributionComplete:true,accountingComplete:complete,settled:complete,
        reason:complete?null:"ACCOUNTING_DETAILS_PENDING"});
    }catch(e){
      if(classifyFailure(e).fatal)throw e;
      // An order this gateway refused in its OWN validation was never signed, never
      // sent, and cannot have an identity on the exchange -- but the executor only
      // saw a failed create_order, which it must treat as ambiguous. The query above
      // then asks Binance about it, gets -2013, and throws. Every cycle. The intent
      // stays in riskOrders, recoveryEvidence stays ineligible, and the account is
      // held forever over exposure that does not exist: 2026-09-18, DYDXUSDT refused
      // at 10:21:09 for a 40 USDT floor the slot had not used since 2026-09-16, still
      // holding the account 45 minutes later with a flat book and a flat exchange.
      //
      // So the not-found is ESTABLISHED rather than assumed, and only then settles.
      // Anything short of the full proof leaves the order exactly where it is.
      const settled=await settleNeverPlacedEntry(db,o,e,gw);
      results.push(settled??{orderId:o.id,error:String(e.message??e)});
    }
  }
  // Management has already had its turn. Work only three oldest affected items per cycle.
  const ids=new Set(pair.match.issues.map(i=>i.positionId).filter(Boolean));
  const closedPending=await readClosedProtectionBacklog(db);
  const byAge=(a,b)=>Date.parse(a.metadata?.v18ReconcileAt??a.updated_at)-Date.parse(b.metadata?.v18ReconcileAt??b.updated_at),
    affected=pair.positions.filter(p=>ids.has(p.id)).sort(byAge),closed=closedPending.rows.sort(byAge);
  // An observed live mismatch gets the first turn; closed-stop cleanup uses the
  // remaining bounded slots and cannot starve the incident that raised the circuit.
  const candidates=[...affected.slice(0,2),...closed.slice(0,Math.max(0,3-Math.min(2,affected.length)))];
  for(const candidate of candidates){
    if(budget.remaining()<500)break;
    try{
      let p=candidate;
      // Persist progress/fairness with CAS before any exchange read; failure never changes exposure.
      await verifyExecutionLease(db);
      const touched=await db.from("v11_long_regime_positions").update({metadata:{...p.metadata,v18ReconcileAt:new Date().toISOString()},updated_at:new Date(Math.max(Date.now(),Date.parse(p.updated_at)+1)).toISOString()}).eq("id",p.id).eq("updated_at",p.updated_at).select("*").maybeSingle();
      if(touched.error||!touched.data)throw Error("RECONCILE_CAS_CONFLICT");
      p=touched.data;
      if((p.metadata?.exitProtection?.orders??[]).length){
        const manager=createGatewayProtection(db,gw,()=>verifyExecutionLease(db));
        const refreshed=p.state==="CLOSED"?await manager.ensure(p.id,{stopPrice:1,priceTick:1,quantityStep:1,
          exchangeQuantity:0,positionMode:"ONE_WAY",manualSymbols:[]}):await manager.refresh(p.id);
        const state=refreshed.state??refreshed;
        if(state.position.remainingQuantity<N(p.remaining_quantity))results.push({positionId:p.id,outcome:"RESOLVED",
          inspectionPerformed:true,evidenceSecured:true,quantityResolved:true,attributionComplete:true,
          accountingComplete:state.position.accountingPending!==true,executedQuantity:N(p.remaining_quantity)-state.position.remainingQuantity});
        if(state.protection.orders.some(o=>!o.terminal&&(o.lastQueryError||o.accountingPending)))throw Error("NATIVE_RECONCILIATION_PENDING");
        if(p.state!=="CLOSED"&&state.position.state==="CLOSED")continue;
        if(p.state==="CLOSED"){
          const done=state.protection.orders.every(o=>o.terminal===true),accountingComplete=state.position.accountingPending!==true;
          results.push({positionId:p.id,operation:"CLOSED_PROTECTION_CLEANUP",outcome:done&&accountingComplete?"RESOLVED":"UNRESOLVED",
            inspectionPerformed:true,evidenceSecured:done,quantityResolved:true,attributionComplete:true,
            accountingComplete,protectionHealth:state.protection.health});
          continue;
        }
        const latest=await db.from("v11_long_regime_positions").select("*").eq("id",p.id).single();
        if(latest.error||!latest.data)throw Error("RECONCILE_POSITION_REFRESH");p=latest.data;
      }
      const issue=pair.match.issues.find(i=>i.positionId===p.id);
      if(issue?.kind==="DB_ONLY_POSITION"||issue?.kind==="KNOWN_EXIT_PENDING_RECONCILIATION"||issue?.kind==="QUANTITY_MISMATCH")
        results.push({positionId:p.id,...await reconcileDbOnlyPosition(db,p,gw,pair.quarantines.find(i=>i.symbol===p.symbol&&
          i.evidence?.positionId===p.id&&["DB_ONLY_POSITION","KNOWN_EXIT_PENDING_RECONCILIATION","QUANTITY_MISMATCH"].includes(i.kind)))});
      else results.push({positionId:p.id,outcome:"UNRESOLVED",inspectionPerformed:true,evidenceSecured:false,
        quantityResolved:false,attributionComplete:false,accountingComplete:false,reason:"NO_SETTLEMENT_EVIDENCE_PATH"});
    }catch(e){if(classifyFailure(e).fatal)throw e;results.push({positionId:candidate.id,error:String(e.message??e)});}
  }
  return results;
}
async function handleEntryMismatch(db,match) {
  await recordMismatch(db,match);
  const pair=await readOpsPair(db);
  await reconcileOps(db,pair);
  // Refresh both sides after reconciliation, regardless of whether anything was closed.
  const after=await readOpsPair(db);await verifyExecutionLease(db);
  await audit(db,null,null,null,"ENTRY_DEFERRED","PORTFOLIO_RACE",{before:match.issues,after:after.match.issues});
}
async function opsControls(db) {
  const [runtime,control,settings]=await Promise.all([
    db.from("v11_long_regime_runtime").select("*").eq("singleton",true).single(),
    db.from("v17_operator_control").select("*").eq("singleton",true).single(),
    db.from("trading_settings").select("*").eq("id",1).single()]);
  if(runtime.error||control.error||settings.error)throw Error("V18_CONTROLS_UNAVAILABLE");
  return {runtime:runtime.data,control:control.data,settings:settings.data};
}
/**
 * Pure entry-control decision from controls the caller already read. Same split,
 * and for the same reason, as booVerdict: at the dispatch point the proposed margin
 * is only known AFTER the pricing quote, so this has to run after it -- and anything
 * that runs after it must not be a network read, or the quote is stale before the
 * order is written.
 */
function decideEntryWith(controls,pair,candidateSymbol,openOrders,{proposedMargin=0,cashBuffer=0,managementFailures=[]}={}) {
  return evaluateEntryDecision({candidateSymbol,classification:pair.match,portfolio:pair.pf,openOrders,
    positions:pair.positions,orders:pair.orders,quarantines:pair.quarantines,
    manualSymbols:pair.manual.map(x=>x.symbol),managementFailures,runtime:controls.runtime,operator:controls.control,settings:controls.settings,
    maxSlots:MAX_SLOTS,proposedMargin,cashBuffer,requireNativeProtection:NATIVE_STOP_ENABLED});
}
async function decideEntry(db,pair,candidateSymbol,openOrders,opts={}) {
  return decideEntryWith(await opsControls(db),pair,candidateSymbol,openOrders,opts);
}
async function persistDecisionRisk(db,pair,decision) {
  for(const q of decision.discoveredQuarantines??[]){
    if(pair.quarantines.some(x=>x.symbol===q.symbol&&["OPEN","VERIFYING"].includes(x.status)))continue;
    await incident(db,{reason:`${q.kind}:${q.symbol}:${q.orderId||"UNKNOWN"}`,kind:q.kind,
      controlScope:CONTROL_SCOPE.SYMBOL_QUARANTINE,symbol:q.symbol,
      state:{exposureState:q.exposureState,accountingState:q.accountingState,orderSource:q.orderSource,recheck:q.recheck},
      evidence:{...q,decisionEvidence:decision.evidence}});
  }
  if(decision.allowed||decision.scope===CONTROL_SCOPE.OPERATOR_HALT)return;
  const reasons=decision.reasons??[],alreadyClassified=(pair.match.issues??[]).some(x=>
    [CONTROL_SCOPE.ACCOUNT_ENTRY_HOLD,CONTROL_SCOPE.ACCOUNT_RISK_BLOCK].includes(x.controlScope))||
    decision.scope===CONTROL_SCOPE.SYMBOL_QUARANTINE&&((pair.match.issues??[]).some(x=>x.symbol===decision.symbol)||
      (pair.match.accounting??[]).some(x=>x.symbol===decision.symbol)||pair.quarantines.some(x=>x.symbol===decision.symbol));
  if(alreadyClassified||reasons.every(x=>/ACCOUNT_(MARGIN|SLOT)_LIMIT|LIVE_EXPOSURE_EXISTS/.test(x)))return;
  const symbol=decision.scope===CONTROL_SCOPE.SYMBOL_QUARANTINE?decision.symbol:null,
    exposure=symbol&&pair.pf.positions.some(x=>sym(x)===symbol&&qty(x)>0)?"HELD":
      reasons.some(x=>/INCOMPLETE|UNPROVEN|UNBOUNDED/.test(x))?"UNKNOWN":"FLAT",
    kind=reasons.some(x=>/EVIDENCE_INCOMPLETE_OR_STALE|OPEN_ORDER_EVIDENCE/.test(x))?"INCOMPLETE_OR_STALE_SNAPSHOT":
      reasons.some(x=>/ORDINARY_ORDER/.test(x))?"UNKNOWN_ORDER_OUTCOME":
      reasons.some(x=>/CONDITIONAL_ORDER/.test(x))?"IDENTITY_OR_SIDE_MISMATCH":"ACCOUNT_RISK_UNBOUNDED";
  await incident(db,{reason:reasons.join(";")||"ENTRY_RISK_UNVERIFIED",kind,controlScope:decision.scope,symbol,
    state:{exposureState:exposure,accountingState:"ATTRIBUTION_INVESTIGATING",orderSource:"UNKNOWN",recheck:decision.recheck},
    evidence:{decision,accountObservation:pair.pf.observation}});
}
async function attemptSymbolRecoveries(db,pair) {
  if(!pair.quarantines.length)return[];
  const live=await opsGateway(db)({action:"v18_open_orders"},5000),results=[];
  for(const active of pair.quarantines.slice(0,5)){
    const evidence=symbolRecoveryEvidence({incident:active,classification:pair.match,portfolio:pair.pf,
      openOrders:live,positions:pair.positions,orders:pair.orders});
    if(!evidence.clean){results.push({incidentId:active.id,symbol:active.symbol,resolved:false,reason:"EVIDENCE_INCOMPLETE"});continue;}
    await verifyExecutionLease(db);
    const r=await db.rpc("v19_symbol_recovery_observation",{p_owner:leaseOwners.get(db),p_incident_id:active.id,
      p_generation:Number(active.generation),p_evidence_version:ENTRY_CONTROL_VERSION,p_evidence:evidence});
    if(r.error)throw Error(`SYMBOL_RECOVERY_CAS:${r.error.message}`);results.push(r.data);
  }
  return results;
}
async function attemptOpsRecovery(db,pair,protectedIds) {
  const c=await opsControls(db);
  let incidentResolution=null;
  if(c.runtime.incident_id){
    const ir=await db.from("v18_ops_incidents").select("id,generation,resolution_evidence").eq("id",c.runtime.incident_id).maybeSingle();
    if(ir.error)throw Error("INCIDENT_EVIDENCE_READ");incidentResolution=ir.data?.resolution_evidence??null;
  }
  const evidence=recoveryEvidence({...c,classification:pair.match,orders:pair.orders,protectedIds,incidentResolution});
  if(!evidence.eligible)return {resolved:false,reason:"EVIDENCE_INCOMPLETE"};
  // The gateway independently fetches all ordinary AND algo orders; ACTIVE owned stops
  // are allowed. Unknown entry/close/algo orders are not a clean recovery observation.
  const live=await opsGateway(db)({action:"v18_open_orders"},5000);
  if(!confirmedLiveProtection(live,pair.positions))return {resolved:false,reason:"LIVE_ORDER_RISK"};
  // Changes during the read invalidate the proof. SQL validates this exact DB manifest
  // and locks the same incident generation + operator rows before the CAS.
  const after=await readOpsPair(db),again=await opsControls(db);
  if(!after.match.ok||JSON.stringify(after.positions.map(p=>[p.id,p.updated_at]))!==JSON.stringify(pair.positions.map(p=>[p.id,p.updated_at]))||
    again.runtime.incident_id!==evidence.incidentId||again.runtime.incident_generation!==evidence.generation)return {resolved:false,reason:"RECOVERY_CHANGED"};
  await verifyExecutionLease(db);
  const r=await db.rpc("v19_account_recovery_observation",{p_owner:leaseOwners.get(db),p_incident_id:evidence.incidentId,p_generation:evidence.generation,
    p_evidence_version:ENTRY_CONTROL_VERSION,p_evidence:{...evidence,observation:after.pf.observation,
      positions:after.positions.map(p=>({id:p.id,updated_at:p.updated_at,quantity:p.remaining_quantity})),ordersObservedAt:live.observed_at_ms}});
  // A lock timeout rolls the whole recovery transaction back: nothing changed and no
  // observation was recorded. Report it in this cycle's recovery result and retry on a
  // later cycle (SQL still enforces freshness/independence). Other errors stay fatal.
  if(r.error&&/lock timeout|55P03/i.test(`${r.error.code??""} ${r.error.message??""}`))
    return {resolved:false,reason:"RECOVERY_LOCK_BUSY",retryable:true};
  if(r.error)throw Error(`RECOVERY_CAS:${r.error.message}`);return r.data;
}
function x1TopObservation(row,p,at){
  const bid=N(row?.best_bid),ask=N(row?.best_ask),bidSize=N(row?.bids?.[0]?.size),timing=rec(row?.timing),
    receivedAt=N(timing.received_at_ms,NaN),requestedAt=N(timing.requested_at_ms,NaN),quantity=N(p.remaining_quantity),
    age=at-receivedAt,valid=!row?.error&&bid>0&&ask>=bid&&bidSize>0&&Number.isSafeInteger(receivedAt)&&
      Number.isSafeInteger(requestedAt)&&requestedAt<=receivedAt&&age>=0&&age<=1000,
    full=valid&&bidSize+Math.max(1e-12,quantity*1e-10)>=quantity;
  return{valid,full,bid,ask,bidSize,quantity,receivedAt,requestedAt,age,
    source:timing.source??"P10_TOP_OF_BOOK_BATCH",bookCapturedAtMs:timing.book_captured_at_ms??null,
    observationId:`x1:${p.id}:${Number.isSafeInteger(receivedAt)?receivedAt:at}`};
}
function x1LocalPolicy(p){
  const meta=rec(p.metadata),costUsable=p.entry_fee_usdt!=null&&Number.isFinite(Number(p.entry_fee_usdt))&&
    Number(p.entry_fee_usdt)>=0&&Number(p.original_quantity)>0,
    r5=meta.leaderExitPolicyVersion===EXIT_REVIEW_R5.policyVersion||
      meta.leaderExitPolicyVersion===P142_POLICY_VERSION;
  return{...POLICY,...(costUsable?(r5?EXIT_REVIEW_R5:EXIT_REVIEW_CANDIDATE):{}),...rec(meta.leaderExitPolicy)};
}
async function runX1FastObservation(db,pair,deadlineMs){
  const selected=(pair.match.safe??[]).filter(p=>rec(p.metadata).exitObservationPolicyVersion===X1_POLICY_VERSION&&
    rec(p.metadata).v17ManualPosition!==true&&p.state==="OPEN");
  const summary={enabled:X1_ENABLED,policyVersion:X1_POLICY_VERSION,baseExitPolicyVersion:EXIT_REVIEW_R5.policyVersion,
    operatorOverride:OPERATOR_OVERRIDE,selected:selected.length,iterations:0,validObservations:0,
    shallowObservations:0,unknownObservations:0,applied:[],errors:[],endedReason:X1_ENABLED?"NO_ELIGIBLE_POSITION":"FLAG_DISABLED"};
  if(!X1_ENABLED||!selected.length)return summary;
  const items=new Map(selected.map(p=>{const meta=rec(p.metadata),x=rec(meta.x1Observation);return[p.id,{p,
    peak:Math.max(N(p.peak_price),N(x.observedBidPeak)),peakAt:Date.parse(meta.leaderLastHighAt||p.entry_at),
    executablePeak:Number.isFinite(Number(x.executableVwapPeak))?Number(x.executableVwapPeak):null,
    candidateStop:N(p.hard_stop_price),lastPersistAt:Date.parse(p.last_evaluated_at||p.updated_at),
    lastStopSyncAt:Date.parse(x.lastStopSyncAt||0),latest:null}]}));
  const gw=opsGateway(db),maxIterations=45;let nextAt=Date.now();
  while(items.size&&summary.iterations<maxIterations&&Date.now()<deadlineMs-3500){
    const wait=Math.max(0,nextAt-Date.now());if(wait>0)await new Promise(resolve=>setTimeout(resolve,wait));
    if(Date.now()>=deadlineMs-3500||cycleBudgets.get(db)?.callsLeft<12){summary.endedReason="BUDGET_RESERVE";break}
    const rows=[...items.values()].map(x=>x.p.symbol);let quotes;
    try{quotes=await gw({action:"p10_quotes",markets:rows},2500)}
    catch(error){if(classifyFailure(error).fatal)throw error;summary.errors.push({at:Date.now(),reason:String(error.message??error)});
      summary.unknownObservations+=items.size;summary.iterations++;nextAt=Math.max(nextAt+1000,Date.now()+1);continue}
    const at=Date.now(),proposals=[];summary.iterations++;
    for(const item of items.values()){
      const row=Array.isArray(quotes)?quotes.find(q=>String(q.market).toUpperCase()===String(item.p.symbol).toUpperCase()):null,
        observation=x1TopObservation(row,item.p,at);
      if(!observation.valid){summary.unknownObservations++;continue}
      if(!observation.full){summary.shallowObservations++;continue}
      summary.validObservations++;
      const tick=N(rec(rec(item.p.metadata).entryMarketRules).priceTick);
      if(!(tick>0)){summary.unknownObservations++;summary.errors.push({positionId:item.p.id,reason:"X1_PRICE_TICK_UNKNOWN"});continue}
      const state=nextExitReviewed({entryPrice:N(item.p.entry_price),entryAt:Date.parse(item.p.entry_at),
        entryFee:Number(item.p.entry_fee_usdt),quantity:N(item.p.original_quantity),peakPrice:item.peak,
        stopPrice:item.candidateStop,lastHighAt:item.peakAt,priceTick:tick},observation.bid,at,x1LocalPolicy(item.p));
      item.peak=state.peakPrice;item.peakAt=state.lastHighAt;item.candidateStop=Math.max(item.candidateStop,state.stopPrice);
      item.executablePeak=Math.max(N(item.executablePeak),observation.bid);item.latest=observation;
      const persistedStop=N(item.p.hard_stop_price),persistedPeak=N(item.p.peak_price),
        stopDirty=item.candidateStop-persistedStop>=tick-Math.max(1e-12,tick*1e-8),
        peakDirty=item.peak>persistedPeak+Math.max(1e-12,persistedPeak*1e-12)||
          item.executablePeak>N(rec(item.p.metadata).x1Observation?.executableVwapPeak)+Math.max(1e-12,item.executablePeak*1e-12),
        stopDue=stopDirty&&(state.action==="CLOSE"||!Number.isFinite(item.lastStopSyncAt)||at-item.lastStopSyncAt>=5000),
        persistDue=peakDirty&&(!Number.isFinite(item.lastPersistAt)||at-item.lastPersistAt>=10000);
      if(state.action==="CLOSE"||stopDue||persistDue)proposals.push({item,observation,state,tick,stopDirty});
    }
    if(proposals.length){
      let check;
      try{check=await readOpsPair(db,gw);await recordMismatch(db,check.match)}
      catch(error){if(classifyFailure(error).fatal)throw error;summary.errors.push({at,reason:String(error.message??error)});check=null}
      for(const proposal of proposals){
        if(!check||cycleBudgets.get(db)?.callsLeft<8)break;
        const fresh=check.match.safe.find(p=>p.id===proposal.item.p.id&&
          rec(p.metadata).exitObservationPolicyVersion===X1_POLICY_VERSION);
        if(!fresh){items.delete(proposal.item.p.id);summary.errors.push({positionId:proposal.item.p.id,reason:"X1_OWNERSHIP_CHANGED"});continue}
        const applyAt=Date.now(),freshObservation=x1TopObservation({best_bid:proposal.observation.bid,best_ask:proposal.observation.ask,
          bids:[{price:proposal.observation.bid,size:proposal.observation.bidSize}],timing:{requested_at_ms:proposal.observation.requestedAt,
            received_at_ms:proposal.observation.receivedAt,book_captured_at_ms:proposal.observation.bookCapturedAtMs,
            source:proposal.observation.source}},fresh,applyAt);
        if(!freshObservation.valid||!freshObservation.full){summary.shallowObservations++;continue}
        try{
          const result=await manageLeader(db,fresh,{gateway:gw,
            cleanupGateway:scopedGateway(db,createBudget({ms:7000,calls:10})),manualSymbols:check.manual.map(x=>x.symbol),
            exchangeQuantity:new Map([[fresh.symbol,N(fresh.remaining_quantity)]]),evaluateQv3:false,fastObservation:true,
            observedQuote:{bid:freshObservation.bid,ask:freshObservation.ask,bidSize:freshObservation.bidSize,
              requestedAtMs:freshObservation.requestedAt,receivedAtMs:freshObservation.receivedAt,detectedAtMs:applyAt,
              bookCapturedAtMs:freshObservation.bookCapturedAtMs,source:freshObservation.source,
              observationId:freshObservation.observationId,fullQuantityExecutable:true,
              observedBidPeak:proposal.item.peak,observedBidPeakAt:proposal.item.peakAt,
              executableVwapPeak:proposal.item.executablePeak}});
          summary.applied.push({positionId:fresh.id,symbol:fresh.symbol,at:applyAt,observationId:freshObservation.observationId,
            action:result.action,reason:result.reason??null,stopBefore:N(fresh.hard_stop_price),
            stopAfter:N(result.stopPrice,N(fresh.hard_stop_price)),observedBidPeak:proposal.item.peak,
            executableVwapPeak:proposal.item.executablePeak,nativeStop:result.nativeStop??null});
          if(result.action==="CLOSE"){items.delete(fresh.id);continue}
          proposal.item.p=result.position??{...fresh,peak_price:result.peakPrice,hard_stop_price:result.stopPrice,
            updated_at:new Date(applyAt).toISOString(),last_evaluated_at:new Date(applyAt).toISOString()};
          proposal.item.candidateStop=N(result.stopPrice);proposal.item.lastPersistAt=applyAt;
          if(proposal.stopDirty)proposal.item.lastStopSyncAt=applyAt;
        }catch(error){if(classifyFailure(error).fatal)throw error;summary.errors.push({positionId:fresh.id,
          reason:String(error.message??error)});items.delete(fresh.id)}
      }
    }
    // Only after this observation and every detected protection action finish.
    // A ready hint cannot trade: release the normal lease, then re-run all guards.
    if(gptReviewReadyToResume(db)){summary.endedReason="GPT_REVIEW_READY";break;}
    nextAt=Math.max(nextAt+1000,Date.now()+1);
  }
  if(!summary.endedReason||["NO_ELIGIBLE_POSITION","FLAG_DISABLED"].includes(summary.endedReason))
    summary.endedReason=items.size?summary.iterations>=maxIterations?"MAX_ITERATIONS":"CYCLE_DEADLINE":"POSITIONS_CLOSED";
  return summary;
}
async function run(db) {
  const cycleStarted=new Date().toISOString();await verifyExecutionLease(db);
  const started=await db.from("v11_long_regime_runtime").update({last_cycle_started_at:cycleStarted}).eq("singleton",true);
  if(started.error)throw Error("HEARTBEAT_START_WRITE");
  let managed=[],reconciliation=[],entry={entered:false,reason:"NOT_EVALUATED"},recovery=null,symbolRecovery=[],
    x1Fast={enabled:X1_ENABLED,policyVersion:X1_POLICY_VERSION,selected:0,endedReason:"NOT_EVALUATED"},
    cec0040Targets={ok:false,checked:0,results:[],reason:"NOT_EVALUATED"},
    health="NOT_EVALUATED",fatal=null,pendingAge=null,entryEvaluationCompleted=false,accountEvidenceAt=null,symbolQuarantineObserved=false;
  try{
    const c=await opsControls(db);
    if(c.runtime.revision!==REVISION)throw Error("REVISION_MISMATCH");
    if(c.runtime.live_enabled!==true){entry.reason="RUNTIME_NOT_LIVE";return {ok:true,patch:PATCH,skipped:entry.reason};}
    let pair=await readOpsPair(db);
    accountEvidenceAt=freshPortfolio(pair.pf)?new Date(Number(pair.pf.observation.requested_at_ms)).toISOString():null;
    symbolQuarantineObserved=pair.quarantines.length>0||
      [...(pair.match.issues??[]),...(pair.match.accounting??[])].some(x=>x.controlScope===CONTROL_SCOPE.SYMBOL_QUARANTINE);
    await recordMismatch(db,pair.match);
    const protectedIds=new Set(),globalBudget=createBudget({ms:40000,calls:120});
    // No trading while an explicit manual intervention/emergency command owns the account.
    const safe=(c.settings.manual_intervention_required||c.settings.emergency_liquidation?[]:pair.match.safe).sort((a,b)=>Date.parse(a.last_evaluated_at)-Date.parse(b.last_evaluated_at));
    const tasks=await boundedMap(safe,3,async p=>{
      const local=createBudget({ms:10000,calls:18}),base=scopedGateway(db,local),gw=async(cmd,tm)=>{globalBudget.take(cmd.action==="v17_stop_fill"?3:cmd.action==="v18_open_orders"?2:1);return base(cmd,tm)};
      // Revalidate ownership and actual residual immediately before each position's work.
      const check=await readOpsPair(db,gw),fresh=check.match.safe.find(x=>x.id===p.id);
      if(!fresh)return {id:p.id,symbol:p.symbol,skipped:"OWNERSHIP_CHANGED"};
      const action=await manageBull(db,fresh,{route:"MOMENTUM"},{gateway:gw,
        cleanupGateway:scopedGateway(db,createBudget({ms:7000,calls:10})),manualSymbols:check.manual.map(x=>x.symbol),
        exchangeQuantity:new Map([[p.symbol,N(fresh.remaining_quantity)]]),quoteRetryBudget:{remaining:1}});
      if(action.nativeStop?.status==="PROTECTED")protectedIds.add(p.id);
      return {id:p.id,symbol:p.symbol,action};
    });
    managed=tasks.map((t,i)=>t.error?{id:safe[i]?.id,symbol:safe[i]?.symbol,error:String(t.error.message??t.error)}:t.value);
    for(const t of tasks)if(t.error&&classifyFailure(t.error).fatal)throw t.error;
    health=managed.some(x=>x.error||x.skipped)||safe.length<pair.positions.length?"DEGRADED":
      pair.positions.length===0?"FLAT":protectedIds.size===safe.length?"PROTECTED":"SOFTWARE_ONLY";
    // Native fills and software receipts share one bounded reconciliation turn.
    pair=await readOpsPair(db);
    pendingAge=Math.max(0,...pair.orders.filter(o=>["PLANNED","DISPATCHED","RECONCILIATION_PENDING","RECONCILIATION_FAILED"].includes(o.state)).map(o=>(Date.now()-Date.parse(o.created_at))/1000),...pair.match.issues.filter(i=>i.positionId).map(i=>(Date.now()-Date.parse(pair.positions.find(p=>p.id===i.positionId)?.last_evaluated_at))/1000));
    reconciliation=await reconcileOps(db,pair);
    pair=await readOpsPair(db);
    health=managed.some(x=>x.error||x.skipped)?"DEGRADED":!pair.match.ok?"DEGRADED":pair.positions.length===0?"FLAT":
      pair.positions.every(p=>protectedIds.has(p.id)||(p.metadata?.exitProtection?.health==="PROTECTED"&&
        (p.metadata?.exitProtection?.orders??[]).some(o=>o.terminal!==true&&["ACTIVE","NEW"].includes(o.status))))?"PROTECTED":"SOFTWARE_ONLY";
    await recordMismatch(db,pair.match);
    // Local incident recovery is independent from the account circuit.  It never
    // writes runtime/operator controls and requires distinct account observations.
    pair=await readOpsPair(db);symbolRecovery=await attemptSymbolRecoveries(db,pair);
    recovery=await attemptOpsRecovery(db,pair,protectedIds);
    // Target maintenance is isolated from position management. Public market-data or
    // shadow-ledger failures are telemetry here; the atomic controller RPC itself is
    // the authority that fails NEW entries closed when causal state is not ready.
    cec0040Targets=await refreshCec0040Targets(db);
    const controls=await opsControls(db);
    if(controls.runtime.circuit_open)entry.reason="CIRCUIT_OPEN_MANAGEMENT_ACTIVE";
    else if(!operatorAllowsRecovery(controls.runtime,controls.control,controls.settings))entry.reason="OPERATOR_ENTRY_BLOCK";
    else {
      pair.managementFailures=managed.filter(x=>x.error);
      const backlog=await readClosedProtectionBacklog(db,1000);
      entry=await runEntryQueue(db,pair,pair.manual,new Set(backlog.rows.map(p=>String(p.symbol).toUpperCase())),backlog.complete);
      entryEvaluationCompleted=true;
    }
    // The cron cadence remains one minute. Within this one bounded invocation X1 reads
    // top-of-book at most once per second and preserves enough time/API budget for the
    // heartbeat and the next lease holder. It never issues a periodic stop replacement.
    // Do not add even a read-only exchange/account call when X1 is disabled. This
    // keeps the rollback flag behavior-identical to the deployed baseline.
    if(X1_ENABLED){pair=await readOpsPair(db);x1Fast=await runX1FastObservation(db,pair,Date.parse(cycleStarted)+50000)}
    else x1Fast=await runX1FastObservation(db,pair,Date.parse(cycleStarted)+50000);
    // Entry can create a protected position after the first health calculation. Read
    // the final owned exposure so the same response/heartbeat cannot report FLAT while
    // a newly filled position and its resident stop are already live.
    if(X1_ENABLED||entry.entered){
      try{
        const finalPair=await readOpsPair(db);await recordMismatch(db,finalPair.match);pair=finalPair;
        if(freshPortfolio(pair.pf))accountEvidenceAt=new Date(Number(pair.pf.observation.requested_at_ms)).toISOString();
        health=managed.some(x=>x.error||x.skipped)?"DEGRADED":!pair.match.ok?"DEGRADED":pair.positions.length===0?"FLAT":
          pair.positions.every(p=>p.metadata?.exitProtection?.health==="PROTECTED"&&
            (p.metadata?.exitProtection?.orders??[]).some(o=>o.terminal!==true&&["ACTIVE","NEW"].includes(o.status)))?
            "PROTECTED":"SOFTWARE_ONLY";
      }catch(error){
        if(classifyFailure(error).fatal)throw error;
        health="DEGRADED";x1Fast.errors??=[];x1Fast.errors.push({at:Date.now(),reason:`FINAL_HEALTH:${String(error.message??error)}`});
      }
    }
    return {ok:true,revision:REVISION,patch:PATCH,entryExecutionPolicy:{version:ENTRY_EXECUTION_POLICY_VERSION,
      maxEntryDriftPct:POLICY.maxEntryDriftPct,scope:"NEW_FILLS_ONLY"},qv3Runtime:{version:QV3_VERSION,basis:QV3_ACTIVATION_BASIS,
      activation:QV3_LIVE_CUTOVER,active:Number.isSafeInteger(QV3_LIVE_CUTOVER)&&Date.now()>=QV3_LIVE_CUTOVER},
      b06133Runtime:{version:B06133_VERSION,scope:"NEW_ENTRIES_AFTER_PULLBACK_REACCEL_TRIGGER",enabled:true},
      cec0040Runtime:{version:CEC0040_VERSION,targetVersion:CEC0040_TARGET_VERSION,
        p142PolicyVersion:P142_POLICY_VERSION,targetRefresh:cec0040Targets},
      e1Runtime:{enabled:E1_ENABLED,policyVersion:E1_POLICY.policyVersion,...OPERATOR_OVERRIDE},
      x1Runtime:x1Fast,managed,reconciliation,entry,recovery,symbolRecovery,protectionHealth:health};
  }catch(e){fatal=e;entry.reason=String(e.message??e);throw e;}
  finally{
    // No stale executor writes after losing the lease; takeover owns the next heartbeat.
    if(!fatal||!classifyFailure(fatal).fatal){
      await verifyExecutionLease(db,true);const now=new Date().toISOString(),patch={last_cycle_completed_at:now,
        entry_block_reason:entry.entered?null:entry.reason,protection_health:health,reconciliation_pending_age:pendingAge,updated_at:now};
      if(accountEvidenceAt)patch.last_account_evidence_at=accountEvidenceAt;
      if(symbolQuarantineObserved)patch.last_symbol_quarantine_observed_at=now;
      if(entryEvaluationCompleted)patch.last_entry_evaluated_at=now;
      const managedExposureResolved=managed.some(x=>x.action?.result?.nativeReconciled||x.action?.result?.executedQuantity>0),
        managedAccountingSettled=managed.some(x=>x.action?.result?.nativeReconciled||
          x.action?.result?.executedQuantity>0&&x.action.result.accountingPending!==true);
      if(managedExposureResolved||reconciliation.some(x=>x.outcome==="RESOLVED"&&x.evidenceSecured===true&&x.quantityResolved===true&&
        (x.executedQuantity>0||x.settled===true||x.settlement)))patch.last_exposure_resolution_at=now;
      if(managedAccountingSettled||reconciliation.some(x=>x.evidenceSecured===true&&x.attributionComplete===true&&x.accountingComplete===true&&
        (x.settled===true||x.settlement||x.executedQuantity>0)))patch.last_accounting_settlement_at=now;
      // A completed HTTP request is not a successful trading cycle. Advance the legacy
      // success clock only after real entry evaluation and clean management/reconciliation.
      // This is telemetry only: it must never clear a circuit or change operator controls.
      if(!fatal&&entryEvaluationCompleted&&["FLAT","PROTECTED","SOFTWARE_ONLY"].includes(health)&&
          managed.every(x=>!x.error&&!x.skipped)&&reconciliation.every(x=>!x.error)){
        patch.last_success_at=now;patch.last_error=null;
      }else if(fatal){patch.last_error=String(fatal.message??fatal).slice(0,500);}
      if(managed.length&&managed.every(x=>x.action&&!x.error&&!x.skipped)&&["PROTECTED","FLAT"].includes(health))patch.last_management_success_at=now;
      if(managed.length&&managed.every(x=>x.action&&!x.error&&!x.skipped)&&["PROTECTED","SOFTWARE_ONLY"].includes(health))
        patch.last_position_protection_success_at=now;
      if(reconciliation.some(x=>x.outcome==="RESOLVED"&&x.evidenceSecured===true&&x.quantityResolved===true&&
          x.attributionComplete===true&&x.accountingComplete===true)&&reconciliation.every(x=>!x.error&&x.outcome!=="UNRESOLVED"))
        patch.last_reconciliation_success_at=now;
      if(entry.entered)patch.last_entry_at=now;
      if(managed.some(x=>x.action?.result?.executedQuantity>0||x.action?.result?.nativeReconciled)||
        reconciliation.some(x=>x.executedQuantity>0)||x1Fast.applied?.some(x=>x.action==="CLOSE"))patch.last_exit_at=now;
      const wr=await db.from("v11_long_regime_runtime").update(patch).eq("singleton",true);if(wr.error)throw Error("HEARTBEAT_WRITE");
    }
  }
}
async function runEntryQueue(db,pair,manual,blockedSymbols=new Set(),backlogComplete=true) {
  const openNow=pair.positions;
  let entry={entered:false,reason:"V17_NO_ENTRY"};
  if(!backlogComplete)return{entered:false,reason:"CLOSED_PROTECTION_BACKLOG_INCOMPLETE"};
  if(active(pair.pf).length>=MAX_SLOTS)return{entered:false,reason:"V11_SLOT_FULL"};
  const since=new Date(Date.now()-SIGNAL_MAX).toISOString(),sg=await db.from("v11_long_regime_signals").select("*").eq("revision",REVISION).eq("status","NEW").eq("lane","BULL").eq("features->>strategy",STRATEGY).gte("entry_bar_at",since).order("entry_bar_at",{ascending:false}).limit(10);
  if(sg.error)throw Error(`SIGNALS:${sg.error.message}`);
const openSymbols=new Set(openNow.map(x=>String(x.symbol).toUpperCase())),closedProtectionSymbols=typeof blockedSymbols==="undefined"?new Set():blockedSymbols,
  quarantinedSymbols=typeof pair==="undefined"?new Set():new Set((pair.quarantines??[]).map(x=>String(x.symbol).toUpperCase())),eligible=(sg.data||[]).filter(x=>!openSymbols.has(String(x.symbol).toUpperCase())),
  ranked=eligible.filter(x=>!closedProtectionSymbols.has(String(x.symbol).toUpperCase())&&!quarantinedSymbols.has(String(x.symbol).toUpperCase()))
    .sort((a,b)=>Date.parse(b.entry_bar_at)-Date.parse(a.entry_bar_at)||N(rec(a.features).rank,999)-N(rec(b.features).rank,999));
// One symbol never occupies more than one place in the queue. The list is already
// freshest-bar-first, so the first row for a symbol is its freshest candidate and
// every later one is superseded. Retiring them terminally (rather than leaving them
// NEW) is what stops a symbol that keeps re-signalling from crowding out other
// symbols on the next cycle as well.
const seenSymbols=new Set(),queue=[],superseded=[];
for(const row of ranked){
  const key=String(row.symbol).toUpperCase();
  if(seenSymbols.has(key)){superseded.push(row);continue}
  seenSymbols.add(key);queue.push(row);
}
for(const row of superseded)
  await db.from("v11_long_regime_signals").update({status:"REJECTED",
    reject_reason:`SUPERSEDED_BY_FRESHER_SIGNAL:${String(row.symbol).toUpperCase()}`,
    updated_at:new Date().toISOString()}).eq("id",row.id).eq("status","NEW");
if(!queue.length)entry={entered:false,reason:eligible.length?(eligible.some(x=>quarantinedSymbols.has(String(x.symbol).toUpperCase()))?"SYMBOL_QUARANTINED":"STALE_PROTECTION_SYMBOL_LOCKED"):"NO_FRESH_BULL_SIGNAL"};
// Candidates that can no longer produce an entry are retired here, before any
// gateway, BOO or E1 work.
//
// Which deadline applies depends on which entry timing owns the signal. Under the
// pullback policy the signal is not trying to buy now -- it is watching for up to
// SETUP_POLICY.setupTtlMs -- so POLICY.maxEntryAgeMs is not its deadline and the
// setup's own expiry is. Legacy signals keep the 120-second rule unchanged. Neither
// deadline is relaxed: the pullback policy's EXECUTION window is the 60-second
// trigger TTL, which is stricter than what V17 ran with.
const stillFresh=[];
for(const row of queue){
  const now=Date.now(),close=N(rec(row.features).signal5Close,NaN);
  if(!Number.isFinite(close)||now<close){
    await db.from("v11_long_regime_signals").update({status:"REJECTED",
      reject_reason:"SIGNAL_STALE_OR_FUTURE",updated_at:new Date().toISOString()})
      .eq("id",row.id).eq("status","NEW");
    if(!stillFresh.length)entry={entered:false,reason:"SIGNAL_STALE_OR_FUTURE"};
    continue;
  }
  if(!setupGoverns(row)){
    if(now-close>POLICY.maxEntryAgeMs){
      await db.from("v11_long_regime_signals").update({status:"REJECTED",
        reject_reason:"SIGNAL_STALE_OR_FUTURE",updated_at:new Date().toISOString()})
        .eq("id",row.id).eq("status","NEW");
      if(!stillFresh.length)entry={entered:false,reason:"SIGNAL_STALE_OR_FUTURE"};
      continue;
    }
    stillFresh.push(row);
    continue;
  }
  if(now-close>SETUP_POLICY.setupTtlMs+60000){
    await db.from("v11_long_regime_signals").update({status:"REJECTED",
      reject_reason:SETUP_REASON.SETUP_EXPIRED,updated_at:new Date().toISOString()})
      .eq("id",row.id).eq("status","NEW");
    if(!stillFresh.length)entry={entered:false,reason:SETUP_REASON.SETUP_EXPIRED};
    continue;
  }
  stillFresh.push(row);
}
// Advance every live setup on this cycle's completed candles. A setup that has not
// triggered is not a candidate: it is watched, not queued, and it consumes no attempt.
//
// Each advance costs one klines read, so the whole pass is bounded on the wall clock
// as well as by the queue size. A setup that does not get its turn this cycle is
// still NEW and is picked up on the next one, a minute later and well inside its
// 15-minute window -- the cadence is protected without dropping the candidate.
const triggered=[],executable=[],policyOpen=setupScopedOpen(openNow).length;
const setupDeadline=Date.now()+SETUP_ADVANCE_BUDGET_MS;
// Advance the setups closest to firing FIRST. The wall-clock budget above is real --
// each advance is a klines read -- so when it runs out, the candidates it did not
// reach wait a whole minute. For a WATCHING setup that costs nothing: its 15-minute
// window has minutes left. For a setup already holding a live trigger, or one bar
// away from producing one, a minute is the entire executable window. Freshest-bar
// order remains the tiebreaker inside each stage, so nothing else about the queue's
// fairness changes -- and this cannot promote a candidate past a gate, only past a
// budget.
// The persisted stage label only. This is an ORDERING heuristic, never a gate, so it
// reads the stored string directly rather than through signalSetup's policy-version
// validation: a row this policy cannot deserialize simply sorts last, and every real
// admission decision downstream still goes through the validated state.
const stageRank=(row)=>{
  if(!setupGoverns(row))return 0;
  const st=rec(rec(row.features).v17Setup).state;
  return st===SETUP_STATE.TRIGGERED?3:st===SETUP_STATE.PULLBACK_OBSERVED?2:st===SETUP_STATE.ARMED?1:0;
};
const advanceOrder=[...stillFresh].sort((a,b)=>
  stageRank(b)-stageRank(a)||Date.parse(b.entry_bar_at)-Date.parse(a.entry_bar_at));
for(const row of advanceOrder){
  // B06133 is defined at the completed-1m re-acceleration decision point.  A
  // legacy direct-entry row has no such timestamp and therefore cannot bypass
  // the new selector.
  if(!setupGoverns(row)){
    await db.from("v11_long_regime_signals").update({status:"REJECTED",
      reject_reason:"B06133_TRIGGER_REQUIRED",updated_at:new Date().toISOString()})
      .eq("id",row.id).eq("status","NEW");
    entry={entered:false,reason:"B06133_TRIGGER_REQUIRED"};continue;
  }
  if(Date.now()>=setupDeadline){entry={entered:false,reason:"V17_SETUP_BUDGET_EXHAUSTED"};break}
  let advanced;
  try{advanced=await advanceSignalSetup(db,row,Date.now());}
  catch(e){entry={entered:false,reason:String(e?.message??e)};continue}
  const state=advanced.state;
  if(!state){entry={entered:false,reason:advanced.reason??SETUP_REASON.INVALID_PRICE};continue}
  if(setupIsTerminal(state)){entry={entered:false,reason:state.terminalReason??SETUP_REASON.SETUP_EXPIRED};continue}
  if(state.state!==SETUP_STATE.TRIGGERED){entry={entered:false,reason:advanced.reason??SETUP_REASON.HOLD};continue}
  triggered.push({row:advanced.row,state});
}
// CEC is causal state, so triggered candidates must reach it chronologically. Setup
// advancement above may prioritize nearly-fired/newer rows for latency, but that
// operational ordering is not allowed to reorder the controller's history.
triggered.sort((a,b)=>Number(a.state.triggerAt)-Number(b.state.triggerAt)||
  N(rec(a.row.features).rank,999)-N(rec(b.row.features).rank,999)||
  String(a.row.symbol).localeCompare(String(b.row.symbol))||String(a.row.id).localeCompare(String(b.row.id)));
for(const advanced of triggered){
  const row=advanced.row,state=advanced.state;
  // Policy-scoped admission limit. It narrows this policy's own exposure during its
  // first live window; it never widens, and it never touches MAX_SLOTS.
  if(policyOpen+executable.filter(setupGoverns).length>=SETUP_MAX_CONCURRENT){
    entry={entered:false,reason:"V17_SETUP_POLICY_SLOT_LIMIT"};continue;
  }
  let selected;
  try{selected=await applyB06133Selection(db,advanced.row,state);}
  catch(error){entry={entered:false,reason:String(error?.message??error)};continue;}
  if(!selected.allowed){entry={entered:false,reason:selected.stamp.reason};continue;}
  let controlled;
  try{controlled=await applyCec0040Selection(db,selected.row,state);}
  catch(error){entry={entered:false,reason:String(error?.message??error)};continue;}
  if(!controlled.allowed){entry={entered:false,reason:controlled.stamp.reason};continue;}
  executable.push(controlled.row);
}
const gptReviewed=await gptFilterExecutable(db,executable);
if(executable.length&&!gptReviewed.candidates.length)entry={entered:false,reason:gptReviewed.reason};
const runDeadline=Date.now()+ENTRY_RUN_BUDGET_MS;
let attempts=0;
for(const s of gptReviewed.candidates){
  if(attempts>=ENTRY_ATTEMPTS_PER_RUN){entry={entered:false,reason:"ENTRY_ATTEMPTS_EXHAUSTED"};break}
  if(Date.now()>=runDeadline){entry={entered:false,reason:"ENTRY_RUN_BUDGET_EXHAUSTED"};break}
  const cl=await db.from("v11_long_regime_signals").update({status:"CLAIMED",updated_at:new Date().toISOString()}).eq("id",s.id).eq("status","NEW").select("*").maybeSingle();
  if(cl.error)throw new Error(`CLAIM:${cl.error.message}`);
  if(!cl.data){entry={entered:false,reason:"CLAIM_RACE"};continue}
  attempts++;
  const attempt={dispatched:false};
  try{
    entry=await openBull(db,cl.data,openNow,manual,attempt,typeof pair==="undefined"?[]:pair.managementFailures??[]);
    await audit(db,null,"BULL","BULL",entry?.entered?"ENTRY_ALLOW":"ENTRY_DEFER",
      entry?.entered?"V17_ENTRY_FILLED":entry?.reason??"V17_NO_ENTRY",{
        signalId:s.id,symbol:s.symbol,stage:"ENTRY_ATTEMPT_OUTCOME",
        finalAdmission:entry?.entered===true,orderDispatched:attempt.dispatched===true,
        entered:entry?.entered===true,entryPriceCheck:attempt.entryPriceCheck??null,
        booAdmission:attempt.booAdmission??null,booPredispatch:attempt.booPredispatch??null})
      .catch(()=>console.error("V17_ENTRY_OUTCOME_AUDIT_FAILED",s.id));
    if(entry?.releaseClaim===true){
      await db.from("v11_long_regime_signals").update({status:"NEW",updated_at:new Date().toISOString()}).eq("id",s.id).eq("status","CLAIMED");
      if(releaseStopsRun(entry))break;
      continue;
    }
    if(entry?.entered===true)break;
  }catch(e){
    const msg=e instanceof Error?e.message:String(e),pending=await db.from("v11_long_regime_orders").select("id").eq("signal_id",s.id).eq("state","RECONCILIATION_FAILED").limit(1);
    if(!pending.data?.length)await db.from("v11_long_regime_signals").update({status:"REJECTED",reject_reason:msg.slice(0,500),updated_at:new Date().toISOString()}).eq("id",s.id);
    if(attempt.dispatched)throw e;
    await audit(db,null,"BULL","BULL","ENTRY_REJECT",msg.slice(0,500),{
      signalId:s.id,symbol:s.symbol,stage:"PRE_ORDER_REJECTION",finalAdmission:false,
      orderDispatched:false,entryPriceCheck:attempt.entryPriceCheck??null,
      booAdmission:attempt.booAdmission??null,booPredispatch:attempt.booPredispatch??null})
      .catch(()=>console.error("V17_ENTRY_REJECTION_AUDIT_FAILED",s.id));
    if(!ENTRY_SKIP_SYMBOL_SCOPED.test(msg))throw e;
    entry={entered:false,reason:msg};
  }
}
return entry;
}

async function requireLeaderEntryControls(db){
  const [c,s,rt]=await Promise.all([
    db.from("v17_operator_control").select("entry_enabled,legacy_entries_retired").eq("singleton",true).single(),
    db.from("trading_settings").select("mode,pause_new_entries,withdrawal_mode,manual_intervention_required,scalp_kill_switch,emergency_liquidation,pause_lock_reason,binance_futures_allocation_usdt").eq("id",1).single(),
    db.from("v11_long_regime_runtime").select("live_enabled,circuit_open,revision").eq("singleton",true).single()]);
  if(c.error||s.error||rt.error)throw new Error("V17_CONTROLS_UNAVAILABLE");
  if(c.data?.entry_enabled!==true||c.data?.legacy_entries_retired!==true)throw new Error("V17_OPERATOR_CUTOVER_NOT_ENABLED");
  if(rt.data?.live_enabled!==true||rt.data?.circuit_open===true||rt.data?.revision!==REVISION)throw new Error("V17_RUNTIME_BLOCKED");
  const x=s.data;
  if(!x||x.mode!=="LIVE_LIMITED"||x.pause_new_entries||x.withdrawal_mode||x.manual_intervention_required||x.scalp_kill_switch||x.emergency_liquidation||x.pause_lock_reason)throw new Error("V17_ENTRY_KILL_SWITCH");
  // MARGIN and binance_futures_allocation_usdt must move TOGETHER. Changing only
  // one halts every entry with V17_MARGIN_CONFIG_MISMATCH -- which is the safe
  // failure, but it is a full stop, not a resize. Operator-requested on
  // 2026-09-16: 40 -> 30 USDT per slot.
  if(!Number.isFinite(Number(x.binance_futures_allocation_usdt))||Math.abs(Number(x.binance_futures_allocation_usdt)-MARGIN)>1e-9)throw new Error("V17_MARGIN_CONFIG_MISMATCH");
}
// One transport hiccup on the top-of-book read used to halt the whole strategy: any throw
// out of manageBull opens the circuit breaker, and on 2026-09-09 a single 3s timeout
// ("The signal has been aborted") stopped V17 for 21 minutes. Halting does not even protect
// the position it failed on -- an open circuit makes run() return early, so exits stop being
// managed too, and only the exchange-resident stop is still working. So retry once.
//
// This retry is safe ONLY because it is scoped to the quote read, which is the first thing
// manageLeader does: no decision has been taken, no row written and no order sent, so a
// second attempt cannot duplicate anything. It must never be widened to cover the exit
// dispatch below, where a retry could close a position twice.
//
// The budget is per run, not per position, so a systemic gateway outage costs one extra
// round trip in total rather than one per open position.
async function leaderQuote(p,ctx){
  if(ctx?.observedQuote){
    const q=ctx.observedQuote,bid=Number(q.bid),ask=Number(q.ask),detectedAtMs=Number(q.detectedAtMs),
      bidSize=Number(q.bidSize),protectedQuantity=Number(p.remaining_quantity),
      timing={requested_at_ms:Number(q.requestedAtMs),received_at_ms:Number(q.receivedAtMs),
        book_captured_at_ms:q.bookCapturedAtMs??null,source:q.source??"P10_TOP_OF_BOOK_BATCH"};
    if(!(bid>0&&ask>=bid)||!Number.isSafeInteger(detectedAtMs)||!Number.isSafeInteger(timing.received_at_ms)||
        detectedAtMs-timing.received_at_ms<0||detectedAtMs-timing.received_at_ms>1000||q.fullQuantityExecutable!==true||
        !(bidSize>0&&protectedQuantity>0&&bidSize+Math.max(1e-12,protectedQuantity*1e-10)>=protectedQuantity))
      throw Error("X1_EXIT_QUOTE_INVALID_STALE_OR_SHALLOW");
    return{bid,ask,detectedAtMs,timing,observedBidPeak:Number(q.observedBidPeak),
      observedBidPeakAt:Number(q.observedBidPeakAt),executableVwapPeak:Number(q.executableVwapPeak),
      observationId:q.observationId??null,bidSize};
  }
  const read=async(timeoutMs)=>{
    const quotes=await (ctx?.gateway??gateway)({action:"p10_quotes",markets:[p.symbol]},timeoutMs);
    const q=Array.isArray(quotes)?quotes.find(x=>x.market===p.symbol):null;
    const bid=Number(q?.best_bid),ask=Number(q?.best_ask);
    const detectedAtMs=Date.now(),timing=q?.timing||{};
    if(q?.error||!(bid>0&&ask>=bid)||!Number.isFinite(timing.received_at_ms)||
        detectedAtMs-timing.received_at_ms>3000||timing.received_at_ms-detectedAtMs>1000)
      throw new Error("V17_EXIT_QUOTE_INVALID_OR_STALE");
    return {bid,ask,detectedAtMs,timing};
  };
  try{return await read(3000)}
  catch(first){
    if(classifyFailure(first).fatal)throw first;
    const budget=ctx?.quoteRetryBudget;
    if(!budget||!(budget.remaining>0))throw first;
    budget.remaining-=1;
    console.error("V17_EXIT_QUOTE_RETRY",p.symbol,String(first instanceof Error?first.message:first));
    return await read(2500);
  }
}
async function manageLeader(db,p,ctx){
  const gateway=ctx?.gateway??exchangeGateway;
  await verifyExecutionLease(db);
  const meta=rec(p.metadata);
  const p142Active=meta.leaderExitPolicyVersion===P142_POLICY_VERSION&&
    rec(meta.cec0040).version===CEC0040_VERSION&&rec(meta.cec0040).enforcementEnabled===true;
  let p142State=Object.keys(rec(meta.p142State)).length?rec(meta.p142State):null,p142Error=null;
  // P142 consumes completed candles before the execution quote is requested. This
  // preserves the quote's existing freshness budget and keeps X1's one-second path
  // free of public candle reads. A market-data failure degrades to the already-live
  // R5 stop; it can neither lower protection nor stop the ordinary manager.
  const costUsable=p.entry_fee_usdt!=null&&Number.isFinite(Number(p.entry_fee_usdt))&&Number(p.entry_fee_usdt)>=0&&
    Number(p.original_quantity)>0;
  if(p142Active&&ctx?.fastObservation!==true&&costUsable){
    const entryAt=Date.parse(p.entry_at),start=p142State?.lastBarOpen==null?
      Math.floor(entryAt/60000)*60000:Number(p142State.lastBarOpen),
      completedThrough=Math.floor(Date.now()/60000)*60000-1;
    if(Number.isSafeInteger(start)&&completedThrough>=start){
      try{
        const bars=await qv3Candles(p.symbol,Date.now(),start);
        p142State=advanceP142Completed({id:p.id,entryAt,entryPrice:Number(p.entry_price),
          entryFee:Number(p.entry_fee_usdt),quantity:Number(p.original_quantity),
          stopPrice:Number(p.hard_stop_price),peakPrice:Number(p.peak_price),
          branch:meta.entryBranch??rec(meta.b06133).branch},bars,p142State);
      }catch(error){
        p142Error=String(error?.message??error).slice(0,300);
        console.error("P142_COMPLETED_CANDLE_UNAVAILABLE",p.id,p142Error);
      }
    }
  }
  const {bid,ask,detectedAtMs,timing,observedBidPeak,observedBidPeakAt,executableVwapPeak,observationId,bidSize}=await leaderQuote(p,ctx);
  // Preserve the existing policy. Today's nine trades do not validate a new default.
  // Cost-breakeven and profit-lock protection from the V17 exit review. These raise the
  // stop only; they can never lower it. Both are evaluated per tick with no confirmation
  // window, so they work on the current one-minute cadence.
  // costBreakeven() throws on a non-finite entry fee or quantity, which would abort this
  // whole evaluation and leave the position unmanaged. Degrade to the baseline stop
  // instead: a weaker stop still protects, no stop at all does not.
  if(!costUsable)console.error("V17_EXIT_COST_INPUTS_UNUSABLE",p.id);
  // Cutover is per position, decided by the stamp written at entry. A position opened
  // under the old ladder keeps it for its whole life, so nothing that is already running
  // has its stop moved by this deploy: R5's risk cut is a level that only NEW positions
  // can ever add. Un-stamped rows are exactly the positions open across the deploy.
  const r5=meta.leaderExitPolicyVersion===EXIT_REVIEW_R5.policyVersion||p142Active;
  const policy={...POLICY,...(costUsable?(r5?EXIT_REVIEW_R5:EXIT_REVIEW_CANDIDATE):{}),...rec(meta.leaderExitPolicy)};
  const useObservedPeak=Number.isFinite(observedBidPeak)&&observedBidPeak>=Number(p.peak_price),
    carriedPeak=useObservedPeak?observedBidPeak:Number(p.peak_price),
    carriedHighAt=useObservedPeak&&Number.isSafeInteger(observedBidPeakAt)&&observedBidPeakAt>=Date.parse(p.entry_at)?
      observedBidPeakAt:Date.parse(meta.leaderLastHighAt||p.entry_at);
  const exitInput={entryPrice:Number(p.entry_price),entryAt:Date.parse(p.entry_at),
    entryFee:Number(p.entry_fee_usdt),quantity:Number(p.original_quantity),
    peakPrice:carriedPeak,stopPrice:Number(p.hard_stop_price),lastHighAt:carriedHighAt,
    // Tick rounding belongs to the X1 observation arm only. The normal one-minute
    // manager remains behavior-identical when the override is disabled.
    priceTick:ctx?.fastObservation===true?N(rec(meta.entryMarketRules).priceTick):0};
  const state=p142Active?nextExitP142(exitInput,bid,detectedAtMs,policy,p142State):
    nextExitReviewed(exitInput,bid,detectedAtMs,policy);
  const telemetry={detectedAtMs,quoteRequestedAtMs:timing.requested_at_ms,
    quoteReceivedAtMs:timing.received_at_ms,exchangeBookAtMs:timing.book_captured_at_ms??null,
    source:timing.source??null,observationId:observationId??null,bidSize:Number.isFinite(bidSize)?bidSize:null};
  const stopImproved=state.stopPrice>Number(p.hard_stop_price)+Math.max(1e-12,Number(p.hard_stop_price)*1e-12);
  const priorX1=rec(meta.x1Observation),x1Observation=ctx?.fastObservation?{...priorX1,
    observedBidPeak:Math.max(N(priorX1.observedBidPeak),state.peakPrice),
    executableVwapPeak:Number.isFinite(executableVwapPeak)?Math.max(N(priorX1.executableVwapPeak),executableVwapPeak):priorX1.executableVwapPeak??null,
    lastObservationId:observationId??null,lastObservationAt:new Date(detectedAtMs).toISOString(),
    quoteAgeMs:detectedAtMs-timing.received_at_ms,source:timing.source??"P10_TOP_OF_BOOK_BATCH",
    fullQuantityExecutable:true,protectedQuantity:Number(p.remaining_quantity),
    lastStopSyncAt:stopImproved?new Date(detectedAtMs).toISOString():priorX1.lastStopSyncAt??null}:priorX1;
  const nextMeta={...meta,leaderLastHighAt:new Date(state.lastHighAt).toISOString(),
    leaderTrailArmed:state.armed,exitTelemetry:telemetry,
    ...(p142Active&&p142State?{p142State}:{}),
    ...(p142Active&&ctx?.fastObservation!==true?{p142Observation:{policyVersion:P142_POLICY_VERSION,
      lastAttemptAt:new Date(detectedAtMs).toISOString(),error:p142Error}}:{}),
    ...(ctx?.fastObservation?{x1Observation}: {})};
  const details={strategy:STRATEGY,bid,...state,...telemetry,
    exitObservationPolicyVersion:ctx?.fastObservation?X1_POLICY_VERSION:meta.exitObservationPolicyVersion??null,
    executableVwapPeak:ctx?.fastObservation?x1Observation.executableVwapPeak:null,operatorOverride:ctx?.fastObservation?OPERATOR_OVERRIDE:null};
  // Keep an exchange-resident STOP_MARKET aligned with the software stop. The software
  // monitor is unchanged and remains the primary path: this only removes the window
  // between two one-minute polls, which is where the measured loss beyond the stop
  // comes from. Every failure is swallowed — protection is best-effort and must never
  // delay, block or alter a detected exit.
  async function syncNativeStop(reason,confirmedQuantity=null){
    if(!NATIVE_STOP_ENABLED)return null;
    const exchangeQuantity=confirmedQuantity===null?ctx?.exchangeQuantity?.get(String(p.symbol).toUpperCase()):confirmedQuantity;
    if(!(exchangeQuantity>0)&&reason!=="CLOSE")return {status:"NO_EXCHANGE_QUANTITY"};
    try{
      // Closing is followed by a small, dedicated cleanup allowance.  It still shares
      // the cycle lease/fence, but cannot be starved by the position's quote/QV3 budget.
      // No symbol-info read is needed once the position is closed; ensure() only
      // refreshes and cancels the exact remembered stop identity.
      const cleanup=reason==="CLOSE"?(ctx?.cleanupGateway??gateway):gateway;
      const info=reason==="CLOSE"?{price_tick:1,quantity_step:1}:await cleanup({action:"symbol_info",market:p.symbol},5000);
      const out=await createGatewayProtection(db,cleanup,()=>verifyExecutionLease(db))
        .ensure(p.id,{stopPrice:state.stopPrice,priceTick:N(info?.price_tick??info?.tick_size),
          quantityStep:N(info?.quantity_step??info?.step_size),exchangeQuantity:exchangeQuantity??0,
          positionMode:"ONE_WAY",manualSymbols:ctx?.manualSymbols??[],lastPrice:bid});
      const ackAt=Math.max(0,...(out.state?.protection?.orders??[]).filter(o=>!o.terminal).map(o=>Number(o.lastQueryAt??o.ackAt??0)));
      return {status:out.status,softwareMonitorRequired:out.softwareMonitorRequired===true,stopAcknowledgementAgeMs:ackAt?Math.max(0,Date.now()-ackAt):null};
    }catch(e){
      if(classifyFailure(e).fatal)throw e;
      console.error("V17_NATIVE_STOP_SYNC_FAILED",p.id,String(e instanceof Error?e.message:e));
      return {status:"SYNC_FAILED",softwareMonitorRequired:true};
    }
  }
  // A marketable BUY LIMIT has a ceiling but no floor: during a fast reversal it can
  // execute materially below the quote that passed entryFresh().  The assessment was
  // computed from the exact fill and persisted with the new position before reaching
  // this manager.  Protect first, close through the ordinary idempotent exit path, then
  // retire that same lifecycle's stop.  A restart repeats the durable intent instead of
  // forgetting the invalid entry or creating another close order.
  const fillGuard=rec(meta.postFillEntryGuard),fillGuardClose=
    meta.entryExecutionPolicyVersion===ENTRY_EXECUTION_POLICY_VERSION&&
    fillGuard.version===ENTRY_EXECUTION_POLICY_VERSION&&fillGuard.action==="CLOSE"&&
    ["V21_POST_FILL_ENTRY_DRIFT","V21_POST_FILL_ENTRY_INPUT_INVALID"].includes(fillGuard.reason)&&
    (fillGuard.fillPrice===null||Math.abs(N(fillGuard.fillPrice)-N(p.entry_price))<=Math.max(1e-12,N(p.entry_price)*1e-8));
  if(fillGuardClose){
    const nativeStop=await syncNativeStop("HOLD");
    const result=await closePos(db,{...p,peak_price:state.peakPrice,
      hard_stop_price:state.stopPrice,metadata:nextMeta},1,fillGuard.reason,ctx);
    await audit(db,p,"BULL","BULL","FULL_CLOSE",fillGuard.reason,{...details,fillGuard,nativeStop})
      .catch(e=>console.error("V21_POST_FILL_AUDIT_FAILED",String(e)));
    const residual=result?.position?.state==="OPEN"?N(result.position.remaining_quantity):null,
      retired=await syncNativeStop(result?.closed===true?"CLOSE":"HOLD",residual);
    return {action:"CLOSE",reason:fillGuard.reason,result,nativeStop:retired,fillGuard};
  }
  // FD1 (GPT final decision): only a TIME-based close candidate or a HOLD tick is ever
  // offered to GPT. Every stop-based CLOSE above is executed untouched and never waits.
  if(meta.fd1HoldPolicyVersion===FD1_HOLD_POLICY_VERSION){
    const timeCandidate=state.action==="CLOSE"&&FD1_TIME_REASONS.includes(state.reason)&&bid>state.stopPrice?state.reason:null;
    if(state.action!=="CLOSE"||timeCandidate){
      const fd1=await fd1HoldTick(db,p,{meta,state,bid,now:detectedAtMs,timeCandidate});
      nextMeta.fd1Hold=fd1.state;details.fd1={reason:fd1.reason??null,close:fd1.close===true,fallback:fd1.fallback===true,
        timeCandidate,last:fd1.state?.last??null,pending:fd1.state?.pending?.event??null};
      if(timeCandidate&&!fd1.close){state.action="HOLD";state.reason=null;}
      else if(fd1.close&&fd1.reason==="FD1_GPT_EXIT"){state.action="CLOSE";state.reason="FD1_GPT_EXIT";}
      details.action=state.action;details.reason=state.reason;
    }
  }
  if(state.action==="CLOSE"){
    // No peak update or audit round trip may delay an already detected stop.
    const result=await closePos(db,{...p,peak_price:state.peakPrice,
      hard_stop_price:state.stopPrice,metadata:nextMeta},1,state.reason,ctx);
    const closeReason=result.nativeReconciled?"V17_NATIVE_STOP":state.reason;
    await audit(db,p,"BULL","BULL","FULL_CLOSE",closeReason,details)
      .catch(e=>console.error("V17_EXIT_AUDIT_FAILED",String(e)));
    // The position is already closed; this only retires any resting exchange stop so it
    // cannot outlive the position. It runs last so it can never delay the exit.
    const nativeStop=await syncNativeStop("CLOSE");
    return {action:"CLOSE",reason:closeReason,result,nativeStop};
  }
  const now=new Date(Math.max(Date.now(),Date.parse(p.updated_at)+1)).toISOString();
  await verifyExecutionLease(db);
  const write=await db.from("v11_long_regime_positions").update({peak_price:state.peakPrice,
    hard_stop_price:state.stopPrice,last_evaluated_at:now,updated_at:now,metadata:nextMeta})
    .eq("id",p.id).eq("state","OPEN").eq("updated_at",p.updated_at).select("*").single();
  if(write.error||!write.data)throw new Error("V17_EXIT_STATE_WRITE");
  // Only after the ratcheted stop is durable: the exchange order must never protect a
  // level the database does not already hold.
  const nativeStop=ctx?.fastObservation&&!stopImproved?{status:"UNCHANGED",softwareMonitorRequired:false}:
    await syncNativeStop("HOLD");
  // Existing stop/deadline decisions and resident protection run first. QV3 failures
  // leave that protection intact; only an exact post-cutover stamp enters QV3 scope.
  const qv3=ctx?.evaluateQv3===false?null:await qv3AfterProtection(db,write.data,{...rec(ctx),bid});
  if(qv3?.result){
    await audit(db,p,"BULL","BULL","FULL_CLOSE","QV3_TWO_BEARISH_CLOSED",{...details,qv3:qv3.assessment})
      .catch(e=>console.error("QV3_AUDIT_FAILED",String(e)));
    const retired=await syncNativeStop("CLOSE");
    return {action:"CLOSE",reason:"QV3_TWO_BEARISH_CLOSED",result:qv3.result,nativeStop:retired};
  }
  if(qv3)details.qv3=qv3;
  await audit(db,p,"BULL","BULL","HOLD",ctx?.fastObservation?"X1_FAST_OBSERVATION_HOLD":"V17_MOMENTUM_HOLD",
    {...details,nativeStop});
  return {action:"HOLD",strategy:STRATEGY,bid,...state,nativeStop,position:write.data};
}
/**
 * QV3's two-bearish-candle exit, observed but NOT executed, for positions opened
 * under the pullback entry timing.
 *
 * On the same 7-day window, replayed with the new entry, QV3's exit cost money:
 * net +27.999 -> +13.456 USDT and profit factor 1.843 -> 1.417 across 43 trades. It
 * closes a position that has merely paused, which is exactly the pause the new entry
 * is designed to buy. The rule is kept and still evaluated so the decision stays
 * reversible and auditable -- only the SELL is withheld.
 *
 * Positions opened before this policy keep their authoritative QV3 stamp and their
 * old behaviour; nothing here reaches them.
 */
async function qv3ShadowOnly(db,p,ctx){
  const meta=rec(p.metadata);
  if(meta.entryTimingPolicyVersion!==SETUP_POLICY_VERSION)return null;
  try{
    const at=Date.now(),prior=rec(meta.qv3ShadowState);
    const shape={id:p.id,entryAt:Date.parse(p.entry_at),entryPrice:Number(p.entry_price),
      side:p.side,state:p.state,ownership:meta.v17ManualPosition===true?"MANUAL":"AUTO",
      qv3:qv3Stamp(QV3_LIVE_CUTOVER,Date.parse(p.entry_at))};
    const start=prior?.favorableCandle?Math.floor(at/60000)*60000-120000
      :Math.ceil(Date.parse(p.entry_at)/60000)*60000;
    const bars=await qv3Candles(p.symbol,at,start),evaluatedAt=Date.now();
    const assessment=qv3Exit(shape,bars,evaluatedAt,prior?.version?prior:null);
    if(!assessment.available)return {shadow:{...assessment,executed:false}};
    const bid=N(ctx?.bid,NaN),quantity=N(p.remaining_quantity,NaN),entry=N(p.entry_price,NaN);
    const shadow={version:assessment.version,wouldClose:assessment.wouldClose===true,
      reason:assessment.reason,timestamp:new Date(evaluatedAt).toISOString(),
      hypotheticalPnlUsdt:assessment.wouldClose&&[bid,quantity,entry].every(Number.isFinite)
        ?(bid-entry)*quantity:null,
      executed:false,executionEnabled:false,entryTimingPolicyVersion:SETUP_POLICY_VERSION};
    // Shadow state is written on its own key so it can never be mistaken for the
    // authoritative qv3State an older position carries.
    await db.from("v11_long_regime_positions")
      .update({metadata:{...meta,qv3ShadowState:assessment.state,qv3Shadow:shadow},
        updated_at:new Date(Math.max(Date.now(),Date.parse(p.updated_at)+1)).toISOString()})
      .eq("id",p.id).eq("state","OPEN").eq("updated_at",p.updated_at);
    return {shadow};
  }catch(e){return {shadow:{available:false,reason:String(e?.message??e),executed:false}}}
}
async function qv3AfterProtection(db,p,ctx){
  if(QV3_LIVE_CUTOVER===null)return null;
  let closeAttempted=false;
  const shape=row=>({id:row.id,entryAt:Date.parse(row.entry_at),entryPrice:Number(row.entry_price),
    side:row.side,state:row.state,ownership:rec(row.metadata).v17ManualPosition===true?"MANUAL":"AUTO",qv3:rec(row.metadata).qv3});
  // A pullback-policy position is never in QV3's executing scope; it is observed only.
  if(rec(p.metadata).entryTimingPolicyVersion===SETUP_POLICY_VERSION)return await qv3ShadowOnly(db,p,ctx);
  if(!qv3Scope(shape(p),QV3_LIVE_CUTOVER))return null;
  try{
    await verifyExecutionLease(db);
    const current=await db.from("v11_long_regime_positions").select("*").eq("id",p.id).single();
    if(current.error||!current.data)throw Error("QV3_POSITION_READ");
    p=current.data;
    if(!qv3Scope(shape(p),QV3_LIVE_CUTOVER)||!ownedEntry(p,await readOpsOrders(db,[p])))return {reason:"QV3_PRESERVE_OWNERSHIP_CHANGED"};
    const at=Date.now(),prior=rec(p.metadata).qv3State;
    const start=prior?.favorableCandle?Math.floor(at/60000)*60000-120000:Math.ceil(Date.parse(p.entry_at)/60000)*60000;
    const bars=await qv3Candles(p.symbol,at,start),evaluatedAt=Date.now();
    const assessment=qv3Exit(shape(p),bars,evaluatedAt,prior);
    const auditedAssessment={...assessment,inputEvidence:qv3AuditEvidence(bars,evaluatedAt,assessment.through,at)};
    if(!assessment.available)return auditedAssessment;
    await verifyExecutionLease(db);
    const saved=await db.from("v11_long_regime_positions").update({metadata:{...rec(p.metadata),qv3State:assessment.state},
      updated_at:new Date(Math.max(Date.now(),Date.parse(p.updated_at)+1)).toISOString()})
      .eq("id",p.id).eq("state","OPEN").eq("updated_at",p.updated_at).select("*").maybeSingle();
    if(saved.error||!saved.data)throw Error("QV3_STATE_CAS_CONFLICT");
    if(assessment.wouldClose){closeAttempted=true;return {assessment:auditedAssessment,result:await closePos(db,saved.data,1,"QV3_TWO_BEARISH_CLOSED",ctx)};}
    return auditedAssessment;
  }catch(e){
    if(closeAttempted||classifyFailure(e).fatal)throw e;
    return {available:false,reason:String(e.message??e),executionEnabled:false};
  }
}
const exchangeGateway=gateway;
const leaseOwners=new WeakMap(),cycleBudgets=new WeakMap();
async function verifyExecutionLease(db,allowBudgetExceeded=false){
  if(!allowBudgetExceeded&&cycleBudgets.get(db)?.remaining()===0)throw Error("V18_API_BUDGET_EXHAUSTED");
  const owner=leaseOwners.get(db);if(!owner)throw new Error("V17_EXECUTION_LEASE_MISSING");
  const r=await db.rpc("v17_verify_execution_lease",{p_owner:owner});
  if(r.error||r.data!==true)throw new Error("V17_EXECUTION_LEASE_EXPIRED");
}
// READ-ONLY account/order/GPT readiness. No lease, no DB writes, no exchange writes.
async function opsReadiness(db){
  const [pf,oo,rt,positions,orders,control]=await Promise.all([gateway({action:"p10_portfolio"}),gateway({action:"v18_open_orders"}),
    db.from("v11_long_regime_runtime").select("circuit_open,circuit_reason,incident_kind,incident_generation,last_error,entry_block_reason,protection_health,last_cycle_completed_at").eq("singleton",true).single(),
    db.from("v11_long_regime_positions").select("id,symbol,remaining_quantity").eq("state","OPEN").limit(MAX_SLOTS+1),
    db.from("v11_long_regime_orders").select("id,symbol,state").in("state",["PLANNED","DISPATCHED","RECONCILIATION_PENDING","RECONCILIATION_FAILED"]).limit(101),
    readReviewControl(db)]);
  const ex=active(pf).map(x=>({symbol:sym(x),quantity:qty(x)}));
  return {ok:true,revision:REVISION,patch:PATCH,observedAt:new Date().toISOString(),
    binance:{positionsComplete:pf?.positions_complete===true,positions:ex,positionCount:ex.length,availableQuote:N(pf?.available_quote,null),
      openOrdersComplete:oo?.complete===true,ordinaryOrderCount:Array.isArray(oo?.orders)?oo.orders.length:null,
      conditionalOrderCount:Array.isArray(oo?.algos)?oo.algos.length:null,ordersObservedAtMs:oo?.observed_at_ms??null},
    db:{openPositionCount:(positions.data??[]).length,openPositions:positions.data??[],unresolvedOrderCount:(orders.data??[]).length,unresolvedOrders:orders.data??[]},
    runtime:rt.data??null,gptControl:control,openaiKeyPresent:(env("OPENAI_API_KEY")||"").length>0,maxSlots:MAX_SLOTS,
    sizing:{targetMarginUsdt:MARGIN,leverage:LEV}};
}
// ORDER-FREE end-to-end GPT dry run for one real engine-approved candidate (replayed on a
// clock shifted to trigger+offset). Phase 1 runs the API with NO lease. Phase 2 takes a
// fresh ordinary execution lease, re-reads the journal and re-checks every entry guard with
// current account state, then STOPS: it never claims the signal, never writes an intent,
// never calls create_order, and persists nothing but the DRYRUN journal row.
async function gptDryRun(db,body){
  const signalId=String(body.signalId??"");if(!/^[0-9a-f-]{36}$/i.test(signalId))return{ok:false,error:"SIGNAL_ID"};
  const row=await db.from("v11_long_regime_signals").select("*").eq("id",signalId).maybeSingle();
  if(row.error||!row.data)return{ok:false,error:"SIGNAL_NOT_FOUND"};
  const s={...row.data,status:"NEW"},f=rec(s.features),trigger=Number(rec(f.v17Setup).triggerAt);
  if(!Number.isSafeInteger(trigger))return{ok:false,error:"TRIGGER_MISSING"};
  const runId=String(body.runId??crypto.randomUUID()).slice(0,60),apiKey=env("OPENAI_API_KEY")||"";
  const c=dryRunCoordinator(db,{triggerAt:trigger,offsetMs:Number(body.offsetMs??4000),runId,apiKey});
  // Phase 1: GPT outside any lease. Optionally a normal leased management cycle runs at the
  // same time to show protection/exit work is not blocked by the API call.
  const cycleP=body.withCycle===true?runWithLease(db).then(r=>({ok:r?.ok,skipped:r?.skipped??null,protectionHealth:r?.protectionHealth??null,
    x1:r?.x1Runtime?{endedReason:r.x1Runtime.endedReason??null,observations:r.x1Runtime.observations??null}:null,entryReason:r?.entry?.reason??null,recovery:r?.recovery??null}))
    .catch(e=>({error:String(e?.message??e).slice(0,200)})):Promise.resolve(null);
  const review=await dryRunReviewPhase(c,s),concurrentCycle=await cycleP;
  // Phase 2: new ordinary lease; re-read the stored result and re-run the guards.
  const guardOp=async db=>{
    const t=Date.now(),reread=await c.consider(s),gpt=c.check(s),reasons=[];
    const sel=rec(f.b06133),cec=rec(f.cec0040),g={};
    g.baseline=review.baselineAllowed;if(!g.baseline)reasons.push("EXISTING_MODEL_NOT_APPROVED");
    g.gpt={reread:reread.reason,decision:reread.decision??null,check:gpt.reason,allowed:gpt.allowed};if(!gpt.allowed)reasons.push("GPT:"+gpt.reason);
    const ep=rec(f.exitPolicy);g.exitPolicyValid=Object.values(ep).every(v=>Number.isFinite(Number(v)))&&Number(ep.stopPct)>0&&Number(ep.stopPct)<1&&Number(ep.trailArmPct)>0&&Number(ep.trailGapPct)>0&&Number(ep.trailGapPct)<1&&Number(ep.maxHoldMs)===POLICY.maxHoldMs&&Number(ep.staleMs)>0;
    if(!g.exitPolicyValid)reasons.push("V17_EXIT_POLICY_INVALID");
    const cp=await db.rpc("v11_cec0040_preview_readonly",{p_signal_id:s.id,p_decision_at:new Date(trigger).toISOString(),p_symbol:String(s.symbol).toUpperCase(),p_branch:sel.branch??"R62"});
    g.cecPreview=cp.error?{error:cp.error.message}:cp.data;
    try{await requireLeaderEntryControls(db);g.leaderControls="PASS";}catch(e){g.leaderControls=String(e?.message??e);reasons.push(g.leaderControls);}
    const gw=opsGateway(db),controls=await opsControls(db);
    const [sn,q,i,pair,orders]=await Promise.all([snap(db).catch(e=>({error:String(e.message)})),gw({action:"quote",market:s.symbol}),gw({action:"symbol_info",market:s.symbol}),
      readOpsPair(db,gw,s.symbol),gw({action:"v18_open_orders"},5000)]);
    const bid=N(q?.best_bid),ask=N(q?.best_ask),sp=bid>0&&ask>0?(ask/bid-1)*10000:999,filters=symbolFilters(i);
    let sized=null;try{sized=sizeEntry(ask,filters.quantityStep,filters);}catch(e){reasons.push("SIZING:"+String(e?.message??e));}
    g.quote={bid,ask,spreadBps:sp,spreadOk:sp<=SPREAD_MAX};if(!(sp<=SPREAD_MAX))reasons.push("ENTRY_SPREAD");
    g.sizing=sized?{targetMarginUsdt:MARGIN,leverage:LEV,sizedMargin:sized.sizedMargin,orderNotionalUsdt:sized.orderNotionalUsdt,limitPrice:sized.limitPrice,boundBy:sized.boundBy}:null;
    const avail=Math.min(N(sn?.available_quote,NaN),N(pair.pf?.available_quote,NaN));
    g.margin={availableUsdt:avail,required:sized?sized.sizedMargin+ENTRY_CASH_BUFFER_USDT:null,ok:!!sized&&avail>=sized.sizedMargin+ENTRY_CASH_BUFFER_USDT};if(!g.margin.ok)reasons.push("ENTRY_MARGIN_INSUFFICIENT");
    g.slots={exchangePositions:active(pair.pf).length,maxSlots:MAX_SLOTS,ok:active(pair.pf).length<MAX_SLOTS};if(!g.slots.ok)reasons.push("V11_SLOT_FULL");
    g.duplicate={symbolOpen:pair.positions.some(p=>String(p.symbol).toUpperCase()===String(s.symbol).toUpperCase()),
      pendingSymbolOrders:pair.orders.filter(o=>String(o.symbol).toUpperCase()===String(s.symbol).toUpperCase()&&["PLANNED","DISPATCHED","RECONCILIATION_PENDING","RECONCILIATION_FAILED"].includes(o.state)).length,
      intentId:cid("v11e",s.id)};
    const dupIntent=await db.from("v11_long_regime_orders").select("id,state").eq("client_order_id",g.duplicate.intentId).limit(1);
    g.duplicate.existingIntent=(dupIntent.data??[]).length>0;
    if(g.duplicate.symbolOpen||g.duplicate.pendingSymbolOrders||g.duplicate.existingIntent)reasons.push("DUPLICATE_ORDER_PROTECTION");
    const decision=decideEntryWith(controls,pair,s.symbol,orders,{proposedMargin:sized?.sizedMargin??0,cashBuffer:ENTRY_CASH_BUFFER_USDT});
    g.entryControl={allowed:decision.allowed,scope:decision.scope??null,reasons:decision.reasons??[]};if(!decision.allowed)reasons.push("ENTRY_CONTROL:"+(decision.reasons??[]).join(","));
    g.circuit={open:controls.runtime.circuit_open,reason:controls.runtime.circuit_reason,incidentKind:controls.runtime.incident_kind};if(controls.runtime.circuit_open)reasons.push("CIRCUIT_OPEN");
    const attempt={},fresh=sized?checkedEntryFresh(s,f,Date.now(),sized.limitPrice,attempt,"DRYRUN_PRICE",q):"NO_PRICE";
    g.freshness={reason:fresh??null,note:"real-time price vs historical trigger reference; a replayed candidate is expected to be stale here"};if(fresh)reasons.push("ENTRY_FRESHNESS:"+fresh);
    const verdict=g.gpt.decision==="VETO"?"WOULD_VETO":!gpt.allowed?"WOULD_ABSTAIN":reasons.length?"WOULD_NOT_EXECUTE":"WOULD_EXECUTE";
    return{ok:true,verdict,stoppedBeforeOrderEndpoint:true,orderCalls:0,reasons,guards:g,phase2Ms:Date.now()-t};
  };
  // The ordinary cron cycle may hold the lease; wait for it like any next cycle would.
  let guarded=null,leaseWaits=0;
  for(;leaseWaits<60;leaseWaits++){guarded=await runWithLease(db,guardOp);if(!guarded?.skipped)break;await new Promise(r=>setTimeout(r,1000));}
  if(guarded)guarded.leaseWaits=leaseWaits;
  const job=await db.from("gpt_final_entry_reviews").select("job_key,state,purpose,decision,valid,error,request_id,input_tokens,cached_input_tokens,output_tokens,api_cost_usd,settled_usd,latency_ms,model,prompt_hash,schema_hash,source_commit,candidate_id,snapshot_hash").eq("signal_id",s.id).eq("purpose","DRYRUN").order("created_at",{ascending:false}).limit(1).maybeSingle();
  return{ok:true,revision:REVISION,patch:PATCH,signal:{id:s.id,symbol:s.symbol,historicalStatus:row.data.status,historicalRejectReason:row.data.reject_reason,branch:rec(f.b06133).branch??null,cecAction:rec(f.cec0040).action??null,triggerAt:trigger},
    review,concurrentCycle,guarded,journal:job.data??null};
}
async function runWithLease(db,operation=run){
  const owner=crypto.randomUUID();
  const lock=await db.rpc("v17_acquire_execution_lease",{p_owner:owner});
  if(lock.error)throw new Error("V17_LEASE_UNAVAILABLE");
  if(lock.data!==true)return {ok:true,skipped:"V17_EXECUTOR_BUSY"};
  leaseOwners.set(db,owner);cycleBudgets.set(db,createBudget({ms:55000,calls:160}));
  try{return await operation(db);}finally{
    leaseOwners.delete(db);cycleBudgets.delete(db);
    const released=await db.rpc("v17_release_execution_lease",{p_owner:owner});
    if(released.error)console.error("V17_LEASE_RELEASE_FAILED");
  }
}
Deno.serve(async req=>{
  if(req.method!=="POST")return res(405,{ok:false,error:"POST_ONLY"});
  const U=env("SUPABASE_URL"),K=env("SUPABASE_SERVICE_ROLE_KEY"),db=createClient(U,K,{
    auth:{persistSession:false,autoRefreshToken:false},
    global:{fetch:async(url,init={})=>{
      const headers=new Headers(init.headers),owner=leaseOwners.get(db);
      if(owner)headers.set("x-v18-execution-owner",owner);
      const timeout=AbortSignal.timeout(2500);
      return fetch(url,{...init,headers,signal:init.signal?AbortSignal.any([init.signal,timeout]):timeout});
    }}
  });
  if(!(await auth(db,req)))return res(401,{ok:false,error:"UNAUTHORIZED"});
  const body=await req.json().catch(()=>({})),mode=String(body.mode||"run").toLowerCase();
  try{
    if(mode==="preflight"||mode==="diagnostic"){
      const [m,sn,pf,q,i,rt,op,cec]=await Promise.all([
        market(db),snap(db),gateway({action:"p10_portfolio"}),
        gateway({action:"quote",market:String(body.symbol||"BTCUSDT")}),
        gateway({action:"symbol_info",market:String(body.symbol||"BTCUSDT")}),
        db.from("v11_long_regime_runtime").select("*").eq("singleton",true).single(),
        db.from("v11_long_regime_positions")
          .select("id,symbol,active_lane,peak_price,entry_price,last_evaluated_at,metadata")
          .eq("state","OPEN").limit(MAX_SLOTS+1),
        cec0040RuntimeStatus(db)
      ]),pfFilters=symbolFilters(i),step=pfFilters.quantityStep,ask=N(q?.best_ask),
        sizing=(()=>{try{return ask>0&&step>0?sizeEntry(ask,step,pfFilters):null}
          catch(e){return{error:String(e?.message??e)}}})();
      return res(200,{ok:true,revision:REVISION,patch:PATCH,
        entryExecutionPolicy:{version:ENTRY_EXECUTION_POLICY_VERSION,maxEntryDriftPct:POLICY.maxEntryDriftPct,scope:"NEW_FILLS_ONLY"},
        b06133Runtime:{version:B06133_VERSION,scope:"NEW_ENTRIES_AFTER_PULLBACK_REACCEL_TRIGGER",enabled:true,maxConcurrent:SETUP_MAX_CONCURRENT},
        cec0040Runtime:cec,operatorOverride:OPERATOR_OVERRIDE,
        e1Runtime:{enabled:E1_ENABLED,policyVersion:E1_POLICY.policyVersion},
        x1Runtime:{enabled:X1_ENABLED,policyVersion:X1_POLICY_VERSION,
          baseExitPolicyVersion:EXIT_REVIEW_R5.policyVersion,observationIntervalMs:1000},
        maxSlots:MAX_SLOTS,runtime:rt.data,marketState:m,snapshotAgeMs:sn.ageMs,
        availableUsdt:Math.min(N(sn.available_quote),N(pf?.available_quote)),
        externalPositions:active(pf).map(x=>({symbol:sym(x),quantity:qty(x)})),
        openPositions:(op.data||[]).map(p=>({...p,metadata:{
          executorPatch:rec(p.metadata).executorPatch,
          entrySelectionPolicyVersion:rec(p.metadata).entrySelectionPolicyVersion,
          b06133:rec(p.metadata).b06133,
          entryControllerPolicyVersion:rec(p.metadata).entryControllerPolicyVersion,
          cec0040:rec(p.metadata).cec0040,
          leaderExitPolicyVersion:rec(p.metadata).leaderExitPolicyVersion,
          p142State:rec(p.metadata).p142State,
          p142Observation:rec(p.metadata).p142Observation,
          entryExecutionPolicyVersion:rec(p.metadata).entryExecutionPolicyVersion,
          entryConfirmationPolicyVersion:rec(p.metadata).entryConfirmationPolicyVersion,
          exitObservationPolicyVersion:rec(p.metadata).exitObservationPolicyVersion,
          x1Observation:rec(p.metadata).x1Observation,qv3:rec(p.metadata).qv3}})),
        quote:q,symbolInfo:{step,priceTick:pfFilters.priceTick,
          minNotional:pfFilters.minNotionalUsdt,minQuantity:pfFilters.minQuantity},
        sizingContract:{...SLOT_SIZING_CONTRACT,...slotSizingBounds(SLOT_SIZING_CONTRACT),
          invariants:assertSlotSizingContract()},sizing});
    }
    if(mode==="ops-readiness")return res(200,await opsReadiness(db));
    if(mode==="gpt-dryrun")return res(200,await gptDryRun(db,body));
    if(mode==="gpt-live-probe"){
      const symbol=String(body.symbol??"BTCUSDT").toUpperCase();if(!/^[A-Z0-9]{2,20}USDT$/.test(symbol))return res(400,{ok:false,error:"SYMBOL"});
      return res(200,{ok:true,revision:REVISION,patch:PATCH,orderCalls:0,probe:await liveProbe(db,{symbol,apiKey:env("OPENAI_API_KEY")||"",
        runId:String(body.runId??crypto.randomUUID()),evaluate:evaluateB06133,fetchInputs:fetchB06133Inputs})});
    }
    if(mode==="fd1-probe"){
      // ORDER-FREE: FD1 entry + hold decisions on live data; no lease, no signal/position/order write.
      const symbol=String(body.symbol??"BTCUSDT").toUpperCase();if(!/^[A-Z0-9]{2,20}USDT$/.test(symbol))return res(400,{ok:false,error:"SYMBOL"});
      return res(200,{ok:true,revision:REVISION,patch:PATCH,orderCalls:0,sizing:{targetMarginUsdt:MARGIN,leverage:Number(LEV),maxSlots:MAX_SLOTS},
        probe:await fd1Probe(db,{symbol,apiKey:env("OPENAI_API_KEY")||"",runId:String(body.runId??crypto.randomUUID()),engine:FD1_ENTRY_ENGINE})});
    }
    if(mode==="fd1-recheck-probe"){
      // ORDER-FREE: INITIAL BUY fixture -> deterioration -> change detector -> real GPT FINAL
      // RECHECK (DRYRUN journal) -> post-recheck safety. No lease, no signal/position/order write.
      const symbol=String(body.symbol??"BTCUSDT").toUpperCase();if(!/^[A-Z0-9]{2,20}USDT$/.test(symbol))return res(400,{ok:false,error:"SYMBOL"});
      const fixture=body.fixture==="NIL"?"NIL":"LIVE";
      return res(200,{ok:true,revision:REVISION,patch:PATCH,orderCalls:0,sizing:{targetMarginUsdt:MARGIN,leverage:Number(LEV),maxSlots:MAX_SLOTS},
        probe:await finalRecheckProbe(db,{symbol,fixture,apiKey:env("OPENAI_API_KEY")||"",runId:String(body.runId??crypto.randomUUID())})});
    }
    if(mode==="cec-bootstrap")return res(200,await runWithLease(db,bootstrapCec0040));
    if(mode!=="run")return res(400,{ok:false,revision:REVISION,patch:PATCH,error:"MODE_UNSUPPORTED"});
    return res(200,await runWithGptReview(db,runWithLease));
  }catch(e){
    const msg=e instanceof Error?e.message:String(e);
    return res(500,{ok:false,revision:REVISION,patch:PATCH,error:msg});
  }
});
