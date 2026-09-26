// Pure proof of a never-accepted second IOC beside an already-owned first fill.
// No order authority, DB writes or relaxation of unknown/timeout outcomes.
import {freshPortfolio,ownedEntry,riskOrders,sameQuantity} from '../_shared/leader-ops-isolation.mjs';
import {entryReceipt} from '../_shared/leader-entry-settlement.mjs';

export const RETRY_RECONCILIATION_VERSION='FD1_PARTIAL_RETRY_RECONCILIATION_1';
const MAX_AGE=6*3600000,FRESH_MS=5000;
const rec=x=>x&&typeof x==='object'&&!Array.isArray(x)?x:{};
const finite=x=>x!==null&&x!==''&&x!==undefined&&Number.isFinite(Number(x));
const stamp=t=>Number.isSafeInteger(t)&&t>=0;
export function retryProofCandidate(order,now=Date.now()){
  const p=rec(order?.request_payload),q=rec(p.order),created=Date.parse(order?.created_at),age=now-created;
  return order?.intent==='OPEN_LONG'&&order.exchange_order_id==null&&
    ['RECONCILIATION_FAILED','RECONCILIATION_PENDING'].includes(order.state)&&
    Number(p.entry_ioc_attempt)===2&&Number(p.entry_ioc_max_attempts)===2&&
    typeof p.retry_of_order_id==='string'&&p.retry_of_order_id!==order.id&&
    /^tb-v11r2-[a-z0-9]+$/.test(String(order.client_order_id??''))&&q.identifier===order.client_order_id&&
    q.market===order.symbol&&q.side==='BUY'&&q.position_side==='LONG'&&q.position_effect==='OPEN'&&
    q.type==='LIMIT'&&q.time_in_force==='IOC'&&finite(q.quantity)&&Number(q.quantity)>0&&
    finite(q.price)&&Number(q.price)>0&&sameQuantity(Number(q.quantity),Number(order.requested_quantity))&&
    Number.isFinite(age)&&age>=0&&age<=MAX_AGE&&
    /^GW_400:Binance futures entry requires at least [\d.]+ USDT margin \([\d.]+ USDT notional at [\d.]+x\); got [\d.]+$/.test(String(order.reject_reason??''));
}
export function parentTradeStart(parent){
  try{const receipt=entryReceipt(parent.response_payload,parent);
    const ids=receipt.tradeIds.map(Number);
    if(!receipt.exact||!(receipt.quantity>0)||!ids.length||ids.some(x=>!Number.isSafeInteger(x)||x<0))return null;
    return Math.min(...ids);
  }catch{return null;}
}
export function proveUnplacedPartialRetry({order,parent,proof,orderHistory,trades,pair,readsStartedAt,readsFinishedAt,now=Date.now()}){
  const reject=reason=>({proven:false,version:RETRY_RECONCILIATION_VERSION,reason});
  if(!retryProofCandidate(order,now))return reject('RETRY_IDENTITY_OR_AGE');
  if(!stamp(readsStartedAt)||!stamp(readsFinishedAt)||readsStartedAt>readsFinishedAt||readsFinishedAt>now||now-readsStartedAt>FRESH_MS)
    return reject('HISTORY_STALE_OR_FUTURE');
  if(proof?.found!==false||Number(proof.lookup_code)!==-2013||proof.position_read_ok!==true||proof.trade_read_ok!==true||
    proof.exchange!=='binance_futures'||proof.market!==order.symbol||proof.identifier!==order.client_order_id||
    proof.source!=='BINANCE_FUTURES_ORDER_AND_POSITION_REST'||!stamp(proof.requested_at_ms)||!stamp(proof.observed_at_ms)||
    proof.requested_at_ms>proof.observed_at_ms||proof.observed_at_ms>now||now-proof.requested_at_ms>FRESH_MS)
    return reject('ORDER_ABSENCE_NOT_FRESHLY_PROVEN');
  if(parent?.id!==order.request_payload.retry_of_order_id||parent.intent!=='OPEN_LONG'||parent.state!=='FILLED'||
    parent.symbol!==order.symbol||parent.signal_id!==order.signal_id||!parent.position_id||!parent.exchange_order_id||
    parent.response_payload?.v18ExposureFinal!==true||Number(parent.request_payload?.entry_ioc_attempt)!==1||
    !(Date.parse(parent.created_at)<=Date.parse(order.created_at)))return reject('PARENT_IDENTITY');
  let receipt;try{receipt=entryReceipt(parent.response_payload,parent);}catch{return reject('PARENT_RECEIPT');}
  if(!receipt.exact||!(receipt.quantity>0)||!stamp(receipt.lastAt)||receipt.lastAt>Date.parse(order.created_at)||parentTradeStart(parent)===null)
    return reject('PARENT_FILL_NOT_FINAL');
  if(!Array.isArray(orderHistory)||orderHistory.length!==1)return reject('ORDER_HISTORY_AMBIGUOUS_OR_TRUNCATED');
  const venue=orderHistory[0];
  if(String(venue?.orderId)!==String(parent.exchange_order_id)||venue.clientOrderId!==parent.client_order_id||venue.symbol!==order.symbol||
    venue.side!=='BUY'||venue.positionSide!=='BOTH'||venue.type!=='LIMIT'||venue.timeInForce!=='IOC'||
    !['FILLED','EXPIRED','CANCELED','CANCELLED'].includes(venue.status)||String(venue.reduceOnly)!=='false'||
    !finite(venue.executedQty)||!sameQuantity(Number(venue.executedQty),receipt.quantity)||
    !finite(venue.origQty)||!sameQuantity(Number(venue.origQty),Number(parent.requested_quantity)))return reject('VENUE_PARENT_MISMATCH');
  if(!Array.isArray(trades)||!trades.length||trades.length>=1000)return reject('TRADE_HISTORY_INCOMPLETE');
  const expected=new Set(receipt.tradeIds.map(String)),seen=new Set();let quantity=0,quote=0;
  for(const t of trades){const id=String(t?.id);
    if(!expected.has(id)||seen.has(id)||String(t.orderId)!==String(parent.exchange_order_id)||t.symbol!==order.symbol||
      t.isBuyer!==true||!finite(t.qty)||Number(t.qty)<=0||!finite(t.price)||Number(t.price)<=0||
      !stamp(Number(t.time))||Number(t.time)>Date.parse(order.created_at))return reject('UNATTRIBUTED_OR_LATE_FILL');
    seen.add(id);quantity+=Number(t.qty);quote+=Number(t.qty)*Number(t.price);
  }
  if(seen.size!==expected.size||!sameQuantity(quantity,receipt.quantity)||!sameQuantity(quote/quantity,receipt.price))return reject('FILL_TOTAL_MISMATCH');
  if(!freshPortfolio(pair?.pf,now)||!Array.isArray(pair?.positions)||!Array.isArray(pair?.orders)||!Array.isArray(pair?.manual))return reject('OWNERSHIP_EVIDENCE_INCOMPLETE');
  const positions=pair.positions.filter(p=>p.symbol===order.symbol),p=positions[0],live=pair.pf.positions.filter(p=>(p.market??p.symbol)===order.symbol),
    pending=riskOrders(pair.orders).filter(o=>o.symbol===order.symbol);
  if(positions.length!==1||p?.id!==parent.position_id||!ownedEntry(p,pair.orders)||pair.manual.some(x=>x.symbol===order.symbol)||
    p.metadata?.v18EntryAccountingPending===true||p.metadata?.exitAccountingPending===true||
    !sameQuantity(Number(p.original_quantity),receipt.quantity)||!sameQuantity(Number(p.remaining_quantity),receipt.quantity)||
    !sameQuantity(Number(p.entry_price),receipt.price)||live.length!==1||live[0].side!=='LONG'||
    !sameQuantity(Number(live[0].quantity),receipt.quantity)||!finite(live[0].entry_price)||
    !sameQuantity(Number(live[0].entry_price),receipt.price)||!finite(proof.position_quantity)||
    !sameQuantity(Number(proof.position_quantity),receipt.quantity)||pending.length!==1||pending[0].id!==order.id)
    return reject('OWNED_PARTIAL_EXPOSURE_CHANGED');
  return {proven:true,version:RETRY_RECONCILIATION_VERSION,reason:'PARTIAL_RETRY_NEVER_PLACED',
    positionId:p.id,parentOrderId:parent.id,parentExchangeOrderId:String(parent.exchange_order_id),
    retainedQuantity:receipt.quantity,retainedEntryPrice:receipt.price,tradeIds:[...seen],
    orderHistoryCount:orderHistory.length,tradeHistoryCount:trades.length,lookupCode:-2013,
    proofRequestedAt:proof.requested_at_ms,proofObservedAt:proof.observed_at_ms,
    historyRequestedAt:readsStartedAt,historyReceivedAt:readsFinishedAt,portfolioObservation:pair.pf.observation};
}
