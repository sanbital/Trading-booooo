/** Strict normalization for the archived production Gateway get_order/create_order
 * shape. No HTTP calls. Fees must be complete and in USDT (or exactly marked).
 */
const near=(a,b)=>Math.abs(a-b)<=Math.max(1e-9,Math.abs(b)*1e-8);
export function normalizeR4GatewayOrder(payload,expected){
 const order=payload?.order??payload,raw=order?.raw;
 if(!raw||payload?.reconciliation_pending===true)throw Error('R4_GATEWAY_RECONCILIATION_PENDING');
 const q=Number(raw.executedQty),requested=Number(raw.origQty);
 if(raw.clientOrderId!==expected.clientId||raw.symbol!==expected.symbol||raw.side!=='SELL'||
   raw.reduceOnly!==true||raw.positionSide!=='BOTH'||!near(requested,expected.quantity))throw Error('R4_GATEWAY_IDENTITY');
 if(!Number.isFinite(q)||q<0||q>requested+1e-8)throw Error('R4_GATEWAY_QUANTITY');
 let quantity=0,quote=0,commission=0,lastFillAt=null;
 const seen=new Set();
 const fills=raw.fills??[];
 if(q>0&&!fills.length)throw Error('R4_GATEWAY_FILLS_MISSING');
 for(const fill of fills){
  const id=String(fill.tradeId??'');if(!id||seen.has(id))throw Error('R4_GATEWAY_DUPLICATE_OR_MISSING_TRADE_ID');seen.add(id);
  const amount=Number(fill.qty),funds=Number(fill.quoteQty),fee=fill.commissionAsset==='USDT'?Number(fill.commission):
    fill.feeQuoteMarkSource==='QUOTE_ASSET_EXACT'?Number(fill.feeQuoteMarked):NaN;
  if(![amount,funds,fee,Number(fill.time)].every(Number.isFinite)||amount<=0||funds<=0)throw Error('R4_GATEWAY_FEES_OR_FILLS_INCOMPLETE');
  quantity+=amount;quote+=funds;commission+=fee;lastFillAt=Math.max(lastFillAt??0,Number(fill.time));
 }
 if(!near(quantity,q))throw Error('R4_GATEWAY_PARTIAL_FILL_LIST');
 const status=String(raw.status).toUpperCase();
 if(!['NEW','PARTIALLY_FILLED','FILLED','CANCELED','EXPIRED','REJECTED'].includes(status))throw Error('R4_GATEWAY_STATUS');
 return {clientId:expected.clientId,symbol:raw.symbol,side:'SELL',reduceOnly:true,requestedQuantity:requested,
  filledQuantity:q,cumulativeQuote:quote,commissionQuote:commission,commissionComplete:true,exact:true,
  status,exchangeOrderId:String(raw.orderId),lastFillAt};
}
export function r4GatewayCommand(intent){
 if(intent.side!=='SELL'||intent.reduceOnly!==true||intent.type!=='MARKET'||intent.positionSide!=='BOTH'||
   !Number.isFinite(intent.quantity)||intent.quantity<=0||!/^tb-r4-[a-f0-9]{28}$/.test(intent.clientId))throw Error('R4_INVALID_GATEWAY_INTENT');
 return {action:'create_order',order:{market:intent.symbol,side:'SELL',type:'MARKET',quantity:intent.quantity,
  identifier:intent.clientId,position_side:'LONG',position_effect:'CLOSE'},wait_for_final_ms:4000};
}
