import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {evaluateModule,mockDb} from './harness.mjs';
const version='DETERMINISTIC_DYNAMIC_STATE_1',migration=fs.readFileSync(new URL('../../supabase/migrations/20261004102700_deterministic_position_nullable_atr.sql',import.meta.url),'utf8');
async function schema(){const pg=new PGlite();await pg.exec(`create table v11_long_regime_positions(entry_atr numeric,metadata jsonb);
 alter table v11_long_regime_positions add constraint leader20_nullable_atr check(entry_atr is not null or coalesce(metadata#>>'{entryFeatures,leader20,version}'='LEADER20_DYNAMIC_1',false)) not valid;`);return pg;}
test('real deterministic filled-entry settlement can store its intentionally null legacy ATR',async()=>{
 const pg=await schema(),at=Date.now();let position;
 const signal={id:'signal',symbol:'TESTUSDT',features:{strategy:'LEADER_MOMENTUM_V17',exitPolicy:{stopPct:.025},deterministic:{version}}},
 intent={id:'intent',signal_id:signal.id,symbol:signal.symbol,requested_quantity:4.5,client_order_id:'entry',request_payload:{order:{side:'BUY',position_effect:'OPEN'},deterministic:{version}}};
 const {db}=mockDb(q=>{
  if(q.table==='v11_long_regime_signals')return {data:signal};
  if(q.table==='v11_long_regime_positions'){if(q.op==='insert')position={...q.patch,id:'position'};return {data:position??null};}
  return {data:true};
 }),h=await evaluateModule();h.ctx.verifyExecutionLease=async()=>{};h.ctx.manualPositionAllowances=async()=>[];
 const raw={orderId:'123',clientOrderId:'entry',symbol:signal.symbol,side:'BUY',reduceOnly:false,positionSide:'BOTH',status:'FILLED',origQty:'4.5',executedQty:'4.5',avgPrice:'100',updateTime:at,fills:[{id:1,qty:4.5,price:100,commission:.225,commissionAsset:'USDT',time:at}]},
 portfolio={exchange:'binance_futures',account_scope:'futures',positions_complete:true,positions:[{market:signal.symbol,quantity:4.5,side:'LONG'}],observation:{id:crypto.randomUUID(),source:'BINANCE_ACCOUNT_REST',requested_at_ms:at,received_at_ms:at}};
 await h.ctx.settleKnownEntry(db,intent,raw,async()=>portfolio);
 assert.equal(position.entry_atr,null);assert.equal(position.hard_stop_price,97.5);
 const insert=()=>pg.query('insert into v11_long_regime_positions values($1,$2)',[position.entry_atr,position.metadata]);
 await assert.rejects(insert,/leader20_nullable_atr/);await pg.exec(migration);await insert();await pg.close();
});
test('nullable ATR keeps the legacy allowance and rejects absent or conflicting deterministic provenance',async()=>{
 const pg=await schema();await pg.exec(migration);
 const insert=(atr,metadata)=>pg.query('insert into v11_long_regime_positions values($1,$2)',[atr,metadata]);
 await insert(2,{});await insert(null,{entryFeatures:{leader20:{version:'LEADER20_DYNAMIC_1'}}});
 for(const metadata of [{},{entryFeatures:{deterministic:{version}}},{deterministicEntry:{version}},{entryFeatures:{deterministic:{version}},deterministicEntry:{version:'OLD'}}])await assert.rejects(()=>insert(null,metadata),/leader20_nullable_atr/);
 await pg.close();
});
