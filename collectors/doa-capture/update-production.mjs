/** Update the existing public-data worker only. Never print config values or trading credentials. */
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const app='sanbital-doa-capture-20260925',ref='refs/heads/codex/production-gpt-arbitration-20260926';
if(process.env.GITHUB_REF!==ref)throw Error('WRONG_RELEASE_REF');
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
if(cfg.env?.CAPTURE_ENDPOINT!==endpoint||cfg.env?.PROTOCOL_SHA256!==protocol||cfg.services?.length||cfg.mounts?.length||
 !String(cfg.image).startsWith('registry.fly.io/'+app+':')||cfg.guest?.memory_mb!==256||cfg.guest?.cpus!==1)throw Error('UNEXPECTED_CAPTURE_CONFIG');
const evidence={source_commit:process.env.GITHUB_SHA,protocol_sha256:protocol,before:safe(before)};
writeFileSync('capture-release.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify({before:evidence.before}));
const auth=spawnSync('flyctl',['auth','docker'],{encoding:'utf8'});if(auth.status!==0)throw Error('REGISTRY_AUTH_FAILED');
const push=spawnSync('docker',['push',image],{stdio:'inherit'});if(push.status!==0)throw Error('IMAGE_PUSH_FAILED');
const lease=await machine('/'+before.id+'/lease','POST',{description:'capture-'+process.env.GITHUB_SHA.slice(0,12),ttl:60});
const nonce=lease.data?.nonce;if(!nonce)throw Error('MACHINE_LEASE_MISSING');
let activeId=before.id,replaced=false;
try{
 const current=await machine('/'+before.id);if(current.instance_id!==before.instance_id)throw Error('CONCURRENT_CAPTURE_DEPLOYMENT');
 // Preserve resources, environment, secret references, network, and all other current config.
 const config={...cfg,image,auto_destroy:false,restart:{policy:'on-failure',max_retries:10}};
 if(cfg.auto_destroy===true){
   // Fly refuses updates to --rm Machines. Start a persistent successor with the same
   // app secrets/config; the DB lease prevents it collecting until the old worker stops.
   const next=await machine('','POST',{name:'capture-continuous',region:before.region,config});
   activeId=next.id;evidence.successor=safe(next);writeFileSync('capture-release.json',JSON.stringify(evidence,null,2));
   await machine('/'+before.id+'/stop','POST',{signal:'SIGTERM',timeout:'10s'},nonce);replaced=true;
 }else await machine('/'+before.id,'POST',{current_version:before.instance_id,config},nonce);
}finally{try{await machine('/'+before.id+'/lease','DELETE',undefined,nonce);}catch(e){if(!replaced||!String(e.message).includes('404'))throw e;}}
evidence.after=safe(await machine('/'+activeId));
writeFileSync('capture-release.json',JSON.stringify(evidence,null,2));
let verified=false;
for(let i=0;i<40;i++){
 await new Promise(r=>setTimeout(r,15000));
 const state=(await query(`select metrics->>'version' version,extract(epoch from clock_timestamp()-heartbeat_at) age_s,
 metrics->>'watched' watched,metrics->>'queue' queue from doa_capture.control where id=1`))[0];
 const captures=await query(`select s.symbol,c->>'status' status,c->>'reason' reason,c->>'buckets' buckets,jsonb_array_length(c->'trajectory') points
 from (values('QUSDT'),('SPELLUSDT'),('JELLYJELLYUSDT')) s(symbol)
 cross join lateral (select public.doa_gpt_capture_context(s.symbol,clock_timestamp()) c) x`);
 console.log(JSON.stringify({state,captures}));evidence.validation={state,captures};
 if(state.version==='DOA-CAPTURE-3-CONTINUOUS'&&Number(state.age_s)<25&&captures.every(x=>x.status==='AVAILABLE'&&Number(x.buckets)===12&&x.points===12)){
   verified=true;break;
 }
}
writeFileSync('capture-release.json',JSON.stringify(evidence,null,2));
if(!verified)throw Error('CAPTURE_LIVE_VALIDATION_INCOMPLETE');
