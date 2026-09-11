import {freshPortfolio,sameQuantity} from './leader-ops-isolation.mjs';
/** Only a persisted bot intent can create ownership. No manual-position adoption. */
export function entryReceipt(raw,intent){
 const o=raw?.order??raw??{},r=o.raw??o,id=String(o.exchange_order_id??r.orderId??''),client=String(o.client_order_id??r.clientOrderId??'');
 const quantity=Number(o.executed_volume??r.executedQty),requested=Number(o.requested_volume??r.origQty),price=Number(o.average_price??r.avgPrice);
 const status=String(o.raw_status??r.status??o.status??'UNKNOWN').toUpperCase();
 if(!id||client!==intent.client_order_id||(intent.exchange_order_id&&id!==String(intent.exchange_order_id))||
   (o.market??r.symbol)!==intent.symbol||(o.side??r.side)!=='BUY'||String(o.reduce_only??r.reduceOnly)!=='false'||
   (r.positionSide??o.position_side)!=='BOTH'||!sameQuantity(requested,Number(intent.requested_quantity))||
   !(quantity>=0&&quantity<=requested&&(quantity===0||price>0))||!['FILLED','EXPIRED','CANCELED','CANCELLED','REJECTED','PARTIALLY_FILLED_CANCELED'].includes(status)||
   (quantity===0&&status==='FILLED'))throw Error('ENTRY_ORDER_EVIDENCE_PENDING');
 const fills=Array.isArray(r.fills)?r.fills:[],ids=new Set();let qty=0,fee=0,exact=fills.length>0;
 for(const t of fills){const tid=t.tradeId??t.id;
   if(tid==null||ids.has(String(tid))||!(Number(t.qty)>0)||t.commissionAsset!=='USDT'||!Number.isFinite(Number(t.commission))){exact=false;continue;}
   ids.add(String(tid));qty+=Number(t.qty);fee+=Number(t.commission);
 }
 exact=quantity===0||exact&&sameQuantity(qty,quantity);
 return{id,client,quantity,price,status,fee:exact?fee:null,exact,lastAt:Number(r.updateTime)||null,tradeIds:[...ids]};
}
export function entryExposureMatches(pf,symbol,quantity,now=Date.now()){
 if(!freshPortfolio(pf,now))return false;
 const rows=pf.positions.filter(x=>(x.market??x.symbol)===symbol);
 return rows.length===1&&rows[0].side==='LONG'&&sameQuantity(Number(rows[0].quantity),quantity);
}
