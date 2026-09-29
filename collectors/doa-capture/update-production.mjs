/** Update the existing public-data worker only. Never print config values or trading credentials. */
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {VERSION} from './core.mjs';
const app='sanbital-doa-capture-20260925';
const releaseRefs=new Set([
 'refs/heads/codex/capture-transport-backlog-20260926',
 'refs/heads/claude/production-recovery-etaajwpernzrcdrifdnw-enpb6i',
]);
if(!releaseRefs.has(process.env.GITHUB_REF))throw Error('WRONG_RELEASE_REF');
const protocol=createHash('sha256').update(readFileSync('collectors/doa-capture/PROTOCOL.md')).digest('hex');
const endpoint='https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/doa-capture-ingest';
const image='registry.fly.io/'+app+':'+process.env.GITHUB_SHA;
async function query(sql){const r=await fetch('https://api.supabase.com/v1/projects/etaajwpernzrcdrifdnw/database/query',{
 method:'POST',headers:{authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN,'content-type':'application/json'},body:JSON.stringify({query:sql}),signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw Error('DATABASE_HTTP_'+r.status);return r.json();}
async function machine(path='',method='GET',body,nonce){const r=await fetch('https://api.machines.dev/v1/apps/'+app+'/machines'+path,{
 method,headers:{authorization:'Bearer '+process.env.FLY_API_TOKEN,'content-type':'application/json',...(nonce?{'fly-machine-lease-nonce':nonce}:{})},
 ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});
 if(!r.ok){const e=await r.json().catch(()=>({}));const reason=String(e.error??e.message??e.code??'').slice(0,240);throw Error('MACHINE_HTTP_'+r.status+':'+reason);}return r.json();}
const safe=m=>({id:m.id,state:m.state,region:m.region,instance_id:m.instance_id,image:m.image_ref,
 guest:m.config.guest,restart:m.config.restart,auto_destroy:m.config.auto_destroy,env_keys:Object.keys(m.config.env??{})});
const c=(await query('select enabled,production_enabled,protocol_sha256 from doa_capture.control where id=1'))[0];
if(!c?.enabled||!c.production_enabled||c.protocol_sha256!==protocol)throw Error('CONTINUOUS_CAPTURE_MIGRATION_NOT_READY');
const list=await machine();if(list.length!==1)throw Error('EXPECTED_ONE_EXISTING_CAPTURE_MACHINE');
const before=await machine('/'+list[0].id),cfg=before.config;
const previousProtocol=process.env.PREVIOUS_PROTOCOL_SHA256??protocol;
if(!/^[a-f0-9]{64}$/.test(previousProtocol))throw Error('INVALID_PREVIOUS_PROTOCOL');
const machineProtocol=cfg.env?.PROTOCOL_SHA256;
if(cfg.env?.CAPTURE_ENDPOINT!==endpoint||![protocol,previousProtocol].includes(machineProtocol)||cfg.services?.length||cfg.mounts?.length||
 !String(cfg.image).startsWith('registry.fly.io/'+app+':')||cfg.guest?.cpu_kind!=='shared'||
 !((cfg.guest?.memory_mb===256&&cfg.guest?.cpus===1)||(cfg.guest?.memory_mb===1024&&cfg.guest?.cpus===4)))throw Error('UNEXPECTED_CAPTURE_CONFIG');
const evidence={source_commit:process.env.GITHUB_SHA,protocol_sha256:protocol,before:safe(before)};
writeFileSync('capture-release.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify({before:evidence.before}));
const auth=spawnSync('flyctl',['auth','docker'],{encoding:'utf8'});if(auth.status!==0)throw Error('REGISTRY_AUTH_FAILED');
const push=spawnSync('docker',['push',image],{stdio:'inherit'});if(push.status!==0)throw Error('IMAGE_PUSH_FAILED');
const lease=await machine('/'+before.id+'/lease','POST',{description:'capture-'+process.env.GITHUB_SHA.slice(0,12),ttl:180});
const nonce=lease.data?.nonce;if(!nonce)throw Error('MACHINE_LEASE_MISSING');
let activeId=before.id,replaced=false;
try{
 const current=await machine('/'+before.id);if(current.instance_id!==before.instance_id)throw Error('CONCURRENT_CAPTURE_DEPLOYMENT');
 // Measured >90% CPU steal on shared-1x prevented sustained public stream capture.
 // Resize this existing machine only; preserve secrets, networking and execution config.
 const config={...cfg,image,env:{...(cfg.env??{}),PROTOCOL_SHA256:protocol},guest:{...cfg.guest,cpu_kind:'shared',cpus:4,memory_mb:1024},auto_destroy:false,restart:{policy:'always'}};
 if(cfg.auto_destroy===true)throw Error('EXISTING_PERSISTENT_COLLECTOR_REQUIRED');
 await machine('/'+before.id,'POST',{current_version:before.instance_id,config},nonce);

 // A machine update is a replacement transition. Starting it before that transition
 // has settled returns 412 "machine getting replaced". Wait until the new instance
 // and exact release config are observable before issuing start.
 let started=null,applied=false;
 for(let i=0;i<60;i++){
   await new Promise(r=>setTimeout(r,2000));
   started=await machine('/'+before.id);
   const imageApplied=started.image_ref?.registry==='registry.fly.io' &&
     started.image_ref?.repository===app && started.image_ref?.tag===process.env.GITHUB_SHA;
   const protocolApplied=started.config?.env?.PROTOCOL_SHA256===protocol;
   const restartApplied=started.config?.restart?.policy==='always' && started.config?.restart?.max_retries==null;
   const persistenceApplied=started.config?.auto_destroy===false;
   if(started.instance_id!==before.instance_id&&imageApplied&&protocolApplied&&restartApplied&&persistenceApplied){
     replaced=true;applied=true;break;
   }
 }
 if(!applied)throw Error('MACHINE_REPLACEMENT_NOT_APPLIED');

 if(started.state!=='started'){
   let startAccepted=false;
   for(let i=0;i<30&&!startAccepted;i++){
     try{await machine('/'+before.id+'/start','POST',undefined,nonce);startAccepted=true;}
     catch(e){
       if(!String(e.message).includes('MACHINE_HTTP_412'))throw e;
       await new Promise(r=>setTimeout(r,2000));
     }
   }
   if(!startAccepted)throw Error('MACHINE_START_REPLACEMENT_TIMEOUT');
 }
 for(let i=0;i<30;i++){
   started=await machine('/'+before.id);
   if(started.state==='started')break;
   await new Promise(r=>setTimeout(r,2000));
 }
 if(started.state!=='started')throw Error('MACHINE_NOT_STARTED');
}finally{try{await machine('/'+before.id+'/lease','DELETE',undefined,nonce);}catch(e){if(!replaced||!String(e.message).includes('404'))throw e;}}
evidence.after=safe(await machine('/'+activeId));
writeFileSync('capture-release.json',JSON.stringify(evidence,null,2));
let verified=false,heartbeatSamples=0,candidateCycleSeen=false;
for(let i=0;i<60;i++){
 await new Promise(r=>setTimeout(r,15000));
 const state=(await query(`select metrics->>'version' version,extract(epoch from clock_timestamp()-heartbeat_at) age_s,
 metrics->>'watched' watched,metrics->>'queue' queue from doa_capture.control where id=1`))[0];
 const captures=await query(`with symbols as (
   select distinct symbol
   from doa_capture.live_micro
   where kind='micro'
     and at>clock_timestamp()-interval '155 seconds'
     and payload->'watch_roles' ? 'SCANNER_LEADER'
   order by symbol
   limit 5
 )
 select s.symbol,c->>'status' status,c->>'reason' reason,c->>'buckets' buckets,jsonb_array_length(c->'trajectory') points
 from symbols s
 cross join lateral (select public.doa_gpt_capture_context_v3(s.symbol,clock_timestamp()) c) x`);
 const heartbeatOK=state.version===VERSION&&Number(state.age_s)<25;
 heartbeatSamples=heartbeatOK?heartbeatSamples+1:0;
 if(captures.some(x=>x.status==='AVAILABLE'&&Number(x.buckets)===24&&x.points===24))candidateCycleSeen=true;
 console.log(JSON.stringify({state,captures,heartbeat_samples:heartbeatSamples,candidate_cycle_seen:candidateCycleSeen}));
 evidence.validation={state,captures,heartbeat_samples:heartbeatSamples,candidate_cycle_seen:candidateCycleSeen};
 if(heartbeatSamples>=3&&candidateCycleSeen){verified=true;break;}
}
evidence.after=safe(await machine('/'+activeId));evidence.heartbeat_samples=heartbeatSamples;evidence.candidate_cycle_seen=candidateCycleSeen;
writeFileSync('capture-release.json',JSON.stringify(evidence,null,2));
if(!verified)throw Error('CAPTURE_LIVE_VALIDATION_INCOMPLETE');
