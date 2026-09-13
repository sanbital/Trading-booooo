// Read-only recognition of a freshly filled V17 order awaiting its position row.
// A positive result means DEFER this scan, never permission to enter or clear a lock.
export async function observeV17EntrySettlement({exposures,orders,observation,queryOrder,now=Date.now()}){
 const incomplete={defer:false,reason:'UNPROVEN_V17_ENTRY_SETTLEMENT'};
 if(!Array.isArray(exposures)||exposures.length!==1||!Array.isArray(orders)||!Number.isFinite(now))return incomplete;
 const e=exposures[0],s=observation;
 if(!s?.id||s.source!=='BINANCE_ACCOUNT_REST'||!Number.isFinite(s.requested_at_ms)||!Number.isFinite(s.received_at_ms)||
  s.requested_at_ms>s.received_at_ms||s.received_at_ms>now||now-s.requested_at_ms>5000)return incomplete;
 if(e.side!=='LONG'||!(Number(e.quantity)>0)||Number(e.tracked_quantity)>0)return incomplete;
 const matches=orders.filter(o=>{
  const p=o.request_payload?.order,at=Date.parse(o.created_at);
  return o.intent==='OPEN_LONG'&&o.state==='DISPATCHED'&&!o.position_id&&o.symbol===e.market&&
   /^tb-v11e-[a-f0-9]{24}$/.test(o.client_order_id??'')&&p?.identifier===o.client_order_id&&
   p.market===o.symbol&&p.side==='BUY'&&p.position_side==='LONG'&&p.position_effect==='OPEN'&&
   p.type==='LIMIT'&&p.time_in_force==='IOC'&&Number(o.requested_quantity)===Number(p.quantity)&&
   Number(p.quantity)>=Number(e.quantity)&&Number.isFinite(at)&&at<=s.requested_at_ms&&now-at<=180000;
 });
 if(matches.length!==1)return incomplete;
 const o=matches[0];let result;
 try{result=await queryOrder({action:'get_order',market:o.symbol,identifier:o.client_order_id,exchange_order_id:o.exchange_order_id});}catch{return incomplete;}
 const r=result?.order??result,raw=r?.raw;
 if(r?.exchange!=='binance_futures'||r.market!==o.symbol||r.client_order_id!==o.client_order_id||r.side!=='BUY'||
  !['BOTH','LONG'].includes(r.position_side)||r.reduce_only!==false||!['FILLED','PARTIALLY_FILLED','CANCELED'].includes(r.status)||
  Number(r.executed_volume)!==Number(e.quantity)||Number(r.requested_volume)!==Number(o.requested_quantity)||
  !r.exchange_order_id||(o.exchange_order_id&&String(r.exchange_order_id)!==String(o.exchange_order_id))||
  !raw||raw.symbol!==o.symbol||raw.clientOrderId!==o.client_order_id||String(raw.orderId)!==String(r.exchange_order_id)||
  raw.side!=='BUY'||raw.reduceOnly!==false||!['BOTH','LONG'].includes(raw.positionSide)||
  Number(raw.executedQty)!==Number(e.quantity)||!Number.isFinite(raw.updateTime)||raw.updateTime>s.received_at_ms||
  raw.updateTime<Date.parse(o.created_at)||Date.now()-now>5000)return incomplete;
 return{defer:true,reason:'V17_ENTRY_SETTLEMENT_PENDING',orderId:o.id,clientOrderId:o.client_order_id,exchangeOrderId:String(r.exchange_order_id),symbol:o.symbol,quantity:Number(e.quantity),observationId:s.id};
}
