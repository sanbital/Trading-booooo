// Read-only production observation. No order, control or fund mutation is allowed.
import fs from 'node:fs';import crypto from 'node:crypto';
const project='etaajwpernzrcdrifdnw',out='infra-evidence/stream-reads';fs.mkdirSync(out,{recursive:true});
const sql=async query=>{const r=await fetch(`https://api.supabase.com/v1/projects/${project}/database/query`,{method:'POST',headers:{authorization:`Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('AUDIT_SQL_HTTP_'+r.status);return r.json();};
const gateway=async command=>{
 if(!['p10_portfolio','v18_open_orders'].includes(command.action))throw Error('AUDIT_READ_ONLY_REQUIRED');
 const raw=JSON.stringify({exchange:'binance_futures',accept_stream:true,...command}),ts=String(Date.now()),nonce=crypto.randomUUID();
 const key=crypto.createHash('sha256').update('gateway:'+process.env.LEARNING_ACCESS_TOKEN).digest('hex');
 const signature=crypto.createHmac('sha256',key).update(`${ts}\n${nonce}\n${raw}`).digest('hex');
 const r=await fetch('https://trading-booooo.fly.dev/v1/command',{method:'POST',headers:{'content-type':'application/json','x-gateway-ts':ts,'x-gateway-nonce':nonce,'x-gateway-signature':signature},body:raw,signal:AbortSignal.timeout(10000)});
 const data=await r.json();if(!r.ok||!data.ok)throw Error('AUDIT_GATEWAY_READ_FAILED');return data.result;
};
const health=async()=>{const r=await fetch('https://trading-booooo.fly.dev/health');if(!r.ok)throw Error('HEALTH_UNAVAILABLE');return {at:Date.now(),...await r.json()};};
const manifest=JSON.parse(fs.readFileSync('ops/deterministic/release-request.json','utf8')),expected=manifest.gateway_commits['trading-booooo'];
const samples=[];let initial;
for(let n=0;n<5;n++){
 const h=await health();if(h.deployment_commit!==expected||h.build!=='2026-10-04-stream-reads-1'||!h.order_writer.required||h.scheduler_enabled!==false||!h.futures_stream_reads?.enabled)throw Error('STREAM_RELEASE_IDENTITY_MISMATCH');
 samples.push(h);if(n===0)initial=h;
 console.log(JSON.stringify({at:new Date(h.at).toISOString(),build:h.build,account:h.futures_stream_reads.account,market:h.futures_stream_reads.market,
  weight:h.futures_rest_budget.estimated_or_observed_weight,exchange_weight:h.futures_rest_budget.exchange_observed_weight,denied:h.futures_rest_budget.denied,blocked_until:h.futures_rest_budget.blocked_until_ms}));
 if(n<4)await new Promise(r=>setTimeout(r,45000));
}
// Compare one fresh independent recovery read with stream evidence. Retain only
// aggregate counts/comparison booleans; credential material and wallet values
// never enter the public workflow artifact.
const [rest,stream,restOrders,streamOrders]=await Promise.all([
 gateway({action:'p10_portfolio',force_rest:true}),gateway({action:'p10_portfolio'}),
 gateway({action:'v18_open_orders',force_rest:true}),gateway({action:'v18_open_orders'})]);
const positions=p=>p.positions.map(x=>[x.market,x.side,Number(x.quantity)]).sort((a,b)=>String(a).localeCompare(String(b)));
const orders=p=>JSON.stringify([p.orders.map(x=>String(x.orderId)).sort(),p.algos.map(x=>String(x.algoId)).sort()]);
const consistency={rest_complete:rest.positions_complete,stream_complete:stream.positions_complete,
 positions_equal:JSON.stringify(positions(rest))===JSON.stringify(positions(stream)),open_orders_equal:orders(restOrders)===orders(streamOrders),
 account_source:stream.observation.source,open_orders_source:streamOrders.observation?.source,rest_positions:rest.positions.length,stream_positions:stream.positions.length,
 open_orders:restOrders.orders.length,open_algos:restOrders.algos.length,conservative_capacity:Number(stream.available_quote)<=Number(rest.available_quote)+1e-8};
const state=await sql("select now() observed_at,(select pause_new_entries from public.trading_settings where id=1) pause_new_entries,(select circuit_open from public.v11_long_regime_runtime where singleton) circuit_open,(select count(*) from public.v11_long_regime_positions where state<>'CLOSED') active_positions,(select count(*) from public.leader20_entry_reservations where state in ('RESERVED','ORDER_PENDING')) active_reservations,(select count(*) from public.v11_long_regime_signals where status='CLAIMED') claimed,(select count(*) from public.v11_long_regime_orders where created_at>clock_timestamp()-interval '10 minutes' and exchange_order_id is not null) acknowledged_orders,(select count(*) from public.v11_long_regime_orders where created_at>clock_timestamp()-interval '10 minutes' and state='FILLED') filled_orders;");
const last=samples.at(-1),seconds=(last.at-initial.at)/1000,before=initial.futures_rest_budget.endpoints,after=last.futures_rest_budget.endpoints;
const delta=Object.fromEntries(Object.entries(after).map(([k,v])=>[k,{requests:v.requests-(before[k]?.requests??0),weight:v.weight-(before[k]?.weight??0)}]));
const report={observed_at:new Date().toISOString(),commit:process.env.GITHUB_SHA,gateway_commit:expected,seconds,samples,delta,consistency,state};
fs.writeFileSync(out+'/audit.json',JSON.stringify(report,null,2));console.log(JSON.stringify({consistency,state,seconds,delta}));
if(!consistency.rest_complete||!consistency.stream_complete||!consistency.positions_equal||!consistency.open_orders_equal||!consistency.conservative_capacity||
 consistency.account_source!=='BINANCE_ACCOUNT_STREAM'||consistency.open_orders_source!=='BINANCE_ACCOUNT_STREAM'||last.futures_rest_budget.blocked_until_ms||
 !last.futures_stream_reads.account?.healthy||!last.futures_stream_reads.account?.synchronized)throw Error('STREAM_OPERATIONAL_VERIFICATION_FAILED');
