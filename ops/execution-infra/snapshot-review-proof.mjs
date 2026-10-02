import {createHash,createHmac,randomUUID} from 'node:crypto';
/** Same independent signed read path as the verified production audit. No machine
 * exec, credential extraction, mutation, historical evidence or cached response. */
export async function readSnapshotReviewProof({app,token,commit,fetchImpl=fetch,now=Date.now}){
 if(!['trading-booooo','trading-booooo-sanbital-gateway'].includes(app)||typeof token!=='string'||token.length<32||!/^[a-f0-9]{40}$/.test(commit))throw Error('REVIEW_READ_CONFIG');
 const url=`https://${app}.fly.dev`,health=await fetchImpl(url+'/health',{signal:AbortSignal.timeout(5000)});
 if(!health.ok)throw Error('REVIEW_GATEWAY_HEALTH_UNAVAILABLE');const h=await health.json();
 if(h.deployment_commit!==commit||h.order_writer?.required!==true)throw Error('REVIEW_GATEWAY_BUILD_CHANGED');
 const secret=createHash('sha256').update('gateway:'+token).digest('hex');
 const read=async action=>{
  const body=JSON.stringify({exchange:'binance_futures',action}),ts=String(now()),nonce=randomUUID(),signature=createHmac('sha256',secret).update(ts+'\n'+nonce+'\n'+body).digest('hex');
  const r=await fetchImpl(url+'/v1/command',{method:'POST',headers:{'content-type':'application/json','x-gateway-ts':ts,'x-gateway-nonce':nonce,'x-gateway-signature':signature},body,signal:AbortSignal.timeout(5000)});
  if(!r.ok)throw Error('REVIEW_GATEWAY_READ_HTTP_'+r.status);const d=await r.json();if(!d.ok)throw Error('REVIEW_GATEWAY_READ_FAILED');return d.result;
 };
 const [portfolio,openOrders]=await Promise.all([read('p10_portfolio'),read('v18_open_orders')]);return {portfolio,openOrders};
}
