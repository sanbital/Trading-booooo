import fs from 'node:fs';import crypto from 'node:crypto';
const project='etaajwpernzrcdrifdnw',out='infra-evidence/entry-boundary';fs.mkdirSync(out,{recursive:true});
const sql=async query=>{const r=await fetch(`https://api.supabase.com/v1/projects/${project}/database/query`,{method:'POST',headers:{authorization:`Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('AUDIT_SQL_HTTP_'+r.status);return r.json();};
const gateway=async command=>{
 if(!['p10_portfolio','v18_open_orders','v18_entry_never_placed_proof','get_order','trade_history','quote'].includes(command.action))throw Error('AUDIT_READ_ONLY_REQUIRED');
 const raw=JSON.stringify({exchange:'binance_futures',...command}),ts=String(Date.now()),nonce=crypto.randomUUID();
 const signature=crypto.createHmac('sha256',crypto.createHash('sha256').update('gateway:'+process.env.LEARNING_ACCESS_TOKEN).digest('hex')).update(`${ts}\n${nonce}\n${raw}`).digest('hex');
 const r=await fetch('https://trading-booooo.fly.dev/v1/command',{method:'POST',headers:{'content-type':'application/json','x-gateway-ts':ts,'x-gateway-nonce':nonce,'x-gateway-signature':signature},body:raw,signal:AbortSignal.timeout(15000)});
 const data=await r.json();return {http_status:r.status,...data};
};
const snap=await sql("select now() observed_at,public.v17_account_recovery_state() recovery,public.leader20_batch_capacity() capacity,public.deterministic_universe() universe;"),signals=await sql("select id,symbol,status,created_at,updated_at,reject_reason,features->'entryExecution' entry_evidence from public.v11_long_regime_signals where id in ('758216c8-8025-465d-9c4f-56a1987acd3d','c5befe98-9810-45b8-897b-a2886542eb9b') or features#>>'{deterministic,version}'='DETERMINISTIC_DYNAMIC_STATE_1' and created_at>clock_timestamp()-interval '20 minutes' order by created_at desc limit 40;"),orders=await sql("select id,signal_id,symbol,intent,state,client_order_id,exchange_order_id,requested_quantity,reject_reason,created_at,updated_at,request_payload->'entry_latency' timing,response_payload from public.v11_long_regime_orders where created_at>clock_timestamp()-interval '40 minutes' order by created_at desc limit 20;");
const oldIds=[['ATHUSDT','tb-v11e-96aa6af9cdc5483e9b2fe4d0'],['WLDUSDT','tb-v11e-758216c88025465d9c4f56a1'],['BERAUSDT','tb-v11e-c5befe98981045b8897ba288'],['OPUSDT','tb-v11e-139458733f1b4b95ab5dbd0e']];
const venue=[];for(const [market,identifier] of oldIds)venue.push({market,identifier,proof:await gateway({action:'v18_entry_never_placed_proof',market,identifier})});
const [portfolio,openOrders]=await Promise.all([gateway({action:'p10_portfolio'}),gateway({action:'v18_open_orders'})]);
// Reproduce the gateway's watch reads without persisting credentials or headers.
const keyResponse=await fetch(`https://api.supabase.com/v1/projects/${project}/api-keys?reveal=true`,{headers:{authorization:`Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`},signal:AbortSignal.timeout(10000)});
if(!keyResponse.ok)throw Error('WATCH_AUDIT_KEY_LOOKUP');
const serviceKey=(await keyResponse.json()).find(k=>k.name==='service_role')?.api_key;
if(!serviceKey)throw Error('WATCH_AUDIT_SERVICE_KEY');
const watchReads=[];
for(const [name,path,method] of [['universe','rpc/deterministic_universe','POST'],['positions','v11_long_regime_positions?state=neq.CLOSED&select=symbol&limit=11','GET']]){
 const start=Date.now();
 const r=await fetch(`https://${project}.supabase.co/rest/v1/${path}`,{method,headers:{apikey:serviceKey,authorization:`Bearer ${serviceKey}`,'content-type':'application/json'},...(method==='POST'?{body:'{}'}:{}),signal:AbortSignal.timeout(10000)});
 const data=await r.json();watchReads.push({name,http_status:r.status,elapsed_ms:Date.now()-start,...(r.ok?{symbols:name==='universe'?(data.members??[]).map(m=>m.symbol):data.map(p=>p.symbol)}:{code:data.code})});
}
const watchQuotes=[];
for(const market of ['AKTUSDT','BEAMXUSDT','IOTAUSDT','NOMUSDT','AINUSDT']){
 const q=await gateway({action:'quote',market,accept_stream:true});watchQuotes.push({market,http_status:q.http_status,ok:q.ok,code:q.code,source:q.result?.timing?.source});
}
console.log(JSON.stringify({watchReads,watchQuotes}));
// Existing internal credential stays in memory for this read-only endpoint. Never
// emit or persist the token query, token, request headers or credential material.
const [{token}]=await sql("select token from public.edge_internal_tokens where name='v10-lane-executor'");
if(!token)throw Error('READINESS_CREDENTIAL_UNAVAILABLE');
const readinessResponse=await fetch(`https://${project}.supabase.co/functions/v1/v10-lane-executor`,{method:'POST',
 headers:{'content-type':'application/json','x-v10-executor-token':token,'x-region':'ap-northeast-1'},
 body:JSON.stringify({mode:'ops-readiness'}),signal:AbortSignal.timeout(25000)});
const readiness={http_status:readinessResponse.status,...await readinessResponse.json()};
const report={observed_at:new Date().toISOString(),commit:process.env.GITHUB_SHA,snap,signals,orders,venue,portfolio,openOrders,readiness,watchReads,watchQuotes};
fs.writeFileSync(`${out}/audit.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({observed_at:report.observed_at,orders:orders.length,signals:signals.length,venue:venue.map(x=>({symbol:x.market,http_status:x.proof.http_status,proven:x.proof.result?.proven})),portfolio_ok:portfolio.ok,open_orders_ok:openOrders.ok,
 readiness_ok:readiness.ok,native_stop_enabled:readiness.native_stop_enabled,hard_stop_pct:readiness.hard_stop_pct,maxSlots:readiness.maxSlots,targetMarginUsdt:readiness.sizingContract?.targetMarginUsdt,leverage:readiness.sizingContract?.leverage}));
