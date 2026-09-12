// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {POLICY, STRATEGY, entryFresh, nextExit, portfolioMatches as leaderPortfolioMatches} from "../_shared/leader-momentum-v17.mjs";
import {nextExitReviewed, EXIT_REVIEW_CANDIDATE, EXIT_REVIEW_R5, exitAttemptId, classifyExitResponse} from "../_shared/leader-exit-review.mjs";
import {protectNewLeaderPosition} from "../_shared/leader-entry-protection.mjs";
import {createGatewayProtection} from "../_shared/leader-protection-adapter.mjs";
import {classifyPortfolio, freshPortfolio, ownedEntry, riskOrders, classifyFailure, operatorAllowsRecovery, recoveryEvidence, confirmedLiveProtection, createBudget, boundedMap} from "../_shared/leader-ops-isolation.mjs";
import {entryReceipt,entryExposureMatches} from "../_shared/leader-entry-settlement.mjs";
import {applyExitReceipt} from "../_shared/leader-exit-settlement.mjs";
import {analyzeDbOnlyExit} from "../_shared/leader-db-only-reconciliation.mjs";
import {ENTRY_CONTROL_VERSION,CONTROL_SCOPE,evaluateEntryDecision,symbolRecoveryEvidence} from "../_shared/leader-entry-control.mjs";
import {QV3_ACTIVATION_BASIS,QV3_LIVE_CUTOVER,QV3_VERSION,qv3Entry,qv3Exit,qv3Scope,qv3Stamp,qv3Candles} from "../_shared/leader-qv3-runtime.mjs";
const REVISION="V11-LONG-REGIME-1.0.1",PATCH="V19-SCOPE-AWARE-ENTRY-1",OBSERVER_REVISION="MARKET-REGIME-OBSERVER-v2-C01-HYSTERESIS-v1-FULLMARKET",PROTOCOL="8.0.0-P10-DONCHIAN-SLOW4R";
// Bounded so a bar of refusals cannot stretch the run past the one-minute cadence.
const ENTRY_ATTEMPTS_PER_RUN=3;
// Pre-dispatch refusals scoped to one symbol. Never includes STOP_POLICY_INVALID or
// STOP_INVALID, which are raised only AFTER a fill -- those are caught by the
// dispatched guard regardless, which is the check that actually protects the account.
const ENTRY_SKIP_SYMBOL_SCOPED=/^(SIGNAL_STALE_OR_FUTURE|ENTRY_DRIFT|WRONG_STRATEGY|INVALID_PRICE|V17_EXIT_POLICY_INVALID|MANUAL_SYMBOL_LOCKED|ENTRY_SPREAD|ENTRY_FEATURES_INVALID|QTY_INVALID|ENTRY_GRANULARITY_BPS|ENTRY_SLOT_GRANULARITY_MARGIN|ENTRY_NOTIONAL_UNDERSIZED|V17_LIMIT_PRICE_MARGIN_OVERFLOW)/;
const MARGIN=40,LEV=3,NOTIONAL=MARGIN*LEV,MAX_SLOTS=10,NOTIONAL_BUFFER_USDT=.12,MAX_MARGIN_BUFFER_USDT=.25,ENTRY_CASH_BUFFER_USDT=.10,SNAP_MAX=90000,SIGNAL_MAX=300000,SPREAD_MAX=25,MAX_GAP_ATR=.5,IOC_BASE_BPS=3,IOC_MAX_BPS=12,BULL_MAX_MS=30*86400000,T1_PRICE=.075,PARTIAL=.30,TRAIL=.0225;
function res(s,b){return new Response(JSON.stringify(b),{status:s,headers:{"content-type":"application/json","cache-control":"no-store"}})}function N(v,d=0){const x=Number(v);return Number.isFinite(x)?x:d}function rec(v){return v&&typeof v==="object"&&!Array.isArray(v)?v:{}}function eq(a,b){if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0}function dec(s){return Math.min(12,Math.max(0,Math.ceil(-Math.log10(s))+2))}function floorStep(v,s){if(!(v>0&&s>0))return 0;return Number((Math.floor((v+s*1e-9)/s)*s).toFixed(dec(s)))}function ceilStep(v,s){if(!(v>0&&s>0))return 0;return Number((Math.ceil((v-s*1e-9)/s)*s).toFixed(dec(s)))}function addStep(v,s){return Number((v+s).toFixed(dec(s)))}function cid(p,x){return`tb-${p}-${String(x).toLowerCase().replace(/[^a-z0-9]/g,"").slice(0,24)}`.slice(0,36)}function terminal(z){return z.qty<=0&&["CANCELED","CANCELLED","REJECTED","EXPIRED","PARTIALLY_FILLED_CANCELED"].includes(z.status)}
const env=n=>(Deno.env.get(n)||"").trim(),GW=env("BINANCE_FUTURES_ORDER_GATEWAY_URL").replace(/\/$/,"")||env("BINANCE_ORDER_GATEWAY_URL").replace(/\/$/,"")||env("ORDER_GATEWAY_URL").replace(/\/$/,""),SEC=env("BINANCE_FUTURES_GATEWAY_SHARED_SECRET")||env("BINANCE_GATEWAY_SHARED_SECRET")||env("GATEWAY_SHARED_SECRET");
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
function sizeEntry(ask,step){if(!(ask>0&&step>0))throw new Error("QTY_INPUT_INVALID");let amount=ceilStep(NOTIONAL/ask,step);if(!(amount>0))throw new Error("QTY_INVALID");let sizedNotional=amount*ask;if(sizedNotional<NOTIONAL+NOTIONAL_BUFFER_USDT){const bumped=addStep(amount,step),bm=bumped*ask/LEV;if(bm<=MARGIN+MAX_MARGIN_BUFFER_USDT){amount=bumped;sizedNotional=amount*ask}}const sizedMargin=sizedNotional/LEV;if(sizedNotional+1e-9<NOTIONAL)throw new Error(`ENTRY_NOTIONAL_UNDERSIZED:${sizedNotional}`);if(sizedMargin>MARGIN+MAX_MARGIN_BUFFER_USDT+1e-9)throw new Error(`ENTRY_SLOT_GRANULARITY_MARGIN:${sizedMargin.toFixed(6)}`);return{amount,sizedNotional,sizedMargin}}
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
  let pf=await gw({action:"p10_portfolio"});
  const manual=await manualPositionAllowances(db),match=classifyPortfolio([p],{...pf,positions:pf?.positions?.filter(x=>sym(x)===p.symbol)},{manual,orders});
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
async function openBull(db,s,openPositions,manual=null,attempt={},managementFailures=[]){
const gateway=opsGateway(db);
await requireLeaderEntryControls(db);
const exitPolicy=rec(s.features?.exitPolicy);
if(!Object.values(exitPolicy).every(v=>Number.isFinite(Number(v)))||!(Number(exitPolicy.stopPct)>0&&Number(exitPolicy.stopPct)<1&&Number(exitPolicy.trailArmPct)>0&&Number(exitPolicy.trailGapPct)>0&&Number(exitPolicy.trailGapPct)<1&&Number(exitPolicy.maxHoldMs)===POLICY.maxHoldMs&&Number(exitPolicy.staleMs)>0))throw new Error("V17_EXIT_POLICY_INVALID");
const initialFresh=entryFresh(rec(s.features),Date.now(),Number(s.features?.referenceClose));
if(initialFresh)throw new Error(initialFresh);
const[sn,q,i,rawInitialPair,initialOrders]=await Promise.all([snap(db),gateway({action:"quote",market:s.symbol}),
  gateway({action:"symbol_info",market:s.symbol}),readOpsPair(db,gateway),gateway({action:"v18_open_orders"},5000)]),
  initialPair=await withCandidateOrders(db,rawInitialPair,s.symbol),manualRows=initialPair.manual;
await recordMismatch(db,initialPair.match);
const initialDecision=await decideEntry(db,initialPair,s.symbol,initialOrders,{managementFailures});
await persistDecisionRisk(db,initialPair,initialDecision);
if(!initialDecision.allowed){return{entered:false,
  reason:`ENTRY_CONTROL:${initialDecision.scope}:${initialDecision.reasons.join(",")}`,releaseClaim:true,entryDecision:initialDecision}}
if(manualRows.some(x=>x.symbol===String(s.symbol).toUpperCase()))throw new Error("MANUAL_SYMBOL_LOCKED");
if(active(initialPair.pf).length>=MAX_SLOTS)return{entered:false,reason:"V11_SLOT_FULL"};
if(initialPair.positions.some(p=>String(p.symbol).toUpperCase()===String(s.symbol).toUpperCase()))return{entered:false,reason:"DUPLICATE_SYMBOL_OPEN"};
const pf=initialPair.pf,bid=N(q?.best_bid),ask=N(q?.best_ask),sp=bid>0&&ask>0?(ask/bid-1)*10000:999;if(!(bid>0&&ask>0&&sp<=SPREAD_MAX))throw new Error(`ENTRY_SPREAD:${sp}`);const f=rec(s.features),ref=N(f.referenceClose),atr=N(f.atr);if(!(atr>0&&ref>0))throw new Error("ENTRY_FEATURES_INVALID");const step=N(i?.quantity_step??i?.step_size),min=Math.max(1,N(i?.min_notional,5)),sized=sizeEntry(ask,step);if(sized.sizedNotional<min)throw new Error("QTY_INVALID");const live=N(pf?.available_quote,NaN),avail=Math.min(N(sn.available_quote),live);if(!Number.isFinite(live))throw new Error("ENTRY_AVAILABLE_BALANCE_UNREADABLE");if(avail<sized.sizedMargin+ENTRY_CASH_BUFFER_USDT)return{entered:false,reason:`ENTRY_MARGIN_INSUFFICIENT:${avail.toFixed(4)}:${sized.sizedMargin.toFixed(4)}`,releaseClaim:true};const gatePrice=(NOTIONAL+NOTIONAL_BUFFER_USDT)/sized.amount,limitPrice=Math.max(ask*(1+IOC_BASE_BPS/10000),gatePrice),iocBps=(limitPrice/ask-1)*10000;if(iocBps>IOC_MAX_BPS)throw new Error(`ENTRY_GRANULARITY_BPS:${iocBps.toFixed(3)}`);const gap=Math.abs(limitPrice-ref)/atr;
const finalFresh=entryFresh(f,Date.now(),limitPrice);if(finalFresh)throw new Error(finalFresh);
if(sized.amount*limitPrice/LEV>MARGIN+MAX_MARGIN_BUFFER_USDT+1e-9)throw new Error("V17_LIMIT_PRICE_MARGIN_OVERFLOW");
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
    return {entered:false,reason:result.reason,releaseClaim:true,qv3:attempt.qv3};
  }
  await requireLeaderEntryControls(db);
  const freshness=entryFresh(f,Date.now(),limitPrice);if(freshness)throw Error(freshness);
}
// Final gateway check uses a new account observation and a new complete ordinary +
// conditional order observation.  No intent exists yet, so a denial cannot duplicate
// or strand an order identity.
await requireLeaderEntryControls(db);
const[rawFinalCheck,finalOrders]=await Promise.all([readOpsPair(db),gateway({action:"v18_open_orders"},5000)]),
  finalCheck=await withCandidateOrders(db,rawFinalCheck,s.symbol),finalDecision=await decideEntry(db,finalCheck,s.symbol,finalOrders,{proposedMargin:sized.sizedMargin,cashBuffer:ENTRY_CASH_BUFFER_USDT,managementFailures});
await recordMismatch(db,finalCheck.match);await persistDecisionRisk(db,finalCheck,finalDecision);
if(!finalDecision.allowed){return{entered:false,
  reason:`ENTRY_CONTROL:${finalDecision.scope}:${finalDecision.reasons.join(",")}`,releaseClaim:true,entryDecision:finalDecision}}
if(finalCheck.positions.some(p=>p.symbol===s.symbol)||active(finalCheck.pf).length>=MAX_SLOTS)return{entered:false,reason:"PORTFOLIO_CHANGED",releaseClaim:true};
await verifyExecutionLease(db);const id=cid("v11e",s.id),rp={action:"create_order",leverage:LEV,order:{market:s.symbol,side:"BUY",type:"LIMIT",price:limitPrice,time_in_force:"IOC",quantity:sized.amount,identifier:id,position_side:"LONG",position_effect:"OPEN"},wait_for_final_ms:4000},oi=await db.from("v11_long_regime_orders").insert({revision:REVISION,signal_id:s.id,position_id:null,symbol:s.symbol,intent:"OPEN_LONG",reason:"V17_LEADER_ENTRY_IOC",client_order_id:id,requested_quantity:sized.amount,state:"PLANNED",request_payload:{...rp,quantity_step:step,target_margin_usdt:MARGIN,sized_margin_usdt:sized.sizedMargin,sized_notional_usdt:sized.sizedNotional,leverage:LEV,spread_bps:sp,entry_gap_atr:gap,ioc_bps:iocBps,max_slots:MAX_SLOTS,executor_patch:PATCH,entry_control:finalDecision.evidence,qv3:qv3Active?{version:QV3_VERSION,activation:QV3_LIVE_CUTOVER,basis:QV3_ACTIVATION_BASIS}:null}}).select("*").single();if(oi.error)throw new Error(`ORDER_INTENT:${oi.error.message}`);try{await verifyExecutionLease(db);attempt.dispatched=true;const raw=await gateway(rp),z=fill(raw);if(z.qty>0&&z.avg>0){const pos={data:await settleKnownEntry(db,oi.data,raw,gateway)},stop=pos.data.hard_stop_price;const entryProtection=await protectNewLeaderPosition({enabled:NATIVE_STOP_ENABLED,position:pos.data,manualSymbols:manualRows.map(x=>x.symbol),readPortfolio:()=>gateway({action:"p10_portfolio"},5000),manage:ctx=>manageLeader(db,pos.data,{...ctx,gateway})});return{entered:true,positionId:pos.data.id,symbol:s.symbol,entryPrice:z.avg,quantity:z.qty,stopPrice:stop,hardDeadline:pos.data.hard_deadline,iocBps,sizedMarginUsdt:sized.sizedMargin,entryProtection,entryDecision:finalDecision,qv3:attempt.qv3}}if(terminal(z)){await settleKnownEntry(db,oi.data,raw,gateway);return{entered:false,reason:`IOC_NO_FILL:${z.status}`,entryDecision:finalDecision,qv3:attempt.qv3}}await db.from("v11_long_regime_orders").update({state:"RECONCILIATION_FAILED",exchange_order_id:z.exchangeOrderId,response_payload:raw,reject_reason:`IOC_PENDING:${z.status}`,updated_at:new Date().toISOString()}).eq("id",oi.data.id);await db.from("v11_long_regime_signals").update({status:"ORDERED",updated_at:new Date().toISOString()}).eq("id",s.id);throw new Error(`IOC_PENDING:${z.status}`)}catch(e){if(classifyFailure(e).fatal)throw e;await verifyExecutionLease(db);const msg=e instanceof Error?e.message:String(e),explicit=false;await db.from("v11_long_regime_orders").update({state:explicit?"REJECTED":"RECONCILIATION_FAILED",reject_reason:msg.slice(0,500),updated_at:new Date().toISOString()}).eq("id",oi.data.id);if(explicit){await db.from("v11_long_regime_signals").update({status:"REJECTED",reject_reason:msg.slice(0,500),updated_at:new Date().toISOString()}).eq("id",s.id);return{entered:false,reason:msg,qv3:attempt.qv3}}await db.from("v11_long_regime_signals").update({status:"ORDERED",updated_at:new Date().toISOString()}).eq("id",s.id);await circuit(db,`BULL_ENTRY_AMBIGUOUS:${msg}`,"KNOWN_ORDER_PENDING_RECONCILIATION",{orderId:oi.data.id,clientOrderId:id,error:msg});throw e}}
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
    const stopPct=Number(f.exitPolicy?.stopPct);if(!(stopPct>0&&stopPct<1))throw new Error("STOP_POLICY_INVALID");const stop=z.avg*(1-stopPct);if(!(stop>0&&stop<z.avg))throw new Error("STOP_INVALID");const now=new Date(),pos=await db.from("v11_long_regime_positions").insert({signal_id:s.id,revision:REVISION,entry_lane:"BULL",active_lane:"BULL",transition_from:null,symbol:s.symbol,side:"LONG",original_quantity:z.qty,remaining_quantity:z.qty,entry_price:z.avg,entry_at:now.toISOString(),entry_atr:atr,entry_bb_pos:N(f.bbPos,0),hard_stop_price:stop,hard_deadline:new Date(now.getTime()+POLICY.maxHoldMs).toISOString(),active_since:now.toISOString(),active_ref_bb:N(f.bbPos,0),active_target_delta:null,t1_completed:false,peak_price:z.avg,last_evaluated_at:now.toISOString(),state:"OPEN",realized_pnl_usdt:receipt.exact?-receipt.fee:null,entry_fee_usdt:receipt.fee,metadata:{qv3:intent.request_payload?.qv3?.version===QV3_VERSION&&intent.request_payload.qv3.basis===QV3_ACTIVATION_BASIS&&Date.parse(intent.created_at)>=Number(intent.request_payload.qv3.activation)?qv3Stamp(intent.request_payload.qv3.activation,now.getTime()):null,v18SettledPnl:receipt.exact?-receipt.fee:0,v18EntryAccountingPending:!receipt.exact,exitAccountingPending:!receipt.exact,executionMode:STRATEGY,leaderExitPolicy:f.exitPolicy,leaderExitPolicyVersion:EXIT_REVIEW_R5.policyVersion,leaderLastHighAt:now.toISOString(),executorPatch:PATCH,maxSlots:MAX_SLOTS,targetMarginUsdt:MARGIN,sizedMarginUsdt:sized.sizedMargin,lastAppliedOrderId:intent.id,entryOrderId:z.exchangeOrderId,entryFeatures:f}}).select("*").single();
    if(pos.error)throw Error(`POSITION:${pos.error.message}`);position=pos.data;
  }
  await verifyExecutionLease(db);
  const wr=await db.from("v11_long_regime_orders").update({state:receipt.exact?"FILLED":"RECONCILIATION_PENDING",exchange_order_id:receipt.id,
    response_payload:{...raw,v18ExposureFinal:true},position_id:position.id,updated_at:new Date().toISOString()}).eq("id",intent.id);
  if(wr.error)throw Error("ENTRY_ORDER_WRITE");
  const sr=await db.from("v11_long_regime_signals").update({status:position.state==="CLOSED"?"CLOSED":"FILLED",position_id:position.id,updated_at:new Date().toISOString()}).eq("id",s.id);
  if(sr.error)throw Error("ENTRY_SIGNAL_WRITE");
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
async function readOpsPair(db,gw=opsGateway(db)) {
  const pf=await gw({action:"p10_portfolio"},3000),positions=await readOpsPositions(db);
  const [manual,orders,quarantines]=await Promise.all([manualPositionAllowances(db),readOpsOrders(db,positions),
    db.from("v18_ops_incidents").select("id,generation,kind,reason,symbol,status,control_scope,exposure_state,accounting_state,order_source,evidence_version,recheck_conditions,last_checked_at,evidence")
      .eq("exchange","binance_futures").eq("account_scope","futures").eq("control_scope","SYMBOL_QUARANTINE")
      .in("status",["OPEN","VERIFYING"]).order("last_checked_at",{ascending:true}).limit(101)]);
  if(quarantines.error)throw Error("SYMBOL_QUARANTINE_READ");
  if((quarantines.data??[]).length>100)throw Error("SYMBOL_QUARANTINE_BACKLOG_OVERFLOW");
  return {pf,positions,manual,orders,quarantines:quarantines.data??[],match:classifyPortfolio(positions,pf,{manual,orders})};
}
async function withCandidateOrders(db,pair,candidateSymbol) {
  const candidate=String(candidateSymbol).toUpperCase(),r=await db.from("v11_long_regime_orders").select("*")
    .eq("symbol",candidate).in("state",["PLANNED","DISPATCHED","RECONCILIATION_FAILED","RECONCILIATION_PENDING"])
    .order("updated_at",{ascending:true}).limit(101);
  if(r.error)throw Error("CANDIDATE_ORDERS_READ");if((r.data??[]).length>100)throw Error("CANDIDATE_ORDER_BACKLOG_OVERFLOW");
  const orders=[...new Map([...pair.orders,...(r.data??[])].map(o=>[o.id,o])).values()];
  return {...pair,orders,match:classifyPortfolio(pair.positions,pair.pf,{manual:pair.manual,orders})};
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
async function reconcileOps(db,pair,budget=createBudget({ms:8000,calls:18})) {
  const gw=scopedGateway(db,budget),results=[];
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
    }catch(e){if(classifyFailure(e).fatal)throw e;results.push({orderId:o.id,error:String(e.message??e)});}
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
async function decideEntry(db,pair,candidateSymbol,openOrders,{proposedMargin=0,cashBuffer=0,managementFailures=[]}={}) {
  const controls=await opsControls(db);
  return evaluateEntryDecision({candidateSymbol,classification:pair.match,portfolio:pair.pf,openOrders,
    positions:pair.positions,orders:pair.orders,quarantines:pair.quarantines,
    manualSymbols:pair.manual.map(x=>x.symbol),managementFailures,runtime:controls.runtime,operator:controls.control,settings:controls.settings,
    maxSlots:MAX_SLOTS,proposedMargin,cashBuffer,requireNativeProtection:NATIVE_STOP_ENABLED});
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
  if(r.error)throw Error(`RECOVERY_CAS:${r.error.message}`);return r.data;
}
async function run(db) {
  const cycleStarted=new Date().toISOString();await verifyExecutionLease(db);
  const started=await db.from("v11_long_regime_runtime").update({last_cycle_started_at:cycleStarted}).eq("singleton",true);
  if(started.error)throw Error("HEARTBEAT_START_WRITE");
  let managed=[],reconciliation=[],entry={entered:false,reason:"NOT_EVALUATED"},recovery=null,symbolRecovery=[],health="NOT_EVALUATED",fatal=null,pendingAge=null,entryEvaluationCompleted=false,accountEvidenceAt=null,symbolQuarantineObserved=false;
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
    const controls=await opsControls(db);
    if(controls.runtime.circuit_open)entry.reason="CIRCUIT_OPEN_MANAGEMENT_ACTIVE";
    else if(!operatorAllowsRecovery(controls.runtime,controls.control,controls.settings))entry.reason="OPERATOR_ENTRY_BLOCK";
    else {
      pair.managementFailures=managed.filter(x=>x.error);
      const backlog=await readClosedProtectionBacklog(db,1000);
      entry=await runEntryQueue(db,pair,pair.manual,new Set(backlog.rows.map(p=>String(p.symbol).toUpperCase())),backlog.complete);
      entryEvaluationCompleted=true;
    }
    return {ok:true,revision:REVISION,patch:PATCH,qv3Runtime:{version:QV3_VERSION,basis:QV3_ACTIVATION_BASIS,
      activation:QV3_LIVE_CUTOVER,active:Number.isSafeInteger(QV3_LIVE_CUTOVER)&&Date.now()>=QV3_LIVE_CUTOVER},
      managed,reconciliation,entry,recovery,symbolRecovery,protectionHealth:health};
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
      if(managed.some(x=>x.action?.result?.executedQuantity>0||x.action?.result?.nativeReconciled)||reconciliation.some(x=>x.executedQuantity>0))patch.last_exit_at=now;
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
  queue=eligible.filter(x=>!closedProtectionSymbols.has(String(x.symbol).toUpperCase())&&!quarantinedSymbols.has(String(x.symbol).toUpperCase()))
    .sort((a,b)=>Date.parse(b.entry_bar_at)-Date.parse(a.entry_bar_at)||N(rec(a.features).rank,999)-N(rec(b.features).rank,999));
if(!queue.length)entry={entered:false,reason:eligible.length?(eligible.some(x=>quarantinedSymbols.has(String(x.symbol).toUpperCase()))?"SYMBOL_QUARANTINED":"STALE_PROTECTION_SYMBOL_LOCKED"):"NO_FRESH_BULL_SIGNAL"};for(const s of queue.slice(0,ENTRY_ATTEMPTS_PER_RUN)){const cl=await db.from("v11_long_regime_signals").update({status:"CLAIMED",updated_at:new Date().toISOString()}).eq("id",s.id).eq("status","NEW").select("*").maybeSingle();if(cl.error)throw new Error(`CLAIM:${cl.error.message}`);if(!cl.data){entry={entered:false,reason:"CLAIM_RACE"};continue}const attempt={dispatched:false};try{entry=await openBull(db,cl.data,openNow,manual,attempt,typeof pair==="undefined"?[]:pair.managementFailures??[]);if(entry?.releaseClaim===true){await db.from("v11_long_regime_signals").update({status:"NEW",updated_at:new Date().toISOString()}).eq("id",s.id).eq("status","CLAIMED");break}if(entry?.entered===true)break;}catch(e){const msg=e instanceof Error?e.message:String(e),pending=await db.from("v11_long_regime_orders").select("id").eq("signal_id",s.id).eq("state","RECONCILIATION_FAILED").limit(1);if(!pending.data?.length)await db.from("v11_long_regime_signals").update({status:"REJECTED",reject_reason:msg.slice(0,500),updated_at:new Date().toISOString()}).eq("id",s.id);if(attempt.dispatched)throw e;if(!ENTRY_SKIP_SYMBOL_SCOPED.test(msg))throw e;entry={entered:false,reason:msg};}}
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
  const {bid,ask,detectedAtMs,timing}=await leaderQuote(p,ctx);
  const meta=rec(p.metadata);
  // Preserve the existing policy. Today's nine trades do not validate a new default.
  // Cost-breakeven and profit-lock protection from the V17 exit review. These raise the
  // stop only; they can never lower it. Both are evaluated per tick with no confirmation
  // window, so they work on the current one-minute cadence.
  // costBreakeven() throws on a non-finite entry fee or quantity, which would abort this
  // whole evaluation and leave the position unmanaged. Degrade to the baseline stop
  // instead: a weaker stop still protects, no stop at all does not.
  const costUsable=p.entry_fee_usdt!=null&&Number.isFinite(Number(p.entry_fee_usdt))&&Number(p.entry_fee_usdt)>=0&&
    Number(p.original_quantity)>0;
  if(!costUsable)console.error("V17_EXIT_COST_INPUTS_UNUSABLE",p.id);
  // Cutover is per position, decided by the stamp written at entry. A position opened
  // under the old ladder keeps it for its whole life, so nothing that is already running
  // has its stop moved by this deploy: R5's risk cut is a level that only NEW positions
  // can ever add. Un-stamped rows are exactly the positions open across the deploy.
  const r5=meta.leaderExitPolicyVersion===EXIT_REVIEW_R5.policyVersion;
  const policy={...POLICY,...(costUsable?(r5?EXIT_REVIEW_R5:EXIT_REVIEW_CANDIDATE):{}),...rec(meta.leaderExitPolicy)};
  const state=nextExitReviewed({entryPrice:Number(p.entry_price),entryAt:Date.parse(p.entry_at),
    entryFee:Number(p.entry_fee_usdt),quantity:Number(p.original_quantity),
    peakPrice:Number(p.peak_price),stopPrice:Number(p.hard_stop_price),
    lastHighAt:Date.parse(meta.leaderLastHighAt||p.entry_at)},bid,detectedAtMs,policy);
  const telemetry={detectedAtMs,quoteRequestedAtMs:timing.requested_at_ms,
    quoteReceivedAtMs:timing.received_at_ms,exchangeBookAtMs:timing.book_captured_at_ms??null};
  const nextMeta={...meta,leaderLastHighAt:new Date(state.lastHighAt).toISOString(),
    leaderTrailArmed:state.armed,exitTelemetry:telemetry};
  const details={strategy:STRATEGY,bid,...state,...telemetry};
  // Keep an exchange-resident STOP_MARKET aligned with the software stop. The software
  // monitor is unchanged and remains the primary path: this only removes the window
  // between two one-minute polls, which is where the measured loss beyond the stop
  // comes from. Every failure is swallowed — protection is best-effort and must never
  // delay, block or alter a detected exit.
  async function syncNativeStop(reason){
    if(!NATIVE_STOP_ENABLED)return null;
    const exchangeQuantity=ctx?.exchangeQuantity?.get(String(p.symbol).toUpperCase());
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
  const nativeStop=await syncNativeStop("HOLD");
  // Existing stop/deadline decisions and resident protection run first. QV3 failures
  // leave that protection intact; only an exact post-cutover stamp enters QV3 scope.
  const qv3=await qv3AfterProtection(db,write.data,ctx);
  if(qv3?.result){
    await audit(db,p,"BULL","BULL","FULL_CLOSE","QV3_TWO_BEARISH_CLOSED",{...details,qv3:qv3.assessment})
      .catch(e=>console.error("QV3_AUDIT_FAILED",String(e)));
    const retired=await syncNativeStop("CLOSE");
    return {action:"CLOSE",reason:"QV3_TWO_BEARISH_CLOSED",result:qv3.result,nativeStop:retired};
  }
  if(qv3)details.qv3=qv3;
  await audit(db,p,"BULL","BULL","HOLD","V17_MOMENTUM_HOLD",{...details,nativeStop});
  return {action:"HOLD",strategy:STRATEGY,bid,...state,nativeStop};
}
async function qv3AfterProtection(db,p,ctx){
  if(QV3_LIVE_CUTOVER===null)return null;
  let closeAttempted=false;
  const shape=row=>({id:row.id,entryAt:Date.parse(row.entry_at),entryPrice:Number(row.entry_price),
    side:row.side,state:row.state,ownership:rec(row.metadata).v17ManualPosition===true?"MANUAL":"AUTO",qv3:rec(row.metadata).qv3});
  if(!qv3Scope(shape(p),QV3_LIVE_CUTOVER))return null;
  try{
    await verifyExecutionLease(db);
    const current=await db.from("v11_long_regime_positions").select("*").eq("id",p.id).single();
    if(current.error||!current.data)throw Error("QV3_POSITION_READ");
    p=current.data;
    if(!qv3Scope(shape(p),QV3_LIVE_CUTOVER)||!ownedEntry(p,await readOpsOrders(db,[p])))return {reason:"QV3_PRESERVE_OWNERSHIP_CHANGED"};
    const at=Date.now(),prior=rec(p.metadata).qv3State;
    const start=prior?.favorableCandle?Math.floor(at/60000)*60000-120000:Math.ceil(Date.parse(p.entry_at)/60000)*60000;
    const bars=await qv3Candles(p.symbol,at,start);
    const assessment=qv3Exit(shape(p),bars,Date.now(),prior);
    if(!assessment.available)return assessment;
    await verifyExecutionLease(db);
    const saved=await db.from("v11_long_regime_positions").update({metadata:{...rec(p.metadata),qv3State:assessment.state},
      updated_at:new Date(Math.max(Date.now(),Date.parse(p.updated_at)+1)).toISOString()})
      .eq("id",p.id).eq("state","OPEN").eq("updated_at",p.updated_at).select("*").maybeSingle();
    if(saved.error||!saved.data)throw Error("QV3_STATE_CAS_CONFLICT");
    if(assessment.wouldClose){closeAttempted=true;return {assessment,result:await closePos(db,saved.data,1,"QV3_TWO_BEARISH_CLOSED",ctx)};}
    return assessment;
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
async function runWithLease(db){
  const owner=crypto.randomUUID();
  const lock=await db.rpc("v17_acquire_execution_lease",{p_owner:owner});
  if(lock.error)throw new Error("V17_LEASE_UNAVAILABLE");
  if(lock.data!==true)return {ok:true,skipped:"V17_EXECUTOR_BUSY"};
  leaseOwners.set(db,owner);cycleBudgets.set(db,createBudget({ms:55000,calls:160}));
  try{return await run(db);}finally{
    leaseOwners.delete(db);cycleBudgets.delete(db);
    const released=await db.rpc("v17_release_execution_lease",{p_owner:owner});
    if(released.error)console.error("V17_LEASE_RELEASE_FAILED");
  }
}
Deno.serve(async req=>{if(req.method!=="POST")return res(405,{ok:false,error:"POST_ONLY"});const U=env("SUPABASE_URL"),K=env("SUPABASE_SERVICE_ROLE_KEY"),db=createClient(U,K,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(url,init={})=>{const headers=new Headers(init.headers);const owner=leaseOwners.get(db);if(owner)headers.set("x-v18-execution-owner",owner);const timeout=AbortSignal.timeout(2500);return fetch(url,{...init,headers,signal:init.signal?AbortSignal.any([init.signal,timeout]):timeout})}}});if(!(await auth(db,req)))return res(401,{ok:false,error:"UNAUTHORIZED"});const body=await req.json().catch(()=>({})),mode=String(body.mode||"run").toLowerCase();try{if(mode==="preflight"||mode==="diagnostic"){const[m,sn,pf,q,i,rt,op]=await Promise.all([market(db),snap(db),gateway({action:"p10_portfolio"}),gateway({action:"quote",market:String(body.symbol||"BTCUSDT")}),gateway({action:"symbol_info",market:String(body.symbol||"BTCUSDT")}),db.from("v11_long_regime_runtime").select("*").eq("singleton",true).single(),db.from("v11_long_regime_positions").select("id,symbol,active_lane,peak_price,entry_price,last_evaluated_at").eq("state","OPEN").limit(MAX_SLOTS+1)]),step=N(i?.quantity_step??i?.step_size),ask=N(q?.best_ask),sizing=ask>0&&step>0?sizeEntry(ask,step):null;return res(200,{ok:true,revision:REVISION,patch:PATCH,maxSlots:MAX_SLOTS,runtime:rt.data,marketState:m,snapshotAgeMs:sn.ageMs,availableUsdt:Math.min(N(sn.available_quote),N(pf?.available_quote)),externalPositions:active(pf).map(x=>({symbol:sym(x),quantity:qty(x)})),openPositions:op.data||[],quote:q,symbolInfo:{step,minNotional:i?.min_notional},sizing})}return res(200,await runWithLease(db))}catch(e){const msg=e instanceof Error?e.message:String(e);return res(500,{ok:false,revision:REVISION,patch:PATCH,error:msg})}});
