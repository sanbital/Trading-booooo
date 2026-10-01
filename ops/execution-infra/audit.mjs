// Read-only. Raw trading state and rollback SQL are encrypted before upload.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomBytes,createCipheriv,publicEncrypt,createHash,createHmac} from 'node:crypto';
const project='etaajwpernzrcdrifdnw';
const ev={version:'EXECUTION_INFRA_AUDIT_1',commit:process.env.GITHUB_SHA,utc:new Date().toISOString(),results:{}};
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
 const r=spawnSync('psql',['--no-psqlrc','-At','-v','ON_ERROR_STOP=1','-c',`begin read only; set local statement_timeout='10s'; select coalesce(json_agg(q),'[]'::json) from (${query}) q; commit;`],{env:{...process.env,PGDATABASE:process.env.SUPABASE_DB_URL,PGCONNECT_TIMEOUT:'8'},encoding:'utf8',timeout:15000,maxBuffer:64*1024*1024});
 if(r.status!==0){const e=String(r.stderr??'');return{ok:false,error:r.error?.code==='ENOENT'?'NO_PSQL':r.signal?'TIMEOUT':/password|authentication/i.test(e)?'DB_AUTH_REJECTED':/translate host|Name or service|resolve/i.test(e)?'DNS_FAILURE':/Network is unreachable|No route/i.test(e)?'NETWORK_UNREACHABLE':/Connection refused/i.test(e)?'CONNECTION_REFUSED':/timeout|timed out/i.test(e)?'CONNECTION_TIMEOUT':/not accepting connections|starting up/i.test(e)?'DB_STARTING':'DB_QUERY_FAILED'};}
 try{return{ok:true,rows:JSON.parse(r.stdout.split('\n').find(l=>l.startsWith('['))??'[]')};}catch{return{ok:false,error:'DB_RESULT_INVALID'};}
}
let selectedDbUrl=process.env.SUPABASE_DB_URL;
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
await record('readiness',()=>sql("select now() utc,now() at time zone 'Asia/Seoul' kst,pg_postmaster_start_time() started_at"));
if(ev.results.readiness.ok){
 const queries={
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
 decisions:"select to_jsonb(r) row from public.gpt_final_entry_reviews r where created_at>=now()-interval '7 days' and purpose='PRODUCTION' and decision='BUY'",
 net_queue:"select count(*) queue_depth,min(id) oldest_request_id from net.http_request_queue",
 net_responses:"select status_code,timed_out,error_msg,count(*) from net._http_response where created>=now()-interval '24 hours' group by 1,2,3 order by count(*) desc limit 50",
 stats:"select datname,numbackends,xact_commit,xact_rollback,blks_read,blks_hit,temp_bytes,deadlocks,blk_read_time,blk_write_time,stats_reset from pg_stat_database where datname=current_database()",
 };
 for(const [name,query]of Object.entries(queries))await record(name,()=>sql(query));
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
for(const app of apps)await record('fly:'+app,async()=>{
 const r=await fetch(`https://api.machines.dev/v1/apps/${app}/machines`,{headers:{authorization:'Bearer '+process.env.FLY_API_TOKEN},signal:AbortSignal.timeout(15000)});
 if(!r.ok)return{ok:false,http:r.status};
 const rows=await r.json();return{ok:true,machines:rows.map(m=>({id:m.id,name:m.name,state:m.state,region:m.region,created_at:m.created_at,updated_at:m.updated_at,image_ref:m.image_ref,guest:m.config?.guest,services:m.config?.services,env:Object.fromEntries(Object.entries(m.config?.env??{}).filter(([k])=>/^(SCHEDULER_ENABLED|AUTO_SCAN_INTERVAL_SECONDS|AUTO_MONITOR_INTERVAL_SECONDS|PORT|PRIMARY_REGION|VERSION)$/.test(k))),events:m.events}))};
});
await record('functions',async()=>{
 const r=await fetch(`https://api.supabase.com/v1/projects/${project}/functions`,{headers:{authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN},signal:AbortSignal.timeout(15000)});return r.ok?{ok:true,rows:await r.json()}:{ok:false,http:r.status};
});
seal();console.log('Encrypted evidence saved; no production changes.');
if(ev.results.readiness?.ok!==true)process.exitCode=2;
