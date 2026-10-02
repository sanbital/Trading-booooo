import {entryReceipt} from './leader-entry-settlement.mjs';
import {exitReceipt} from './leader-exit-settlement.mjs';
const knownNotFound=error=>/-2013|order does not exist/i.test(String(error?.message??error));
const stopIdentity=row=>row.payload?.params?.clientAlgoId??row.payload?.clientAlgoId;
/** Uses the existing signed gateway and existing receipt validators. Construction
 * performs no IO. Acknowledgement is never interpreted as final fill/position truth.
 */
export function createWriterExchange({gateway,now=Date.now}) {
  const check=row=>{
    if (row.account_key!=='binance_futures:futures'||row.payload?.exchange!=='binance_futures') throw Error('WRITER_ACCOUNT_MISMATCH');
    const action=row.payload.action;
    if (!['create_order','cancel_order','v17_create_stop','v17_cancel_stop'].includes(action)) throw Error('WRITER_ACTION_UNSUPPORTED');
    const id=action==='create_order'?row.payload.order?.identifier:action==='cancel_order'?row.payload.identifier:stopIdentity(row);
    if (!id||id!==row.client_order_id) throw Error('WRITER_CLIENT_ORDER_ID_MISMATCH');
  };
  const query=async(row,signal)=>{
    const action=row.payload.action;
    if (action==='v17_create_stop'||action==='v17_cancel_stop') {
      const raw=await gateway({exchange:'binance_futures',action:'v17_query_stop',
        clientAlgoId:row.client_order_id,symbol:row.symbol},{signal});
      if (raw?.clientAlgoId!==row.client_order_id||raw?.symbol!==row.symbol||raw?.algoId==null) throw Error('PROTECTION_IDENTITY_MISMATCH');
      return {complete:true,found:true,orderId:String(raw.algoId),raw,
        canceled:['CANCELED','CANCELLED'].includes(String(raw.algoStatus??raw.status).toUpperCase())};
    }
    const raw=await gateway({exchange:'binance_futures',action:'get_order',market:row.symbol,
      identifier:row.client_order_id,exchange_order_id:row.exchange_order_id},{signal});
    const intent={client_order_id:row.client_order_id,exchange_order_id:row.exchange_order_id,
      symbol:row.symbol,requested_quantity:Number(row.payload.order?.quantity)};
    // Cancels refer to an existing intent, whose requested quantity and side must be
    // supplied in the immutable command's reference. Do not invent them from a reply.
    if(row.payload.action==='cancel_order')Object.assign(intent,row.payload.reference_intent);
    const receipt=row.kind==='ENTRY'||row.payload.reference_intent?.intent==='OPEN_LONG'?entryReceipt(raw,intent):exitReceipt(raw,intent);
    return {complete:true,found:true,orderId:receipt.id,raw,receipt,status:receipt.status,
      quantity:receipt.quantity??receipt.q,requested:receipt.requested,
      canceled:['CANCELED','CANCELLED'].includes(receipt.status)};
  };
  return {
    async submitFenced(row,{lease,signal,verify}) {
      check(row);signal?.throwIfAborted();await verify();
      const raw=await gateway({...row.payload,writer:{account_key:row.account_key,
        execution_key:row.execution_key,owner:lease.owner,fence:String(lease.fence)}},{signal});
      signal?.throwIfAborted();
      const found=await query(row,signal); // Same-ID query is mandatory after create acknowledgement.
      return {...found,acknowledgement:raw};
    },
    async lookup(row,{signal}={}) {
      check(row);
      try{return await query(row,signal);}
      catch(error){
        // Negative ordinary entry lookup alone is never proof of absence. Use only
        // the existing corroborated gateway proof and its existing six-hour bound.
        const age=now()-Date.parse(row.created_at);
        if(row.kind!=='ENTRY'||row.exchange_order_id||!knownNotFound(error)||
          !Number.isFinite(age)||age<0||age>6*3600000) return {complete:false,found:null};
        const proof=await gateway({exchange:'binance_futures',action:'v18_entry_never_placed_proof',
          market:row.symbol,identifier:row.client_order_id},{signal});
        const neverPlaced=proof?.proven===true&&proof.found===false&&proof.position_quantity===0&&
          proof.position_read_ok===true&&proof.trade_read_ok===true;
        return {complete:neverPlaced,found:neverPlaced?false:null,neverPlaced,evidence:proof};
      }
    },
  };
}
