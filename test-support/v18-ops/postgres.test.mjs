import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const dependency=process.env.PGLITE_MODULE;
if(!dependency)throw Error('Set PGLITE_MODULE to the installed @electric-sql/pglite/dist/index.js');
const {PGlite}=await import(pathToFileURL(dependency).href);
const schema=JSON.parse(readFileSync(new URL('./schema-columns.json',import.meta.url),'utf8'));
const migration=readFileSync(new URL('../../supabase/migrations/'+readdirSync(new URL('../../supabase/migrations/',import.meta.url)).find(x=>x.endsWith('_v18_ops_isolation.sql')),import.meta.url),'utf8');
const OWNER='11111111-1111-4111-8111-111111111111';
async function setup(){
 const pg=new PGlite();await pg.exec('create role anon; create role authenticated; create role service_role;');
 for(const t of schema){await pg.exec(`create table public.${t.table_name} (${t.columns.map(c=>`"${c.name}" ${c.type.replace('_text','text[]')}`).join(',')});`);}
 // Column types are read from production. Only seed defaults/keys used by this test.
 await pg.exec(`alter table v17_execution_lease add primary key(singleton);
 alter table v11_long_regime_positions add primary key(id);
 alter table v11_long_regime_orders add primary key(id);
 alter table v11_long_regime_runtime add primary key(singleton);
 insert into v17_execution_lease(singleton,owner,expires_at) values(true,'${OWNER}',clock_timestamp()+interval '10 minutes');
 insert into v11_long_regime_runtime(singleton,revision,live_enabled,circuit_open) values(true,'V11-LONG-REGIME-1.0.1',true,false);
 insert into v17_operator_control(singleton,entry_enabled,legacy_entries_retired) values(true,true,true);
 insert into trading_settings(id,mode,pause_new_entries,withdrawal_mode,manual_intervention_required,scalp_kill_switch,emergency_liquidation) values(1,'LIVE_LIMITED',false,false,false,false,false);`);
 await pg.exec(readFileSync(new URL('./lease-rpcs.sql',import.meta.url),'utf8'));
 await pg.exec(migration);
 await pg.exec(`create trigger v11_long_regime_slot_cap_trg before insert or update of state on v11_long_regime_positions for each row execute function v11_long_regime_enforce_slot_cap();`);
 await pg.exec(`create trigger original_fill_attribution before insert or update of exchange_order_id,bot_order_id,position_id on exchange_trade_fills for each row execute function enforce_futures_fill_order_attribution();
 create unique index fill_identity on exchange_trade_fills(exchange,account_scope,market,exchange_trade_id);`);
 return pg;
}
async function incident(pg,kind='KNOWN_EXIT_PENDING_RECONCILIATION'){
 const r=await pg.query('select v18_record_incident($1,$2,$3,$4) id',[OWNER,kind,'TAC_RACE',{}]);return r.rows[0].id;
}
async function observe(pg,id,generation=1,obs='new-'+Math.random()){
 const now=Number((await pg.query('select extract(epoch from clock_timestamp())*1000 ms')).rows[0].ms);
 const evidence={positions:[],ordersObservedAt:now,observation:{id:obs,source:'BINANCE_ACCOUNT_REST',requested_at_ms:now,received_at_ms:now}};
 return (await pg.query('select v18_recovery_observation($1,$2,$3,$4) result',[OWNER,id,generation,evidence])).rows[0].result;
}
test('SQL migration applies twice; RLS and invoker RPC grants exclude anon/authenticated',async()=>{
 const pg=await setup();await pg.exec(migration);
 const r=await pg.query("select has_function_privilege('anon','public.v18_record_incident(uuid,text,text,jsonb)','execute') anon, has_function_privilege('authenticated','public.v18_recovery_observation(uuid,uuid,bigint,jsonb)','execute') authenticated, relrowsecurity rls from pg_class where relname='v18_ops_incidents'");
 assert.deepEqual(r.rows[0],{anon:false,authenticated:false,rls:true});await pg.close();
});
test('SQL V17 preserves declared ten slots; eleventh rejected, legacy cap remains three',async()=>{
 const pg=await setup();
 const add=async(n,mode='LEADER_MOMENTUM_V17')=>pg.query("insert into v11_long_regime_positions(id,state,metadata) values($1,'OPEN',$2)",['22222222-2222-4222-8222-'+String(n).padStart(12,'0'),{executionMode:mode}]);
 for(let n=1;n<=10;n++)await add(n);
 await assert.rejects(()=>add(11),/SLOT_CAP/);
 await pg.exec("update v11_long_regime_positions set state='OPEN'");
 await pg.exec('delete from v11_long_regime_positions');
 for(let n=1;n<=3;n++)await add(n,'LEGACY');
 await assert.rejects(()=>add(4,'LEGACY'),/SLOT_CAP/);await pg.close();
});
test('SQL CAS, independent evidence, operator pause, and new incident generation',async()=>{
 const pg=await setup(),id=await incident(pg);const one=await observe(pg,id,1,'one');assert.equal(one.checks,1);
 assert.equal((await observe(pg,id,1,'one')).reason,'OBSERVATION_NOT_INDEPENDENT');
 await pg.exec("update trading_settings set pause_new_entries=true where id=1");assert.equal((await observe(pg,id)).reason,'OPERATOR_HALT');
 await pg.exec("update trading_settings set pause_new_entries=false where id=1");
 await incident(pg,'AUTHENTICATION_FAILURE');assert.equal((await observe(pg,id)).reason,'INCIDENT_CAS_MISS');
 assert.equal((await pg.query('select circuit_open from v11_long_regime_runtime')).rows[0].circuit_open,true);await pg.close();
});
test('SQL three observations span >=110s; only exact incident is cleared',async()=>{
 const pg=await setup(),id=await incident(pg);await observe(pg,id);
 // Advance stored historical observation timestamps; current proof uses real PG clock.
 await pg.exec("update v18_ops_incidents set last_observed_at=clock_timestamp()-interval '60 seconds',first_clean_at=clock_timestamp()-interval '120 seconds'");
 assert.equal((await observe(pg,id)).checks,2);
 await pg.exec("update v18_ops_incidents set last_observed_at=clock_timestamp()-interval '60 seconds'");
 assert.equal((await observe(pg,id)).resolved,true);await pg.close();
});
test('SQL legacy writer creates a new epoch; malformed flat proof never clears it',async()=>{
 const pg=await setup(),id=await incident(pg);
 const bad=await pg.query('select v18_recovery_observation($1,$2,1,$3) result',[OWNER,id,{observation:{id:'bad',requested_at_ms:Date.now()},ordersObservedAt:Date.now()}]);
 assert.equal(bad.rows[0].result.reason,'STALE_EVIDENCE');
 await pg.exec("update v11_long_regime_runtime set circuit_reason='NEW_AUTH_FAILURE',last_error='AUTH_FAILURE'");
 assert.equal((await observe(pg,id)).reason,'INCIDENT_CAS_MISS');
 const r=(await pg.query('select incident_generation,incident_kind,circuit_open from v11_long_regime_runtime')).rows[0];
 assert.equal(Number(r.incident_generation),2);assert.equal(r.incident_kind,'MANUAL_REVIEW_REQUIRED');assert.equal(r.circuit_open,true);await pg.close();
});
test('SQL expired lease fences ordinary position writes in the same transaction',async()=>{
 const pg=await setup();await pg.exec("update v17_execution_lease set expires_at=clock_timestamp()-interval '1 second'");
 await pg.query("select set_config('request.headers',$1,false)",[JSON.stringify({'x-v18-execution-owner':OWNER})]);
 await assert.rejects(()=>pg.exec("insert into v11_long_regime_positions(id) values('22222222-2222-4222-8222-222222222222')"),/FENCED/);
 assert.equal((await pg.query('select count(*) n from v11_long_regime_positions')).rows[0].n,0);await pg.close();
});

test('SQL fill-first/native-metadata-first, duplicates and foreign scope attribution',async()=>{
 const pg=await setup(),pid='22222222-2222-4222-8222-222222222222';
 await pg.query("insert into v11_long_regime_positions(id,symbol,side,metadata,remaining_quantity,state) values($1,'EDGEUSDT','LONG',$2,0,'CLOSED')",[pid,{executionMode:'LEADER_MOMENTUM_V17'}]);
 const insert=async(trade,scope='futures')=>pg.query("insert into exchange_trade_fills(exchange,account_scope,market,exchange_trade_id,exchange_order_id,side,quantity) values('binance_futures',$1,'EDGEUSDT',$2,'999','SELL',93) on conflict(exchange,account_scope,market,exchange_trade_id) do update set exchange_order_id=excluded.exchange_order_id",[scope,trade]);
 await insert(1);assert.equal((await pg.query('select v17_position_id from exchange_trade_fills')).rows[0].v17_position_id,null);
 const metadata={executionMode:'LEADER_MOMENTUM_V17',exitProtection:{orders:[{actualOrderId:'999',spec:{params:{symbol:'EDGEUSDT',side:'SELL',reduceOnly:'true'}}}]}};
 await pg.query('update v11_long_regime_positions set metadata=$1 where id=$2',[metadata,pid]);
 assert.equal((await pg.query('select v17_position_id from exchange_trade_fills')).rows[0].v17_position_id,pid);
 await insert(1);await insert(2);await insert(3,'other-account');
 const rows=(await pg.query('select account_scope,v17_position_id from exchange_trade_fills order by exchange_trade_id')).rows;
 assert.equal(rows.length,3);assert.equal(rows[1].v17_position_id,pid);assert.equal(rows[2].v17_position_id,null);
 assert.equal((await pg.query('select remaining_quantity from v11_long_regime_positions')).rows[0].remaining_quantity,'0');await pg.close();
});

test('SQL order metadata arriving after fill retries attribution without touching PnL',async()=>{
 const pg=await setup(),pid='22222222-2222-4222-8222-222222222222',oid='33333333-3333-4333-8333-333333333333';
 await pg.query("insert into v11_long_regime_positions(id,symbol,side,metadata,state,realized_pnl_usdt) values($1,'VETUSDT','LONG',$2,'CLOSED',null)",[pid,{}]);
 await pg.exec("insert into exchange_trade_fills(exchange,account_scope,market,exchange_trade_id,exchange_order_id,side,quantity) values('binance_futures','futures','VETUSDT',7,'88','SELL',20)");
 await pg.query("insert into v11_long_regime_orders(id,position_id,symbol,exchange_order_id,client_order_id) values($1,$2,'VETUSDT','88','known-client')",[oid,pid]);
 const row=(await pg.query('select v17_position_id,v17_order_id from exchange_trade_fills')).rows[0];assert.equal(row.v17_position_id,pid);assert.equal(row.v17_order_id,oid);
 assert.equal((await pg.query('select realized_pnl_usdt from v11_long_regime_positions')).rows[0].realized_pnl_usdt,null);await pg.close();
});
test('SQL native terminalization closes its own signal in the same transaction',async()=>{
 const pg=await setup(),pid='22222222-2222-4222-8222-222222222222',sid='33333333-3333-4333-8333-333333333333';
 await pg.query("insert into v11_long_regime_positions(id,signal_id,state,remaining_quantity,metadata) values($1,$2,'OPEN',93,$3)",[pid,sid,{executionMode:'LEADER_MOMENTUM_V17'}]);
 await pg.query("insert into v11_long_regime_signals(id,position_id,status) values($1,$2,'FILLED')",[sid,pid]);
 await pg.query("update v11_long_regime_positions set state='CLOSED',remaining_quantity=0,closed_at=clock_timestamp(),metadata=$1 where id=$2",[{executionMode:'LEADER_MOMENTUM_V17',exitProtection:{orders:[{actualOrderId:'900418698',appliedQuantity:93}]}},pid]);
 assert.equal((await pg.query('select status from v11_long_regime_signals')).rows[0].status,'CLOSED');await pg.close();
});
test('SQL approval procedure: exact legacy incident stays open for verification; replay changes zero rows',async()=>{
 const pg=await setup();
 await pg.exec(`truncate v11_long_regime_runtime;insert into v11_long_regime_runtime(singleton,live_enabled,circuit_open,circuit_reason,last_error,updated_at) values(true,true,true,'BULL_EXTERNAL_EXPOSURE:COUNT:1:2:SAGAUSDT','EXTERNAL_POSITION','2026-09-10T16:16:06.727Z');
 update v17_execution_lease set owner=null,expires_at='-infinity';
 insert into v11_long_regime_positions(id,symbol,original_quantity,remaining_quantity,state) values('9d21a501-0b4a-4230-826b-6ca2d37d66e8','TACUSDT',64310,0,'CLOSED'),('794da229-cdce-4d41-800d-578f92d03f56','SAGAUSDT',7067.3,0,'CLOSED');
 insert into exchange_trade_fills(exchange,account_scope,market,exchange_order_id,exchange_trade_id,side,quantity) values
 ('binance_futures','futures','TACUSDT','1179849258',116576836,'SELL',53510),('binance_futures','futures','TACUSDT','1179849258',116576837,'SELL',2983),('binance_futures','futures','TACUSDT','1179849258',116576838,'SELL',7817),('binance_futures','futures','SAGAUSDT','4882990988',311493537,'SELL',7067.3);`);
 const now=Date.now(),evidence={portfolio:{exchange:'binance_futures',account_scope:'futures',positions_complete:true,positions:[],observation:{id:'independent',source:'BINANCE_ACCOUNT_REST',requested_at_ms:now,received_at_ms:now}},openOrders:{complete:true,orders:[],algos:[],observed_at_ms:now}};
 const values={owner_uuid:OWNER,expected_updated_at:'2026-09-10T16:16:06.727Z',evidence_json:JSON.stringify(evidence)};
 const source=readFileSync(new URL('../../docs/operations/v18-approve-flat-legacy-incident.sql',import.meta.url),'utf8');
 const script=source.replace(/:'(owner_uuid|expected_updated_at|evidence_json)'/g,(_,k)=>"'"+values[k].replaceAll("'","''")+"'");
 await pg.exec(script);const r=(await pg.query('select circuit_open,incident_kind from v11_long_regime_runtime')).rows[0];
 assert.equal(r.circuit_open,true);assert.equal(r.incident_kind,'KNOWN_EXIT_PENDING_RECONCILIATION');
 await assert.rejects(()=>pg.exec(script),/CAS_MISS/);await pg.exec('rollback');
 assert.equal((await pg.query('select count(*) n from v18_ops_incidents')).rows[0].n,1);
 assert.equal((await pg.query('select owner from v17_execution_lease')).rows[0].owner,null);await pg.close();
});
