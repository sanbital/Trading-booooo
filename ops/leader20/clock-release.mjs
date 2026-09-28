/** User-authorized schedule change; no validation order and no account/risk/budget change. */
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const request=JSON.parse(fs.readFileSync('deployment-evidence/top20-clock-release.json','utf8'));
const project='etaajwpernzrcdrifdnw',app='sanbital-doa-capture-20260925',sha=process.env.GITHUB_SHA;
if(process.env.GITHUB_REF!=='refs/heads/main'||!/^[a-f0-9]{40}$/.test(sha??'')||request.policy!=='TOP20_CLOCK_CAPTURE_1'||request.change_provider_caps||request.validation_orders)throw Error('RELEASE_SCOPE');
const image=`registry.fly.io/${app}:${sha}`,evidence={source_commit:sha,policy:request.policy,test_orders:0};
const save=()=>fs.writeFileSync('release-evidence/clock-release.json',JSON.stringify(evidence,null,2));
const run=(cmd,args,options={})=>{const r=spawnSync(cmd,args,{encoding:'utf8',maxBuffer:8*1024*1024,...options});if(r.status!==0){if(r.stderr)process.stderr.write(r.stderr);throw Error('COMMAND_FAILED:'+cmd+':'+args[0]);}return r.stdout;};
async function query(query){const r=await fetch(`https://api.supabase.com/v1/projects/${project}/database/query`,{method:'POST',headers:{authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN,'content-type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('DATABASE_HTTP_'+r.status+':'+(await r.text()).slice(0,500));return r.json();}
async function machine(path='',method='GET',body,nonce){const r=await fetch(`https://api.machines.dev/v1/apps/${app}/machines`+path,{method,headers:{authorization:'Bearer '+process.env.FLY_API_TOKEN,'content-type':'application/json',...(nonce?{'fly-machine-lease-nonce':nonce}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error('MACHINE_HTTP_'+r.status);return r.json();}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const safe=m=>({id:m.id,state:m.state,instance_id:m.instance_id,image:m.image_ref,guest:m.config.guest});
run('git',['merge-base','--is-ancestor',request.baseline_main,'HEAD']);
run('supabase',['functions','deploy','--help']);run('supabase',['functions','download','--help']);
const listed=JSON.parse(run('supabase',['functions','list','--project-ref',project,'--output','json']));
for(const [slug,version] of Object.entries(request.expected_versions)){
 const f=(listed.functions??listed).find(f=>f.slug===slug);if(f?.version!==version||f.verify_jwt!==false||f.status!=='ACTIVE')throw Error('CONCURRENT_FUNCTION_DEPLOY:'+slug);
}
const baseline=(await query(`select c.clock_capture_enabled,c.watch_limit,d.protocol_sha256,d.metrics->>'source_commit' collector_commit,
 (select jsonb_agg(to_jsonb(a) order by provider) from ai_provider_limits a) provider_limits
 from leader20_control c cross join doa_capture.control d where c.singleton and d.id=1`))[0];
const protocol=createHash('sha256').update(fs.readFileSync('collectors/doa-capture/PROTOCOL.md')).digest('hex');
if(baseline.clock_capture_enabled||baseline.watch_limit!==10||baseline.collector_commit!==request.baseline_collector_commit||baseline.protocol_sha256!==protocol)throw Error('BASELINE_CHANGED');
evidence.before=baseline;save();
const baselineDirectory=process.env.RUNNER_TEMP+'/clock-baseline';
run('git',['worktree','add','--detach',baselineDirectory,request.baseline_main]);
for(const slug of Object.keys(request.expected_versions)){
 const out=`release-evidence/before-${slug}`;fs.mkdirSync(out,{recursive:true});
 run('supabase',['functions','download',slug,'--project-ref',project,'--use-api','--workdir',out]);
 run('node',['ops/gpt-final-review/verify-bundle-parity.mjs',out,baselineDirectory,slug]);
}
const list=await machine();if(list.length!==1)throw Error('EXPECTED_ONE_COLLECTOR');
const before=await machine('/'+list[0].id),cfg=before.config;
if(cfg.env?.CAPTURE_ENDPOINT!==`https://${project}.supabase.co/functions/v1/doa-capture-ingest`||cfg.env?.PROTOCOL_SHA256!==protocol||cfg.services?.length||cfg.mounts?.length||cfg.auto_destroy===true||!String(cfg.image).startsWith(`registry.fly.io/${app}:`))throw Error('COLLECTOR_CONFIG');
evidence.collector_before=safe(before);save();
run('flyctl',['auth','docker']);run('docker',['push',image],{stdio:'inherit'});
const lease=await machine('/'+before.id+'/lease','POST',{description:'clock-'+sha.slice(0,12),ttl:60}),nonce=lease.data?.nonce;
if(!nonce)throw Error('MACHINE_LEASE_MISSING');
try{const current=await machine('/'+before.id);if(current.instance_id!==before.instance_id)throw Error('CONCURRENT_COLLECTOR_DEPLOY');
 await machine('/'+before.id,'POST',{current_version:before.instance_id,config:{...cfg,image}},nonce);
}finally{await machine('/'+before.id+'/lease','DELETE',undefined,nonce);}
let healthy=false;
for(let i=0;i<24;i++){
 await sleep(10000);
 const [c]=await query(`select metrics->>'version' version,metrics->>'source_commit' source_commit,extract(epoch from clock_timestamp()-heartbeat_at) age_s from doa_capture.control where id=1`);
 if(c.version==='DOA-CAPTURE-7-CLOCK-TOP20'&&c.source_commit===sha&&Number(c.age_s)<25){healthy=true;evidence.collector_verified=c;break;}
}
if(!healthy)throw Error('COLLECTOR_HEARTBEAT_NOT_VERIFIED');save();
for(const slug of Object.keys(request.expected_versions)){
 run('supabase',['functions','deploy',slug,'--project-ref',project,'--no-verify-jwt','--use-api'],{stdio:'inherit'});
 const out=`release-evidence/after-${slug}`;fs.mkdirSync(out,{recursive:true});
 run('supabase',['functions','download',slug,'--project-ref',project,'--use-api','--workdir',out]);
 evidence[slug]=JSON.parse(run('node',['ops/gpt-final-review/verify-bundle-parity.mjs',out,'.',slug]));save();
}
// An in-flight entry must settle before changing strategic generation.
let settled=false;for(let i=0;i<30;i++){
 const [c]=await query(`select count(*)::int pending from public.v11_long_regime_orders where intent='OPEN_LONG'
  and state in ('PLANNED','DISPATCHED','RECONCILIATION_PENDING','RECONCILIATION_FAILED') and response_payload->>'v18ExposureFinal' is distinct from 'true'`);
 if(c.pending===0){settled=true;break;}await sleep(10000);
}if(!settled)throw Error('ENTRY_SETTLEMENT_PENDING');
const activate=fs.readFileSync('ops/leader20/clock-activate.sql','utf8');
evidence.activation=await query(activate);save();
const [after]=await query(`select c.clock_capture_enabled,c.watch_limit,c.generation,
 (select jsonb_agg(to_jsonb(a) order by provider) from ai_provider_limits a) provider_limits,
 (select schedule from cron.job where jobname='leader20-observer-tick') schedule
 from leader20_control c where singleton`);
if(!after.clock_capture_enabled||after.watch_limit!==20||JSON.stringify(after.provider_limits)!==JSON.stringify(baseline.provider_limits)||after.schedule!=='10 seconds')throw Error('ACTIVATION_PARITY');
evidence.after=after;evidence.collector_after=safe(await machine('/'+before.id));save();
console.log(JSON.stringify({activated:true,source_commit:sha,watch_limit:20,capture_seconds:120,slot_seconds:600,provider_limits_changed:false}));
