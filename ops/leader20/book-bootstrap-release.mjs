import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const request=JSON.parse(fs.readFileSync('deployment-evidence/top20-book-bootstrap.json','utf8'));
const project='etaajwpernzrcdrifdnw',app='sanbital-doa-capture-20260925',sha=process.env.GITHUB_SHA;
if(process.env.GITHUB_REF!=='refs/heads/main'||!/^[a-f0-9]{40}$/.test(sha??'')||request.policy!=='TOP20_CLOCK_BOOK_BOOTSTRAP_1'||request.validation_orders)throw Error('RELEASE_SCOPE');
const evidence={source_commit:sha,policy:request.policy,validation_orders:0};
const save=()=>fs.writeFileSync('release-evidence/book-bootstrap.json',JSON.stringify(evidence,null,2));
const run=(cmd,args,options={})=>{const r=spawnSync(cmd,args,{encoding:'utf8',maxBuffer:8*1024*1024,...options});if(r.status!==0){if(r.stderr)process.stderr.write(r.stderr);throw Error('COMMAND_FAILED:'+cmd);}return r.stdout;};
async function api(path,method='GET',body){const r=await fetch('https://api.supabase.com/v1/projects/'+project+path,{method,headers:{authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('SUPABASE_HTTP_'+r.status);return r.json();}
const query=query=>api('/database/query','POST',{query});
async function machine(path='',method='GET',body,nonce){const r=await fetch(`https://api.machines.dev/v1/apps/${app}/machines`+path,{method,headers:{authorization:'Bearer '+process.env.FLY_API_TOKEN,'content-type':'application/json',...(nonce?{'fly-machine-lease-nonce':nonce}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error('MACHINE_HTTP_'+r.status);const text=await r.text();return text?JSON.parse(text):null;}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const safe=m=>({id:m.id,state:m.state,instance_id:m.instance_id,image:m.image_ref,guest:m.config.guest});
const versions=async()=>{const all=await api('/functions');return Object.fromEntries(Object.keys(request.expected_versions).map(slug=>{const f=(all.functions??all).find(f=>f.slug===slug);if(f?.status!=='ACTIVE'||f.verify_jwt!==false)throw Error('FUNCTION_STATUS');return [slug,f.version];}));};
evidence.functions_before=await versions();if(JSON.stringify(evidence.functions_before)!==JSON.stringify(request.expected_versions))throw Error('FUNCTION_BASELINE');
const baselineProtocol=createHash('sha256').update(run('git',['show',request.baseline_collector_commit+':collectors/doa-capture/PROTOCOL.md'])).digest('hex');
const protocol=createHash('sha256').update(fs.readFileSync('collectors/doa-capture/PROTOCOL.md')).digest('hex');
// Leave enough idle time for the existing 90-second single-writer lease handoff.
for(;;){const phase=Date.now()%600000;if(phase>=120000&&phase<300000)break;await sleep(10000);}
const [baseline]=await query(`select d.protocol_sha256,d.metrics->>'source_commit' collector_commit,extract(epoch from clock_timestamp()-d.heartbeat_at) age_s,
 c.clock_capture_enabled,c.watch_limit,c.generation,(select jsonb_agg(to_jsonb(p) order by provider) from ai_provider_limits p) provider_limits
 from doa_capture.control d cross join leader20_control c where d.id=1 and c.singleton`);
if(baseline.protocol_sha256!==baselineProtocol||baseline.collector_commit!==request.baseline_collector_commit||Number(baseline.age_s)>25||!baseline.clock_capture_enabled||baseline.watch_limit!==20)throw Error('COLLECTOR_BASELINE');
evidence.before=baseline;save();
const list=await machine();if(list.length!==1)throw Error('EXPECTED_ONE_COLLECTOR');
const before=await machine('/'+list[0].id),cfg=before.config;
if(cfg.env?.CAPTURE_ENDPOINT!==`https://${project}.supabase.co/functions/v1/doa-capture-ingest`||cfg.env?.PROTOCOL_SHA256!==baselineProtocol||cfg.services?.length||cfg.mounts?.length||cfg.auto_destroy===true||!String(cfg.image).startsWith(`registry.fly.io/${app}:`))throw Error('COLLECTOR_CONFIG');
evidence.collector_before=safe(before);save();
const image=`registry.fly.io/${app}:${sha}`;run('flyctl',['auth','docker']);run('docker',['push',image],{stdio:'inherit'});
// Re-check phase after upload, before touching the running process.
for(;;){const phase=Date.now()%600000;if(phase>=120000&&phase<300000)break;await sleep(10000);}
const lease=await machine('/'+before.id+'/lease','POST',{description:'bootstrap-'+sha.slice(0,10),ttl:60}),nonce=lease.data?.nonce;
if(!nonce)throw Error('LEASE_MISSING');
try{
 const current=await machine('/'+before.id);if(current.instance_id!==before.instance_id)throw Error('CONCURRENT_COLLECTOR_DEPLOY');
 // Also repair supervision: the machine was created `--restart no --rm`, so any exit destroyed it.
 await machine('/'+before.id,'POST',{current_version:before.instance_id,
  config:{...cfg,image,auto_destroy:false,restart:{policy:'always'},env:{...cfg.env,PROTOCOL_SHA256:protocol}}},nonce);
 const updated=await query(`update doa_capture.control set protocol_sha256='${protocol}' where id=1 and protocol_sha256='${baselineProtocol}' returning id`);
 if(updated.length!==1)throw Error('PROTOCOL_COMPARE_AND_SET');
}finally{await machine('/'+before.id+'/lease','DELETE',undefined,nonce);}
let healthy=false;for(let i=0;i<24;i++){
 await sleep(10000);const [c]=await query(`select protocol_sha256,metrics->>'version' version,metrics->>'source_commit' source_commit,
 metrics->'exchange_weight_limit' exchange_weight_limit,extract(epoch from clock_timestamp()-heartbeat_at) age_s from doa_capture.control where id=1`);
 if(c.protocol_sha256===protocol&&c.version==='DOA-CAPTURE-8-CLOCK-BOOTSTRAP'&&c.source_commit===sha&&Number(c.age_s)<25){evidence.collector_verified=c;healthy=true;break;}
}if(!healthy)throw Error('COLLECTOR_NOT_HEALTHY');
const [after]=await query(`select clock_capture_enabled,watch_limit,generation,(select jsonb_agg(to_jsonb(p) order by provider) from ai_provider_limits p) provider_limits from leader20_control where singleton`);
evidence.after=after;evidence.functions_after=await versions();
if(!after.clock_capture_enabled||after.watch_limit!==20||after.generation!==baseline.generation||JSON.stringify(after.provider_limits)!==JSON.stringify(baseline.provider_limits)||JSON.stringify(evidence.functions_after)!==JSON.stringify(evidence.functions_before))throw Error('UNEXPECTED_TRADING_CHANGE');
evidence.collector_after=safe(await machine('/'+before.id));evidence.verified=true;save();
console.log(JSON.stringify({verified:true,source_commit:sha,collector_only:true,protocol_sha256:protocol}));
