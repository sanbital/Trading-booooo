// Protected exact-main collector image replacement. No key-reveal, SQL mutation,
// authority change, machine exec, gateway/executor deployment or order command.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {VERSION} from '../../collectors/doa-capture/core.mjs';
import {validateMarketSensor} from '../../supabase/functions/_shared/gpt-final-decision/market-sensor.mjs';
import {COLLECTOR_APP,COLLECTOR_BASELINE,assertCollectorRepairState,collectorReplacement} from './collector-repair-policy.mjs';
const sha=process.env.GITHUB_SHA,project='etaajwpernzrcdrifdnw';
if(process.env.GITHUB_REPOSITORY!=='sanbital/Trading-booooo'||process.env.GITHUB_REF!=='refs/heads/main'||sha!==process.env.EXPECTED_COMMIT||!/^[a-f0-9]{40}$/.test(sha??''))throw Error('COLLECTOR_REPAIR_EXACT_MAIN');
const source=JSON.parse(fs.readFileSync('ops/deterministic/release-request.json','utf8')).staged_source_commit;
const protocol=createHash('sha256').update(fs.readFileSync('collectors/doa-capture/PROTOCOL.md')).digest('hex');
const report={version:'DETERMINISTIC_COLLECTOR_INTEGRITY_REPAIR_1',source_commit:sha,baseline_source:COLLECTOR_BASELINE,order_commands:0,db_mutations:0,authority_mutations:0,observations:[],image_update_attempted:false};
function note(stage,value={}){const item={utc:new Date().toISOString(),stage,...value};report.observations.push(item);fs.mkdirSync('infra-evidence',{recursive:true});fs.writeFileSync('infra-evidence/deterministic-collector-repair.json',JSON.stringify(report,null,2));console.log(JSON.stringify(item));}
async function query(query){const r=await fetch(`https://api.supabase.com/v1/projects/${project}/database/query`,{method:'POST',headers:{authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN,'content-type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('COLLECTOR_REPAIR_DB_HTTP_'+r.status);const rows=await r.json();if(!rows[0]?.evidence)throw Error('COLLECTOR_REPAIR_DB_RESULT');return rows[0].evidence;}
const stateSQL=`select jsonb_build_object('utc',clock_timestamp(),'postmaster',pg_postmaster_start_time(),
 'paused',(select pause_new_entries from trading_settings where id=1),
 'enabled',(select enabled from deterministic_control where singleton),'generation',(select generation from deterministic_control where singleton),'source',(select source_commit from deterministic_control where singleton),
 'gpt_off',(select mode='OFF' from gpt_final_review_control where singleton),'batch_off',(select not enabled from leader20_batch_control where singleton),
 'open_positions',(select count(*)::int from v11_long_regime_positions where state='OPEN'),
 'unresolved_orders',(select count(*)::int from v11_long_regime_orders where state in ('PLANNED','DISPATCHED','SUBMITTING','PARTIALLY_FILLED','UNKNOWN','RECONCILIATION_PENDING','RECONCILIATION_FAILED')),
 'incidents',(select count(*)::int from v18_ops_incidents where exchange='binance_futures' and account_scope='futures' and resolved_at is null and status in ('OPEN','VERIFYING')),
 'circuit_open',(select circuit_open from v11_long_regime_runtime where singleton),'protection_health',(select protection_health from v11_long_regime_runtime where singleton),
 'recovery_complete',(select recovery_complete from trading_scheduler_control where scheduler_key='trading-production'),'recovered_postmaster',(select recovered_postmaster_at from trading_scheduler_control where scheduler_key='trading-production'),
 'capture_enabled',(select enabled from doa_capture.control where id=1),'capture_production',(select production_enabled from doa_capture.control where id=1),
 'capture_version',(select metrics->>'version' from doa_capture.control where id=1),'capture_source',(select metrics->>'source_commit' from doa_capture.control where id=1)) evidence`;
async function machine(path='',method='GET',body,nonce){const r=await fetch(`https://api.machines.dev/v1/apps/${COLLECTOR_APP}/machines${path}`,{method,headers:{authorization:'Bearer '+process.env.FLY_API_TOKEN,'content-type':'application/json',...(nonce?{'fly-machine-lease-nonce':nonce}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('COLLECTOR_REPAIR_MACHINE_HTTP_'+r.status);return r.json();}
const safe=m=>({id:m.id,instance_id:m.instance_id,state:m.state,region:m.region,image:m.config.image,guest:m.config.guest,restart:m.config.restart??null,auto_destroy:m.config.auto_destroy??null});
try{
 const initial=await query(stateSQL);assertCollectorRepairState(initial,source);if(initial.capture_source!==COLLECTOR_BASELINE||initial.capture_version!=='DOA-CAPTURE-9-SYMBOL-RESYNC')throw Error('COLLECTOR_REPAIR_SOURCE_DRIFT');
 const list=await machine();if(list.length!==1)throw Error('COLLECTOR_REPAIR_SINGLE_MACHINE_REQUIRED');
 const before=await machine('/'+list[0].id),config=collectorReplacement(before,sha,protocol);report.before=safe(before);report.postmaster=initial.postmaster;report.rollback_image=before.config.image;note('COLLECTOR_BASELINE_PASSED',{before:report.before,entry_paused:true});
 const lease=await machine('/'+before.id+'/lease','POST',{description:'deterministic-book-integrity-'+sha.slice(0,12),ttl:60});const nonce=lease.data?.nonce;if(!nonce)throw Error('COLLECTOR_REPAIR_LEASE_MISSING');
 try{
  const current=await machine('/'+before.id);if(current.instance_id!==before.instance_id)throw Error('COLLECTOR_REPAIR_CONCURRENT_CHANGE');
  assertCollectorRepairState(await query(stateSQL),source,initial.postmaster);
  report.image_update_attempted=true;note('COLLECTOR_IMAGE_UPDATE_STARTED');
  await machine('/'+before.id,'POST',{current_version:before.instance_id,config},nonce);
 }finally{await machine('/'+before.id+'/lease','DELETE',undefined,nonce);}
 let consecutive=0;
 for(let attempt=0;attempt<24;attempt++){
  await new Promise(r=>setTimeout(r,15000));
  const s=await query(stateSQL);assertCollectorRepairState(s,source,initial.postmaster);
  const c=await query(`with t as materialized(select clock_timestamp() at) select jsonb_build_object('as_of_ms',floor(extract(epoch from t.at)*1000)::bigint,'heartbeat_age_ms',(select extract(epoch from(t.at-heartbeat_at))*1000 from doa_capture.control where id=1),'btc',doa_market_sensor_context_v1('BTCUSDT',t.at)) evidence from t`);
  const sensor=validateMarketSensor(c.btc,c.as_of_ms),healthy=s.capture_source===sha&&s.capture_version===VERSION&&c.heartbeat_age_ms>=0&&c.heartbeat_age_ms<10000&&sensor.status==='AVAILABLE';
  consecutive=healthy?consecutive+1:0;note('COLLECTOR_RUNTIME_OBSERVED',{capture_source:s.capture_source,capture_version:s.capture_version,heartbeat_age_ms:c.heartbeat_age_ms,btc_status:sensor.status,btc_reason:sensor.reason??null,btc_buckets:sensor.buckets??null,consecutive,entry_paused:true});
  if(consecutive>=3){const after=await machine('/'+before.id);if(after.state!=='started'||after.config.image!==config.image)throw Error('COLLECTOR_REPAIR_IMAGE_NOT_RUNNING');report.after=safe(after);note('COLLECTOR_REPAIR_VERIFIED_ENTRIES_PAUSED',{collector_source:sha,collector_version:VERSION,btc_buckets:24});process.exit(0);}
 }
 throw Error('COLLECTOR_REPAIR_RUNTIME_NOT_VERIFIED');
}catch(e){note('COLLECTOR_REPAIR_BLOCKED_ENTRIES_PAUSED',{error:/^[A-Z0-9_]+$/.test(e.message)?e.message:'COLLECTOR_REPAIR_REQUEST_FAILED',rollback_image:report.rollback_image??null});process.exitCode=1;}
