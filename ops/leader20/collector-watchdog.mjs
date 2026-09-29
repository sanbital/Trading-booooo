// Third layer of collector survival (2026-09-29). Runs OUTSIDE both the worker and Fly.
//
// Layer 1 keeps the worker alive through transport failures; layer 2 makes Fly restart it if the
// process dies. Neither covers the case that actually happened: the machine gone, or wedged in a
// state where it is "running" but no longer streaming. This job watches the one fact that cannot
// lie -- the heartbeat the collector writes on every ingest -- and forces recovery.
//
// It never changes trading state: no capacity, no admission, no order, no capture policy. It only
// starts or restarts the collector machine, and reports what it saw.
import {spawnSync} from 'node:child_process';
const project='etaajwpernzrcdrifdnw';
const app='sanbital-doa-capture-20260925';
const STALE_MS=Number(process.env.WATCHDOG_STALE_MS??180000);
const token=process.env.FLY_API_TOKEN,access=process.env.SUPABASE_ACCESS_TOKEN;
const dbUrl=process.env.SUPABASE_DB_URL??'';
if(!token||!access)throw Error('WATCHDOG_CREDENTIALS_MISSING');
if(!(STALE_MS>=120000))throw Error('WATCHDOG_STALE_MS_TOO_TIGHT');

const out={checked_at:new Date().toISOString(),stale_threshold_ms:STALE_MS,action:'NONE'};
const fail=m=>{out.error=m;console.log(JSON.stringify(out,null,2));process.exit(1);};

// A watchdog that can only see through one API is blind exactly when that API is the thing
// failing. On 2026-09-29 the management endpoint returned HTTP 544 for over an hour while the
// project's own runtime answered normally, so the heartbeat was unreadable and the collector
// stayed down. The direct Postgres connection is an independent path; either one answering is
// enough to judge, and neither is trusted to be the only one.
const FIELD_SEP='\t';
// Why the direct path failed matters: a missing secret is an operator fix, an unreachable
// database is an outage. Never record psql's raw stderr -- it can echo the connection string.
function queryDirect(sql){
 if(!dbUrl){out.direct_probe='NO_DB_URL_CONFIGURED';return null;}
 const r=spawnSync('psql',[dbUrl,'-At','-F',FIELD_SEP,'--no-psqlrc','-v','ON_ERROR_STOP=1','-c',sql],
  {encoding:'utf8',timeout:30000});
 if(r.error?.code==='ENOENT'){out.direct_probe='PSQL_NOT_INSTALLED';return null;}
 if(r.status!==0){
  const e=String(r.stderr??'');
  out.direct_probe=r.signal==='SIGTERM'?'DB_CONNECT_TIMEOUT'
   :/password|authentication/i.test(e)?'DB_AUTH_REJECTED'
   :/could not translate host|Name or service not known/i.test(e)?'DB_DNS_UNRESOLVED'
   :/could not connect|Connection refused|timeout expired|server closed/i.test(e)?'DB_UNREACHABLE'
   :'DB_QUERY_FAILED';
  return null;
 }
 out.direct_probe='OK';
 return r.stdout.trim().split('\n').filter(Boolean).map(line=>line.split(FIELD_SEP));
}
async function queryManaged(sql,attempts=3){
 let last;
 for(let i=1;i<=attempts;i++){
  try{
   const r=await fetch(`https://api.supabase.com/v1/projects/${project}/database/query`,
    {method:'POST',headers:{Authorization:'Bearer '+access,'Content-Type':'application/json'},
     body:JSON.stringify({query:sql}),signal:AbortSignal.timeout(20000)});
   if(r.ok)return r.json();
   last='SUPABASE_QUERY_'+r.status;
  }catch(e){last='SUPABASE_QUERY_'+(e.name==='TimeoutError'?'TIMEOUT':'NETWORK');}
  if(i<attempts)await new Promise(r=>setTimeout(r,i*4000));
 }
 out.managed_query_error=last;
 return null;
}
// Is the project's own runtime serving, independent of the management API? Note a 401 only
// proves the function gateway answered -- it does NOT prove the database behind it is serving.
async function runtimeReachable(){
 try{
  const r=await fetch(`https://${project}.supabase.co/functions/v1/doa-capture-ingest`,
   {method:'POST',headers:{'Content-Type':'application/json'},body:'{}',
    signal:AbortSignal.timeout(15000)});
  return {reachable:true,status:r.status,proves:'FUNCTION_GATEWAY_ONLY'};
 }catch(e){return {reachable:false,status:null,error:e.name};}
}
async function machines(path='',method='GET',body){
 const r=await fetch(`https://api.machines.dev/v1/apps/${app}/machines`+path,
  {method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},
   ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});
 if(!r.ok)throw Error('MACHINE_HTTP_'+r.status);
 return r.status===200?r.json():{};
}

out.runtime=await runtimeReachable();
// The control row is the authority on whether capture is supposed to be running at all. A
// deliberately disabled or ended collector is NOT an outage and must never be restarted.
const CONTROL_SQL=`select enabled,
 extract(epoch from (clock_timestamp()-heartbeat_at))*1000 heartbeat_age_ms,
 ends_at<=clock_timestamp() window_ended,
 (select count(distinct symbol) from doa_capture.live_micro
   where kind='micro' and at>clock_timestamp()-interval '90 seconds') streaming
 from doa_capture.control where id=1`;
let c=null;
const direct=queryDirect(CONTROL_SQL);
if(direct?.length===1){
 out.control_source='DIRECT_POSTGRES';
 const [enabled,age,ended,streaming]=direct[0];
 c={enabled:enabled==='t',heartbeat_age_ms:Number(age),window_ended:ended==='t',streaming:Number(streaming)};
}else{
 const rows=await queryManaged(CONTROL_SQL);
 if(rows?.length){out.control_source='MANAGEMENT_API';c=rows[0];}
}
if(!c)fail(out.managed_query_error??'CONTROL_UNREADABLE_ON_EVERY_PATH');
out.control={enabled:c.enabled,heartbeat_age_ms:Math.round(Number(c.heartbeat_age_ms)),
 window_ended:c.window_ended,streaming_symbols:Number(c.streaming)};

if(!c.enabled){out.action='NONE';out.reason='COLLECTOR_DISABLED_BY_OPERATOR';}
else if(c.window_ended){out.action='NONE';out.reason='CAPTURE_WINDOW_ENDED';}
else if(!(Number(c.heartbeat_age_ms)>STALE_MS)){out.action='NONE';out.reason='HEARTBEAT_HEALTHY';}
else{
 out.reason='HEARTBEAT_STALE';
 const list=await machines().catch(e=>fail(String(e.message)));
 out.machines=list.map(m=>({id:m.id,state:m.state,restart:m.config?.restart??null}));
 if(list.length!==1)fail('EXPECTED_ONE_COLLECTOR_FOUND_'+list.length);
 const m=list[0];
 // Started but not streaming is the wedged case: replace the process, do not just poke it.
 out.action=m.state==='started'?'RESTART':'START';
 await machines(`/${m.id}/${m.state==='started'?'restart':'start'}`,'POST').catch(e=>fail(String(e.message)));
 // Recovery is only real once the heartbeat moves again, read on whichever path answers.
 const AGE_SQL=`select extract(epoch from (clock_timestamp()-heartbeat_at))*1000 age
   from doa_capture.control where id=1`;
 for(let i=0;i<20;i++){
  await new Promise(r=>setTimeout(r,15000));
  const d=queryDirect(AGE_SQL);
  let age=d?.length?Math.round(Number(d[0][0])):null;
  if(age===null){const [v]=(await queryManaged(AGE_SQL,1))??[null];age=v?Math.round(Number(v.age)):null;}
  if(Number.isFinite(age)&&age<60000){out.recovered=true;out.heartbeat_age_after_ms=age;break;}
 }
 if(!out.recovered)fail('COLLECTOR_DID_NOT_RESUME');
}
console.log(JSON.stringify(out,null,2));
