// Read-only. Raw trading state and rollback SQL are encrypted before upload.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomBytes,createCipheriv,publicEncrypt,createHash,createHmac} from 'node:crypto';
import {summarizeCohort} from './cohort-summary.mjs';
const project='etaajwpernzrcdrifdnw';
const event=process.env.GITHUB_EVENT_PATH?JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8')):{};
const fullAudit=process.env.GITHUB_EVENT_NAME!=='schedule'||event.schedule==='23 0 * * *';
const ev={version:'EXECUTION_INFRA_AUDIT_1',commit:process.env.GITHUB_SHA,utc:new Date().toISOString(),results:{}};
ev.scope=fullAudit?'FULL_BASELINE':'READINESS_AND_SAFETY';
const kst=utc=>new Date(Date.parse(utc)+9*3600000).toISOString().replace('Z','+09:00');ev.kst=kst(ev.utc);
function seal(){
 mkdirSync('infra-evidence',{recursive:true});
 const key=randomBytes(32),iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);
 const data=Buffer.concat([c.update(JSON.stringify(ev)),c.final()]);
 const encryptedKey=publicEncrypt({key:readFileSync('ops/execution-infra/evidence-public.pem'),oaepHash:'sha256'},key);
 writeFileSync('infra-evidence/audit.encrypted.json',JSON.stringify({version:1,key:encryptedKey.toString('base64'),iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),data:data.toString('base64')}));
}
async function record(name,fn){try{ev.results[name]=await fn();}catch(e){ev.results[name]={ok:false,error:e.name==='TimeoutError'?'TIMEOUT':'REQUEST_FAILED'};}seal();console.log(name,ev.results[name]?.ok===false?'UNAVAILABLE':'COLLECTED');}
async function managed(query){
 const r=await fetch(`https://api.supabase.com/v1/projects/${project}/database/query`,{method:'POST',headers:{authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN,'content-type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(20000)});
 if(!r.ok)return{ok:false,http:r.status};return{ok:true,rows:await r.json()};
}
function direct(query){
 if(!process.env.SUPABASE_DB_URL)return{ok:false,error:'NO_DB_URL'};
 const r=spawnSync('psql',['--no-psqlrc','--dbname',process.env.SUPABASE_DB_URL,'-At','-v','ON_ERROR_STOP=1','-c',`begin read only; set local statement_timeout='10s'; select coalesce(json_agg(q),'[]'::json) from (${query}) q; commit;`],{env:{...process.env,PGCONNECT_TIMEOUT:'8'},encoding:'utf8',timeout:15000,maxBuffer:64*1024*1024});
 if(r.status!==0){const e=String(r.stderr??'');return{ok:false,error:r.error?.code==='ENOENT'?'NO_PSQL':r.signal?'TIMEOUT':/password|authentication/i.test(e)?'DB_AUTH_REJECTED':/translate host|Name or service|resolve/i.test(e)?'DNS_FAILURE':/Network is unreachable|No route/i.test(e)?'NETWORK_UNREACHABLE':/Connection refused/i.test(e)?'CONNECTION_REFUSED':/timeout|timed out/i.test(e)?'CONNECTION_TIMEOUT':/not accepting connections|starting up/i.test(e)?'DB_STARTING':'DB_QUERY_FAILED',encrypted_detail:e.slice(0,2000)};}
 try{return{ok:true,rows:JSON.parse(r.stdout.split('\n').find(l=>l.startsWith('['))??'[]')};}catch{return{ok:false,error:'DB_RESULT_INVALID'};}
}
let selectedDbUrl=process.env.SUPABASE_DB_URL;
// Platform metadata and metrics have independent transport paths. A DB SQL outage
// does not justify stopping resource/config/health evidence collection.
for(const [name,path] of Object.entries({
 platform_health:'health?services=db&services=db_postgres_user&services=rest&services=pooler',
 postgres_config:'config/database/postgres',
 pooler_config:'config/database/pooler',
 platform_metrics:'analytics/endpoints/metrics',
}))await record(name,async()=>{
 const r=await fetch(`https://api.supabase.com/v1/projects/${project}/${path}`,{
  headers:{authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN},signal:AbortSignal.timeout(15000)});
 if(!r.ok)return{ok:false,http:r.status,encrypted_detail:(await r.text()).slice(0,2000)};
 const value=name==='platform_metrics'?await r.text():await r.json();
 return{ok:true,utc:new Date().toISOString(),value};
});
async function sql(query){const d=direct(query);if(d.ok)return d;return managed(query);}
if(selectedDbUrl){
 const probe=direct('select 1');ev.results.pooler_probe=probe;
 if(!probe.ok){
  try{const u=new URL(selectedDbUrl);u.hostname='db.'+project+'.supabase.co';u.port='5432';u.username='postgres';u.searchParams.set('sslmode','require');u.searchParams.set('connect_timeout','8');
   process.env.SUPABASE_DB_URL=u.href;
   const directProbe=direct('select 1');ev.results.direct_probe=directProbe;if(!directProbe.ok)process.env.SUPABASE_DB_URL=selectedDbUrl;
  }catch{process.env.SUPABASE_DB_URL=selectedDbUrl;}
 }
}
if(selectedDbUrl)await record('transaction_pooler_probe',async()=>{
 const current=process.env.SUPABASE_DB_URL;
 try{
  const u=new URL(selectedDbUrl);
  if(!u.hostname.endsWith('.pooler.supabase.com'))return{ok:false,error:'TRANSACTION_POOLER_NOT_CONFIGURED'};
  u.port='6543';process.env.SUPABASE_DB_URL=u.href;
  const result=direct('select 1');if(!result.ok)process.env.SUPABASE_DB_URL=current;return result;
 }catch{process.env.SUPABASE_DB_URL=current;return{ok:false,error:'TRANSACTION_POOLER_CONFIG_INVALID'};}
});
await record('service_rest_probe',async()=>{
 // This external read can use an existing PostgREST connection even when a new SQL
 // connection fails. Keys and Authorization never enter evidence or log state.
 const keysResponse=await fetch(`https://api.supabase.com/v1/projects/${project}/api-keys?reveal=true`,{
  headers:{authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN},signal:AbortSignal.timeout(5000)});
 if(!keysResponse.ok)return{ok:false,error:'REST_KEY_LOOKUP_UNAVAILABLE',http:keysResponse.status};
 const keys=await keysResponse.json(),key=Array.isArray(keys)?keys.find(k=>k.name==='service_role')?.api_key:null;
 if(!key)return{ok:false,error:'REST_SERVICE_KEY_UNAVAILABLE'};
 const response=await fetch(`https://${project}.supabase.co/rest/v1/v11_long_regime_runtime?select=singleton,live_enabled,circuit_open&limit=1`,{
  headers:{apikey:key,authorization:'Bearer '+key},signal:AbortSignal.timeout(5000)});
 return response.ok?{ok:true,utc:new Date().toISOString(),rows:await response.json()}:{ok:false,http:response.status};
});
await record('readiness',()=>sql("select now() utc,now() at time zone 'Asia/Seoul' kst,pg_postmaster_start_time() started_at"));
if(ev.results.readiness.ok){
 const queries={
 deterministic_controls:"select jsonb_build_object('leader20',(select to_jsonb(c) from public.leader20_control c),'batch',(select to_jsonb(c) from public.leader20_batch_control c),'gpt',(select to_jsonb(c) from public.gpt_final_review_control c),'v17',(select to_jsonb(c) from public.v17_operator_control c),'capture',(select to_jsonb(c)-'lease_owner' from doa_capture.control c)) controls",
 deterministic_settings:"select jsonb_build_object('mode',mode,'pause',pause_new_entries,'allocation',binance_futures_allocation_usdt,'allocation_mode',binance_futures_allocation_mode,'reserve',binance_futures_reserve_usdt,'leverage',binance_futures_leverage,'slots',max_open_positions_per_exchange,'futures_enabled',binance_futures_enabled,'ready',binance_futures_trade_ready) settings from public.trading_settings where id=1",
 deterministic_functions:"select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) arguments,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','doa_capture') and p.prokind='f' and p.proname ~ '^(doa_|leader20_|v17_|v19_|v11_).*'",
 deterministic_constraints:"select c.conrelid::regclass name,c.conname,pg_get_constraintdef(c.oid) definition from pg_constraint c where c.conrelid::regclass::text ~ 'leader20|v11_long_regime|doa_capture'",
 deterministic_trades:"select p.id,p.signal_id,p.symbol,p.state,p.entry_at,p.entry_price,p.exit_price,p.closed_at,p.exit_reason,p.realized_pnl_usdt,p.entry_fee_usdt,p.peak_price,p.hard_stop_price,p.metadata,s.features from public.v11_long_regime_positions p left join public.v11_long_regime_signals s on s.id=p.signal_id where p.entry_at>=now()-interval '30 days' order by p.entry_at",
 deterministic_failure_journals:"select r.job_key,r.symbol,r.created_at,r.completed_at,r.decision,r.valid,r.latency_ms,r.record from public.gpt_final_entry_reviews r where r.signal_id in (select p.signal_id from public.v11_long_regime_positions p where p.symbol in ('OPNUSDT','MAGMAUSDT','CTUSDT') and p.entry_at>=now()-interval '3 days') order by r.created_at",
 deterministic_failure_capture:"select e.position_id,e.symbol,e.at,e.received_at,e.payload from public.evolution_capture e join public.v11_long_regime_positions p on p.id=e.position_id where p.symbol in ('OPNUSDT','MAGMAUSDT','CTUSDT') and p.entry_at>=now()-interval '3 days' order by e.position_id,e.at",
 deterministic_capture_sample:"select kind,symbol,at,received_at,payload from doa_capture.live_micro order by at desc limit 30",
 deterministic_accounting:"select p.id,p.symbol,p.state,p.realized_pnl_usdt,p.metadata->'exitAccountingPending' accounting_pending,count(f.id) fills,count(f.id) filter(where f.accounting_status<>'ACCOUNTED') unaccounted_fills,sum(f.realized_pnl_quote) fill_pnl,sum(f.fee_quote_amount) fees from public.v11_long_regime_positions p left join public.exchange_trade_fills f on f.v17_position_id=p.id where p.entry_at>=now()-interval '30 days' group by p.id",
 settings:"select name,setting,unit,source from pg_settings where name in ('cron.use_background_workers','cron.max_running_jobs','max_connections','max_worker_processes','statement_timeout','shared_buffers','work_mem','max_parallel_workers','autovacuum_max_workers')",
 activity:"select backend_type,state,wait_event_type,wait_event,count(*) connections,max(extract(epoch from now()-query_start)) max_query_age_s from pg_stat_activity group by 1,2,3,4",
 cron_backup:"select * from cron.job order by jobid",
 cron_runs:"select j.jobid,j.jobname,j.schedule,j.active,count(*) runs,count(*) filter(where r.status='failed') failures,count(*) filter(where r.return_message ilike '%startup timeout%') startup_timeouts,percentile_cont(array[0.5,0.95,0.99]) within group(order by extract(epoch from r.end_time-r.start_time)) durations_s,min(r.start_time) first_run,max(r.start_time) last_run from cron.job j left join cron.job_run_details r on r.jobid=j.jobid and r.start_time>=now()-interval '24 hours' group by 1,2,3,4 order by 1",
 cron_failures:"select jobid,status,return_message,start_time,end_time from cron.job_run_details where start_time>=now()-interval '24 hours' and status='failed' order by start_time desc limit 200",
 tables:"select n.nspname,c.relname,c.relpersistence,c.relkind,pg_total_relation_size(c.oid) bytes from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','net','doa_capture') and c.relkind in ('r','m') and (c.relname ~ 'execution|dispatch|outbox|order|fill|position|runtime|lease|review|authority|scheduler|control|settings' or n.nspname='net') order by 1,2",
 columns:"select table_schema,table_name,column_name,data_type,column_default from information_schema.columns where table_schema in ('public','net') and table_name ~ 'execution|dispatch|outbox|order|fill|position|runtime|lease|review|authority|scheduler|control' order by 1,2,ordinal_position",
 function_backup:"select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) arguments,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and p.proname ~ 'execution|dispatch|outbox|lease|durable|recover|pipeline_health'",
 constraints:"select c.conrelid::regclass name,c.conname,pg_get_constraintdef(c.oid) definition from pg_constraint c where c.conrelid::regclass::text ~ 'execution|dispatch|order|fill|position|lease'",
 indexes:"select schemaname,tablename,indexname,indexdef from pg_indexes where schemaname='public' and tablename ~ 'execution|dispatch|order|fill|position|lease'",
 triggers:"select t.tgrelid::regclass name,pg_get_triggerdef(t.oid) definition from pg_trigger t where not t.tgisinternal and t.tgrelid::regclass::text ~ 'execution|dispatch|review|order|fill|position'",
 runtime:"select to_jsonb(r) row from public.v11_long_regime_runtime r",
 leases:"select to_jsonb(r) row from public.v17_execution_lease r",
 positions:"select to_jsonb(r) row from public.v11_long_regime_positions r where state='OPEN'",
 unresolved_orders:"select to_jsonb(r) row from public.v11_long_regime_orders r where state in ('PLANNED','DISPATCHED','SUBMITTING','PARTIALLY_FILLED','UNKNOWN','RECONCILIATION_PENDING','RECONCILIATION_FAILED')",
 dispatches:"select to_jsonb(d) row from public.leader20_execution_dispatches d where gpt_completed_at>=now()-interval '7 days' order by gpt_completed_at",
 decisions:"select job_key,purpose,state,decision,valid,created_at,record->'identity' identity,record#>'{packet,leader20,entry_window}' entry_window,record#>'{result,review_route}' review_route,record#>'{result,completed_at_ms}' completed_at_ms,record#>'{result,error}' error,record#>'{result,origin}' origin from public.gpt_final_entry_reviews r where created_at>=now()-interval '7 days' and purpose='PRODUCTION' and decision='BUY'",
 cohort_clock:"select to_jsonb(c) row from public.leader20_clock_executions c where gpt_buy_completed_at>=now()-interval '7 days'",
 same_decision_cohort:readFileSync('ops/execution-infra/cohort.sql','utf8'),
 cohort_orders:"select (to_jsonb(o)-'request_payload'-'response_payload') || jsonb_build_object('clock_authority',o.request_payload#>'{entry_gpt_decision,clockFinalAuthority}','clock_execution',o.request_payload->'entry_clock_execution','same_order_finality',o.response_payload->'v22EntryFinality','not_dispatched',o.response_payload->'notDispatched') row from public.v11_long_regime_orders o where signal_id in (select (r.record#>>'{identity,signal_id}')::uuid from public.gpt_final_entry_reviews r where created_at>=now()-interval '7 days' and purpose='PRODUCTION' and state='DONE' and valid is true and decision='BUY' and r.record#>>'{result,review_route}'='TOP20_CLOCK_GPT_FINAL_3')",
 cohort_positions:"select to_jsonb(p) row from public.v11_long_regime_positions p where signal_id in (select (r.record#>>'{identity,signal_id}')::uuid from public.gpt_final_entry_reviews r where created_at>=now()-interval '7 days' and purpose='PRODUCTION' and state='DONE' and valid is true and decision='BUY' and r.record#>>'{result,review_route}'='TOP20_CLOCK_GPT_FINAL_3')",
 cohort_fills:"select to_jsonb(f) row from public.exchange_trade_fills f where f.v17_order_id in (select o.id from public.v11_long_regime_orders o where signal_id in (select (r.record#>>'{identity,signal_id}')::uuid from public.gpt_final_entry_reviews r where created_at>=now()-interval '7 days' and purpose='PRODUCTION' and state='DONE' and valid is true and decision='BUY' and r.record#>>'{result,review_route}'='TOP20_CLOCK_GPT_FINAL_3'))",
 net_queue:"select count(*) queue_depth,min(id) oldest_request_id from net.http_request_queue",
 net_responses:"select status_code,timed_out,error_msg,count(*) from net._http_response where created>=now()-interval '24 hours' group by 1,2,3 order by count(*) desc limit 50",
 stats:"select datname,numbackends,xact_commit,xact_rollback,blks_read,blks_hit,temp_bytes,deadlocks,blk_read_time,blk_write_time,stats_reset from pg_stat_database where datname=current_database()",
 };
 const routine=new Set(['settings','activity','leases','positions','unresolved_orders','net_queue','stats']);
 for(const [name,query]of Object.entries(queries))if(fullAudit||routine.has(name))await record(name,()=>sql(query));
 if(ev.results.same_decision_cohort?.ok)await record('same_decision_cohort_summary',async()=>({
   ok:true,value:summarizeCohort(ev.results.same_decision_cohort.rows),
 }));
}
await record('exchange_read_only',async()=>{
 const app=process.env.FLY_BINANCE_APP_NAME,token=process.env.LEARNING_ACCESS_TOKEN;
 if(!app||!token)return{ok:false,error:'SIGNED_READ_CONFIG_MISSING'};
 const secret=createHash('sha256').update('gateway:'+token).digest('hex');
 const read=async action=>{
  if(!['p10_portfolio','v18_open_orders'].includes(action))throw Error('READ_ONLY_ACTION');
  const body=JSON.stringify({exchange:'binance_futures',action}),ts=String(Date.now()),nonce=crypto.randomUUID();
  const signature=createHmac('sha256',secret).update(ts+'\n'+nonce+'\n'+body).digest('hex');
  const r=await fetch('https://'+app+'.fly.dev/v1/command',{method:'POST',headers:{'content-type':'application/json','x-gateway-ts':ts,'x-gateway-nonce':nonce,'x-gateway-signature':signature},body,signal:AbortSignal.timeout(5000)});
  const d=await r.json();if(!r.ok||!d.ok)return{ok:false,http:r.status};return{ok:true,result:d.result};
 };
 const portfolio=await read('p10_portfolio'),openOrders=await read('v18_open_orders');
 return{ok:portfolio.ok&&openOrders.ok,portfolio,openOrders,utc:new Date().toISOString()};
});
const apps=[...new Set([process.env.FLY_APP_NAME,process.env.FLY_BINANCE_APP_NAME,'sanbital-doa-capture-20260925'].filter(Boolean))];
for(const app of [process.env.FLY_APP_NAME,process.env.FLY_BINANCE_APP_NAME].filter(Boolean))
 await record('fly_health:'+app,async()=>{
  const r=await fetch(`https://${app}.fly.dev/health`,{signal:AbortSignal.timeout(5000)});
  return r.ok?{ok:true,utc:new Date().toISOString(),value:await r.json()}:{ok:false,http:r.status};
 });
for(const app of apps)await record('fly:'+app,async()=>{
 const r=await fetch(`https://api.machines.dev/v1/apps/${app}/machines`,{headers:{authorization:'Bearer '+process.env.FLY_API_TOKEN},signal:AbortSignal.timeout(15000)});
 if(!r.ok)return{ok:false,http:r.status};
 const rows=await r.json();
 if(fullAudit&&[process.env.FLY_APP_NAME,process.env.FLY_BINANCE_APP_NAME].includes(app)){
  // Read a fixed source allowlist from the running image. No environment reads,
  // process signalling, config mutation, order calls, or arbitrary command inputs.
  const source='const fs=require("node:fs"),crypto=require("node:crypto");const files=["server.mjs","futures-mode-evidence.mjs","v17-stop-commands.mjs","v17-shadow-worker.mjs","v17-shadow-host.mjs","leader-exit-r3.mjs","leader-exit-r4.mjs"];console.log(JSON.stringify(files.map(name=>{const path="/app/"+name;if(!fs.existsSync(path))return{name,missing:true};const bytes=fs.readFileSync(path);return{name,sha256:crypto.createHash("sha256").update(bytes).digest("hex"),content:bytes.toString("base64")}})))';
  for(const machine of rows.filter(m=>m.state==='started'))await record('fly_source:'+app+':'+machine.id,async()=>{
   const response=await fetch(`https://api.machines.dev/v1/apps/${app}/machines/${machine.id}/exec`,{
    method:'POST',headers:{authorization:'Bearer '+process.env.FLY_API_TOKEN,'content-type':'application/json'},
    body:JSON.stringify({cmd:"node -e '"+source+"'",timeout:10}),signal:AbortSignal.timeout(15000)});
   if(!response.ok)return{ok:false,http:response.status};
   const result=await response.json();
   return result.exit_code===0?{ok:true,utc:new Date().toISOString(),files:JSON.parse(result.stdout)}:
    {ok:false,error:'SOURCE_READ_FAILED'};
  });
 }
 return{ok:true,machines:rows.map(m=>({id:m.id,name:m.name,state:m.state,region:m.region,created_at:m.created_at,updated_at:m.updated_at,image_ref:m.image_ref,config:m.config,guest:m.config?.guest,services:m.config?.services,env:Object.fromEntries(Object.entries(m.config?.env??{}).filter(([k])=>/^(SCHEDULER_ENABLED|EXTERNAL_SCHEDULER_ENABLED|ORDER_WRITER_REQUIRED|AUTO_SCAN_INTERVAL_SECONDS|AUTO_MONITOR_INTERVAL_SECONDS|PORT|PRIMARY_REGION|VERSION)$/.test(k))),events:m.events}))};
});
await record('functions',async()=>{
 const r=await fetch(`https://api.supabase.com/v1/projects/${project}/functions`,{headers:{authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN},signal:AbortSignal.timeout(15000)});return r.ok?{ok:true,rows:await r.json()}:{ok:false,http:r.status};
});
seal();console.log('Encrypted evidence saved; no production changes.');
if(ev.results.readiness?.ok!==true)process.exitCode=2;
