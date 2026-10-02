import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {encryptTimeline} from './platform-sampler.mjs';
const app=process.env.WRITER_STAGE_APP;
if(!['trading-booooo','trading-booooo-sanbital-gateway'].includes(app)||process.env.GITHUB_REPOSITORY!=='sanbital/Trading-booooo'||process.env.GITHUB_REF!=='refs/heads/main')throw Error('GATEWAY_STAGE_TARGET_GUARD');
const r=await fetch(`https://api.machines.dev/v1/apps/${app}/machines`,{headers:{authorization:'Bearer '+process.env.FLY_API_TOKEN},signal:AbortSignal.timeout(10000)});
if(!r.ok)throw Error('GATEWAY_MACHINE_BACKUP_UNAVAILABLE');const machines=await r.json();
if(!Array.isArray(machines)||machines.length!==1||machines[0].config?.guest?.memory_mb!==256||machines[0].config?.guest?.cpus!==1)throw Error('GATEWAY_MACHINE_BASELINE_CHANGED');
const backup={utc:new Date().toISOString(),commit:process.env.GITHUB_SHA,app,machines};mkdirSync('infra-evidence',{recursive:true});
writeFileSync(`infra-evidence/writer-stage-${app}-before.encrypted.json`,JSON.stringify(encryptTimeline(backup,readFileSync('ops/execution-infra/evidence-public.pem'))));
console.log(JSON.stringify({utc:backup.utc,app,backup:'ENCRYPTED',machines:machines.length,computeChanged:false}));

const h=await fetch(`https://${app}.fly.dev/health`,{signal:AbortSignal.timeout(5000)});if(!h.ok)throw Error('GATEWAY_BEFORE_HEALTH_UNAVAILABLE');const health=await h.json();
writeFileSync(`infra-evidence/writer-stage-${app}-flags-before.json`,JSON.stringify({external:health.external_scheduler?.enabled,writer:health.order_writer?.required,scheduler:health.scheduler_enabled}));
