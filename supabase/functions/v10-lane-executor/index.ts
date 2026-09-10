// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {POLICY, STRATEGY, entryFresh, nextExit, portfolioMatches as leaderPortfolioMatches} from "../_shared/leader-momentum-v17.mjs";
import {nextExitReviewed, EXIT_REVIEW_CANDIDATE, EXIT_REVIEW_R5, exitAttemptId, classifyExitResponse} from "../_shared/leader-exit-review.mjs";
import {protectNewLeaderPosition} from "../_shared/leader-entry-protection.mjs";
import {createGatewayProtection} from "../_shared/leader-protection-adapter.mjs";
import {managementPass, updateLastExit, rememberEntryProtection, reconcileBeforeClose, executionPending, recentLeaderExit} from "../_shared/leader-operations.mjs";
import {readExecutionReceipt, exitExecutionPatch, recoverExecutionJournal} from "../_shared/leader-settlement.mjs";
const REVISION="V11-LONG-REGIME-1.0.1",PATCH="V18-OPS-HARDENING-1",OBSERVER_REVISION="MARKET-REGIME-OBSERVER-v2-C01-HYSTERESIS-v1-FULLMARKET",PROTOCOL="8.0.0-P10-DONCHIAN-SLOW4R";
// Bounded so a bar of refusals cannot stretch the run past the one-minute cadence.
const ENTRY_ATTEMPTS_PER_RUN=3;
// Pre-dispatch refusals scoped to one symbol. Never includes STOP_POLICY_INVALID or
// STOP_INVALID, which are raised only AFTER a fill -- those are caught by the
// dispatched guard regardless, which is the check that actually protects the account.
const ENTRY_SKIP_SYMBOL_SCOPED=/^(SIGNAL_STALE_OR_FUTURE|SIGNAL_PREDATES_LAST_EXIT|ENTRY_DRIFT|WRONG_STRATEGY|INVALID_PRICE|V17_EXIT_POLICY_INVALID|MANUAL_SYMBOL_LOCKED|ENTRY_SPREAD|ENTRY_FEATURES_INVALID|QTY_INVALID|ENTRY_GRANULARITY_BPS|ENTRY_SLOT_GRANULARITY_MARGIN|ENTRY_NOTIONAL_UNDERSIZED|V17_LIMIT_PRICE_MARGIN_OVERFLOW)/;
const MARGIN=40,LEV=3,NOTIONAL=MARGIN*LEV,MAX_SLOTS=10,NOTIONAL_BUFFER_USDT=.12,MAX_MARGIN_BUFFER_USDT=.25,ENTRY_CASH_BUFFER_USDT=.10,SNAP_MAX=90000,SIGNAL_MAX=300000,SPREAD_MAX=25,MAX_GAP_ATR=.5,IOC_BASE_BPS=3,IOC_MAX_BPS=12,BULL_MAX_MS=30*86400000,T1_PRICE=.075,PARTIAL=.30,TRAIL=.0225;
function res(s,b){return new Response(JSON.stringify(b),{status:s,headers:{"content-type":"application/json","cache-control":"no-store"}})}function N(v,d=0){const x=Number(v);return Number.isFinite(x)?x:d}function rec(v){return v&&typeof v==="object"&&!Array.isArray(v)?v:{}}function eq(a,b){if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0}function dec(s){return Math.min(12,Math.max(0,Math.ceil(-Math.log10(s))+2))}function floorStep(v,s){if(!(v>0&&s>0))return 0;return Number((Math.floor((v+s*1e-9)/s)*s).toFixed(dec(s)))}function ceilStep(v,s){if(!(v>0&&s>0))return 0;return Number((Math.ceil((v-s*1e-9)/s)*s).toFixed(dec(s)))}function addStep(v,s){return Number((v+s).toFixed(dec(s)))}function cid(p,x){return`tb-${p}-${String(x).toLowerCase().replace(/[^a-z0-9]/g,"").slice(0,24)}`.slice(0,36)}function terminal(z){return z.qty===0&&["CANCELED","CANCELLED","REJECTED","EXPIRED","PARTIALLY_FILLED_CANCELED"].includes(z.status)}
const env=n=>(Deno.env.get(n)||"").trim(),GW=env("BINANCE_FUTURES_ORDER_GATEWAY_URL").replace(/\/$/,"")||env("BINANCE_ORDER_GATEWAY_URL").replace(/\/$/,"")||env("ORDER_GATEWAY_URL").replace(/\/$/,""),SEC=env("BINANCE_FUTURES_GATEWAY_SHARED_SECRET")||env("BINANCE_GATEWAY_SHARED_SECRET")||env("GATEWAY_SHARED_SECRET");
// Exchange-resident protective stop. Default OFF: enabling it starts submitting real
// STOP_MARKET orders, so it is a deliberate operator action, not a deploy side effect.
const NATIVE_STOP_ENABLED=env("V17_NATIVE_STOP")==="true";
async function hmac(s,m){const k=await crypto.subtle.importKey("raw",new TextEncoder().encode(s),{name:"HMAC",hash:"SHA-256"},false,["sign"]),g=await crypto.subtle.sign("HMAC",k,new TextEncoder().encode(m));return[...new Uint8Array(g)].map(x=>x.toString(16).padStart(2,"0")).join("")}
async function gateway(cmd,tm=20000){if(!GW||!SEC)throw new Error("GATEWAY_CONFIG");const x=["create_order","v17_create_stop","v17_cancel_stop"].includes(cmd.action)?{...cmd,engine_version:PROTOCOL}:cmd,raw=JSON.stringify({exchange:"binance_futures",...x}),ts=String(Date.now()),nonce=crypto.randomUUID(),sig=await hmac(SEC,`${ts}\n${nonce}\n${raw}`),c=new AbortController,t=setTimeout(()=>c.abort(),tm);try{const r=await fetch(`${GW}/v1/command`,{method:"POST",signal:c.signal,headers:{"content-type":"application/json","x-gateway-ts":ts,"x-gateway-nonce":nonce,"x-gateway-signature":sig},body:raw}),txt=await r.text();let d;try{d=txt?JSON.parse(txt):null}catch{d={raw:txt}}if(!r.ok||!d?.ok)throw new Error(`GW_${r.status}:${d?.error||txt}`);return d.result}catch(error){
 if(cmd.action!=="create_order")throw error;
 for(let attempt=0;attempt<3;attempt++){
  await new Promise(resolve=>setTimeout(resolve,900));
  try{const recovered=await gateway({action:"get_order",market:cmd.order.market,identifier:cmd.order.identifier},6000),receipt=fill(recovered);
   if(receipt.qty!==null&&(receipt.qty>0||terminal(receipt)))return recovered;
  }catch{/* the uncertain order is never submitted again */}
 }
 throw new Error("V18_ORDER_DISPATCH_UNRESOLVED");
}finally{clearTimeout(t)}}
function fill(p){return readExecutionReceipt(p)}
function active(p){return(Array.isArray(p?.positions)?p.positions:[]).filter(x=>Math.abs(N(x?.quantity??x?.positionAmt??x?.position_amount))>1e-12)}function sym(p){return String(p?.market??p?.symbol??"").toUpperCase()}function qty(p){return Math.abs(N(p?.quantity??p?.positionAmt??p?.position_amount))}
async function auth(db,req){const p=(req.headers.get("x-v18-protection-token")||req.headers.get("x-v10-executor-token")||"").trim();const t=await db.from("edge_internal_tokens").select("token").eq("name","v10-lane-executor").maybeSingle();return!t.error&&p&&t.data?.token&&eq(p,String(t.data.token))}
function route(v){const x=String(v||"").toUpperCase();return x==="RISK_OFF"?"BEAR":x==="NEUTRAL"?"RANGE":x==="BULL"||x==="STRONG_BULL"?"BULL":"CASH"}
async function market(db){const o=await db.from("market_regime_observations").select("id,observed_at,predicted_regime,bull_score,confidence").eq("model_revision",OBSERVER_REVISION).eq("trading_influence",true).order("observed_at",{ascending:false}).limit(1).maybeSingle();if(o.error)throw new Error(`OBSERVER:${o.error.message}`);const age=o.data?Date.now()-Date.parse(o.data.observed_at):Infinity;return{route:age<=12*60000?route(o.data?.predicted_regime):"CASH",ageMs:age,observer:o.data||null}}
async function snap(db){const s=await db.from("trading_account_snapshots").select("captured_at,available_quote,positions,positions_complete").eq("exchange","binance_futures").order("captured_at",{ascending:false}).limit(1).maybeSingle();if(s.error||!s.data)throw new Error("SNAPSHOT_MISSING");const age=Date.now()-Date.parse(s.data.captured_at);if(s.data.positions_complete!==true||!Number.isFinite(age)||age<0||age>SNAP_MAX)throw new Error(`SNAPSHOT_INVALID:${age}`);return{...s.data,ageMs:age}}
async function circuit(db,r){await db.from("v11_long_regime_runtime").update({circuit_open:true,circuit_reason:String(r).slice(0,500),last_error:String(r).slice(0,1000),updated_at:new Date().toISOString()}).eq("singleton",true)}
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
// A Binance futures MARKET order can acknowledge as FILLED for the whole quantity before
// /fapi/v1/userTrades has indexed its fills, so the ack carries avgPrice 0 and an empty
// trade list. On 2026-09-09 that made MAGMAUSDT report EXIT_NO_FILL:FILLED while the
// position was already flat on the exchange, which opened the circuit and halted V17 for
// nine hours -- with the books still saying OPEN 449.
//
// Only the PRICE is missing there; whether the position exists is not in question. So we
// re-read the order, which the gateway answers by re-fetching userTrades. This is a read:
// unlike re-sending the order it cannot close a position twice, which is the same reason
// leaderQuote() may retry and the exit dispatch may not.
const EXIT_SETTLE_ATTEMPTS=3,EXIT_SETTLE_DELAY_MS=900,EXIT_SETTLE_TIMEOUT_MS=6000;
async function settleExitFill(p,identifier,z,onResponse){
  for(let i=0;i<EXIT_SETTLE_ATTEMPTS;i++){
    await new Promise(r=>setTimeout(r,EXIT_SETTLE_DELAY_MS));
    try{
      const q={action:"get_order",market:p.symbol,identifier};
      if(z.exchangeOrderId)q.exchange_order_id=z.exchangeOrderId;
      const raw=await gateway(q,EXIT_SETTLE_TIMEOUT_MS),y=fill(raw);
      if(y.qty>0&&y.avg>0&&y.feeKnown!==false&&(!z.exchangeOrderId||y.exchangeOrderId===z.exchangeOrderId)){onResponse?.(raw);return{...y,exchangeOrderId:y.exchangeOrderId??z.exchangeOrderId}}
    }catch(_){/* a failed read leaves the ack as the best evidence we have */}
  }
  return z;
}
async function closePos(db,p,fraction,reason){
 if(NATIVE_STOP_ENABLED&&rec(p.metadata).executionMode===STRATEGY){
  p=await reconcileBeforeClose({db,position:p,protection:createGatewayProtection(db,gateway,()=>verifyExecutionLease(db))});
  if(p.state==="CLOSED")return{closed:true,position:p,exitPrice:p.exit_price,realizedPnlUsdt:p.realized_pnl_usdt,nativeAlreadyClosed:true};
 }
 const outstanding=await db.from("v11_long_regime_orders").select("id,state,response_payload").eq("position_id",p.id).in("state",["PLANNED","RECONCILIATION_FAILED","RECONCILIATION_PENDING"]).limit(30);
 if(outstanding.error||outstanding.data?.some(executionPending))throw Error("V18_EXIT_RECONCILIATION_REQUIRED");
 const [pf,info]=await Promise.all([gateway({action:"p10_portfolio"}),gateway({action:"symbol_info",market:p.symbol})]);
 const rows=active(pf).filter(x=>sym(x)===p.symbol.toUpperCase());
 if(!portfolioMatches([p],{positions:rows}).ok){await circuit(db,"BULL_EXCHANGE_MISMATCH:"+p.symbol);throw Error("POSITION_MISMATCH");}
 const step=N(info?.quantity_step??info?.step_size),amount=floorStep(N(p.remaining_quantity)*Math.max(0,Math.min(1,fraction)),step);
 if(!(amount>0))throw Error("EXIT_QTY_ZERO");
 const id=await exitAttemptId(p.id,crypto.randomUUID(),reason==="BULL_T1"?"v11p":"v11x");
 const request={action:"create_order",order:{market:p.symbol,side:"SELL",type:"MARKET",quantity:amount,identifier:id,position_side:"LONG",position_effect:"CLOSE"},wait_for_final_ms:4000};
 const oi=await db.from("v11_long_regime_orders").insert({revision:REVISION,signal_id:p.signal_id,position_id:p.id,symbol:p.symbol,intent:reason==="BULL_T1"?"PARTIAL_CLOSE":"CLOSE_LONG",reason,client_order_id:id,requested_quantity:amount,state:"PLANNED",request_payload:{...request,quantity_step:step,fraction,position_quantity_before:p.remaining_quantity,executor_patch:PATCH}}).select("*").single();
 if(oi.error)throw Error("EXIT_INTENT");
 let z=null,settled=null;
 try{
  await verifyExecutionLease(db);settled=await gateway(request);z=fill(settled);
  if(z.qty>0&&(!(z.avg>0)||z.feeKnown===false))z=await settleExitFill(p,id,z,r=>{settled=r;});
  const patch=exitExecutionPatch(p,oi.data,z),closed=patch?.state==="CLOSED",pending=patch?.metadata?.exitAccountingPending===true;
  if(!patch)throw Error("EXIT_ALREADY_APPLIED");
  const up=await db.from("v11_long_regime_positions").update(patch).eq("id",p.id).eq("updated_at",p.updated_at).select("*").single();
  if(up.error||!up.data)throw Error("EXIT_POSITION_CAS");
  const fillState=classifyExitResponse(amount,z.qty,z.status,step);
  const saved=await db.from("v11_long_regime_orders").update({state:pending?"RECONCILIATION_PENDING":fillState.state,exchange_order_id:z.exchangeOrderId,response_payload:settled,updated_at:new Date().toISOString()}).eq("id",oi.data.id);
  if(saved.error)throw Error("EXIT_RECEIPT_WRITE");
  if(closed)await db.from("v11_long_regime_signals").update({status:"CLOSED",updated_at:new Date().toISOString()}).eq("id",p.signal_id);
  return {closed,position:up.data,exitPrice:z.avg??null,realizedPnlUsdt:patch.realized_pnl_usdt,accountingPending:pending};
 }catch(e){
  const patch={state:"RECONCILIATION_FAILED",reject_reason:String(e?.message??e).slice(0,500),updated_at:new Date().toISOString()};
  if(z?.exchangeOrderId)patch.exchange_order_id=z.exchangeOrderId;if(settled)patch.response_payload=settled;
  await db.from("v11_long_regime_orders").update(patch).eq("id",oi.data.id);
  await circuit(db,"BULL_EXIT_AMBIGUOUS:"+p.symbol);throw e;
 }
}
async function manageBull(db,p,m,ctx){
if(rec(p.metadata).executionMode===STRATEGY)return await manageLeader(db,p,ctx);
const q=await gateway({action:"quote",market:p.symbol}),bid=N(q?.best_bid);if(!(bid>0))throw new Error("QUOTE_INVALID");const now=new Date().toISOString(),entry=N(p.entry_price),peak=Math.max(N(p.peak_price,entry),bid),peakWrite=await db.from("v11_long_regime_positions").update({peak_price:peak,last_evaluated_at:now,updated_at:now}).eq("id",p.id).select("*").single();if(peakWrite.error)throw new Error(`BULL_PEAK_WRITE:${peakWrite.error.message}`);p=peakWrite.data;const stop=N(p.hard_stop_price),deadline=Date.parse(p.hard_deadline);if(Number.isFinite(deadline)&&Date.now()>=deadline){await audit(db,p,"BULL","BULL","FULL_CLOSE","BULL_30D_SAFETY_DEADLINE",{marketRoute:m.route,bid,peak});return{action:"CLOSE",reason:"BULL_30D_SAFETY_DEADLINE",result:await closePos(db,p,1,"BULL_30D_SAFETY_DEADLINE")}}if(bid<=stop){await audit(db,p,"BULL","BULL","FULL_CLOSE","BULL_HARD_STOP",{marketRoute:m.route,bid,stop,peak});return{action:"CLOSE",reason:"BULL_HARD_STOP",result:await closePos(db,p,1,"BULL_HARD_STOP")}}if(m.route==="RANGE"||m.route==="BEAR"){const r=`REGIME_BULL_TO_${m.route}_REALIZE`;await audit(db,p,"BULL",m.route,"FULL_CLOSE",r,{marketRoute:m.route,bid,peak});return{action:"CLOSE",reason:r,result:await closePos(db,p,1,r)}}const t1=entry*(1+T1_PRICE);if(!p.t1_completed&&bid>=t1){await audit(db,p,"BULL","BULL","PARTIAL_CLOSE","BULL_T1",{marketRoute:m.route,bid,t1,peak});const frac=Math.min(1,N(p.original_quantity)*PARTIAL/Math.max(1e-12,N(p.remaining_quantity))),r=await closePos(db,p,frac,"BULL_T1");if(r?.position&&!r.closed){const ns=Math.max(N(r.position.hard_stop_price),entry),up=await db.from("v11_long_regime_positions").update({hard_stop_price:ns,peak_price:peak,last_evaluated_at:now,updated_at:now}).eq("id",p.id);if(up.error)throw new Error(`T1_PROTECT:${up.error.message}`)}return{action:"PARTIAL",reason:"BULL_T1",result:r}}let newStop=stop;if(p.t1_completed)newStop=Math.max(stop,entry,peak*(1-TRAIL));if(newStop>stop){const up=await db.from("v11_long_regime_positions").update({hard_stop_price:newStop,peak_price:peak,last_evaluated_at:now,updated_at:now}).eq("id",p.id);if(up.error)throw new Error(`BULL_TRAIL_WRITE:${up.error.message}`)}if(p.t1_completed&&bid<=newStop){await audit(db,p,"BULL","BULL","FULL_CLOSE","BULL_TRAIL_PROTECTION",{marketRoute:m.route,bid,newStop,peak});return{action:"CLOSE",reason:"BULL_TRAIL_PROTECTION",result:await closePos(db,{...p,hard_stop_price:newStop,peak_price:peak},1,"BULL_TRAIL_PROTECTION")}}await audit(db,p,"BULL","BULL","HOLD","BULL_TREND_HOLD",{marketRoute:m.route,bid,t1,t1Completed:p.t1_completed,peak,newStop,deadline:p.hard_deadline});return{action:"HOLD",lane:"BULL",bid,t1,peak,newStop,deadline:p.hard_deadline}}
// `attempt` is an out-param: openBull sets dispatched=true at the instant an order
// leaves this process. run() uses it to decide whether a failure is safe to move past.
async function openBull(db,s,openPositions,manual=null,attempt={}){
await requireLeaderEntryControls(db);
const exitPolicy=rec(s.features?.exitPolicy);
if(!Object.values(exitPolicy).every(v=>Number.isFinite(Number(v)))||!(Number(exitPolicy.stopPct)>0&&Number(exitPolicy.stopPct)<1&&Number(exitPolicy.trailArmPct)>0&&Number(exitPolicy.trailGapPct)>0&&Number(exitPolicy.trailGapPct)<1&&Number(exitPolicy.maxHoldMs)===POLICY.maxHoldMs&&Number(exitPolicy.staleMs)>0))throw new Error("V17_EXIT_POLICY_INVALID");
const initialFresh=entryFresh(rec(s.features),Date.now(),Number(s.features?.referenceClose));
if(initialFresh)throw new Error(initialFresh);
const[sn,pf,q,i,manualRows]=await Promise.all([snap(db),gateway({action:"p10_portfolio"}),gateway({action:"quote",market:s.symbol}),gateway({action:"symbol_info",market:s.symbol}),manual?Promise.resolve(manual):manualPositionAllowances(db)]),pm=portfolioMatches(openPositions,pf,manualRows);if(!pm.ok){await circuit(db,`BULL_EXTERNAL_EXPOSURE:${pm.reason}:${pm.ext.map(sym).join(",")}`);throw new Error("EXTERNAL_POSITION")}if(manualRows.some(x=>x.symbol===String(s.symbol).toUpperCase()))throw new Error("MANUAL_SYMBOL_LOCKED");if(openPositions.length>=MAX_SLOTS)return{entered:false,reason:"V11_SLOT_FULL"};if(openPositions.some(p=>String(p.symbol).toUpperCase()===String(s.symbol).toUpperCase()))return{entered:false,reason:"DUPLICATE_SYMBOL_OPEN"};const bid=N(q?.best_bid),ask=N(q?.best_ask),sp=bid>0&&ask>0?(ask/bid-1)*10000:999;if(!(bid>0&&ask>0&&sp<=SPREAD_MAX))throw new Error(`ENTRY_SPREAD:${sp}`);const f=rec(s.features),ref=N(f.referenceClose),atr=N(f.atr);if(!(atr>0&&ref>0))throw new Error("ENTRY_FEATURES_INVALID");const step=N(i?.quantity_step??i?.step_size),min=Math.max(1,N(i?.min_notional,5)),sized=sizeEntry(ask,step);if(sized.sizedNotional<min)throw new Error("QTY_INVALID");const live=N(pf?.available_quote,NaN),avail=Math.min(N(sn.available_quote),live);if(!Number.isFinite(live))throw new Error("ENTRY_AVAILABLE_BALANCE_UNREADABLE");if(avail<sized.sizedMargin+ENTRY_CASH_BUFFER_USDT)return{entered:false,reason:`ENTRY_MARGIN_INSUFFICIENT:${avail.toFixed(4)}:${sized.sizedMargin.toFixed(4)}`,releaseClaim:true};const gatePrice=(NOTIONAL+NOTIONAL_BUFFER_USDT)/sized.amount,limitPrice=Math.max(ask*(1+IOC_BASE_BPS/10000),gatePrice),iocBps=(limitPrice/ask-1)*10000;if(iocBps>IOC_MAX_BPS)throw new Error(`ENTRY_GRANULARITY_BPS:${iocBps.toFixed(3)}`);const gap=Math.abs(limitPrice-ref)/atr;
const finalFresh=entryFresh(f,Date.now(),limitPrice);if(finalFresh)throw new Error(finalFresh);
if(sized.amount*limitPrice/LEV>MARGIN+MAX_MARGIN_BUFFER_USDT+1e-9)throw new Error("V17_LIMIT_PRICE_MARGIN_OVERFLOW");
// V17 replaces pullback-specific ATR gap gating with a price-drift/age guard.
await requireLeaderEntryControls(db);const recentExit=await recentLeaderExit(db,s.symbol);if(recentExit?.closedAt&&Date.parse(recentExit.closedAt)>=Number(f.signal5Close))throw Error("SIGNAL_PREDATES_LAST_EXIT");const id=cid("v11e",s.id),rp={action:"create_order",leverage:LEV,order:{market:s.symbol,side:"BUY",type:"LIMIT",price:limitPrice,time_in_force:"IOC",quantity:sized.amount,identifier:id,position_side:"LONG",position_effect:"OPEN"},wait_for_final_ms:4000},oi=await db.from("v11_long_regime_orders").insert({revision:REVISION,signal_id:s.id,position_id:null,symbol:s.symbol,intent:"OPEN_LONG",reason:"V17_LEADER_ENTRY_IOC",client_order_id:id,requested_quantity:sized.amount,state:"PLANNED",request_payload:{...rp,reentry_context:recentExit,quantity_step:step,target_margin_usdt:MARGIN,sized_margin_usdt:sized.sizedMargin,sized_notional_usdt:sized.sizedNotional,leverage:LEV,spread_bps:sp,entry_gap_atr:gap,ioc_bps:iocBps,max_slots:MAX_SLOTS,executor_patch:PATCH}}).select("*").single();if(oi.error)throw new Error(`ORDER_INTENT:${oi.error.message}`);try{await verifyExecutionLease(db);attempt.dispatched=true;const raw=await gateway(rp),z=fill(raw);if(z.qty>0){return await recordLeaderEntry(db,s,oi.data,z,raw,manualRows)}if(terminal(z)){const why=`IOC_NO_FILL:${z.status}`;await db.from("v11_long_regime_orders").update({state:"REJECTED",exchange_order_id:z.exchangeOrderId,response_payload:raw,reject_reason:why,updated_at:new Date().toISOString()}).eq("id",oi.data.id);await db.from("v11_long_regime_signals").update({status:"REJECTED",reject_reason:why,updated_at:new Date().toISOString()}).eq("id",s.id);return{entered:false,reason:why}}await db.from("v11_long_regime_orders").update({state:"RECONCILIATION_FAILED",exchange_order_id:z.exchangeOrderId,response_payload:raw,reject_reason:`IOC_PENDING:${z.status}`,updated_at:new Date().toISOString()}).eq("id",oi.data.id);await db.from("v11_long_regime_signals").update({status:"ORDERED",updated_at:new Date().toISOString()}).eq("id",s.id);await circuit(db,`BULL_ENTRY_AMBIGUOUS:${z.status}`);throw new Error(`IOC_PENDING:${z.status}`)}catch(e){const msg=e instanceof Error?e.message:String(e),explicit=/^GW_4\d\d:/.test(msg);await db.from("v11_long_regime_orders").update({state:explicit?"REJECTED":"RECONCILIATION_FAILED",reject_reason:msg.slice(0,500),updated_at:new Date().toISOString()}).eq("id",oi.data.id);if(explicit){await db.from("v11_long_regime_signals").update({status:"REJECTED",reject_reason:msg.slice(0,500),updated_at:new Date().toISOString()}).eq("id",s.id);return{entered:false,reason:msg}}await db.from("v11_long_regime_signals").update({status:"ORDERED",updated_at:new Date().toISOString()}).eq("id",s.id);await circuit(db,`BULL_ENTRY_AMBIGUOUS:${msg}`);throw e}}
async function recordLeaderEntry(db,s,order,z,raw,manualRows=null){
 const manual=manualRows??await manualPositionAllowances(db),f=rec(s.features),stopPct=Number(f.exitPolicy?.stopPct);
 if(!(stopPct>0&&stopPct<1))throw Error("STOP_POLICY_INVALID");
 if(!(z.avg>0)){
  const pf=await gateway({action:"p10_portfolio"}),rows=active(pf).filter(x=>sym(x)===s.symbol);
  if(rows.length!==1||Math.abs(qty(rows[0])-z.qty)>Math.max(1e-10,z.qty*1e-8)||manual.some(x=>x.symbol===s.symbol))throw Error("ENTRY_PRICE_PENDING");
  z={...z,avg:Number(rows[0].entry_price),priceSource:"SIGNED_POSITION"};
 }
 if(!(z.avg>0))throw Error("ENTRY_PRICE_PENDING");
 const stop=z.avg*(1-stopPct);if(!(stop>0&&stop<z.avg))throw Error("STOP_INVALID");
 const existing=await db.from("v11_long_regime_positions").select("*").eq("signal_id",s.id).maybeSingle();
 if(existing.error)throw Error("ENTRY_POSITION_READ");
 let p=existing.data;
 if(p&&(p.metadata?.executionMode!==STRATEGY||p.metadata?.v17ManualPosition===true||z.qty<Number(p.original_quantity)-1e-8))throw Error("ENTRY_RECEIPT_OWNERSHIP_OR_QUANTITY");
 const now=Date.now(),entryAt=z.firstFillAt>0&&z.firstFillAt<=now?z.firstFillAt:now,fee=z.feeKnown===false?null:z.fee;
 if(!p){
  const pos=await db.from("v11_long_regime_positions").insert({signal_id:s.id,revision:REVISION,entry_lane:"BULL",active_lane:"BULL",transition_from:null,symbol:s.symbol,side:"LONG",original_quantity:z.qty,remaining_quantity:z.qty,entry_price:z.avg,entry_at:new Date(entryAt).toISOString(),entry_atr:Number(f.atr),entry_bb_pos:N(f.bbPos),hard_stop_price:stop,hard_deadline:new Date(entryAt+POLICY.maxHoldMs).toISOString(),active_since:new Date(entryAt).toISOString(),active_ref_bb:N(f.bbPos),active_target_delta:null,t1_completed:false,peak_price:z.avg,last_evaluated_at:new Date(now).toISOString(),state:"OPEN",realized_pnl_usdt:fee===null?null:-fee,entry_fee_usdt:fee,
   metadata:{executionMode:STRATEGY,leaderExitPolicy:f.exitPolicy,leaderExitPolicyVersion:EXIT_REVIEW_R5.policyVersion,leaderLastHighAt:new Date(entryAt).toISOString(),executorPatch:PATCH,maxSlots:MAX_SLOTS,targetMarginUsdt:MARGIN,sizedMarginUsdt:order.request_payload?.sized_margin_usdt,lastAppliedOrderId:order.id,entryOrderId:z.exchangeOrderId||order.client_order_id,entryFeatures:f,knownExitPnlUsdt:0,entryAccountingPending:fee===null,entryPriceSource:z.priceSource??"ORDER_FILL"}}).select("*").single();
  if(pos.error||!pos.data)throw Error("ENTRY_POSITION_WRITE");p=pos.data;
 }else if(z.qty>Number(p.original_quantity)+1e-10){
  // Only additional fills of THIS persisted IOC, never a top-up order. Refuse to
  // resize after any exit; that requires explicit mixed-fill reconciliation.
  if(p.state!=="OPEN"||Number(p.remaining_quantity)!==Number(p.original_quantity)||p.metadata?.entryOrderId!==z.exchangeOrderId)throw Error("ENTRY_RESIDUAL_RECONCILIATION_REQUIRED");
  const up=await db.from("v11_long_regime_positions").update({original_quantity:z.qty,remaining_quantity:z.qty,entry_price:z.avg,entry_fee_usdt:fee,realized_pnl_usdt:fee===null?null:-fee,hard_stop_price:Math.max(Number(p.hard_stop_price),stop),metadata:{...p.metadata,entryAccountingPending:fee===null},updated_at:new Date(now).toISOString()}).eq("id",p.id).eq("updated_at",p.updated_at).select("*").single();
  if(up.error||!up.data)throw Error("ENTRY_RESIDUAL_CAS");p=up.data;
 }
 const terminalFill=["FILLED","EXPIRED","CANCELED","CANCELLED","PARTIALLY_FILLED_CANCELED"].includes(z.status);
 const link=await db.from("v11_long_regime_orders").update({state:terminalFill?"FILLED":"RECONCILIATION_PENDING",exchange_order_id:z.exchangeOrderId,response_payload:raw,position_id:p.id,updated_at:new Date().toISOString()}).eq("id",order.id);
 const linkFailed=!!link.error;
 await db.from("v11_long_regime_signals").update({status:p.state==="CLOSED"?"CLOSED":"FILLED",position_id:p.id,updated_at:new Date().toISOString()}).eq("id",s.id);
 const entryProtection=p.state==="CLOSED"?{status:"CLOSED",softwareMonitorRequired:false}:await protectNewLeaderPosition({enabled:NATIVE_STOP_ENABLED,position:p,manualSymbols:manual.map(x=>x.symbol),readPortfolio:()=>gateway({action:"p10_portfolio"},5000),manage:ctx=>manageLeader(db,p,ctx)});
 try{await rememberEntryProtection(db,p.id,entryProtection)}catch{console.error("V18_ENTRY_PROTECTION_JOURNAL_FAILED",p.id)}
 if(linkFailed)throw Error("ENTRY_ORDER_LINK");
 return {entered:true,positionId:p.id,symbol:s.symbol,entryPrice:z.avg,quantity:z.qty,stopPrice:stop,hardDeadline:p.hard_deadline,iocBps:order.request_payload?.ioc_bps,sizedMarginUsdt:order.request_payload?.sized_margin_usdt,entryProtection};
}
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
// A native stop that fills between two one-minute polls leaves the exchange without the
// position while the database still shows it open. That divergence is precisely what the
// exchange-resident stop exists to produce, so it must be reconciled BEFORE the mismatch
// guard runs. Otherwise the feature working as designed opens the circuit breaker and
// halts all trading with the fill unbooked -- the success case would be the failure case.
// Narrow by construction: only when the flag is on, only for positions that actually
// carry a live protection order, and the guard still trips if the books do not then agree.
async function reconcileNativeFills(db,open){
  if(!NATIVE_STOP_ENABLED)return null;
  const pending=open.filter(p=>(rec(rec(p.metadata).exitProtection).orders||[])
    .some(o=>o&&o.terminal!==true));
  if(!pending.length)return null;
  const protection=createGatewayProtection(db,gateway,()=>verifyExecutionLease(db));
  for(const p of pending){
    // A reconciliation failure must not mask the mismatch; leave the guard to fire.
    try{await protection.refresh(p.id)}
    catch(e){console.error("V17_NATIVE_RECONCILE_FAILED",p.id,String(e instanceof Error?e.message:e))}
  }
  const again=await db.from("v11_long_regime_positions").select("*").eq("state","OPEN")
    .order("entry_at",{ascending:true}).limit(MAX_SLOTS+1);
  if(again.error)throw new Error(`POSITIONS_RECONCILE:${again.error.message}`);
  return again.data||[];
}
async function run(db){const rt=await db.from("v11_long_regime_runtime").select("*").eq("singleton",true).single();if(rt.error||!rt.data)throw new Error("RUNTIME");if(rt.data.revision!==REVISION)throw new Error(`REVISION_MISMATCH:${rt.data.revision}`);if(rt.data.circuit_open===true&&rt.data.live_enabled===true)return runProtectionPass(db);if(rt.data.live_enabled!==true)return{ok:true,revision:REVISION,patch:PATCH,skipped:"RUNTIME_NOT_LIVE",runtime:rt.data};const op=await db.from("v11_long_regime_positions").select("*").eq("state","OPEN").order("entry_at",{ascending:true}).limit(MAX_SLOTS+1);if(op.error)throw new Error(`POSITIONS:${op.error.message}`);if((op.data||[]).length>MAX_SLOTS){await circuit(db,`V11_SLOT_OVERFLOW:${op.data.length}`);throw new Error("V11_SLOT_OVERFLOW")}let allOpen=op.data||[],m=allOpen.some(p=>p.active_lane==="BULL"&&rec(p.metadata).executionMode!==STRATEGY)?await market(db).catch(e=>({route:"CASH",observer:null,error:String(e)})):{route:"MOMENTUM",observer:null},[pf,manual]=await Promise.all([gateway({action:"p10_portfolio"}),manualPositionAllowances(db)]),pm=portfolioMatches(allOpen,pf,manual);if(!pm.ok){const reconciled=await reconcileNativeFills(db,allOpen);if(reconciled){allOpen=reconciled;pm=portfolioMatches(allOpen,pf,manual)}}if(!pm.ok){await circuit(db,`BULL_EXCHANGE_MISMATCH:${pm.reason}:${pm.ext.map(sym).join(",")}`);throw new Error("EXCHANGE_MISMATCH")}await pushShadowPositions(db,allOpen).catch(e=>console.error("V17_SHADOW_PUSH_FAILED",String(e)));
  const ctx={manualSymbols:manual.map(x=>x.symbol),exchangeQuantity:new Map((pm.ext||[]).map(x=>[String(x.symbol||"").toUpperCase(),N(x.absoluteQuantity)])),quoteRetryBudget:{remaining:3}};
  const actions=[];for(const p of allOpen.filter(x=>x.active_lane==="BULL")){try{const action=await manageBull(db,p,m,ctx);actions.push({id:p.id,symbol:p.symbol,action})}catch(e){actions.push({id:p.id,symbol:p.symbol,error:String(e instanceof Error?e.message:e)});await circuit(db,`V17_POSITION_MANAGEMENT_FAILED:${p.symbol}`)}}const refreshed=await db.from("v11_long_regime_positions").select("*").eq("state","OPEN").order("entry_at",{ascending:true}).limit(MAX_SLOTS+1);if(refreshed.error)throw new Error(`POSITIONS_REFRESH:${refreshed.error.message}`);const openNow=refreshed.data||[];if(openNow.length>MAX_SLOTS){await circuit(db,`V11_SLOT_OVERFLOW:${openNow.length}`);throw new Error("V11_SLOT_OVERFLOW")}let entry={entered:false,reason:actions.some(x=>x.error)?"V17_EXIT_RECOVERY_REQUIRED":"V17_NO_ENTRY"};if(!actions.some(x=>x.error||x.action?.nativeStop?.softwareMonitorRequired===true)&&openNow.length<MAX_SLOTS){const since=new Date(Date.now()-SIGNAL_MAX).toISOString(),sg=await db.from("v11_long_regime_signals").select("*").eq("revision",REVISION).eq("status","NEW").eq("lane","BULL").eq("features->>strategy",STRATEGY).gte("entry_bar_at",since).order("entry_bar_at",{ascending:false}).limit(10);if(sg.error)throw new Error(`SIGNALS:${sg.error.message}`);const openSymbols=new Set(openNow.map(x=>String(x.symbol).toUpperCase()));const queue=(sg.data||[]).filter(x=>!openSymbols.has(String(x.symbol).toUpperCase())).sort((a,b)=>Date.parse(b.entry_bar_at)-Date.parse(a.entry_bar_at)||N(rec(a.features).rank,999)-N(rec(b.features).rank,999));if(!queue.length)entry={entered:false,reason:"NO_FRESH_BULL_SIGNAL"};for(const s of queue.slice(0,ENTRY_ATTEMPTS_PER_RUN)){const cl=await db.from("v11_long_regime_signals").update({status:"CLAIMED",updated_at:new Date().toISOString()}).eq("id",s.id).eq("status","NEW").select("*").maybeSingle();if(cl.error)throw new Error(`CLAIM:${cl.error.message}`);if(!cl.data){entry={entered:false,reason:"CLAIM_RACE"};continue}const attempt={dispatched:false};try{entry=await openBull(db,cl.data,openNow,manual,attempt);if(entry?.releaseClaim===true){await db.from("v11_long_regime_signals").update({status:"NEW",updated_at:new Date().toISOString()}).eq("id",s.id).eq("status","CLAIMED");break}if(entry?.entered===true)break;}catch(e){const msg=e instanceof Error?e.message:String(e),pending=await db.from("v11_long_regime_orders").select("id").eq("signal_id",s.id).eq("state","RECONCILIATION_FAILED").limit(1);if(!pending.data?.length)await db.from("v11_long_regime_signals").update({status:"REJECTED",reject_reason:msg.slice(0,500),updated_at:new Date().toISOString()}).eq("id",s.id);if(attempt.dispatched)throw e;if(!ENTRY_SKIP_SYMBOL_SCOPED.test(msg))throw e;entry={entered:false,reason:msg};}}}else if(openNow.length>=MAX_SLOTS)entry={entered:false,reason:"V11_SLOT_FULL"};const now=new Date().toISOString();await db.from("v11_long_regime_runtime").update({last_success_at:actions.some(x=>x.error)?rt.data.last_success_at:now,last_error:actions.some(x=>x.error)?actions.filter(x=>x.error).map(x=>`${x.symbol}:${x.error}`).join(";").slice(0,1000):null,last_entry_at:entry.entered?now:rt.data.last_entry_at,updated_at:now}).eq("singleton",true);return{ok:true,revision:REVISION,patch:PATCH,maxSlots:MAX_SLOTS,marketState:m,managed:actions,openPositions:openNow.map(x=>({id:x.id,symbol:x.symbol,activeLane:x.active_lane})),entry}}

async function requireLeaderEntryControls(db){
  const [c,s,rt,pending]=await Promise.all([
    db.from("v17_operator_control").select("entry_enabled,legacy_entries_retired").eq("singleton",true).single(),
    db.from("trading_settings").select("mode,pause_new_entries,withdrawal_mode,manual_intervention_required,scalp_kill_switch,binance_futures_allocation_usdt").eq("id",1).single(),
    db.from("v11_long_regime_runtime").select("live_enabled,circuit_open,revision").eq("singleton",true).single(),
    db.from("v11_long_regime_orders").select("id").in("state",["PLANNED","RECONCILIATION_FAILED","RECONCILIATION_PENDING"]).limit(1)]);
  if(c.error||s.error||rt.error||pending.error)throw new Error("V17_CONTROLS_UNAVAILABLE");
  if(c.data?.entry_enabled!==true||c.data?.legacy_entries_retired!==true)throw new Error("V17_OPERATOR_CUTOVER_NOT_ENABLED");
  if(rt.data?.live_enabled!==true||rt.data?.circuit_open===true||rt.data?.revision!==REVISION)throw new Error("V17_RUNTIME_BLOCKED");
  if(pending.data?.length)throw Error("V18_UNRESOLVED_ORDER_BLOCKS_ENTRY");
  const x=s.data;
  if(!x||x.mode!=="LIVE_LIMITED"||x.pause_new_entries||x.withdrawal_mode||x.manual_intervention_required||x.scalp_kill_switch)throw new Error("V17_ENTRY_KILL_SWITCH");
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
    const cached=ctx?.quotes instanceof Map?ctx.quotes.get(p.symbol):null;
    const usableCache=cached&&Date.now()-Number(cached.timing?.book_captured_at_ms)<=2000;
    const quotes=usableCache?[cached]:await gateway({action:"p10_quotes",markets:[p.symbol]},timeoutMs);
    const q=Array.isArray(quotes)?quotes.find(x=>x.market===p.symbol):null;
    const bid=Number(q?.best_bid),ask=Number(q?.best_ask);
    const detectedAtMs=Date.now(),timing=q?.timing||{};
    if(q?.error||!(bid>0&&ask>=bid)||!Number.isFinite(timing.received_at_ms)||
        detectedAtMs-timing.received_at_ms>3000||timing.received_at_ms-detectedAtMs>1000||
        (ctx?.fast===true&&(!Number.isFinite(timing.book_captured_at_ms)||detectedAtMs-timing.book_captured_at_ms>2000||timing.book_captured_at_ms>detectedAtMs||timing.book_captured_at_ms<Date.parse(p.entry_at))))
      throw new Error("V17_EXIT_QUOTE_INVALID_OR_STALE");
    return {bid,ask,detectedAtMs,timing};
  };
  try{return await read(3000)}
  catch(first){
    const budget=ctx?.quoteRetryBudget;
    if(!budget||!(budget.remaining>0))throw first;
    budget.remaining-=1;
    console.error("V17_EXIT_QUOTE_RETRY",p.symbol,String(first instanceof Error?first.message:first));
    return await read(2500);
  }
}
async function manageLeader(db,p,ctx){
  const {bid,ask,detectedAtMs,timing}=await leaderQuote(p,ctx);
  const meta=rec(p.metadata);
  // Preserve the existing policy. Today's nine trades do not validate a new default.
  // Cost-breakeven and profit-lock protection from the V17 exit review. These raise the
  // stop only; they can never lower it. Both are evaluated per tick with no confirmation
  // window, so they work on the current one-minute cadence.
  // costBreakeven() throws on a non-finite entry fee or quantity, which would abort this
  // whole evaluation and leave the position unmanaged. Degrade to the baseline stop
  // instead: a weaker stop still protects, no stop at all does not.
  const costUsable=p.entry_fee_usdt!==null&&p.entry_fee_usdt!==undefined&&Number.isFinite(Number(p.entry_fee_usdt))&&Number(p.entry_fee_usdt)>=0&&
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
      const info=await gateway({action:"symbol_info",market:p.symbol},5000);
      const out=await createGatewayProtection(db,gateway,()=>verifyExecutionLease(db))
        .ensure(p.id,{stopPrice:state.stopPrice,priceTick:N(info?.price_tick??info?.tick_size),
          quantityStep:N(info?.quantity_step??info?.step_size),exchangeQuantity,
          positionMode:"ONE_WAY",manualSymbols:ctx?.manualSymbols??[],lastPrice:bid,
          minUpdateIntervalMs:ctx?.nativeMinIntervalMs??0,minImprovementBps:ctx?.nativeMinImprovementBps??0});
      const receipt=out.state?.protection?.orders?.find(o=>o.clientId===out.clientId);
      return {status:out.status,softwareMonitorRequired:out.softwareMonitorRequired===true,ackAt:receipt?.ackAt??null,quantity:receipt?.spec?.params?.quantity??null,stopPrice:receipt?.spec?.params?.triggerPrice??null};
    }catch(e){
      console.error("V17_NATIVE_STOP_SYNC_FAILED",p.id,String(e instanceof Error?e.message:e));
      return {status:"SYNC_FAILED",softwareMonitorRequired:true};
    }
  }
  if(state.action==="CLOSE"){
    // No peak update or audit round trip may delay an already detected stop.
    const result=await closePos(db,{...p,peak_price:state.peakPrice,
      hard_stop_price:state.stopPrice,metadata:nextMeta},1,state.reason);
    await audit(db,p,"BULL","BULL","FULL_CLOSE",state.reason,details)
      .catch(e=>console.error("V17_EXIT_AUDIT_FAILED",String(e)));
    // The position is already closed; this only retires any resting exchange stop so it
    // cannot outlive the position. It runs last so it can never delay the exit.
    const nativeStop=await syncNativeStop("CLOSE");
    return {action:"CLOSE",reason:state.reason,result,nativeStop};
  }
  const now=new Date().toISOString();
  const write=await db.from("v11_long_regime_positions").update({peak_price:state.peakPrice,
    hard_stop_price:state.stopPrice,last_evaluated_at:now,updated_at:now,metadata:nextMeta})
    .eq("id",p.id).eq("state","OPEN").select("*").single();
  if(write.error||!write.data)throw new Error("V17_EXIT_STATE_WRITE");
  // Only after the ratcheted stop is durable: the exchange order must never protect a
  // level the database does not already hold.
  const nativeStop=await syncNativeStop("HOLD");
  await audit(db,p,"BULL","BULL","HOLD","V17_MOMENTUM_HOLD",{...details,nativeStop});
  return {action:"HOLD",strategy:STRATEGY,bid,...state,nativeStop};
}
async function runProtectionPass(db){
 return managementPass({db,gateway,protection:createGatewayProtection(db,gateway,()=>verifyExecutionLease(db)),manualAllowances:()=>manualPositionAllowances(db),manage:(p,ctx)=>manageLeader(db,p,ctx),portfolioMatches,nativeEnabled:NATIVE_STOP_ENABLED});
}
const leaseOwners=new WeakMap();
async function verifyExecutionLease(db){
  const owner=leaseOwners.get(db);if(!owner)throw new Error("V17_EXECUTION_LEASE_MISSING");
  const r=await db.rpc("v17_verify_execution_lease",{p_owner:owner});
  if(r.error||r.data!==true)throw new Error("V17_EXECUTION_LEASE_EXPIRED");
}
async function runWithLease(db,mode="run"){
  const owner=crypto.randomUUID();
  const lock=await db.rpc("v17_acquire_execution_lease",{p_owner:owner});
  if(lock.error)throw new Error("V17_LEASE_UNAVAILABLE");
  if(lock.data!==true)return {ok:true,skipped:"V17_EXECUTOR_BUSY"};
  leaseOwners.set(db,owner);
  try{
   const rt=await db.from("v11_long_regime_runtime").select("live_enabled,revision").eq("singleton",true).single();
   if(rt.error||rt.data?.revision!==REVISION)throw Error("V18_RUNTIME_UNAVAILABLE");
   if(rt.data?.live_enabled!==true)return {ok:true,skipped:"RUNTIME_DISABLED"};
   await recoverExecutionJournal({db,gateway,verifyLease:()=>verifyExecutionLease(db),recordEntry:(s,o,z,raw)=>recordLeaderEntry(db,s,o,z,raw)});const result=await(mode==="protect"?runProtectionPass(db):run(db));await updateLastExit(db);return result;}finally{
    leaseOwners.delete(db);
    const released=await db.rpc("v17_release_execution_lease",{p_owner:owner});
    if(released.error)console.error("V17_LEASE_RELEASE_FAILED");
  }
}
Deno.serve(async req=>{if(req.method!=="POST")return res(405,{ok:false,error:"POST_ONLY"});const U=env("SUPABASE_URL"),K=env("SUPABASE_SERVICE_ROLE_KEY"),db=createClient(U,K,{auth:{persistSession:false,autoRefreshToken:false}});if(!(await auth(db,req)))return res(401,{ok:false,error:"UNAUTHORIZED"});const body=await req.json().catch(()=>({})),mode=String(body.mode||"run").toLowerCase();try{if(req.headers.has("x-v18-protection-token")&&mode!=="protect")return res(403,{ok:false,error:"PROTECTION_TOKEN_MODE"});if(!["run","protect","preflight","diagnostic"].includes(mode))return res(400,{ok:false,error:"INVALID_MODE"});if(mode==="preflight"||mode==="diagnostic"){const[m,sn,pf,q,i,rt,op]=await Promise.all([market(db),snap(db),gateway({action:"p10_portfolio"}),gateway({action:"quote",market:String(body.symbol||"BTCUSDT")}),gateway({action:"symbol_info",market:String(body.symbol||"BTCUSDT")}),db.from("v11_long_regime_runtime").select("*").eq("singleton",true).single(),db.from("v11_long_regime_positions").select("id,symbol,active_lane,peak_price,entry_price,last_evaluated_at").eq("state","OPEN").limit(MAX_SLOTS+1)]),step=N(i?.quantity_step??i?.step_size),ask=N(q?.best_ask),sizing=ask>0&&step>0?sizeEntry(ask,step):null;return res(200,{ok:true,revision:REVISION,patch:PATCH,maxSlots:MAX_SLOTS,runtime:rt.data,marketState:m,snapshotAgeMs:sn.ageMs,availableUsdt:Math.min(N(sn.available_quote),N(pf?.available_quote)),externalPositions:active(pf).map(x=>({symbol:sym(x),quantity:qty(x)})),openPositions:op.data||[],quote:q,symbolInfo:{step,minNotional:i?.min_notional},sizing})}return res(200,await runWithLease(db,mode))}catch(e){const msg=e instanceof Error?e.message:String(e);try{await db.from("v11_long_regime_runtime").update({last_error:msg.slice(0,1000),updated_at:new Date().toISOString()}).eq("singleton",true)}catch{}return res(500,{ok:false,revision:REVISION,patch:PATCH,error:msg})}});
