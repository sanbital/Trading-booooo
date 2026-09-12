import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const dependency=process.env.PGLITE_MODULE;
if(!dependency)throw Error('Set PGLITE_MODULE to the installed @electric-sql/pglite/dist/index.js');
const {PGlite}=await import(pathToFileURL(dependency).href);
const schema=JSON.parse(readFileSync(new URL('./schema-columns.json',import.meta.url),'utf8'));
const migration=readFileSync(new URL('../../supabase/migrations/'+readdirSync(new URL('../../supabase/migrations/',import.meta.url)).find(x=>x.endsWith('_v18_ops_isolation.sql')),import.meta.url),'utf8');
const dbOnlyMigration=readFileSync(new URL('../../supabase/migrations/'+readdirSync(new URL('../../supabase/migrations/',import.meta.url)).find(x=>x.endsWith('_v18_db_only_reconciliation.sql')),import.meta.url),'utf8');
const recoveryScopeMigration=readFileSync(new URL('../../supabase/migrations/'+readdirSync(new URL('../../supabase/migrations/',import.meta.url)).find(x=>x.endsWith('_v18_db_only_recovery_exit_scope.sql')),import.meta.url),'utf8');
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
 await pg.exec(dbOnlyMigration);
 await pg.exec(recoveryScopeMigration);
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
test('SQL migrations apply twice; RLS and invoker RPC grants exclude anon/authenticated',async()=>{
 const pg=await setup();await pg.exec(migration);await pg.exec(dbOnlyMigration);await pg.exec(recoveryScopeMigration);
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
test('SQL sanitized stale-stop settlement is atomic, exact, idempotent, and alone makes UNEXPLAINED recoverable',async()=>{
 const pg=await setup(),target='22222222-2222-4222-8222-222222222222',source='33333333-3333-4333-8333-333333333333',
  signal='44444444-4444-4444-8444-444444444444',entryOrder='90000000001',exitOrder='90000000002',client='tb-v17s-stale0000000000000000001',algo='80000000001';
 const ms=Number((await pg.query('select extract(epoch from clock_timestamp())*1000 ms')).rows[0].ms),
  entryAt=new Date(ms-600000).toISOString(),sourceClosed=new Date(ms-700000).toISOString(),exitAt=new Date(ms-1000).toISOString();
 const sourceMeta={executionMode:'LEADER_MOMENTUM_V17',exitProtection:{health:'RECONCILIATION_PENDING',orders:[{clientId:client,algoId:algo,status:'CANCEL_PENDING',terminal:false,
  spec:{params:{clientAlgoId:client,symbol:'CASEUSDT',side:'SELL',positionSide:'BOTH',reduceOnly:'true',type:'STOP_MARKET',quantity:120,triggerPrice:.01503}}}]}};
 const targetMeta={executionMode:'LEADER_MOMENTUM_V17',entryOrderId:entryOrder,v18SettledPnl:-.000767,qv3:{version:'QV3_ENTRY_EXIT_TWO_1'},
  exitProtection:{health:'PROTECTED',orders:[{clientId:'tb-v17s-current',algoId:'current-algo',status:'REJECTED',terminal:true,
   spec:{params:{clientAlgoId:'tb-v17s-current',symbol:'CASEUSDT',side:'SELL',positionSide:'BOTH',reduceOnly:'true',quantity:100}}}]}};
 await pg.query("insert into v11_long_regime_positions(id,signal_id,symbol,side,state,original_quantity,remaining_quantity,entry_price,entry_at,closed_at,realized_pnl_usdt,entry_fee_usdt,metadata,updated_at) values($1,'11111111-1111-4111-8111-111111111111','CASEUSDT','LONG','CLOSED',120,0,.01544,$2,$3,-1.1,.06,$4,clock_timestamp()),($5,$6,'CASEUSDT','LONG','OPEN',100,100,.01534,$7,null,-.000767,.000767,$8,clock_timestamp())",
  [source,new Date(ms-1200000).toISOString(),sourceClosed,sourceMeta,target,signal,entryAt,targetMeta]);
 await pg.query("insert into v11_long_regime_signals(id,position_id,status,symbol) values($1,$2,'FILLED','CASEUSDT')",[signal,target]);
 await pg.query("insert into v11_long_regime_orders(id,signal_id,position_id,symbol,intent,state,exchange_order_id,client_order_id,request_payload,created_at,updated_at) values('55555555-5555-4555-8555-555555555555',$1,$2,'CASEUSDT','OPEN_LONG','FILLED',$3,'tb-v11e-case',$4,$5,$5)",
  [signal,target,entryOrder,{order:{side:'BUY',position_side:'LONG',position_effect:'OPEN'}},entryAt]);
 await pg.query("insert into exchange_trade_fills(exchange,account_scope,market,exchange_trade_id,exchange_order_id,side,price,quantity,quote_amount,fee_quote_amount,realized_pnl_quote,accounting_status,source,executed_at,v17_position_id) values ('binance_futures','futures','CASEUSDT',700000001,$1,'BUY',.01534,100,1.534,.000767,0,'PENDING','AUTOMATED',$2,$3),('binance_futures','futures','CASEUSDT',700000002,$4,'SELL',.01503,40,.6012,.0003006,-.0124,'UNMATCHED_INVENTORY','UNCLASSIFIED',$5,null),('binance_futures','futures','CASEUSDT',700000003,$4,'SELL',.01503,60,.9018,.0004509,-.0186,'UNMATCHED_INVENTORY','UNCLASSIFIED',$5,null)",[entryOrder,entryAt,target,exitOrder,exitAt]);
 const id=await incident(pg,'UNEXPLAINED_EXPOSURE'),updated=(await pg.query('select updated_at from v11_long_regime_positions where id=$1',[target])).rows[0].updated_at;
 await pg.query("select set_config('request.headers',$1,false)",[JSON.stringify({'x-v18-execution-owner':OWNER})]);
 const evidence={version:'V18-DB-ONLY-EVIDENCE-1',classification:'VERIFIED_STALE_NATIVE_STOP',exchange:'binance_futures',accountScope:'futures',
  targetPositionId:target,targetSignalId:signal,targetUpdatedAt:updated,targetRemainingQuantity:100,symbol:'CASEUSDT',entryOrderId:entryOrder,
  sourcePositionId:source,laneOrderId:null,exchangeOrderId:exitOrder,clientOrderId:client,algoId:algo,tradeIds:['700000002','700000003'],
  quantity:100,funds:1.503,exitPrice:.01503,grossPnl:-.031,exitFee:.0007515,closedAt:exitAt,
  order:{symbol:'CASEUSDT',orderId:exitOrder,clientOrderId:client,side:'SELL',positionSide:'BOTH',reduceOnly:'true',type:'MARKET',status:'FILLED',origQty:100,executedQty:100,avgPrice:.01503,cumQuote:1.503,time:ms-1000,updateTime:ms-1000},
  algo:{clientAlgoId:client,algoId:algo,actualOrderId:exitOrder,status:'FINISHED'},
  portfolioObservation:{id:'sql-flat-1',source:'BINANCE_ACCOUNT_REST',requested_at_ms:ms,received_at_ms:ms},ordersObservedAt:ms,strategyExit:true};
 const one=(await pg.query('select v18_settle_db_only_exit($1,$2,1,$3,$4) result',[OWNER,id,target,evidence])).rows[0].result;
 assert.equal(one.settled,true);assert.equal(one.idempotent,false);assert.equal(Number(one.realizedPnlUsdt),-.0325185);
 const position=(await pg.query('select state,remaining_quantity,exit_price,exit_reason,closed_at,realized_pnl_usdt,metadata from v11_long_regime_positions where id=$1',[target])).rows[0];
 assert.equal(position.state,'CLOSED');assert.equal(position.remaining_quantity,'0');assert.equal(Number(position.exit_price),.01503);
 assert.equal(position.exit_reason,'STALE_NATIVE_STOP_CROSS_LIFECYCLE');assert.equal(Number(position.realized_pnl_usdt),-.0325185);
 assert.equal(position.metadata.qv3.version,'QV3_ENTRY_EXIT_TWO_1');
 const fills=(await pg.query("select v17_position_id,accounting_status,source from exchange_trade_fills where side='SELL' order by exchange_trade_id")).rows;
 assert.deepEqual(fills,[{v17_position_id:target,accounting_status:'ACCOUNTED',source:'AUTOMATED'},{v17_position_id:target,accounting_status:'ACCOUNTED',source:'AUTOMATED'}]);
 assert.deepEqual((await pg.query("select v17_position_id,accounting_status from exchange_trade_fills where side='BUY'")).rows[0],
  {v17_position_id:target,accounting_status:'PENDING'});
 assert.equal(Number((await pg.query('select realized_pnl_usdt from v11_long_regime_positions where id=$1',[source])).rows[0].realized_pnl_usdt),-1.1);
 const replay=(await pg.query('select v18_settle_db_only_exit($1,$2,1,$3,$4) result',[OWNER,id,target,evidence])).rows[0].result;
 assert.equal(replay.idempotent,true);assert.equal((await pg.query("select count(*) n from exchange_trade_fills where accounting_status='ACCOUNTED'")).rows[0].n,2);
 const first=await observe(pg,id,1,'settled-1');assert.equal(first.checks,1);
 await pg.exec("update v18_ops_incidents set last_observed_at=clock_timestamp()-interval '60 seconds',first_clean_at=clock_timestamp()-interval '120 seconds'");
 assert.equal((await observe(pg,id,1,'settled-2')).checks,2);await pg.exec("update v18_ops_incidents set last_observed_at=clock_timestamp()-interval '60 seconds'");
 assert.equal((await observe(pg,id,1,'settled-3')).resolved,true);assert.equal((await pg.query('select circuit_open from v11_long_regime_runtime')).rows[0].circuit_open,false);
 await pg.close();
});
test('SQL verified external close settles actual exposure but preserves the unexplained-exposure halt',async()=>{
 const pg=await setup(),target='22222222-2222-4222-8222-222222222222',signal='44444444-4444-4444-8444-444444444444',
  entryOrder='90000000011',exitOrder='90000000012',client='web-manual-synthetic';
 const ms=Number((await pg.query('select extract(epoch from clock_timestamp())*1000 ms')).rows[0].ms),
  entryAt=new Date(ms-600000).toISOString(),exitAt=new Date(ms-1000).toISOString();
 const targetMeta={executionMode:'LEADER_MOMENTUM_V17',entryOrderId:entryOrder,v18SettledPnl:-.001,
  exitProtection:{health:'REJECTED',orders:[{clientId:'tb-v17s-current',status:'REJECTED',terminal:true}]}};
 await pg.query("insert into v11_long_regime_positions(id,signal_id,symbol,side,state,original_quantity,remaining_quantity,entry_price,entry_at,realized_pnl_usdt,entry_fee_usdt,metadata,updated_at) values($1,$2,'CASEUSDT','LONG','OPEN',100,100,.01534,$3,-.001,.001,$4,clock_timestamp())",
  [target,signal,entryAt,targetMeta]);
 await pg.query("insert into v11_long_regime_signals(id,position_id,status,symbol) values($1,$2,'FILLED','CASEUSDT')",[signal,target]);
 await pg.query("insert into v11_long_regime_orders(id,signal_id,position_id,symbol,intent,state,exchange_order_id,client_order_id,request_payload,created_at,updated_at) values('55555555-5555-4555-8555-555555555555',$1,$2,'CASEUSDT','OPEN_LONG','FILLED',$3,'tb-v11e-case',$4,$5,$5)",
  [signal,target,entryOrder,{order:{side:'BUY',position_side:'LONG',position_effect:'OPEN'}},entryAt]);
 await pg.query("insert into exchange_trade_fills(exchange,account_scope,market,exchange_trade_id,exchange_order_id,side,price,quantity,quote_amount,fee_quote_amount,realized_pnl_quote,accounting_status,source,executed_at) values ('binance_futures','futures','CASEUSDT',700000012,$1,'SELL',.01503,100,1.503,.001,-.031,'UNMATCHED_INVENTORY','UNCLASSIFIED',$2)",[exitOrder,exitAt]);
 const id=await incident(pg,'UNEXPLAINED_EXPOSURE'),updated=(await pg.query('select updated_at from v11_long_regime_positions where id=$1',[target])).rows[0].updated_at;
 const evidence={version:'V18-DB-ONLY-EVIDENCE-1',classification:'VERIFIED_EXTERNAL_OR_UNATTRIBUTED_CLOSE',exchange:'binance_futures',accountScope:'futures',
  targetPositionId:target,targetSignalId:signal,targetUpdatedAt:updated,targetRemainingQuantity:100,symbol:'CASEUSDT',entryOrderId:entryOrder,
  sourcePositionId:null,laneOrderId:null,exchangeOrderId:exitOrder,clientOrderId:client,algoId:null,tradeIds:['700000012'],
  quantity:100,funds:1.503,exitPrice:.01503,grossPnl:-.031,exitFee:.001,closedAt:exitAt,
  order:{symbol:'CASEUSDT',orderId:exitOrder,clientOrderId:client,side:'SELL',positionSide:'BOTH',reduceOnly:'true',type:'MARKET',status:'FILLED',origQty:100,executedQty:100,avgPrice:.01503,cumQuote:1.503,time:ms-1000,updateTime:ms-1000},
  algo:null,portfolioObservation:{id:'sql-flat-external',source:'BINANCE_ACCOUNT_REST',requested_at_ms:ms,received_at_ms:ms},ordersObservedAt:ms,strategyExit:false};
 const settled=(await pg.query('select v18_settle_db_only_exit($1,$2,1,$3,$4) result',[OWNER,id,target,evidence])).rows[0].result;
 assert.equal(settled.settled,true);assert.equal(settled.recoveryEligible,false);assert.equal(Number(settled.realizedPnlUsdt),-.033);
 const position=(await pg.query('select state,remaining_quantity,exit_reason,metadata from v11_long_regime_positions where id=$1',[target])).rows[0];
 assert.equal(position.state,'CLOSED');assert.equal(position.remaining_quantity,'0');assert.equal(position.exit_reason,'EXTERNAL_OR_UNATTRIBUTED_CLOSE');
 assert.equal(position.metadata.v18ExternalExit.strategyExit,false);
 assert.deepEqual((await pg.query('select v17_position_id,accounting_status,source from exchange_trade_fills')).rows[0],
  {v17_position_id:target,accounting_status:'ACCOUNTED',source:'UNCLASSIFIED'});
 assert.equal((await observe(pg,id,1,'external-not-recoverable')).reason,'MANUAL_REVIEW_REQUIRED');
 assert.equal((await pg.query('select circuit_open from v11_long_regime_runtime')).rows[0].circuit_open,true);await pg.close();
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
