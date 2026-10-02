import {recoverAccountAtCutover} from './cutover-account-recovery.mjs';
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
const operation=process.env.CUTOVER_OPERATION;
if(!['enable_external','disable_external','enable_writer','disable_writer','verify'].includes(operation))throw Error('CUTOVER_OPERATION_GUARD');
const project='etaajwpernzrcdrifdnw',tokyo='trading-booooo-sanbital-gateway';
async function query(sql){const r=await fetch(`https://api.supabase.com/v1/projects/${project}/database/query`,{method:'POST',headers:{authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN,'content-type':'application/json'},body:JSON.stringify({query:sql}),signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('CUTOVER_DB_UNAVAILABLE');return r.json();}
if(operation==='enable_external'){
 let rows=await query(`select c.enabled, c.scheduler_key, i.short_writer_enabled,
  i.recovered_postmaster_at=pg_postmaster_start_time() ready,
  not exists(select 1 from cron.job where active and jobid in (select legacy_cron_jobid from public.trading_scheduler_jobs where scheduler_key=c.scheduler_key and enabled)) old_cron_disabled
  from public.trading_scheduler_control c cross join public.v17_execution_infrastructure_control i where c.scheduler_key='trading-production' and i.singleton`);
 if(rows.length===1&&rows[0].enabled===true&&rows[0].old_cron_disabled===true&&rows[0].short_writer_enabled===true&&rows[0].ready!==true){
  await recoverAccountAtCutover({project,accessToken:process.env.SUPABASE_ACCESS_TOKEN});
  rows[0].ready=(await query("select recovered_postmaster_at=pg_postmaster_start_time() ready from public.v17_execution_infrastructure_control where singleton"))[0]?.ready;
 }
 if(rows.length!==1||rows[0].enabled!==true||rows[0].ready!==true||rows[0].short_writer_enabled!==true||rows[0].old_cron_disabled!==true)throw Error('CUTOVER_READINESS_OR_DUAL_SCHEDULER_GUARD');
}
if(operation==='enable_writer'){
 const rows=await query("select short_writer_enabled from public.v17_execution_infrastructure_control where singleton");
 if(rows[0]?.short_writer_enabled!==true)throw Error('SHORT_WRITER_REQUIRED_BEFORE_GATEWAY_GUARD');
}
const apps=operation.includes('external')?[tokyo]:['trading-booooo',tokyo];
mkdirSync('infra-evidence',{recursive:true});
for(const app of apps){
 const setting={enable_external:'EXTERNAL_SCHEDULER_ENABLED=true',disable_external:'EXTERNAL_SCHEDULER_ENABLED=false',enable_writer:'ORDER_WRITER_REQUIRED=true',disable_writer:'ORDER_WRITER_REQUIRED=false'}[operation];
 if(setting){const r=spawnSync('flyctl',['secrets','set','--app',app,setting],{env:process.env,encoding:'utf8',timeout:180000});if(r.status!==0)throw Error('FLY_FLAG_DEPLOY_FAILED');}
 let health;
 for(let attempt=0;attempt<20;attempt++){
  try{const r=await fetch(`https://${app}.fly.dev/health`,{signal:AbortSignal.timeout(4000)});if(r.ok){health=await r.json();
   const required=operation==='enable_writer'?true:operation==='disable_writer'?false:undefined;
   const external=operation==='enable_external'?true:operation==='disable_external'?false:undefined;
   if(health.build==='2026-10-02-external-clock-1'&&(required===undefined||health.order_writer?.required===required)&&(external===undefined||health.external_scheduler?.enabled===external))break;
   health=null;}}
  catch{} await new Promise(r=>setTimeout(r,2000));
 }
 if(!health)throw Error('FLY_CUTOVER_HEALTH_CONTRACT');
 const evidence={utc:new Date().toISOString(),kst:new Date(Date.now()+9*3600000).toISOString().replace('Z','+09:00'),commit:process.env.GITHUB_SHA,operation,app,build:health.build,version:health.version,order_writer:health.order_writer,scheduler_enabled:health.scheduler_enabled,external_scheduler:health.external_scheduler,intervals:health.intervals};
 writeFileSync(`infra-evidence/scheduler-cutover-${app}-${operation}.json`,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}
