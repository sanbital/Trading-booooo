import {classifyPortfolio} from '../leader-ops-isolation.mjs';
import {ENGINE} from './market-state.mjs';

const canonical=value=>JSON.stringify(value,(key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?
  Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item);
const positive=value=>Number.isFinite(Number(value))&&Number(value)>0;
const empty=value=>value==null||typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===0;

/** Temporary risk view for the exact intent created by this fenced dispatch.
 * The durable row and reservation remain PLANNED and charged. No other caller,
 * pending identity, acknowledged intent or portfolio issue receives an exception.
 */
export function plannedEntryRiskView(pair,{order,signal,attemptNo,request}={},now=Date.now()){
 const deny=reason=>({allowed:false,reason:'OWN_PLANNED_ENTRY_'+reason});
 const q=request?.order,p=order?.request_payload;
 if(!order?.id||!signal?.id||!signal?.symbol||!order.client_order_id||
   !Number.isInteger(attemptNo)||![1,2].includes(attemptNo)||request?.action!=='create_order'||request.leverage!==3||
   q?.market!==signal.symbol||q.side!=='BUY'||q.type!=='LIMIT'||q.time_in_force!=='IOC'||
   q.position_side!=='LONG'||q.position_effect!=='OPEN'||q.identifier!==order.client_order_id||
   !positive(q.quantity)||!positive(q.price)||Number(order.requested_quantity)!==Number(q.quantity)||
   p?.deterministic?.version!==ENGINE||p?.executor_patch!==ENGINE||p?.entry_ioc_attempt!==attemptNo||
   p?.entry_ioc?.attempt!==attemptNo||p?.entry_ioc_max_attempts!==2||
   p.action!==request.action||p.leverage!==request.leverage||canonical(p.order)!==canonical(q))return deny('CONTEXT_MISMATCH');
 const rows=pair?.orders;
 if(!Array.isArray(rows))return deny('READ_INCOMPLETE');
 const matches=rows.filter(o=>o.id===order.id);
 if(matches.length!==1)return deny('IDENTITY_NOT_UNIQUE');
 const current=matches[0];
 for(const row of [order,current])if(row.signal_id!==signal.id||row.symbol!==signal.symbol||row.intent!=='OPEN_LONG'||
   row.client_order_id!==order.client_order_id||row.state!=='PLANNED'||row.position_id!=null||
   row.exchange_order_id!=null||!empty(row.response_payload))return deny('NOT_UNSUBMITTED');
 if(Number(current.requested_quantity)!==Number(order.requested_quantity)||
   canonical(current.request_payload)!==canonical(order.request_payload))return deny('INTENT_CHANGED');
 const orders=rows.filter(o=>o.id!==order.id);
 return {allowed:true,pair:{...pair,orders,match:classifyPortfolio(pair.positions,pair.pf,{manual:pair.manual,orders,now})}};
}
