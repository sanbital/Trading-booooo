// Read-only production evidence for the 2026-09-29 collector recovery, plus an explicit
// opt-in recovery action. Runs on a GitHub runner because that is the only place that can
// reach BOTH api.machines.dev and the Supabase paths at once.
//
// MODE=observe  (default) : reads only. Never starts, restarts or reconfigures anything.
// MODE=recover            : may start a stopped machine or restart a started-but-silent one.
//
// It never touches trading state: no capacity, no admission, no order, no capture policy,
// no TTL, no deadline, no sizing. Recovery is limited to the collector process lifecycle.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

const project='etaajwpernzrcdrifdnw';
const app='sanbital-doa-capture-20260925';
const MODE=(process.env.MODE??'observe').toLowerCase();
const STALE_MS=Number(process.env.WATCHDOG_STALE_MS??180000);
const token=process.env.FLY_API_TOKEN,access=process.env.SUPABASE_ACCESS_TOKEN;
const dbUrl=process.env.SUPABASE_DB_URL??'';
if(!['observe','recover'].includes(MODE))throw Error('MODE_INVALID');
if(!token)throw Error('FLY_API_TOKEN_MISSING');

const ev={mode:MODE,checked_at:new Date().toISOString(),findings:{},actions:[],errors:[]};
const note=(k,v)=>{ev.findings[k]=v;};
const err=m=>{ev.errors.push(m);};

// ---------------------------------------------------------------- protocol hash (repo side)
const protocolSha=createHash('sha256')
  .update(readFileSync('collectors/doa-capture/PROTOCOL.md')).digest('hex');
note('protocol_sha256_repo',protocolSha);

// ---------------------------------------------------------------- Supabase, three paths
const FIELD_SEP='\t';
function sqlDirect(sql){
  if(!dbUrl)return {ok:false,reason:'NO_DB_URL_CONFIGURED'};
  const r=spawnSync('psql',[dbUrl,'-At','-F',FIELD_SEP,'--no-psqlrc','-v','ON_ERROR_STOP=1','-c',sql],
    {encoding:'utf8',timeout:30000});
  if(r.error?.code==='ENOENT')return {ok:false,reason:'PSQL_NOT_INSTALLED'};
  if(r.status!==0){
    const e=String(r.stderr??'');            // never recorded: it can echo the DSN
    return {ok:false,reason:r.signal==='SIGTERM'?'DB_CONNECT_TIMEOUT'
      :/password|authentication|role .* does not exist/i.test(e)?'DB_AUTH_REJECTED'
      :/could not translate host|Name or service not known/i.test(e)?'DB_DNS_UNRESOLVED'
      :/could not connect|Connection refused|timeout expired|server closed/i.test(e)?'DB_UNREACHABLE'
      :'DB_QUERY_FAILED'};
  }
  return {ok:true,rows:r.stdout.trim().split('\n').filter(Boolean).map(l=>l.split(FIELD_SEP))};
}
async function sqlManaged(sql,attempts=2){
  let last;
  for(let i=1;i<=attempts;i++){
    try{
      const r=await fetch(`https://api.supabase.com/v1/projects/${project}/database/query`,
        {method:'POST',headers:{Authorization:'Bearer '+access,'Content-Type':'application/json'},
         body:JSON.stringify({query:sql}),signal:AbortSignal.timeout(20000)});
      if(r.ok)return {ok:true,rows:await r.json()};
      last='SUPABASE_QUERY_'+r.status;
    }catch(e){last='SUPABASE_QUERY_'+(e.name==='TimeoutError'?'TIMEOUT':'NETWORK');}
    if(i<attempts)await new Promise(r=>setTimeout(r,4000));
  }
  return {ok:false,reason:last};
}
// A 401 here proves the FUNCTION GATEWAY answered. It says nothing about the database behind it.
async function functionGateway(){
  try{
    const r=await fetch(`https://${project}.supabase.co/functions/v1/doa-capture-ingest`,
      {method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});
    return {reachable:true,status:r.status,proves:'FUNCTION_GATEWAY_ONLY'};
  }catch(e){return {reachable:false,error:e.name};}
}
// PostgREST answering at all is independent evidence that Postgres is serving that path.
async function postgrestReachable(){
  try{
    const r=await fetch(`https://${project}.supabase.co/rest/v1/`,{signal:AbortSignal.timeout(15000)});
    return {reachable:true,status:r.status};
  }catch(e){return {reachable:false,error:e.name};}
}

note('function_gateway',await functionGateway());
note('postgrest',await postgrestReachable());

const CONTROL_SQL=`select enabled,protocol_sha256,
 extract(epoch from (clock_timestamp()-heartbeat_at))*1000 heartbeat_age_ms,
 to_char(heartbeat_at,'YYYY-MM-DD"T"HH24:MI:SSOF') heartbeat_at,
 ends_at<=clock_timestamp() window_ended,
 (select count(distinct symbol) from doa_capture.live_micro
   where kind='micro' and at>clock_timestamp()-interval '3 minutes') streaming_3m
 from doa_capture.control where id=1`;

let control=null;
const d=sqlDirect(CONTROL_SQL);
note('sql_direct',d.ok?{ok:true}:{ok:false,reason:d.reason});
if(d.ok&&d.rows.length===1){
  const [enabled,sha,age,at,ended,streaming]=d.rows[0];
  control={source:'DIRECT_POSTGRES',enabled:enabled==='t',protocol_sha256:sha,
    heartbeat_age_ms:Math.round(Number(age)),heartbeat_at:at,window_ended:ended==='t',
    streaming_3m:Number(streaming)};
}else{
  const m=await sqlManaged(CONTROL_SQL);
  note('sql_managed',m.ok?{ok:true}:{ok:false,reason:m.reason});
  if(m.ok&&m.rows?.length){const r=m.rows[0];control={source:'MANAGEMENT_API',...r,
    heartbeat_age_ms:Math.round(Number(r.heartbeat_age_ms))};}
}
note('control',control??{readable:false});
if(!control)err('CONTROL_UNREADABLE_ON_EVERY_SQL_PATH');

// ---------------------------------------------------------------- Fly machine truth
async function machines(path='',method='GET',body){
  const r=await fetch(`https://api.machines.dev/v1/apps/${app}/machines`+path,
    {method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},
     ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});
  const text=await r.text();
  if(!r.ok)throw Error('MACHINE_HTTP_'+r.status+':'+text.slice(0,200));
  return text?JSON.parse(text):null;
}
let machine=null;
try{
  const list=await machines();
  note('machine_count',list.length);
  if(list.length===1){
    machine=await machines('/'+list[0].id);
    // Supervision policy as PRODUCTION actually holds it, not as the repo wishes it were.
    note('machine',{id:machine.id,name:machine.name,state:machine.state,region:machine.region,
      image:machine.config?.image,
      restart:machine.config?.restart??null,
      auto_destroy:machine.config?.auto_destroy??null,
      protocol_sha256_env:machine.config?.env?.PROTOCOL_SHA256??null,
      capture_endpoint:machine.config?.env?.CAPTURE_ENDPOINT??null});
  }else{
    note('machine',{present:false,count:list.length});
    err(list.length===0?'COLLECTOR_MACHINE_ABSENT':'UNEXPECTED_MACHINE_COUNT_'+list.length);
  }
}catch(e){err(String(e.message));}

// ---------------------------------------------------------------- hash agreement
if(machine&&control){
  const dbSha=control.protocol_sha256,flySha=machine.config?.env?.PROTOCOL_SHA256;
  note('protocol_hash_agreement',{repo:protocolSha,db:dbSha,fly:flySha,
    db_matches_fly:dbSha===flySha,
    repo_matches_live:protocolSha===dbSha&&protocolSha===flySha});
}

// ---------------------------------------------------------------- recovery (opt-in only)
if(MODE==='recover'){
  if(!machine){err('CANNOT_RECOVER_WITHOUT_MACHINE');}
  else if(control&&control.enabled===false){ev.actions.push('SKIPPED_COLLECTOR_DISABLED_BY_OPERATOR');}
  else if(control&&control.window_ended===true){ev.actions.push('SKIPPED_CAPTURE_WINDOW_ENDED');}
  else{
    const stale=control?control.heartbeat_age_ms>STALE_MS:null;
    // With no readable control row a STOPPED machine is still unambiguous: a stopped collector
    // is never the intended running state, and the control row governs whether it captures
    // (a started worker whose control says disabled now idles rather than trading).
    if(machine.state!=='started'){
      ev.actions.push('START');
      try{await machines('/'+machine.id+'/start','POST');}catch(e){err('START_FAILED:'+e.message);}
    }else if(stale===true){
      ev.actions.push('RESTART');
      try{await machines('/'+machine.id+'/restart','POST');}catch(e){err('RESTART_FAILED:'+e.message);}
    }else if(stale===null){
      ev.actions.push('NO_ACTION_STARTED_BUT_HEARTBEAT_UNREADABLE');
    }else{
      ev.actions.push('NO_ACTION_HEARTBEAT_HEALTHY');
    }
    if(ev.actions.some(a=>a==='START'||a==='RESTART')){
      await new Promise(r=>setTimeout(r,20000));
      const after=await machines('/'+machine.id).catch(()=>null);
      note('machine_after',after?{id:after.id,state:after.state}:{readable:false});
    }
  }
}

console.log(JSON.stringify(ev,null,2));
// Observation must not fail the job on a production finding; only a broken probe should.
// Recovery must fail loudly if it could not do what it was asked to do.
const fatal=ev.errors.filter(e=>!/^COLLECTOR_MACHINE_ABSENT$|^CONTROL_UNREADABLE_ON_EVERY_SQL_PATH$/.test(e));
if(fatal.length||(MODE==='recover'&&ev.errors.length))process.exit(1);
