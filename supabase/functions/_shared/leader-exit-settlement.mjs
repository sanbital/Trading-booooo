import {freshPortfolio,sameQuantity} from './leader-ops-isolation.mjs';
import {canonicalOrderFills} from './leader-fill-evidence.mjs';
const terminal=s=>['FILLED','EXPIRED','CANCELED','CANCELLED','REJECTED','PARTIALLY_FILLED_CANCELED'].includes(s);
/** Quantity is an order fact; accounting needs the complete, deduplicated actual trades. */
export function exitReceipt(raw,intent) {
  const o=raw?.order??raw??{},r=o.raw??o;
  const id=String(o.exchange_order_id??r.orderId??''),client=String(o.client_order_id??r.clientOrderId??'');
  const q=Number(o.executed_volume??r.executedQty),requested=Number(o.requested_volume??r.origQty);
  const status=String(o.raw_status??r.status??o.status??'UNKNOWN').toUpperCase();
  if(!id||client!==intent.client_order_id||(intent.exchange_order_id&&id!==String(intent.exchange_order_id))||
    (o.market??r.symbol)!==intent.symbol||(o.side??r.side)!=='SELL'||
    String(o.reduce_only??r.reduceOnly)!=='true'||!['BOTH','LONG'].includes(o.position_side??r.positionSide)||
    !sameQuantity(requested,Number(intent.requested_quantity))||!Number.isFinite(q)||q<0||q>requested+1e-9||(status==='FILLED'&&q===0))
    throw Error('EXIT_ORDER_IDENTITY_OR_QUANTITY_MISMATCH');
  const fills=canonicalOrderFills(r.fills,{expectedQuantity:q,expectedSide:'SELL'}),exact=fills.exact;
  return {id,client,q,requested,status,terminal:terminal(status),exact,funds:exact?fills.funds:null,
    fee:exact?fills.fee:null,lastAt:exact?fills.lastAt:Number(r.updateTime)||null,tradeIds:fills.tradeIds};
}
export async function applyExitReceipt(db,p,intent,raw,pf,{verifyLease,now=Date.now}={}) {
  const receipt=exitReceipt(raw,intent),meta=p.metadata??{},journal=structuredClone(meta.v18Exits??{});
  const old=journal[intent.id]??{quantity:0,accountedQuantity:0,funds:0,fee:0};
  if(old.exchangeOrderId&&old.exchangeOrderId!==receipt.id)throw Error('EXIT_RECEIPT_ID_CHANGED');
  const delta=receipt.q-old.quantity;
  if(delta< -1e-10||delta>Number(p.remaining_quantity)+1e-9)throw Error('EXIT_CUMULATIVE_QUANTITY_MISMATCH');
  if(!freshPortfolio(pf,now()))throw Error('EXIT_PORTFOLIO_STALE');
  const rows=pf.positions.filter(x=>String(x.market??x.symbol).toUpperCase()===p.symbol);
  if(rows.length>1||rows.some(x=>x.side!=='LONG'))throw Error('EXIT_OWNERSHIP_MISMATCH');
  const held=rows.length?Number(rows[0].quantity):0,after=Number(p.remaining_quantity)-delta;
  // A terminal partial-order FILLED is never interpreted as a full-position close.
  if(!sameQuantity(held,after))throw Error('EXIT_EXPOSURE_RECONCILIATION_PENDING');
  if(!receipt.terminal)throw Error('EXIT_ORDER_OUTCOME_PENDING');
  const prior=meta.v18SettledPnl??p.realized_pnl_usdt;let settled=prior==null?NaN:Number(prior);
  if(!Number.isFinite(settled))throw Error('EXIT_PRIOR_ACCOUNTING_UNKNOWN');
  if(receipt.exact)settled+=(receipt.funds-old.funds)-Number(p.entry_price)*(receipt.q-old.accountedQuantity)-(receipt.fee-old.fee);
  journal[intent.id]={...old,exchangeOrderId:receipt.id,clientOrderId:receipt.client,quantity:receipt.q,
    status:receipt.status,detailsComplete:receipt.exact,tradeIds:receipt.tradeIds,
    ...(receipt.exact?{accountedQuantity:receipt.q,funds:receipt.funds,fee:receipt.fee}:{})};
  const pending=meta.v18EntryAccountingPending===true||Object.values(journal).some(x=>x.quantity>0&&!x.detailsComplete)||
    (meta.exitProtection?.orders??[]).some(x=>x.accountingPending===true);
  const closed=after<=1e-10,stamp=new Date(Math.max(now(),Date.parse(p.updated_at)+1)).toISOString();
  const patch={remaining_quantity:closed?0:after,state:closed?'CLOSED':'OPEN',
    realized_pnl_usdt:pending?null:settled,exit_price:receipt.exact&&receipt.q>0?receipt.funds/receipt.q:p.exit_price??null,
    closed_at:closed?(receipt.lastAt?new Date(receipt.lastAt).toISOString():p.closed_at??null):null,
    exit_reason:closed?intent.reason:p.exit_reason,t1_completed:intent.intent==='PARTIAL_CLOSE'&&receipt.q>0?true:p.t1_completed,
    metadata:{...meta,v18Exits:journal,v18SettledPnl:settled,exitAccountingPending:pending,lastAppliedOrderId:intent.id,
      lastExitOrderId:receipt.id,lastExitReason:intent.reason},updated_at:stamp};
  await verifyLease();
  const up=await db.from('v11_long_regime_positions').update(patch).eq('id',p.id).eq('updated_at',p.updated_at).select('*').maybeSingle();
  if(up.error||!up.data)throw Error('EXIT_POSITION_CAS_CONFLICT');
  await verifyLease();
  const order=await db.from('v11_long_regime_orders').update({state:pending?'RECONCILIATION_PENDING':receipt.q>0?'FILLED':'REJECTED',
    exchange_order_id:receipt.id,response_payload:{...raw,v18ExposureFinal:true},reject_reason:pending?'ACCOUNTING_DETAILS_PENDING':null,
    updated_at:stamp}).eq('id',intent.id);
  if(order.error)throw Error('EXIT_ORDER_JOURNAL_WRITE');
  if(closed){await verifyLease();const signal=await db.from('v11_long_regime_signals').update({status:'CLOSED',updated_at:stamp}).eq('id',p.signal_id);
    if(signal.error)throw Error('EXIT_SIGNAL_WRITE');}
  return {closed,executedQuantity:delta,position:up.data,exitPrice:patch.exit_price,realizedPnlUsdt:patch.realized_pnl_usdt,accountingPending:pending};
}
