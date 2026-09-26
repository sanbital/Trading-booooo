/** Persistent, causal, equal-capital portfolio replay. Research only; no exchange client. */
import {planSlotEntry,SLOT_SIZING_CONTRACT} from '../leader-slot-sizing.mjs';
import {POLICY} from '../leader-momentum-v17.mjs';
import {EXIT_REVIEW_R5} from '../leader-exit-review.mjs';
import {hardSafetyState,softCandidate,exitContext,positionGeneration} from '../exit-authority.mjs';
import {advanceP142Completed,nextExitP142} from '../leader-cec0040.mjs';
import {initialHoldState,holdStep} from '../gpt-final-decision/hold.mjs';
import {dynamicsEvent} from '../gpt-final-decision/trajectory.mjs';
const ensure=(v,e)=>{if(!v)throw Error(e);};
const EP={...POLICY,...EXIT_REVIEW_R5};
export function emptyPortfolio(capital,start){return {version:'CAUSAL_PORTFOLIO_1',last_ms:start,cash:capital.capital_usdt,positions:{},trades:[],events:0,missing:[],decisions:0,opportunities:0,completed:0,decision_errors:0,filled:0,rejections:0,symbols:[],regimes:[],days:[]};}
export function filtersOf(filters){const get=t=>filters?.find(x=>x.filterType===t)??{};return {quantityStep:Number(get('LOT_SIZE').stepSize),priceTick:Number(get('PRICE_FILTER').tickSize),minNotionalUsdt:Number(get('MIN_NOTIONAL').notional),minQuantity:Number(get('LOT_SIZE').minQty)};}
function validQuote(q){return q&&q.bid>0&&q.ask>=q.bid&&Number.isSafeInteger(q.at_ms)&&q.received_at_ms>=q.at_ms&&q.coverage===true;}
// Future execution results never release cash, expose a price, or free a slot early.
function settle(s,at){s.pending_fills??=[];const due=s.pending_fills.filter(f=>f.at<=at);s.pending_fills=s.pending_fills.filter(f=>f.at>at);
 for(const f of due){if(f.kind==='ENTRY'){s.cash+=f.reserved-(f.position?.margin??0);if(f.position){s.positions[f.symbol]=f.position;s.filled++;}else s.rejections++;}
  else{s.cash+=f.margin+f.trade.net_usdt;s.trades.push(f.trade);s.completed++;delete s.positions[f.symbol];}}
}
export async function advancePortfolio(input,event,{capital,decide,fillQuote,candles,funding,capture,recheck}){
 const s=structuredClone(input);ensure(capital.margin_usdt===SLOT_SIZING_CONTRACT.targetMarginUsdt&&capital.leverage===SLOT_SIZING_CONTRACT.leverage&&capital.max_slots===10,'CAPITAL_MANIFEST_DRIFT');
 ensure(event.at_ms>=s.last_ms&&event.id!==s.last_id&&event.received_at_ms<=event.at_ms,'PORTFOLIO_CAUSAL_ORDER');s.last_ms=event.at_ms;s.last_id=event.id;s.events++;
 settle(s,event.at_ms);
 s.symbols=[...new Set([...(s.symbols??[]),event.symbol])];s.days=[...new Set([...(s.days??[]),Math.floor(event.at_ms/86400000)])];if(event.regime)s.regimes=[...new Set([...(s.regimes??[]),event.regime])];
 let p=s.positions[event.symbol],decision=null,hard=null,soft=null,eventName=null;
 if(s.pending_fills.some(f=>f.symbol===event.symbol))return s;
 if(p&&event.at_ms<=p.entry_at_ms)return s;
 if(!validQuote(event.quote)){if(p)s.missing.push({id:event.id,reason:'QUOTE_GAP',symbol:event.symbol});return s;}
 const bid=event.quote.bid;
 if(p){
  if(event.at_ms-p.last_observation>12000)s.missing.push({id:event.id,reason:'PROTECTION_OBSERVATION_GAP',symbol:event.symbol});p.last_observation=event.at_ms;
  if(bid>p.peak_price)p.last_high_at=event.at_ms;p.peak_price=Math.max(p.peak_price,bid);p.metadata.fd1Hold??=initialHoldState(p.entry_price);
  hard=hardSafetyState(p,{bid,now:event.at_ms,peak:p.peak_price,policy:EP,r5:true,priceTick:p.filters.priceTick});p.hard_stop_price=hard.hardFloor;
  if(hard.hardHit){decision={valid:true,decision:'EXIT',authority:'HARD_SAFETY',latency_ms:0};eventName=hard.hardReason;}
  else{
   const ei={id:p.id,entryAt:p.entry_at_ms,entryPrice:p.entry_price,entryFee:p.entry_fee,quantity:p.original_quantity,stopPrice:hard.hardFloor,peakPrice:p.peak_price,branch:p.branch,lastHighAt:p.last_high_at,priceTick:p.filters.priceTick};
   if(Math.floor(event.at_ms/60000)>Math.floor((p.p142_at??p.entry_at_ms)/60000)){
    const bars=await candles(p.symbol,p.entry_at_ms,p.p142_at??p.entry_at_ms,event.at_ms);
    try{p.metadata.p142State=advanceP142Completed(ei,bars,p.metadata.p142State??null);p.p142_at=event.at_ms;}catch{s.missing.push({id:event.id,reason:'P142_BAR_GAP'});}
   }
   const raw=nextExitP142(ei,bid,event.at_ms,EP,p.metadata.p142State);soft=softCandidate(raw,hard,p,bid);
   p.metadata.exitAuthority={...hard,softLevel:soft.level,softReason:soft.reason};
   p.resident_floor=Math.max(p.resident_floor??hard.hardFloor,hard.hardFloor,soft.level??0);
   if(capital.resident_protection===true&&bid<=p.resident_floor){decision={valid:true,decision:'EXIT',authority:'RESIDENT_PROTECTION',latency_ms:0};eventName=soft.reason??hard.hardReason;}else{
   let dynamics=null;if(event.at_ms-(p.dynamics_at??0)>=10000){const c=await capture(event.symbol,event.at_ms);dynamics=dynamicsEvent(c,p.dynamics_observation,!!p.metadata.fd1Hold.protectUntil);p.dynamics_observation=dynamics.observation;p.dynamics_at=event.at_ms;}
   const timeCandidate=['V17_MAX_HOLD','V17_MOMENTUM_STALE'].includes(raw.reason)?raw.reason:null;
   const step=await holdStep(p.metadata.fd1Hold,{now:event.at_ms,price:bid,peak:p.peak_price,timeCandidate,softTrigger:soft,dynamics,positionId:p.id,generation:positionGeneration(p),answerOf:async()=>null});p.metadata.fd1Hold=step.state;
   if(step.start){eventName=step.start.event;decision=await decide({event,position:p,task:'HOLD',exit_context:exitContext(p,hard,soft,bid,event.at_ms),event_name:eventName});s.decisions++;
    // Delay completion to observed model latency. Hard protection remains evaluated on each intervening frame.
    p.pending={decision,ready_at:event.at_ms+Math.max(1,decision.latency_ms??25000),soft,timeCandidate,dynamics,started:event.at_ms};
   }
   if(p.pending&&p.pending.ready_at<=event.at_ms){const pending=p.pending,r=pending.decision;
    const finish=await holdStep(p.metadata.fd1Hold,{now:event.at_ms,price:bid,peak:p.peak_price,timeCandidate:pending.timeCandidate,softTrigger:soft,dynamics:pending.dynamics,positionId:p.id,generation:positionGeneration(p),
      answerOf:async()=>({state:'DONE',valid:r.valid===true&&['GPT_FINAL_ONLY','DEEPSEEK_EMERGENCY_EXIT_ONLY'].includes(r.authority),decision:r.decision,authority:r.authority,completed_at_ms:pending.ready_at,snapshot_at_ms:pending.started,refresh_error:r.refresh_error})});
    p.metadata.fd1Hold=finish.state;p.pending=null;decision=finish.close?{...r,latency_ms:0}:null;
   }else decision=null;
   }
  }
 }else if(event.opportunity&&event.admission_eligible){s.opportunities++;
  if(Object.keys(s.positions).length+s.pending_fills.filter(f=>f.kind==='ENTRY').length>=capital.max_slots||s.cash<capital.margin_usdt)return s;
  decision=await decide({event,position:null,task:'ENTRY'});s.decisions++;eventName='ENTRY';
 }
 if(!decision?.valid||!['GPT_FINAL_ONLY','HARD_SAFETY','RESIDENT_PROTECTION','DEEPSEEK_EMERGENCY_EXIT_ONLY'].includes(decision.authority)){if(decision)s.decision_errors++;return s;}
 if(!p&&decision.decision==='BUY'){
  if(recheck){const checked=await recheck(event,decision);if(checked.required){s.decisions++;if(!checked.result?.valid||checked.result.authority!=='GPT_FINAL_ONLY'||checked.result.decision!=='BUY'){if(!checked.result?.valid)s.decision_errors++;return s;}decision={...checked.result,latency_ms:checked.completed_at_ms-event.at_ms};}}
  const f=filtersOf(event.filters);let plan;try{plan=planSlotEntry({ask:event.quote.ask,...f});}catch{return s;}
  const q=await fillQuote(event.symbol,event.at_ms+Math.max(1,decision.latency_ms??0)+capital.latency_ms);
  if(!validQuote(q)||!(q.buy_vwap>0)){s.missing.push({id:event.id,reason:'ENTRY_QUOTE_UNAVAILABLE'});return s;}
  const reserved=plan.maxOrderMarginUsdt;if(s.cash<reserved)return s;
  if(q.buy_vwap>plan.limitPrice){s.cash-=reserved;s.pending_fills.push({kind:'ENTRY',symbol:event.symbol,at:q.received_at_ms,reserved,position:null});return s;}
  const qty=plan.quantity;if(!(q.ask_depth_usdt>=qty*q.buy_vwap)){s.missing.push({id:event.id,reason:'PARTIAL_FILL_UNRESOLVED'});return s;}
  const margin=qty*q.buy_vwap/capital.leverage;if(margin>plan.maxOrderMarginUsdt||s.cash<margin)return s;
  const pid='sim:'+event.id,entryAt=new Date(q.received_at_ms).toISOString(),position={id:pid,symbol:event.symbol,entry_at:entryAt,entry_at_ms:q.received_at_ms,entry_price:q.buy_vwap,original_quantity:qty,remaining_quantity:qty,
   entry_fee:qty*q.buy_vwap*capital.taker_fee,entry_notional:qty*q.buy_vwap,margin,hard_stop_price:q.buy_vwap*(1-POLICY.stopPct),peak_price:q.buy_vwap,last_high_at:q.at_ms,last_observation:q.at_ms,
   filters:f,branch:event.branch??'V30_SCORE',regime:event.regime,metadata:{},decision_id:event.id};s.cash-=reserved;s.pending_fills.push({kind:'ENTRY',symbol:event.symbol,at:q.received_at_ms,reserved,position});
 }else if(p&&decision.decision==='EXIT'){
  const q=await fillQuote(event.symbol,event.at_ms+capital.latency_ms);
  if(!validQuote(q)||!(q.sell_vwap>0)||q.bid_depth_usdt<p.remaining_quantity*q.sell_vwap){s.missing.push({id:event.id,reason:'EXIT_FILL_UNRESOLVED'});return s;}
  const cashflow=await funding(event.symbol,p.entry_at_ms,q.at_ms,p.remaining_quantity);if(!Number.isFinite(cashflow)){s.missing.push({id:event.id,reason:'FUNDING_MISSING'});return s;}
  const fee=q.sell_vwap*p.remaining_quantity*capital.taker_fee,net=(q.sell_vwap-p.entry_price)*p.remaining_quantity-p.entry_fee-fee-cashflow;
  const trade={symbol:p.symbol,entry_ms:p.entry_at_ms,closed_ms:q.received_at_ms,net_usdt:net,fees_usdt:p.entry_fee+fee,funding_usdt:cashflow,notional_usdt:p.entry_notional,regime:p.regime,
   mfe:p.peak_price/p.entry_price-1,mfe_capture:p.peak_price>p.entry_price?(q.sell_vwap-p.entry_price)/(p.peak_price-p.entry_price):null,exit_reason:eventName,exit_authority:decision.authority,entry_decision_id:p.decision_id};
  s.pending_fills.push({kind:'EXIT',symbol:p.symbol,at:q.received_at_ms,margin:p.margin,trade});
 }
 return s;
}
