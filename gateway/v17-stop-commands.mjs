/** Signed transport is injected by the host. No requests are made on import. */
export function createV17StopCommands({request,assertVersion,positionSideDual}) {
 const identity=(c)=>{
  if(!/^tb-v17s-[a-f0-9]{27}$/.test(String(c.clientAlgoId))||!/^([\p{L}\p{N}]+)USDT$/u.test(String(c.symbol)))
   throw Error('INVALID_V17_STOP_IDENTITY');
 };
 async function query(c){
  identity(c);const a=await request('GET','/fapi/v1/algoOrder',{clientAlgoId:c.clientAlgoId});
  if(a.symbol!==c.symbol||a.clientAlgoId!==c.clientAlgoId)throw Error('V17_STOP_IDENTITY_MISMATCH');
  return a;
 }
 return async function handle(action,c){
  if(action==='v17_protection_capabilities')return {version:1,oneWayOnly:true,quantityBound:true};
  if(action==='v17_query_stop')return query(c);
  if(action==='v17_create_stop'){
   assertVersion(c);const p=c.params??{};identity(p);
   if(await positionSideDual())throw Error('V17_NATIVE_HEDGE_MODE_UNSUPPORTED');
   if(p.side!=='SELL'||p.positionSide!=='BOTH'||p.type!=='STOP_MARKET'||
      p.algoType!=='CONDITIONAL'||String(p.reduceOnly)!=='true'||
      p.workingType!=='CONTRACT_PRICE'||String(p.priceProtect)!=='false'||p.closePosition!=null||
      !Number.isFinite(p.quantity)||p.quantity<=0||!Number.isFinite(p.triggerPrice)||p.triggerPrice<=0)
    throw Error('V17_NATIVE_STOP_SPEC_INVALID');
   // Explicit field allowlist excludes caller-supplied account or routing fields.
   const params=Object.fromEntries(['algoType','symbol','side','positionSide','type','quantity',
    'triggerPrice','workingType','priceProtect','reduceOnly','clientAlgoId'].map(k=>[k,p[k]]));
   return request('POST','/fapi/v1/algoOrder',params);
  }
  if(action==='v17_cancel_stop'){
   assertVersion(c);await query(c);
   return request('DELETE','/fapi/v1/algoOrder',{clientAlgoId:c.clientAlgoId});
  }
  if(action==='v17_stop_fill'){
   // Bind the market-order ID to the persisted bot algo, never an arbitrary order.
   const algo=await query(c),id=String(algo.actualOrderId??'');
   if(!id||id==='0'||id!==String(c.actualOrderId))throw Error('V17_NATIVE_ACTUAL_ORDER_MISMATCH');
   const order=await request('GET','/fapi/v1/order',{symbol:c.symbol,orderId:id});
   const trades=await request('GET','/fapi/v1/userTrades',{symbol:c.symbol,orderId:id,limit:1000}).catch(()=>null);
   const orderEvidence={orderId:id,clientAlgoId:c.clientAlgoId,symbol:c.symbol,
     side:order.side,positionSide:order.positionSide,reduceOnly:order.reduceOnly,
     requestedQuantity:Number(order.origQty),quantity:Number(order.executedQty),status:order.status,
     lastAt:Number(order.updateTime)};
   const valid=String(order.orderId)===id&&order.symbol===c.symbol&&order.side==='SELL'&&
     String(order.reduceOnly)==='true'&&order.positionSide==='BOTH'&&
     Number.isFinite(orderEvidence.quantity)&&orderEvidence.quantity>=0;
   if(!valid)throw Error('V18_NATIVE_ORDER_EVIDENCE_MISMATCH');
   if(!Array.isArray(trades))return {exact:false,orderEvidence};
   const seen=new Set();let quantity=0,funds=0,fee=0,lastFillAt=0;
   for(const t of trades){
    if(String(t.orderId)!==id||t.symbol!==c.symbol||t.side!=='SELL'||t.commissionAsset!=='USDT'||
       seen.has(String(t.id))||![t.qty,t.price,t.commission,t.time].every(v=>Number.isFinite(Number(v))))return {exact:false,orderEvidence};
    seen.add(String(t.id));quantity+=Number(t.qty);funds+=Number(t.qty)*Number(t.price);
    fee+=Number(t.commission);lastFillAt=Math.max(lastFillAt,Number(t.time));
   }
   const close=(a,b)=>Number.isFinite(b)&&Math.abs(a-b)<=Math.max(1e-8,Math.abs(b)*1e-7);
   const exact=close(quantity,Number(order.executedQty))&&close(funds,Number(order.cumQuote));
   return {exact,quantity,funds,fee,lastFillAt,status:order.status,orderEvidence,tradeIds:[...seen]};
  }
  throw Error('V17_NATIVE_ACTION_UNSUPPORTED');
 };
}
