import {writeFileSync} from 'node:fs';
const project='etaajwpernzrcdrifdnw',base='https://'+project+'.supabase.co';
const evidence={source_commit:process.env.GITHUB_SHA,validation_orders:0,fly:[]};
const save=()=>writeFileSync('release-evidence/capacity-runtime.json',JSON.stringify(evidence,null,2));
async function query(query){const r=await fetch('https://api.supabase.com/v1/projects/'+project+'/database/query',{
 method:'POST',headers:{authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN,'content-type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error('DATABASE_HTTP_'+r.status);return r.json();}
// Audit only this bot's existing collector/gateway. Never print env, tokens or machine config.
for(const app of [...new Set(['sanbital-doa-capture-20260925',process.env.FLY_BINANCE_APP_NAME].filter(Boolean))]){
 const r=await fetch('https://api.machines.dev/v1/apps/'+app+'/machines',{headers:{authorization:'Bearer '+process.env.FLY_API_TOKEN},signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error('FLY_AUDIT_'+r.status);
 const machines=await r.json();evidence.fly.push({app,machines:machines.map(m=>({id:m.id,state:m.state,region:m.region,
  guest:m.config?.guest,mount_count:m.config?.mounts?.length??0,service_count:m.config?.services?.length??0}))});save();
 if(app==='sanbital-doa-capture-20260925'&&(machines.length!==1||machines[0].config?.guest?.cpus!==1||machines[0].config?.guest?.memory_mb!==256))throw Error('COLLECTOR_NOT_MINIMUM_SINGLE_INSTANCE');
}
evidence.control=(await query("select daily_cap_usd,monthly_cap_usd,max_calls_per_day,approval_ref,budget_effective_day,daily_spend_offset,daily_call_offset from public.gpt_final_review_control where singleton"))[0];
if(Number(evidence.control.monthly_cap_usd)!==40||Number(evidence.control.daily_cap_usd)!==1.25)throw Error('MONTHLY_LIMIT_NOT_APPLIED');save();
const token=(await query("select token from public.edge_internal_tokens where name='doa-capture'"))[0]?.token;
if(!token)throw Error('CAPTURE_AUTH_MISSING');
for(let i=0;i<20;i++){
 const r=await fetch(base+'/functions/v1/doa-capture-ingest',{method:'POST',headers:{'content-type':'application/json','x-doa-capture-token':token},body:'{"action":"archive-maintenance"}',signal:AbortSignal.timeout(90000)});
 const result=await r.json();evidence.archive_response={status:r.status,...result};save();
 if(!r.ok)throw Error('ARCHIVE_MAINTENANCE_FAILED');
 if(result.state==='VERIFIED')break;
 if(!['IDLE','BUSY'].includes(result.state))throw Error('ARCHIVE_NOT_READY:'+result.state);
 await new Promise(r=>setTimeout(r,15000));
}
evidence.archive=(await query("select (select public from storage.buckets where id='leader20-capture-private') public_bucket,(select count(*) from public.leader20_archive_objects where state='VERIFIED') verified_objects,(select sum(bytes) from public.leader20_archive_objects where state<>'DELETED') cold_bytes,(select count(*) from public.leader20_micro_archive) hot_rows,(select pg_total_relation_size('public.leader20_micro_archive')) hot_bytes,(select object_path from public.leader20_archive_objects where state='VERIFIED' order by verified_at desc limit 1) sample_path"))[0];
if(evidence.archive.public_bucket!==false||Number(evidence.archive.verified_objects)<1)throw Error('PRIVATE_ARCHIVE_NOT_VERIFIED');
const publicRead=await fetch(base+'/storage/v1/object/public/leader20-capture-private/'+evidence.archive.sample_path,{signal:AbortSignal.timeout(10000)});
evidence.archive.anonymous_http_status=publicRead.status;delete evidence.archive.sample_path;save();
if(publicRead.ok)throw Error('ARCHIVE_PUBLIC_READ');
evidence.capture=(await query("select metrics-'live_contexts' metrics,extract(epoch from now()-heartbeat_at) heartbeat_age from doa_capture.control where id=1"))[0];
evidence.strategy=(await query("select active_strategy,watch_limit,archive_max_bytes,cold_archive_max_bytes,cold_archive_state,archive_last_verified_at from public.leader20_control where singleton"))[0];
evidence.verified=true;save();console.log(JSON.stringify(evidence));
