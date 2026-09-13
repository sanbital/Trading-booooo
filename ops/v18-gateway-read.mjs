// Signed reads only. Credentials stay in process memory and never enter evidence.
import crypto from 'node:crypto';
import {writeFileSync,mkdirSync} from 'node:fs';
import {freshPortfolio} from '../supabase/functions/_shared/leader-ops-isolation.mjs';
const url=`https://${process.env.FLY_BINANCE_APP_NAME}.fly.dev`;
const token=process.env.LEARNING_ACCESS_TOKEN;
if(!process.env.FLY_BINANCE_APP_NAME || !token || token.length<32)throw Error('MISSING_CONFIG');
const secret=crypto.createHash('sha256').update(`gateway:${token}`).digest('hex');
export async function read(action){
  if(!['p10_portfolio','v18_open_orders'].includes(action))throw Error('READ_ONLY_ACTION');
  const body=JSON.stringify({exchange:'binance_futures',action});
  const ts=String(Date.now()),nonce=crypto.randomUUID();
  const signature=crypto.createHmac('sha256',secret).update(`${ts}\n${nonce}\n${body}`).digest('hex');
  const r=await fetch(`${url}/v1/command`,{method:'POST',headers:{'content-type':'application/json','x-gateway-ts':ts,'x-gateway-nonce':nonce,'x-gateway-signature':signature},body,signal:AbortSignal.timeout(5000)});
  const d=await r.json();if(!r.ok||!d.ok)throw Error(`GATEWAY_READ_FAILED:${r.status}:${d.error||''}`);return d.result;
}
const h=await fetch(`${url}/health`,{signal:AbortSignal.timeout(5000)}).then(r=>r.json());
if(h.ops_patch!=='V18-OPS-ISOLATION-3')throw Error('GATEWAY_PATCH_MISMATCH');
const [portfolio,openOrders]=await Promise.all([read('p10_portfolio'),read('v18_open_orders')]);
if(!freshPortfolio(portfolio))throw Error('PORTFOLIO_PROOF_INVALID');
if(openOrders.complete!==true||!Array.isArray(openOrders.orders)||!Array.isArray(openOrders.algos)||Date.now()-openOrders.observed_at_ms>3000)throw Error('ORDERS_INCOMPLETE');
mkdirSync('release-evidence',{recursive:true});
writeFileSync('release-evidence/gateway-read.json',JSON.stringify({observedAt:new Date().toISOString(),health:h,portfolio,openOrders},null,2));
console.log(JSON.stringify({patch:h.ops_patch,positions:portfolio.positions.length,orders:openOrders.orders.length,algoOrders:openOrders.algos.length,observation:portfolio.observation}));
