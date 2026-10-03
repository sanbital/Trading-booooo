import {mkdirSync,writeFileSync} from 'node:fs';
import {PROJECT,readPlatform} from './platform-health-read.mjs';
if(process.env.GITHUB_REPOSITORY!=='sanbital/Trading-booooo'||process.env.GITHUB_REF!=='refs/heads/main'||process.env.EXPECTED_COMMIT!==process.env.GITHUB_SHA||!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA??''))throw Error('PLATFORM_EXACT_MAIN_REQUIRED');
const report={version:'DETERMINISTIC_PLATFORM_READ_ONLY_1',utc:new Date().toISOString(),source_commit:process.env.GITHUB_SHA,mutations:0};
report.platform=await readPlatform({token:process.env.SUPABASE_ACCESS_TOKEN});
// Group/count only: no query text, user identities, connection strings or raw errors.
const query=`select jsonb_build_object('utc',now(),'postmaster',pg_postmaster_start_time(),
 'settings',(select jsonb_agg(jsonb_build_object('name',name,'setting',setting,'unit',unit)) from pg_settings where name in ('max_connections','max_worker_processes','max_parallel_workers','shared_buffers','work_mem','maintenance_work_mem','statement_timeout','cron.use_background_workers','cron.max_running_jobs')),
 'activity',(select jsonb_agg(to_jsonb(a)) from (select backend_type,state,wait_event_type,wait_event,count(*) connections,max(extract(epoch from now()-query_start)) max_query_age_s from pg_stat_activity group by 1,2,3,4)a),
 'database',(select jsonb_build_object('numbackends',numbackends,'temp_bytes',temp_bytes,'deadlocks',deadlocks,'stats_reset',stats_reset,'xact_commit',xact_commit,'xact_rollback',xact_rollback,'blks_read',blks_read,'blks_hit',blks_hit) from pg_stat_database where datname=current_database())) evidence`;
const start=Date.now();try{
 const r=await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`,{method:'POST',headers:{authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN,'content-type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(15000)});
 if(!r.ok)report.database={ok:false,http:r.status,ms:Date.now()-start};
 else {const rows=await r.json();if(!Array.isArray(rows)||rows.length!==1||!rows[0].evidence)throw Error('RESULT_INVALID');report.database={ok:true,ms:Date.now()-start,value:rows[0].evidence};}
}catch(e){report.database={ok:false,error:e.name==='TimeoutError'?'TIMEOUT':'REQUEST_FAILED',ms:Date.now()-start};}
mkdirSync('infra-evidence',{recursive:true});writeFileSync('infra-evidence/deterministic-platform-health.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
if(!report.database.ok||!report.platform.health.ok||!report.platform.metrics.ok)process.exitCode=2;
