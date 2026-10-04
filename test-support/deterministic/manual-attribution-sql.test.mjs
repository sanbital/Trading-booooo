import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const template=fs.readFileSync(new URL('../../ops/execution-infra/attribute-manual-gtc.sql',import.meta.url),'utf8');
const incident='4959917c-987c-4bf5-b85b-8942808c20c2';
async function setup(){const pg=new PGlite();await pg.exec(`
create table v11_long_regime_runtime(singleton boolean,circuit_open boolean,incident_id uuid,incident_generation bigint,incident_kind text,circuit_reason text,live_enabled boolean);
insert into v11_long_regime_runtime values(true,true,'${incident}',199,'EXCHANGE_ONLY_POSITION','ACCOUNT_RISK_BLOCK:EXCHANGE_ONLY_POSITION:GTCUSDT',true);
create table trading_settings(id int,mode text,pause_new_entries boolean,pause_lock_reason text,manual_event_reason text,emergency_liquidation boolean,withdrawal_mode boolean,scalp_kill_switch boolean,manual_intervention_required boolean);
insert into trading_settings values(1,'LIVE_LIMITED',true,'P10_UNTRACKED_FUTURES_EXPOSURE','P10_UNTRACKED_FUTURES_EXPOSURE',false,false,false,false);
create table v17_operator_control(singleton boolean,entry_enabled boolean,legacy_entries_retired boolean);insert into v17_operator_control values(true,true,true);
create table v11_long_regime_positions(state text);create table v10_lane_positions(state text);create table trading_positions(is_paper boolean,state text);
create table v11_long_regime_orders(state text,response_payload jsonb);
create table exchange_trade_fills(exchange text,account_scope text,market text,exchange_order_id text,side text,bot_order_id uuid,position_id uuid,v17_order_id uuid,v17_position_id uuid,quantity numeric);
insert into exchange_trade_fills select 'binance_futures','futures','GTCUSDT','4634347872','BUY',null,null,null,null,case when n=11 then 944.6 else 100 end from generate_series(1,11) n;
create table trading_asset_locks(exchange text,asset text,state text,reason text,metadata jsonb);
create table v18_ops_incidents(id uuid,resolution_evidence jsonb);insert into v18_ops_incidents values('${incident}',null);
create function v17_acquire_execution_lease(uuid) returns boolean language sql as $$select true$$;
create function v17_release_execution_lease(uuid) returns boolean language sql as $$select true$$;
create function v19_record_incident(uuid,text,text,text,text,jsonb,jsonb,text) returns jsonb language plpgsql as $$begin
update v11_long_regime_runtime set incident_kind=$2,incident_generation=incident_generation+1,circuit_reason=$3;
return jsonb_build_object('globalCircuit',true);end$$;
`);return pg;}
async function evidence(pg){const {postmaster}= (await pg.query('select pg_postmaster_start_time() postmaster')).rows[0];const now=Date.now();return {
 version:'USER_CONFIRMED_GTC_20261004_1',attestation:'USER_CONFIRMED_DIRECT_ORDER',commit:'a'.repeat(40),postmaster,owner:'11111111-1111-4111-8111-111111111111',
 evidence:{portfolio:{exchange:'binance_futures',account_scope:'futures',positions_complete:true,observation:{id:'fresh',source:'BINANCE_ACCOUNT_REST',requested_at_ms:now,received_at_ms:now},positions:[{market:'GTCUSDT',side:'LONG',quantity:1944.6}]},openOrders:{complete:true,orders:[],algos:[],observed_at_ms:now},order:{exchange_order_id:'4634347872',status:'FILLED',executed_volume:1944.6}}};}
const query=a=>template.replace('__REVIEW_JSON__',"'"+JSON.stringify(a).replaceAll("'","''")+"'");
test('exact manual attribution registers only a bounded external allowance and retains the circuit',async()=>{
 const pg=await setup();await pg.exec(query(await evidence(pg)));
 const lock=(await pg.query('select * from trading_asset_locks')).rows[0];assert.equal(lock.metadata.maxQuantity,1944.6);assert.equal(lock.metadata.botManagementAuthorized,false);
 const rt=(await pg.query('select * from v11_long_regime_runtime')).rows[0];assert.equal(rt.circuit_open,true);assert.equal(rt.incident_kind,'ACCOUNTING_DETAILS_PENDING');
 assert.equal((await pg.query('select count(*)::int n from v11_long_regime_positions')).rows[0].n,0);await pg.close();
});
test('stale evidence, unknown orders, changed quantity, absent confirmation and a new incident roll back attribution',async()=>{
 for(const mutate of [a=>a.evidence.portfolio.observation.requested_at_ms-=10000,a=>a.evidence.openOrders.orders=[{id:'foreign'}],a=>a.evidence.portfolio.positions[0].quantity=1944.7,a=>a.attestation='UNKNOWN',null]){
  const pg=await setup(),a=await evidence(pg);if(mutate)mutate(a);else await pg.exec('update v11_long_regime_runtime set incident_generation=200');
  await assert.rejects(()=>pg.exec(query(a)),/MANUAL_REVIEW/);await pg.exec('rollback');
  assert.equal((await pg.query('select count(*)::int n from trading_asset_locks')).rows[0].n,0);assert.equal((await pg.query('select circuit_open from v11_long_regime_runtime')).rows[0].circuit_open,true);await pg.close();
 }
});
