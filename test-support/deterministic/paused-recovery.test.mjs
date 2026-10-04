import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {PGlite} from '@electric-sql/pglite';
const owner='11111111-1111-4111-8111-111111111111',order='22222222-2222-4222-8222-222222222222',incident='33333333-3333-4333-8333-333333333333',client='tb-v11e-'+ 'a'.repeat(24);
async function fixture(){const pg=new PGlite();await pg.exec(fs.readFileSync(new URL('schema.sql',import.meta.url),'utf8'));await pg.exec(fs.readFileSync(new URL('capacity-baseline.sql',import.meta.url),'utf8'));await pg.exec(fs.readFileSync(new URL('../../supabase/migrations/20261002102500_deterministic_dynamic_state.sql',import.meta.url),'utf8'));
 await pg.exec(`create function v18_require_lease(p_owner uuid) returns void language plpgsql as $$begin if v17_verify_execution_lease(p_owner) is distinct from true then raise exception 'V18_EXECUTION_FENCED';end if;end $$;
 create table v11_long_regime_runtime(singleton boolean,circuit_open boolean,incident_id uuid,incident_generation bigint,incident_kind text,circuit_reason text,live_enabled boolean,protection_health text,incident_last_checked_at timestamptz,incident_resolved_at timestamptz,last_error text,entry_block_reason text,updated_at timestamptz);
 create table v18_ops_incidents(id uuid,generation bigint,kind text,reason text,control_scope text,exchange text,account_scope text,status text,resolved_at timestamptz,evidence jsonb,clean_checks int,first_clean_at timestamptz,last_observed_at timestamptz,last_observation_id text,last_checked_at timestamptz,resolution_evidence jsonb);
 create table trading_settings(id int,pause_new_entries boolean,mode text,withdrawal_mode boolean,manual_intervention_required boolean,scalp_kill_switch boolean,emergency_liquidation boolean,pause_lock_reason text);
 create table v17_operator_control(singleton boolean,entry_enabled boolean,legacy_entries_retired boolean);
 create table leader20_batch_control(singleton boolean,enabled boolean);create table gpt_final_review_control(singleton boolean,mode text);
 insert into trading_settings values(1,true,'LIVE_LIMITED',false,false,false,false,null);insert into v17_operator_control values(true,true,true);insert into leader20_batch_control values(true,false);insert into gpt_final_review_control values(true,'OFF');
 update deterministic_control set enabled=true,generation=2;
 insert into v17_execution_lease values(true,'${owner}',1,clock_timestamp()+interval '150 seconds',pg_postmaster_start_time());
 insert into v11_long_regime_orders(id,symbol,intent,state,client_order_id,response_payload) values('${order}','TESTUSDT','OPEN_LONG','REJECTED','${client}','{"v18ExposureFinal":true,"v18EntryNeverPlaced":{"neverPlaced":true,"source":"BINANCE_FUTURES_ORDER_AND_POSITION_REST"}}');
 insert into v11_long_regime_runtime(singleton,circuit_open,incident_id,incident_generation,incident_kind,circuit_reason,live_enabled,protection_health) values(true,true,'${incident}',7,'KNOWN_ORDER_PENDING_RECONCILIATION','fixture reason',true,'FLAT');
 insert into v18_ops_incidents(id,generation,kind,reason,control_scope,exchange,account_scope,status,evidence,clean_checks) values('${incident}',7,'KNOWN_ORDER_PENDING_RECONCILIATION','fixture reason','ACCOUNT_ENTRY_HOLD','binance_futures','futures','OPEN','{"issues":[{"orderId":"${order}","symbol":"TESTUSDT"}]}',0);`);
 await pg.exec(fs.readFileSync(new URL('../../supabase/migrations/20261004000400_deterministic_submission_null_proof.sql',import.meta.url),'utf8'));return pg;}
function evidence(){const now=Date.now();return {observation:{id:'fixture-'+now,source:'BINANCE_ACCOUNT_REST',requested_at_ms:now,received_at_ms:now},positionsComplete:true,positions:[],ordersComplete:true,orders:[],algos:[],ordersObservedAt:now,proof:{source:'BINANCE_FUTURES_ORDER_AND_POSITION_REST',market:'TESTUSDT',identifier:client,proven:true,found:false,lookup_code:-2013,position_read_ok:true,trade_read_ok:true,position_quantity:0,recent_trade_count:0,observed_at_ms:now}};}
const call=async(pg,e=evidence(),generation=7)=>(await pg.query('select deterministic_paused_never_placed_recovery($1,$2,$3,$4,$5) result',[owner,incident,generation,order,e])).rows[0].result;
test('paused recovery cannot clear an incident from one or repeated observation; three independent observations keep entries paused',async()=>{
 const pg=await fixture();try{
  const e=evidence(),first=await call(pg,e);assert.equal(first.resolved,false);assert.equal(first.checks,1);assert.equal((await call(pg,e)).reason,'OBSERVATION_NOT_INDEPENDENT');
  // Local historical fixture models two independent prior observations. The real
  // runner waits56s between each signed observation; no production clock is moved.
  await pg.exec("update v18_ops_incidents set clean_checks=2,first_clean_at=clock_timestamp()-interval '112 seconds',last_observed_at=clock_timestamp()-interval '56 seconds',last_observation_id='prior' ");
  const resolved=await call(pg);assert.equal(resolved.resolved,true);assert.equal(resolved.checks,3);assert.equal(resolved.entriesPaused,true);
  assert.equal((await pg.query('select pause_new_entries from trading_settings')).rows[0].pause_new_entries,true);
  assert.equal((await pg.query('select state from v11_long_regime_orders')).rows[0].state,'REJECTED');assert.equal((await pg.query('select count(*) n from v11_long_regime_positions')).rows[0].n,0);
  assert.equal((await pg.query('select circuit_open from v11_long_regime_runtime')).rows[0].circuit_open,false);
  assert.equal((await pg.query('select status from v18_ops_incidents')).rows[0].status,'RESOLVED');
 }finally{await pg.close();}
});
test('paused recovery rejects incomplete venue truth, stale data, other identities and lost writer ownership',async()=>{
 const pg=await fixture();try{
  for(const mutate of [e=>e.positionsComplete=false,e=>e.positions=[{quantity:1}],e=>e.ordersComplete=false,e=>e.orders=[{unknown:true}],e=>e.algos=[{unknown:true}],e=>e.proof.proven=false,e=>e.proof.found=null,e=>e.proof.identifier='other',e=>e.proof.lookup_code=500,e=>e.proof.recent_trade_count=1,e=>e.proof.observed_at_ms-=6000,e=>e.observation.requested_at_ms-=6000,e=>e.proof.observed_at_ms+=1500]){
   const e=evidence();mutate(e);assert.equal((await call(pg,e)).resolved,false);
  }
  assert.equal((await call(pg,evidence(),8)).reason,'INCIDENT_CAS_MISS');
  await pg.exec("update v11_long_regime_orders set state='UNKNOWN'");assert.equal((await call(pg)).reason,'NEVER_PLACED_FLAT_TRUTH_REQUIRED');await pg.exec("update v11_long_regime_orders set state='REJECTED'");
  await pg.exec("insert into v11_long_regime_positions(symbol,state,remaining_quantity) values('HELDUSDT','OPEN',1)");assert.equal((await call(pg)).reason,'NEVER_PLACED_FLAT_TRUTH_REQUIRED');await pg.exec('delete from v11_long_regime_positions');
  await pg.exec("insert into v11_long_regime_positions(symbol,state,remaining_quantity,metadata) values('OLDUSDT','CLOSED',0,'{\"exitProtection\":{\"orders\":[{\"terminal\":false}]}}')");assert.equal((await call(pg)).reason,'NEVER_PLACED_FLAT_TRUTH_REQUIRED');await pg.exec('delete from v11_long_regime_positions');
  await pg.exec('update trading_settings set pause_new_entries=false');assert.equal((await call(pg)).reason,'PAUSED_DETERMINISTIC_PERMISSION_REQUIRED');await pg.exec('update trading_settings set pause_new_entries=true,manual_intervention_required=true');assert.equal((await call(pg)).resolved,false);
  await pg.exec("update v17_execution_lease set postmaster_started_at=pg_postmaster_start_time()-interval '1 minute'");await assert.rejects(()=>call(pg),/V18_EXECUTION_FENCED/);
  const grants=(await pg.query("select has_function_privilege('anon','deterministic_paused_never_placed_recovery(uuid,uuid,bigint,uuid,jsonb)','execute') anon,has_function_privilege('service_role','deterministic_paused_never_placed_recovery(uuid,uuid,bigint,uuid,jsonb)','execute') service")).rows[0];assert.deepEqual(grants,{anon:false,service:true});
 }finally{await pg.close();}
});
