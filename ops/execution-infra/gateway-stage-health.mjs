import {mkdirSync,writeFileSync} from 'node:fs';
const app=process.env.WRITER_STAGE_APP;
if(!['trading-booooo','trading-booooo-sanbital-gateway'].includes(app))throw Error('GATEWAY_HEALTH_TARGET_GUARD');
const r=await fetch(`https://${app}.fly.dev/health`,{signal:AbortSignal.timeout(10000)});
if(!r.ok)throw Error('GATEWAY_STAGED_HEALTH_UNAVAILABLE');const h=await r.json(),scheduler=app==='trading-booooo-sanbital-gateway';
if(h.build!=='2026-10-02-account-writer-fence-1'||h.order_writer?.required!==false||h.scheduler_enabled!==scheduler)throw Error('GATEWAY_STAGE_CONTRACT_MISMATCH');
const evidence={utc:new Date().toISOString(),commit:process.env.GITHUB_SHA,app,build:h.build,version:h.version,ops_patch:h.ops_patch,order_writer:h.order_writer,scheduler_enabled:h.scheduler_enabled,intervals:h.intervals};
mkdirSync('infra-evidence',{recursive:true});writeFileSync(`infra-evidence/writer-stage-${app}-health.json`,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
