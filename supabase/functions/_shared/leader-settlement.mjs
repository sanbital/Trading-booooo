const number=v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const terminal=s=>['FILLED','EXPIRED','CANCELED','CANCELLED','PARTIALLY_FILLED_CANCELED','REJECTED'].includes(s);
const near=(a,b)=>Math.abs(a-b)<=Math.max(1e-10,Math.abs(b)*1e-8);
/** Distinguish reported execution from the later indexing of fees and fills. */
export function readExecutionReceipt(p) {
 const o=p?.order??p??{},f=p?.fill??{},raw=o.raw??o;
 const qty=number(f.executedVolume??f.executed_quantity??o.executed_volume??o.executedQty);
 let avg=number(f.averagePrice??f.average_price??o.average_price??o.avgPrice);
 if(!(avg>0)){const funds=number(o.executed_funds??raw.cumQuote);avg=qty>0&&funds>0?funds/qty:null;}
 const rows=Array.isArray(raw.fills)?raw.fills:Array.isArray(o.trades)?o.trades:null;
 let fee=null,feeKnown=false,firstFillAt=null,lastFillAt=null;
 if(rows!==null){
  let quantity=0,totalFee=0,valid=rows.length>0;const seen=new Set();
  for(const t of rows){
   const q=number(t.qty??t.volume),commission=number(t.commission??t.fee),id=String(t.tradeId??t.trade_id??t.id??'');
   const asset=t.commissionAsset??t.fee_asset,at=number(t.time)??(t.executed_at?Date.parse(t.executed_at):null);
   if(!(q>0)||commission===null||asset!=='USDT'||!id||seen.has(id))valid=false;
   seen.add(id);quantity+=q??0;totalFee+=commission??0;
   if(at>0){firstFillAt=firstFillAt===null?at:Math.min(firstFillAt,at);lastFillAt=Math.max(lastFillAt??0,at);}
  }
  feeKnown=valid&&qty>0&&near(quantity,qty)&&!raw.fee_lookup_error;
  if(feeKnown)fee=totalFee;
 }else if(!o.raw){
  // Direct exchange adapters may supply an explicitly complete receipt without a
  // normalized raw wrapper. Missing values are still null, never an assumed zero.
  fee=number(f.paidFeeQuote??f.paidFee??o.paid_fee??o.commission);feeKnown=fee!==null;
 }
 const updated=number(raw.updateTime);
 if(lastFillAt===null&&updated>0&&qty>0)lastFillAt=updated;
 return {status:String(o.raw_status??o.status??p?.status??'UNKNOWN').toUpperCase(),
  exchangeOrderId:o.exchange_order_id==null?(o.orderId==null?null:String(o.orderId)):String(o.exchange_order_id),
  qty,avg:avg>0?avg:null,fee,feeKnown,firstFillAt,lastFillAt,raw:p};
}
export function knownExitPnl(p){
 const saved=number(p.metadata?.knownExitPnlUsdt);if(saved!==null)return saved;
 const realized=number(p.realized_pnl_usdt),fee=number(p.entry_fee_usdt);
 if(realized!==null&&fee!==null)return realized+fee;
 return null;
}
export function exitExecutionPatch(p,order,z,now=Date.now()) {
 const meta=p.metadata??{},applied=meta.appliedExecutionIds??[];
 if(meta.lastAppliedOrderId===order.id||applied.includes(order.id))return null;
 if(!terminal(z.status)||!(z.qty>0)||z.qty>Number(p.remaining_quantity)+1e-8)throw Error('EXIT_EXECUTION_UNCONFIRMED');
 const remaining=Math.max(0,Number(p.remaining_quantity)-z.qty),closed=remaining<=1e-10;
 const complete=z.avg>0&&z.feeKnown!==false&&Number.isFinite(z.fee),delta=complete?(z.avg-Number(p.entry_price))*z.qty-z.fee:null;
 const before=knownExitPnl(p),known=before===null?null:before+(delta??0),pending=[...(meta.pendingExitAccounting??[])];
 if(!complete)pending.push({orderId:order.id,clientOrderId:order.client_order_id,exchangeOrderId:z.exchangeOrderId,quantity:z.qty,price:z.avg??null,fee:z.fee??null});
 const fee=number(p.entry_fee_usdt),real=known===null||fee===null||pending.length?null:known-fee;
 const at=z.lastFillAt>0&&z.lastFillAt<=now?z.lastFillAt:now;
 return {remaining_quantity:remaining,state:closed?'CLOSED':'OPEN',realized_pnl_usdt:real,
  exit_price:z.avg??null,exit_reason:closed?order.reason:p.exit_reason,closed_at:closed?new Date(at).toISOString():null,
  last_evaluated_at:new Date(now).toISOString(),updated_at:new Date(Math.max(now,Date.parse(p.updated_at??0)+1)||now).toISOString(),
  t1_completed:order.reason==='BULL_T1'?true:p.t1_completed,
  metadata:{...meta,lastAppliedOrderId:order.id,lastExitOrderId:z.exchangeOrderId||order.client_order_id,lastExitReason:order.reason,
   appliedExecutionIds:[...applied,order.id],knownExitPnlUsdt:known,pendingExitAccounting:pending,exitAccountingPending:pending.length>0}};
}

/** All retries below are get_order reads of the persisted identifier. No dispatch. */
export async function recoverExecutionJournal({db,gateway,recordEntry,clock=Date.now,verifyLease=async()=>{},maxReads=3}) {
 const read=async q=>{const r=await q;if(r.error)throw Error('SETTLEMENT_DATABASE');return r.data;};
 let reads=0;
 const lookup=async(symbol,clientId,orderId)=>{
  if(reads>=maxReads)throw Error('SETTLEMENT_READ_BUDGET');reads++;
  const raw=await gateway({action:'get_order',market:symbol,identifier:clientId,exchange_order_id:orderId},6000),z=readExecutionReceipt(raw);
  if(!z.exchangeOrderId||(orderId&&z.exchangeOrderId!==String(orderId)))throw Error('ORDER_ID_MISMATCH');
  return {raw,z};
 };
 const pending=await read(db.from('v11_long_regime_orders').select('*').in('state',['PLANNED','RECONCILIATION_FAILED','RECONCILIATION_PENDING']).order('updated_at',{ascending:true}).limit(30))??[];
 const results=[];
 for(const o of pending){
  if(reads>=Math.max(1,maxReads-1))break;
  try{
   const s=await read(db.from('v11_long_regime_signals').select('*').eq('id',o.signal_id).maybeSingle());
   if(s?.features?.strategy!=='LEADER_MOMENTUM_V17')continue;
   const {raw,z}=await lookup(o.symbol,o.client_order_id,o.exchange_order_id);
   if(!terminal(z.status))throw Error('ORDER_NOT_TERMINAL');
   await verifyLease();
   if(z.qty===0){
    await read(db.from('v11_long_regime_orders').update({state:'REJECTED',exchange_order_id:z.exchangeOrderId,response_payload:raw,reject_reason:'CONFIRMED_TERMINAL_NO_FILL',updated_at:new Date(clock()).toISOString()}).eq('id',o.id));
    if(o.intent==='OPEN_LONG'&&!o.position_id)await read(db.from('v11_long_regime_signals').update({status:'REJECTED',reject_reason:'CONFIRMED_TERMINAL_NO_FILL',updated_at:new Date(clock()).toISOString()}).eq('id',s.id));
    results.push({id:o.id,status:'NO_FILL'});continue;
   }
   if(!(z.qty>0))throw Error('QUANTITY_UNKNOWN');
   if(o.intent==='OPEN_LONG'){
    if(!(z.avg>0))throw Error('ENTRY_PRICE_PENDING');
    await recordEntry(s,o,z,raw);results.push({id:o.id,status:'ENTRY_RECOVERED'});continue;
   }
   const p=await read(db.from('v11_long_regime_positions').select('*').eq('id',o.position_id).single());
   if(p?.metadata?.executionMode!=='LEADER_MOMENTUM_V17'||p.metadata?.v17ManualPosition===true)throw Error('NOT_OWNED');
   const patch=exitExecutionPatch(p,o,z,clock());
   if(patch){const saved=await read(db.from('v11_long_regime_positions').update(patch).eq('id',p.id).eq('updated_at',p.updated_at).select('id').maybeSingle());if(!saved)throw Error('SETTLEMENT_CAS');}
   if((patch?.state??p.state)==='CLOSED')await read(db.from('v11_long_regime_signals').update({status:'CLOSED',updated_at:new Date(clock()).toISOString()}).eq('id',p.signal_id));
   await read(db.from('v11_long_regime_orders').update({state:z.avg>0&&z.feeKnown?'FILLED':'RECONCILIATION_PENDING',response_payload:raw,exchange_order_id:z.exchangeOrderId,updated_at:new Date(clock()).toISOString()}).eq('id',o.id));
   results.push({id:o.id,status:'EXECUTION_RECOVERED'});
  }catch{
   results.push({id:o.id,status:'RECONCILIATION_PENDING'});
   // Rotate uncertain orders so an unavailable old receipt cannot starve recovery.
   await verifyLease();
   await read(db.from('v11_long_regime_orders').update({updated_at:new Date(clock()).toISOString()}).eq('id',o.id));
  }
 }
 // Quantity was already booked on these rows. Only reconcile the missing money;
 // CAS removes each pending item in the same write as its PnL delta.
 const positions=await read(db.from('v11_long_regime_positions').select('*').eq('metadata->>executionMode','LEADER_MOMENTUM_V17')
  .or('metadata->>entryAccountingPending.eq.true,metadata->>exitAccountingPending.eq.true')
  .order('updated_at',{ascending:true}).limit(30))??[];
 for(const initial of positions){
  if(reads>=maxReads)break;
  if(initial.metadata?.v17ManualPosition===true||(!initial.metadata?.entryAccountingPending&&!initial.metadata?.pendingExitAccounting?.length))continue;
  try{
   const p=await read(db.from('v11_long_regime_positions').select('*').eq('id',initial.id).single()),meta={...p.metadata};
   let fee=number(p.entry_fee_usdt),known=knownExitPnl(p),changed=false;
   if(meta.entryAccountingPending){
    const os=await read(db.from('v11_long_regime_orders').select('*').eq('position_id',p.id).eq('intent','OPEN_LONG').limit(1)),o=os?.[0];
    if(o){const {z}=await lookup(p.symbol,o.client_order_id,o.exchange_order_id);
     if(terminal(z.status)&&z.qty>0&&z.feeKnown&&near(z.qty,Number(p.original_quantity))){fee=z.fee;meta.entryAccountingPending=false;changed=true;}}
   }
   const remaining=[];
   for(const item of meta.pendingExitAccounting??[]){
    if(reads>=maxReads){remaining.push(item);continue;}
    const {z}=await lookup(p.symbol,item.clientOrderId,item.exchangeOrderId);
    if(terminal(z.status)&&z.qty>0&&z.avg>0&&z.feeKnown&&near(z.qty,item.quantity)&&known!==null){known+=(z.avg-Number(p.entry_price))*z.qty-z.fee;changed=true;}
    else remaining.push(item);
   }
   if(!changed)continue;
   meta.pendingExitAccounting=remaining;meta.exitAccountingPending=remaining.length>0;meta.knownExitPnlUsdt=known;
   const patch={entry_fee_usdt:fee,realized_pnl_usdt:fee===null||known===null||remaining.length?null:known-fee,metadata:meta,
    updated_at:new Date(Math.max(clock(),Date.parse(p.updated_at)+1)).toISOString()};
   await verifyLease();
   const saved=await read(db.from('v11_long_regime_positions').update(patch).eq('id',p.id).eq('updated_at',p.updated_at).select('id').maybeSingle());
   if(!saved)throw Error('SETTLEMENT_CAS');
  }catch{
   results.push({id:initial.id,status:'ACCOUNTING_PENDING'});
   await verifyLease();
   await read(db.from('v11_long_regime_positions').update({updated_at:new Date(Math.max(clock(),Date.parse(initial.updated_at)+1)).toISOString()})
    .eq('id',initial.id).eq('updated_at',initial.updated_at));
  }
 }
 return results;
}
