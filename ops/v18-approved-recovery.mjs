// Explicitly approved operation: classify the exact resolved legacy TAC incident.
// It never sets circuit_open=false, changes settings, or submits exchange orders.
import {read} from './v18-gateway-read.mjs';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import crypto from 'node:crypto';
const ref=process.env.SUPABASE_PROJECT_REF;
if(ref!=='etaajwpernzrcdrifdnw'||!process.env.SUPABASE_DB_URL||!process.env.SUPABASE_ACCESS_TOKEN)throw Error('RECOVERY_CONFIG');
const metadata=await fetch(`https://api.supabase.com/v1/projects/${ref}/functions/v10-lane-executor`,{headers:{Authorization:`Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`},signal:AbortSignal.timeout(5000)}).then(async r=>{if(!r.ok)throw Error(`FUNCTION_READ_${r.status}`);return r.json()});
if(metadata.version!==34||metadata.status!=='ACTIVE'||metadata.verify_jwt!==false)throw Error('REVIEWED_EXECUTOR_VERSION_CHANGED');
const env={...process.env,PGDATABASE:process.env.SUPABASE_DB_URL,PGCONNECT_TIMEOUT:'3'};
function query(s){return execFileSync('psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1'],{env,input:s,encoding:'utf8',timeout:10000}).trim();}
const snapshot=JSON.parse(query(`begin read only;
select jsonb_build_object('observed_at',clock_timestamp(),'runtime',(select to_jsonb(r) from v11_long_regime_runtime r where singleton),
'lease',(select to_jsonb(l) from v17_execution_lease l where singleton),
'operator',(select to_jsonb(o) from v17_operator_control o where singleton),
'settings',(select jsonb_build_object('mode',mode,'pause',pause_new_entries,'kill',scalp_kill_switch,'withdrawal',withdrawal_mode,'manual',manual_intervention_required,'emergency',emergency_liquidation,'pause_lock_reason',pause_lock_reason,'allocation',binance_futures_allocation_usdt,'leverage',binance_futures_leverage) from trading_settings where id=1),
'open_positions',(select coalesce(jsonb_agg(to_jsonb(p)),'[]') from v11_long_regime_positions p where state='OPEN'),
'pending_orders',(select coalesce(jsonb_agg(to_jsonb(o)),'[]') from v11_long_regime_orders o where state in ('PLANNED','DISPATCHED','RECONCILIATION_FAILED','RECONCILIATION_PENDING')),
'tac_saga',(select jsonb_agg(to_jsonb(p)) from v11_long_regime_positions p where id in ('9d21a501-0b4a-4230-826b-6ca2d37d66e8','794da229-cdce-4d41-800d-578f92d03f56')),
'migration',(select version from supabase_migrations.schema_migrations where name='v18_ops_isolation'));
commit;`));
writeFileSync('release-evidence/recovery-before.json',JSON.stringify(snapshot,null,2));
if(snapshot.migration!=='20260911000759')throw Error('MIGRATION_VERSION_CHANGED');
if(snapshot.runtime.incident_id){
  if(snapshot.runtime.circuit_reason==='APPROVED_TAC_NATIVE_CLOSE_RECONCILED'&&snapshot.runtime.incident_kind==='KNOWN_EXIT_PENDING_RECONCILIATION'){
    console.log(JSON.stringify({skipped:'INCIDENT_ALREADY_CLASSIFIED',incidentId:snapshot.runtime.incident_id,circuitOpen:snapshot.runtime.circuit_open}));process.exit(0);
  }
  throw Error('NEW_INCIDENT_REQUIRES_REVIEW');
}
const [portfolio,openOrders]=await Promise.all([read('p10_portfolio'),read('v18_open_orders')]);
const evidence={portfolio,openOrders};
writeFileSync('release-evidence/recovery-fresh-evidence.json',JSON.stringify(evidence,null,2));
const output=execFileSync('psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1',
  '-v',`owner_uuid=${crypto.randomUUID()}`,'-v',`expected_updated_at=${snapshot.runtime.updated_at}`,
  '-v',`evidence_json=${JSON.stringify(evidence)}`,'-f','docs/operations/v18-approve-flat-legacy-incident.sql'],{env,encoding:'utf8',timeout:10000});
writeFileSync('release-evidence/recovery-transaction.txt',output);
const after=JSON.parse(query('begin read only; select to_jsonb(r) from v11_long_regime_runtime r where singleton; commit;'));
if(after.circuit_open!==true||after.incident_kind!=='KNOWN_EXIT_PENDING_RECONCILIATION'||after.circuit_reason!=='APPROVED_TAC_NATIVE_CLOSE_RECONCILED')throw Error('RECOVERY_POSTCONDITION');
writeFileSync('release-evidence/recovery-after.json',JSON.stringify(after,null,2));
console.log(JSON.stringify({incidentId:after.incident_id,generation:after.incident_generation,circuitOpen:after.circuit_open,status:'CLASSIFIED_AWAITING_THREE_INDEPENDENT_CYCLES',positions:portfolio.positions.length,openOrders:openOrders.orders.length,algos:openOrders.algos.length}));
