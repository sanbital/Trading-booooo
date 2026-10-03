import fs from 'node:fs';
import {assertPausedQuoteRepair,assertQuoteRepairHealth} from './quote-repair-policy.mjs';
import {expectedGatewayCommit} from './gateway-source.mjs';
const stage=process.argv[2],request=JSON.parse(fs.readFileSync('ops/deterministic/release-request.json','utf8'));
if(!['before','after'].includes(stage)||process.env.GITHUB_REPOSITORY!=='sanbital/Trading-booooo'||process.env.GITHUB_REF!=='refs/heads/main')throw Error('QUOTE_REPAIR_EXACT_TARGET');
const r=await fetch('https://api.supabase.com/v1/projects/etaajwpernzrcdrifdnw/database/query',{method:'POST',headers:{authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN,'content-type':'application/json'},body:JSON.stringify({query:"select (select pause_new_entries from trading_settings where id=1) paused,(select count(*) from v11_long_regime_positions where state='OPEN') positions,(select count(*) from v11_long_regime_orders where state in ('PLANNED','DISPATCHED','SUBMITTING','PARTIALLY_FILLED','UNKNOWN','RECONCILIATION_PENDING','RECONCILIATION_FAILED')) unresolved_orders,(select circuit_open from v11_long_regime_runtime where singleton) circuit,(select count(*) from v17_execution_lease where owner is not null and expires_at>clock_timestamp()) writers"}),signal:AbortSignal.timeout(15000)});
if(!r.ok)throw Error('QUOTE_REPAIR_ACCOUNT_UNAVAILABLE');const [s]=await r.json();
assertPausedQuoteRepair(s);
for(const app of ['trading-booooo','trading-booooo-sanbital-gateway']){
 const h=await fetch(`https://${app}.fly.dev/health`,{signal:AbortSignal.timeout(5000)});if(!h.ok)throw Error('QUOTE_REPAIR_HEALTH_UNAVAILABLE');const value=await h.json(),binance=app==='trading-booooo';
 const expected=stage==='after'&&binance?process.env.GITHUB_SHA:expectedGatewayCommit(request,app);
 assertQuoteRepairHealth(value,{app,expectedCommit:expected});
 const summary={stage,utc:new Date().toISOString(),app,source_commit:value.deployment_commit,writer_required:value.order_writer.required,external_scheduler:value.external_scheduler.enabled,entry_paused:s.paused,positions:s.positions,unresolved_orders:s.unresolved_orders};fs.mkdirSync('infra-evidence',{recursive:true});fs.writeFileSync(`infra-evidence/quote-repair-${app}-${stage}.json`,JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
}
