// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const REVISION="V11-LONG-REGIME-1.0.1";
const PATCH="IOC-ENTRY-V7-EQUITY-SCALED-3SLOT-GWFLOOR";
const OBSERVER_REVISION="MARKET-REGIME-OBSERVER-v2-C01-HYSTERESIS-v1-FULLMARKET";
const PROTOCOL="8.0.0-P10-DONCHIAN-SLOW4R";
const LEV=3, MAX_SLOTS=3;
// Per-slot margin is derived from the live wallet balance so MAX_SLOTS entries
// always fit the account. MARGIN_CAP keeps the researched 40 USDT ceiling, and
// SLOT_RESERVE_USDT is held back for fees, funding and step granularity.
const MARGIN_CAP=40, SLOT_RESERVE_USDT=2, MIN_SLOT_MARGIN_USDT=5;
// Mirrors FUTURES_MIN_ENTRY_MARGIN_USDT in gateway/server.mjs. The gateway rejects any
// OPEN below this margin, so sizing must never fall under it: when capital cannot fund
// MAX_SLOTS at this floor the extra slot simply stays unfilled.
const GATEWAY_MIN_ENTRY_MARGIN_USDT=40;
const NOTIONAL_BUFFER_USDT=.12, MAX_MARGIN_BUFFER_USDT=.25, ENTRY_CASH_BUFFER_USDT=.10;
const SPREAD_MAX=25, SIGNAL_MAX=120000, IOC_BASE_BPS=3, IOC_MAX_BPS=12;

function res(s,b){return new Response(JSON.stringify(b),{status:s,headers:{"content-type":"application/json","cache-control":"no-store"}})}
function N(v,d=0){const x=Number(v);return Number.isFinite(x)?x:d}
function rec(v){return v&&typeof v==="object"&&!Array.isArray(v)?v:{}}
function eq(a,b){if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0}
function dec(s){return Math.min(12,Math.max(0,Math.ceil(-Math.log10(s))+2))}
function floorStep(v,s){if(!(v>0&&s>0))return 0;return Number((Math.floor((v+s*1e-9)/s)*s).toFixed(dec(s)))}
function ceilStep(v,s){if(!(v>0&&s>0))return 0;return Number((Math.ceil((v-s*1e-9)/s)*s).toFixed(dec(s)))}
function addStep(v,s){return Number((v+s).toFixed(dec(s)))}
function cid(p,x){return`tb-${p}-${String(x).toLowerCase().replace(/[^a-z0-9]/g,"").slice(0,24)}`.slice(0,36)}
function terminal(z){return z.qty<=0&&["CANCELED","CANCELLED","REJECTED","EXPIRED","PARTIALLY_FILLED_CANCELED"].includes(z.status)}

const env=n=>(Deno.env.get(n)||"").trim();
const GW=env("BINANCE_FUTURES_ORDER_GATEWAY_URL").replace(/\/$/,"")||env("BINANCE_ORDER_GATEWAY_URL").replace(/\/$/,"")||env("ORDER_GATEWAY_URL").replace(/\/$/,"");
const SEC=env("BINANCE_FUTURES_GATEWAY_SHARED_SECRET")||env("BINANCE_GATEWAY_SHARED_SECRET")||env("GATEWAY_SHARED_SECRET");

async function hmac(s,m){const k=await crypto.subtle.importKey("raw",new TextEncoder().encode(s),{name:"HMAC",hash:"SHA-256"},false,["sign"]);const g=await crypto.subtle.sign("HMAC",k,new TextEncoder().encode(m));return[...new Uint8Array(g)].map(x=>x.toString(16).padStart(2,"0")).join("")}
async function gateway(cmd,tm=20000){if(!GW||!SEC)throw new Error("GATEWAY_CONFIG");const x=cmd.action==="create_order"?{...cmd,engine_version:PROTOCOL}:cmd,raw=JSON.stringify({exchange:"binance_futures",...x}),ts=String(Date.now()),nonce=crypto.randomUUID(),sig=await hmac(SEC,`${ts}\n${nonce}\n${raw}`),c=new AbortController,t=setTimeout(()=>c.abort(),tm);try{const r=await fetch(`${GW}/v1/command`,{method:"POST",signal:c.signal,headers:{"content-type":"application/json","x-gateway-ts":ts,"x-gateway-nonce":nonce,"x-gateway-signature":sig},body:raw}),txt=await r.text();let d;try{d=txt?JSON.parse(txt):null}catch{d={raw:txt}}if(!r.ok||!d?.ok)throw new Error(`GW_${r.status}:${d?.error||txt}`);return d.result}finally{clearTimeout(t)}}
function fill(p){const o=p?.order??p??{},f=p?.fill??{},q=Math.max(0,N(f.executedVolume??f.executed_quantity??o.executed_volume??o.executedQty)),a=Math.max(0,N(f.averagePrice??f.average_price??o.average_price??o.avgPrice));return{status:String(o?.status??p?.status??"UNKNOWN").toUpperCase(),exchangeOrderId:o?.exchange_order_id==null?(o?.orderId==null?null:String(o.orderId)):String(o.exchange_order_id),qty:q,avg:a,fee:Math.max(0,N(f.paidFeeQuote??f.paidFee??o.paid_fee??o.commission)),raw:p}}
function active(p){return(Array.isArray(p?.positions)?p.positions:[]).filter(x=>Math.abs(N(x?.quantity??x?.positionAmt??x?.position_amount))>1e-12)}
function sym(p){return String(p?.market??p?.symbol??"").toUpperCase()}
function qty(p){return Math.abs(N(p?.quantity??p?.positionAmt??p?.position_amount))}

async function auth(db,req){const p=(req.headers.get("x-v10-executor-token")||"").trim();const t=await db.from("edge_internal_tokens").select("token").eq("name","v10-lane-executor").maybeSingle();return!t.error&&p&&t.data?.token&&eq(p,String(t.data.token))}
function route(v){const x=String(v||"").toUpperCase();return x==="RISK_OFF"?"BEAR":x==="NEUTRAL"?"RANGE":x==="BULL"||x==="STRONG_BULL"?"BULL":"CASH"}
async function market(db){const o=await db.from("market_regime_observations").select("id,observed_at,predicted_regime,bull_score,confidence").eq("model_revision",OBSERVER_REVISION).eq("trading_influence",true).order("observed_at",{ascending:false}).limit(1).maybeSingle();if(o.error)throw new Error(`OBSERVER:${o.error.message}`);const age=o.data?Date.now()-Date.parse(o.data.observed_at):Infinity;return{route:age<=12*60000?route(o.data?.predicted_regime):"CASH",ageMs:age,observer:o.data||null}}
async function circuit(db,r){await db.from("v11_long_regime_runtime").update({circuit_open:true,circuit_reason:String(r).slice(0,500),last_error:String(r).slice(0,1000),updated_at:new Date().toISOString()}).eq("singleton",true)}
async function audit(db,p,b,a,action,reason,details={}){await db.from("v11_long_regime_decisions").insert({revision:REVISION,position_id:p?.id||null,observed_regime:details.marketRoute||null,active_lane_before:b||null,active_lane_after:a||null,action,reason,details:{...details,executorPatch:PATCH}})}
function portfolioMatches(openPositions,pf){const ext=active(pf),expected=openPositions.map(p=>String(p.symbol).toUpperCase());if(ext.length!==expected.length)return{ok:false,ext,reason:`COUNT:${ext.length}:${expected.length}`};const seen=new Set();for(const x of ext){const s=sym(x);if(seen.has(s)||!expected.includes(s))return{ok:false,ext,reason:`SYMBOL:${s}`};seen.add(s)}return{ok:true,ext,reason:"OK"}}

// Wallet balance divided across MAX_SLOTS, so three concurrent slots always fit
// the account instead of the third entry dying on ENTRY_MARGIN.
function slotMargin(pf){
  const settled=N(pf?.settled_quote,NaN),avail=N(pf?.available_quote,NaN),used=N(pf?.total_initial_margin_quote,0);
  const base=Number.isFinite(settled)&&settled>0?settled:(Number.isFinite(avail)?avail+used:NaN);
  if(!Number.isFinite(base)||!(base>0))throw new Error("SLOT_MARGIN_BASE_INVALID");
  const per=Math.floor(((base-SLOT_RESERVE_USDT)/MAX_SLOTS)*100)/100;
  if(!(per>=MIN_SLOT_MARGIN_USDT))throw new Error(`SLOT_MARGIN_TOO_SMALL:${per}`);
  return Math.min(MARGIN_CAP,Math.max(GATEWAY_MIN_ENTRY_MARGIN_USDT,per));
}
function sizeEntry(ask,step,margin){
  if(!(ask>0&&step>0))throw new Error("QTY_INPUT_INVALID");
  if(!(margin>0))throw new Error("SLOT_MARGIN_INVALID");
  const notional=margin*LEV;
  let amount=ceilStep(notional/ask,step);
  if(!(amount>0))throw new Error("QTY_INVALID");
  let sizedNotional=amount*ask;
  if(sizedNotional<notional+NOTIONAL_BUFFER_USDT){const bumped=addStep(amount,step),bm=bumped*ask/LEV;if(bm<=margin+MAX_MARGIN_BUFFER_USDT){amount=bumped;sizedNotional=amount*ask}}
  const sizedMargin=sizedNotional/LEV;
  if(sizedNotional+1e-9<notional)throw new Error(`ENTRY_NOTIONAL_UNDERSIZED:${sizedNotional}`);
  if(sizedMargin>margin+MAX_MARGIN_BUFFER_USDT+1e-9)throw new Error(`ENTRY_SLOT_GRANULARITY_MARGIN:${sizedMargin.toFixed(6)}`);
  return{amount,sizedNotional,sizedMargin,slotMarginUsdt:margin,slotNotionalUsdt:notional}
}

async function openEntry(db,s,openPositions){
  const[pf,q,i]=await Promise.all([gateway({action:"p10_portfolio"}),gateway({action:"quote",market:s.symbol}),gateway({action:"symbol_info",market:s.symbol})]);
  const pm=portfolioMatches(openPositions,pf);
  if(!pm.ok){await circuit(db,`MICRO_EXTERNAL_EXPOSURE:${pm.reason}:${pm.ext.map(sym).join(",")}`);throw new Error("EXTERNAL_POSITION")}
  if(openPositions.length>=MAX_SLOTS||pm.ext.length>=MAX_SLOTS)return{entered:false,reason:"V11_SLOT_FULL"};
  if(openPositions.some(p=>String(p.symbol).toUpperCase()===String(s.symbol).toUpperCase()))return{entered:false,reason:"DUPLICATE_SYMBOL_OPEN"};
  const bid=N(q?.best_bid),ask=N(q?.best_ask),sp=bid>0&&ask>0?(ask/bid-1)*10000:999;
  if(!(bid>0&&ask>0&&sp<=SPREAD_MAX))throw new Error(`ENTRY_SPREAD:${sp}`);
  const f=rec(s.features),ref=N(f.referenceClose),gap=ref>0?Math.abs(ask/ref-1)*10000:999;
  if(gap>15)throw new Error(`MICRO_ENTRY_GAP_BPS:${gap}`);
  const step=N(i?.quantity_step??i?.step_size),min=Math.max(1,N(i?.min_notional,5)),margin=slotMargin(pf),sized=sizeEntry(ask,step,margin);
  if(sized.sizedNotional<min)throw new Error("QTY_INVALID");
  const live=N(pf?.available_quote,NaN);
  if(!Number.isFinite(live)||live<sized.sizedMargin+ENTRY_CASH_BUFFER_USDT)throw new Error(`ENTRY_MARGIN:${live}:${sized.sizedMargin}`);
  const gatePrice=(sized.slotNotionalUsdt+NOTIONAL_BUFFER_USDT)/sized.amount,limitPrice=Math.max(ask*(1+IOC_BASE_BPS/10000),gatePrice),iocBps=(limitPrice/ask-1)*10000;
  if(iocBps>IOC_MAX_BPS)throw new Error(`ENTRY_GRANULARITY_BPS:${iocBps.toFixed(3)}`);
  const limitGap=ref>0?Math.abs(limitPrice/ref-1)*10000:999;
  if(limitGap>27)throw new Error(`MICRO_LIMIT_GAP_BPS:${limitGap.toFixed(3)}`);
  const id=cid("v11m",s.id),rp={action:"create_order",leverage:LEV,order:{market:s.symbol,side:"BUY",type:"LIMIT",price:limitPrice,time_in_force:"IOC",quantity:sized.amount,identifier:id,position_side:"LONG",position_effect:"OPEN"},wait_for_final_ms:4000};
  const oi=await db.from("v11_long_regime_orders").insert({revision:REVISION,signal_id:s.id,position_id:null,symbol:s.symbol,intent:"OPEN_LONG",reason:"MICRO_ENTRY_IOC",client_order_id:id,requested_quantity:sized.amount,state:"PLANNED",request_payload:{...rp,quantity_step:step,target_margin_usdt:margin,margin_cap_usdt:MARGIN_CAP,gateway_min_margin_usdt:GATEWAY_MIN_ENTRY_MARGIN_USDT,slot_reserve_usdt:SLOT_RESERVE_USDT,sized_margin_usdt:sized.sizedMargin,sized_notional_usdt:sized.sizedNotional,leverage:LEV,spread_bps:sp,gap_bps:gap,ioc_bps:iocBps,max_slots:MAX_SLOTS,account_authority:"LIVE_P10_PORTFOLIO",executor_patch:PATCH}}).select("*").single();
  if(oi.error)throw new Error(`ORDER_INTENT:${oi.error.message}`);
  try{
    const raw=await gateway(rp),z=fill(raw);
    if(z.qty>0&&z.avg>0){
      const stopPct=N(f.stopPct,.0035),maxMin=N(f.maxHoldMin,s.lane==="BEAR"?8:12),now=new Date(),stop=z.avg*(1-stopPct);
      const pos=await db.from("v11_long_regime_positions").insert({signal_id:s.id,revision:REVISION,entry_lane:s.lane,active_lane:s.lane,transition_from:null,symbol:s.symbol,side:"LONG",original_quantity:z.qty,remaining_quantity:z.qty,entry_price:z.avg,entry_at:now.toISOString(),entry_atr:N(f.atr,z.avg),entry_bb_pos:N(f.bbPos,0),hard_stop_price:stop,hard_deadline:new Date(now.getTime()+maxMin*60000).toISOString(),active_since:now.toISOString(),active_ref_bb:N(f.bbPos,0),active_target_delta:null,t1_completed:false,peak_price:z.avg,last_evaluated_at:now.toISOString(),state:"OPEN",realized_pnl_usdt:-z.fee,entry_fee_usdt:z.fee,metadata:{executionMode:"MICRO",executorPatch:PATCH,targetPct:N(f.targetPct,.0045),stopPct,maxHoldMin:maxMin,microPattern:f.microPattern||"SWEEP_RECLAIM",entryFeatures:f,maxSlots:MAX_SLOTS,targetMarginUsdt:margin,sizedMarginUsdt:sized.sizedMargin,accountAuthority:"LIVE_P10_PORTFOLIO",lastAppliedOrderId:oi.data.id,entryOrderId:z.exchangeOrderId||id}}).select("*").single();
      if(pos.error)throw new Error(`POSITION:${pos.error.message}`);
      await db.from("v11_long_regime_orders").update({state:"FILLED",exchange_order_id:z.exchangeOrderId,response_payload:raw,position_id:pos.data.id,updated_at:new Date().toISOString()}).eq("id",oi.data.id);
      await db.from("v11_long_regime_signals").update({status:"FILLED",position_id:pos.data.id,updated_at:new Date().toISOString()}).eq("id",s.id);
      return{entered:true,positionId:pos.data.id,symbol:s.symbol,entryPrice:z.avg,quantity:z.qty,stopPrice:stop,targetPrice:z.avg*(1+N(f.targetPct,.0045)),maxHoldMin:maxMin,iocBps,slotMarginUsdt:margin,sizedMarginUsdt:sized.sizedMargin}
    }
    if(terminal(z)){const why=`IOC_NO_FILL:${z.status}`;await db.from("v11_long_regime_orders").update({state:"REJECTED",exchange_order_id:z.exchangeOrderId,response_payload:raw,reject_reason:why,updated_at:new Date().toISOString()}).eq("id",oi.data.id);await db.from("v11_long_regime_signals").update({status:"REJECTED",reject_reason:why,updated_at:new Date().toISOString()}).eq("id",s.id);return{entered:false,reason:why}}
    await db.from("v11_long_regime_orders").update({state:"RECONCILIATION_FAILED",exchange_order_id:z.exchangeOrderId,response_payload:raw,reject_reason:`IOC_PENDING:${z.status}`,updated_at:new Date().toISOString()}).eq("id",oi.data.id);
    await db.from("v11_long_regime_signals").update({status:"ORDERED",updated_at:new Date().toISOString()}).eq("id",s.id);await circuit(db,`MICRO_ENTRY_AMBIGUOUS:${z.status}`);throw new Error(`IOC_PENDING:${z.status}`)
  }catch(e){
    const msg=e instanceof Error?e.message:String(e),explicit=/^GW_4\d\d:/.test(msg);
    await db.from("v11_long_regime_orders").update({state:explicit?"REJECTED":"RECONCILIATION_FAILED",reject_reason:msg.slice(0,500),updated_at:new Date().toISOString()}).eq("id",oi.data.id);
    if(explicit){await db.from("v11_long_regime_signals").update({status:"REJECTED",reject_reason:msg.slice(0,500),updated_at:new Date().toISOString()}).eq("id",s.id);return{entered:false,reason:msg}}
    await db.from("v11_long_regime_signals").update({status:"ORDERED",updated_at:new Date().toISOString()}).eq("id",s.id);await circuit(db,`MICRO_ENTRY_AMBIGUOUS:${msg}`);throw e
  }
}

async function closePos(db,p,reason){
  const[pf,i]=await Promise.all([gateway({action:"p10_portfolio"}),gateway({action:"symbol_info",market:p.symbol})]),match=active(pf).filter(x=>sym(x)===p.symbol.toUpperCase());
  if(match.length!==1){await circuit(db,`MICRO_POSITION_MISMATCH:${p.symbol}:${match.length}`);throw new Error("POSITION_MISMATCH")}
  const step=N(i?.quantity_step??i?.step_size),amount=floorStep(Math.min(N(p.remaining_quantity),qty(match[0])),step);
  if(!(amount>0))throw new Error("EXIT_QTY_ZERO");
  const id=cid("v11mx",`${p.id}${crypto.randomUUID()}`),rp={action:"create_order",order:{market:p.symbol,side:"SELL",type:"MARKET",quantity:amount,identifier:id,position_side:"LONG",position_effect:"CLOSE"},wait_for_final_ms:4000};
  const oi=await db.from("v11_long_regime_orders").insert({revision:REVISION,signal_id:p.signal_id,position_id:p.id,symbol:p.symbol,intent:"CLOSE_LONG",reason,client_order_id:id,requested_quantity:amount,state:"PLANNED",request_payload:{...rp,quantity_step:step,executor_patch:PATCH}}).select("*").single();
  if(oi.error)throw new Error(`EXIT_INTENT:${oi.error.message}`);
  const raw=await gateway(rp),z=fill(raw);
  if(!(z.qty>0&&z.avg>0)){await db.from("v11_long_regime_orders").update({state:"RECONCILIATION_FAILED",response_payload:raw,reject_reason:`EXIT_NO_FILL:${z.status}`,updated_at:new Date().toISOString()}).eq("id",oi.data.id);await circuit(db,`MICRO_EXIT_AMBIGUOUS:${z.status}`);throw new Error(`EXIT_NO_FILL:${z.status}`)}
  const pnl=(z.avg-N(p.entry_price))*z.qty-z.fee,real=N(p.realized_pnl_usdt)+pnl,finalPeak=Math.max(N(p.peak_price,N(p.entry_price)),z.avg),now=new Date().toISOString();
  await db.from("v11_long_regime_positions").update({remaining_quantity:0,state:"CLOSED",realized_pnl_usdt:real,peak_price:finalPeak,last_evaluated_at:now,exit_price:z.avg,exit_reason:reason,closed_at:now,metadata:{...rec(p.metadata),executorPatch:PATCH,lastAppliedOrderId:oi.data.id,lastExitOrderId:z.exchangeOrderId||id,lastExitReason:reason,finalPeakPrice:finalPeak},updated_at:now}).eq("id",p.id);
  await db.from("v11_long_regime_orders").update({state:"FILLED",exchange_order_id:z.exchangeOrderId,response_payload:raw,updated_at:now}).eq("id",oi.data.id);
  await db.from("v11_long_regime_signals").update({status:"CLOSED",updated_at:now}).eq("id",p.signal_id);
  return{closed:true,exitPrice:z.avg,realizedPnlUsdt:real,peakPrice:finalPeak}
}

async function manage(db,p,m){
  const q=await gateway({action:"quote",market:p.symbol}),bid=N(q?.best_bid),ask=N(q?.best_ask);
  if(!(bid>0&&ask>0))throw new Error("EXIT_QUOTE_INVALID");
  const now=new Date().toISOString(),observedPeak=Math.max(N(p.peak_price,N(p.entry_price)),bid);
  const pw=await db.from("v11_long_regime_positions").update({peak_price:observedPeak,last_evaluated_at:now,updated_at:now}).eq("id",p.id).select("*").single();
  if(pw.error)throw new Error(`PEAK_WRITE:${pw.error.message}`);p=pw.data;
  const before=p.active_lane,stop=N(p.hard_stop_price),meta=rec(p.metadata);
  if(bid<=stop){await audit(db,p,before,before,"FULL_CLOSE","MICRO_HARD_STOP",{marketRoute:m.route,bid,stop,peak:observedPeak});return{action:"CLOSE",reason:"MICRO_HARD_STOP",result:await closePos(db,p,"MICRO_HARD_STOP")}}
  if(m.route==="BULL"){const deadline=new Date(Date.now()+30*86400000).toISOString(),up=await db.from("v11_long_regime_positions").update({active_lane:"BULL",transition_from:before,active_since:now,active_target_delta:null,hard_deadline:deadline,peak_price:observedPeak,last_evaluated_at:now,metadata:{...meta,executionMode:"GRADUATED_BULL",executorPatch:PATCH,microGraduatedAt:now},updated_at:now}).eq("id",p.id).select("*").single();if(up.error)throw new Error(`GRADUATE:${up.error.message}`);await audit(db,p,before,"BULL","SWITCH_POLICY","MICRO_TO_BULL_GRADUATE",{marketRoute:m.route,bid,peak:observedPeak,hardStopPreserved:stop});return{action:"GRADUATE_BULL",positionId:p.id}}
  let pos=p;
  if(["RANGE","BEAR"].includes(m.route)&&m.route!==before){const maxMin=m.route==="BEAR"?8:12,targetPct=m.route==="BEAR"?.005:.0045,newStop=Math.max(stop,N(p.entry_price)*(1-.0035)),up=await db.from("v11_long_regime_positions").update({active_lane:m.route,transition_from:before,active_since:now,hard_stop_price:newStop,hard_deadline:new Date(Date.now()+maxMin*60000).toISOString(),peak_price:observedPeak,last_evaluated_at:now,metadata:{...meta,executionMode:"MICRO",executorPatch:PATCH,targetPct,maxHoldMin:maxMin},updated_at:now}).eq("id",p.id).select("*").single();if(up.error)throw new Error(`MICRO_SWITCH:${up.error.message}`);pos=up.data;await audit(db,p,before,m.route,"SWITCH_POLICY",`MICRO_${before}_TO_${m.route}`,{marketRoute:m.route,newStop,targetPct,maxHoldMin:maxMin,peak:observedPeak})}
  const mm=rec(pos.metadata),targetPct=N(mm.targetPct,pos.active_lane==="BEAR"?.005:.0045),target=N(pos.entry_price)*(1+targetPct),deadline=Date.parse(pos.hard_deadline);
  if(bid>=target){const r=`${pos.active_lane}_MICRO_TARGET`;await audit(db,pos,pos.active_lane,pos.active_lane,"FULL_CLOSE",r,{marketRoute:m.route,bid,target,targetPct,peak:observedPeak});return{action:"CLOSE",reason:r,result:await closePos(db,pos,r)}}
  if(Date.now()>=deadline){const r=`${pos.active_lane}_MICRO_TIME_EXIT`;await audit(db,pos,pos.active_lane,pos.active_lane,"FULL_CLOSE",r,{marketRoute:m.route,bid,deadline:pos.hard_deadline,peak:observedPeak});return{action:"CLOSE",reason:r,result:await closePos(db,pos,r)}}
  await audit(db,pos,pos.active_lane,pos.active_lane,"HOLD","MICRO_HOLD",{marketRoute:m.route,bid,target,stop:pos.hard_stop_price,deadline:pos.hard_deadline,peak:observedPeak});
  return{action:"HOLD",lane:pos.active_lane,bid,target,stop:N(pos.hard_stop_price),deadline:pos.hard_deadline,peak:observedPeak}
}

async function run(db){
  const rt=await db.from("v11_long_regime_runtime").select("*").eq("singleton",true).single();
  if(rt.error||!rt.data)throw new Error("RUNTIME");
  if(rt.data.live_enabled!==true||rt.data.circuit_open===true)return{ok:true,revision:REVISION,patch:PATCH,skipped:"RUNTIME_NOT_LIVE",runtime:rt.data};
  const op=await db.from("v11_long_regime_positions").select("*").eq("state","OPEN").order("entry_at",{ascending:true}).limit(MAX_SLOTS+1);
  if(op.error)throw new Error(`POSITIONS:${op.error.message}`);
  if((op.data||[]).length>MAX_SLOTS){await circuit(db,`V11_SLOT_OVERFLOW:${op.data.length}`);throw new Error("V11_SLOT_OVERFLOW")}
  const allOpen=op.data||[],m=await market(db),pf=await gateway({action:"p10_portfolio"}),pm=portfolioMatches(allOpen,pf);
  if(!pm.ok){await circuit(db,`MICRO_EXCHANGE_MISMATCH:${pm.reason}:${pm.ext.map(sym).join(",")}`);throw new Error("EXCHANGE_MISMATCH")}
  const actions=[];
  for(const p of allOpen.filter(x=>x.active_lane!=="BULL")){const action=await manage(db,p,m);actions.push({id:p.id,symbol:p.symbol,action})}
  const refreshed=await db.from("v11_long_regime_positions").select("*").eq("state","OPEN").order("entry_at",{ascending:true}).limit(MAX_SLOTS+1);
  if(refreshed.error)throw new Error(`POSITIONS_REFRESH:${refreshed.error.message}`);
  const openNow=refreshed.data||[];
  if(openNow.length>MAX_SLOTS){await circuit(db,`V11_SLOT_OVERFLOW:${openNow.length}`);throw new Error("V11_SLOT_OVERFLOW")}
  let entry={entered:false,reason:"MICRO_ROUTE_INACTIVE"};
  if(["RANGE","BEAR"].includes(m.route)&&openNow.length<MAX_SLOTS){
    const since=new Date(Date.now()-SIGNAL_MAX).toISOString(),sg=await db.from("v11_long_regime_signals").select("*").eq("revision",REVISION).eq("status","NEW").eq("lane",m.route).gte("entry_bar_at",since).order("entry_bar_at",{ascending:false}).limit(10);
    if(sg.error)throw new Error(`SIGNALS:${sg.error.message}`);
    const openSymbols=new Set(openNow.map(x=>String(x.symbol).toUpperCase())),s=(sg.data||[]).find(x=>rec(x.features).executionMode==="MICRO"&&!openSymbols.has(String(x.symbol).toUpperCase()));
    if(!s)entry={entered:false,reason:"NO_FRESH_MICRO_SIGNAL"};
    else{
      const cl=await db.from("v11_long_regime_signals").update({status:"CLAIMED",updated_at:new Date().toISOString()}).eq("id",s.id).eq("status","NEW").select("*").maybeSingle();
      if(cl.error)throw new Error(`CLAIM:${cl.error.message}`);
      if(!cl.data)entry={entered:false,reason:"CLAIM_RACE"};
      else{try{entry=await openEntry(db,cl.data,openNow)}catch(e){const msg=e instanceof Error?e.message:String(e),pending=await db.from("v11_long_regime_orders").select("id").eq("signal_id",s.id).in("state",["SUBMITTED","RECONCILIATION_FAILED"]).limit(1);if(!pending.data?.length)await db.from("v11_long_regime_signals").update({status:"REJECTED",reject_reason:msg.slice(0,500),updated_at:new Date().toISOString()}).eq("id",s.id);throw e}}
    }
  }else if(["RANGE","BEAR"].includes(m.route)&&openNow.length>=MAX_SLOTS)entry={entered:false,reason:"V11_SLOT_FULL"};
  const now=new Date().toISOString();
  await db.from("v11_long_regime_runtime").update({last_success_at:now,last_error:null,last_entry_at:entry.entered?now:rt.data.last_entry_at,last_exit_at:actions.some(x=>x.action?.action==="CLOSE")?now:rt.data.last_exit_at,updated_at:now}).eq("singleton",true);
  return{ok:true,revision:REVISION,patch:PATCH,maxSlots:MAX_SLOTS,accountAuthority:"LIVE_P10_PORTFOLIO",marketState:m,managed:actions,openPositions:openNow.map(x=>({id:x.id,symbol:x.symbol,activeLane:x.active_lane})),entry}
}

Deno.serve(async req=>{
  if(req.method!=="POST")return res(405,{ok:false,error:"POST_ONLY"});
  const U=env("SUPABASE_URL"),K=env("SUPABASE_SERVICE_ROLE_KEY"),db=createClient(U,K,{auth:{persistSession:false,autoRefreshToken:false}});
  if(!(await auth(db,req)))return res(401,{ok:false,error:"UNAUTHORIZED"});
  const body=await req.json().catch(()=>({}));
  try{
    if(String(body.mode||"").toLowerCase()==="preflight"){
      const[rt,m,pf,q,i,op]=await Promise.all([db.from("v11_long_regime_runtime").select("*").eq("singleton",true).single(),market(db),gateway({action:"p10_portfolio"}),gateway({action:"quote",market:String(body.symbol||"BTCUSDT")}),gateway({action:"symbol_info",market:String(body.symbol||"BTCUSDT")}),db.from("v11_long_regime_positions").select("id,symbol,active_lane,peak_price,entry_price,hard_stop_price,hard_deadline,last_evaluated_at").eq("state","OPEN").limit(MAX_SLOTS+1)]);
      const step=N(i?.quantity_step??i?.step_size),ask=N(q?.best_ask),margin=slotMargin(pf),sizing=ask>0&&step>0?sizeEntry(ask,step,margin):null;
      const settled=N(pf?.settled_quote),fundable=Math.floor(settled/(margin+MAX_MARGIN_BUFFER_USDT));
      return res(200,{ok:true,revision:REVISION,patch:PATCH,maxSlots:MAX_SLOTS,slotMarginUsdt:margin,slotNotionalUsdt:margin*LEV,marginCapUsdt:MARGIN_CAP,gatewayMinMarginUsdt:GATEWAY_MIN_ENTRY_MARGIN_USDT,slotReserveUsdt:SLOT_RESERVE_USDT,fundableSlots:fundable,runtime:rt.data,marketState:m,availableUsdt:N(pf?.available_quote),settledUsdt:settled,equityUsdt:N(pf?.total_equity_quote),externalPositions:active(pf),openPositions:op.data||[],quote:q,symbolInfo:{step,minNotional:i?.min_notional},sizing});
    }
    return res(200,await run(db))
  }
  catch(e){const msg=e instanceof Error?e.message:String(e);try{await db.from("v11_long_regime_runtime").update({last_error:msg.slice(0,1000),updated_at:new Date().toISOString()}).eq("singleton",true)}catch{}return res(500,{ok:false,revision:REVISION,patch:PATCH,error:msg})}
});
