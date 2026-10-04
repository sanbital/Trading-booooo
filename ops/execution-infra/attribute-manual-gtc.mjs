import fs from 'node:fs';
import crypto from 'node:crypto';
const project='etaajwpernzrcdrifdnw';
if(process.env.GITHUB_REPOSITORY!=='sanbital/Trading-booooo'||process.env.GITHUB_REF!=='refs/heads/main'||process.env.EXPECTED_COMMIT!==process.env.GITHUB_SHA)throw Error('MANUAL_REVIEW_SOURCE_GUARD');
const request=async(url,options={})=>{const r=await fetch(url,{...options,signal:AbortSignal.timeout(20000)});const data=await r.json();if(!r.ok)throw Error(JSON.stringify(data).match(/MANUAL_REVIEW_[A-Z_]+/)?.[0]??'MANUAL_REVIEW_HTTP_'+r.status);return data;};
const managementHeaders={authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN,'content-type':'application/json'};
const sql=query=>request(`https://api.supabase.com/v1/projects/${project}/database/query`,{method:'POST',headers:managementHeaders,body:JSON.stringify({query})});
const gateway=async command=>{
 if(!['get_order','p10_portfolio','v18_open_orders'].includes(command.action))throw Error('MANUAL_REVIEW_READ_ONLY_GATEWAY');
 const body=JSON.stringify({exchange:'binance_futures',...command}),ts=String(Date.now()),nonce=crypto.randomUUID();
 const signature=crypto.createHmac('sha256',crypto.createHash('sha256').update('gateway:'+process.env.LEARNING_ACCESS_TOKEN).digest('hex')).update(`${ts}\n${nonce}\n${body}`).digest('hex');
 const r=await request('https://trading-booooo.fly.dev/v1/command',{method:'POST',headers:{'content-type':'application/json','x-gateway-ts':ts,'x-gateway-nonce':nonce,'x-gateway-signature':signature},body});
 if(r.ok!==true)throw Error('MANUAL_REVIEW_GATEWAY_RESULT');return r.result;
};
const fn=await request(`https://api.supabase.com/v1/projects/${project}/functions/market-autotrader`,{headers:managementHeaders});
if(fn.version!==457||fn.status!=='ACTIVE')throw Error('MANUAL_REVIEW_MAINTENANCE_VERSION');
const executor=await request(`https://api.supabase.com/v1/projects/${project}/functions/v10-lane-executor`,{headers:managementHeaders});
if(executor.version!==202||executor.status!=='ACTIVE')throw Error('MANUAL_REVIEW_EXECUTOR_VERSION');
const health=await request('https://trading-booooo.fly.dev/health');
if(health.deployment_commit!=='79165cd39f9c8a4dbfeef7bd24e6db27b859c441'||health.order_writer.required!==true)throw Error('MANUAL_REVIEW_GATEWAY_VERSION');
const [{postmaster}]=await sql('select pg_postmaster_start_time() postmaster');
const order=await gateway({action:'get_order',market:'GTCUSDT',identifier:'tb-manual-read-4634347872',exchange_order_id:'4634347872'});
async function attribute(){
const [portfolio,openOrders]=await Promise.all([gateway({action:'p10_portfolio',force_rest:true}),gateway({action:'v18_open_orders',force_rest:true})]);
console.log(JSON.stringify({proof:{exchange:portfolio.exchange,account_scope:portfolio.account_scope,positions_complete:portfolio.positions_complete,
 positions:portfolio.positions.map(p=>({market:p.market,side:p.side,quantity:p.quantity})),observation:portfolio.observation,
 portfolio_age_ms:Date.now()-portfolio.observation.requested_at_ms,open_orders_complete:openOrders.complete,
 orders:openOrders.orders?.length,algos:openOrders.algos,orders_age_ms:Date.now()-openOrders.observed_at_ms,
 order_id:order.exchange_order_id,status:order.status,executed_volume:order.executed_volume}}));
const a={version:'USER_CONFIRMED_GTC_20261004_1',attestation:'USER_CONFIRMED_DIRECT_ORDER',commit:process.env.GITHUB_SHA,postmaster,owner:crypto.randomUUID(),evidence:{order,portfolio,openOrders}};
const query=fs.readFileSync('ops/execution-infra/attribute-manual-gtc.sql','utf8').replace('__REVIEW_JSON__',"'"+JSON.stringify(a).replaceAll("'","''")+"'");
await sql(query);
}
for(let attempt=1;;attempt++){
 try{await attribute();break;}catch(error){
  if(attempt>=3||!['MANUAL_REVIEW_FRESH_EXACT_HOLDING_REQUIRED','MANUAL_REVIEW_WRITER_BUSY'].includes(error.message))throw error;
  console.log(JSON.stringify({status:'REJECTED_TRANSACTION_RETRY_WITH_NEW_EVIDENCE',attempt,reason:error.message}));
 }
}
console.log(JSON.stringify({status:'MANUAL_ALLOWANCE_REGISTERED_CIRCUIT_RETAINED',symbol:'GTCUSDT',maxQuantity:1944.6,orderId:'4634347872'}));
const resume=await request(`https://${project}.supabase.co/functions/v1/market-autotrader`,{method:'POST',headers:{'content-type':'application/json','x-autotrade-token':process.env.LEARNING_ACCESS_TOKEN,'x-region':'ap-northeast-1'},body:JSON.stringify({action:'resume'})});
if(resume.ok!==true)throw Error('MANUAL_REVIEW_SAFE_RESUME_REFUSED');
console.log(JSON.stringify({status:'SAFE_RESUME_ACCEPTED_WAITING_ORIGINAL_INDEPENDENT_RECOVERY',utc:new Date().toISOString()}));
