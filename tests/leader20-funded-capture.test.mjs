import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
test('PostgreSQL capture follows actual entry capital while preserving exit watches',async t=>{
 const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href),db=new PGlite();t.after(()=>db.close());
 const q=async(s,a=[]) => (await db.query(s,a)).rows;
 const slot=Math.floor(Date.now()/600000)*600000,iso=x=>new Date(x).toISOString();
 await db.exec("create table test_clock(at timestamptz);create function test_now() returns timestamptz language sql as 'select at from public.test_clock';");
 await q('insert into test_clock values($1)',[iso(slot-150000)]);
 const load=async p=>db.exec((await read(p)).replaceAll('clock_timestamp()','public.test_now()'));
 await load('test-support/leader20-ledger-schema.sql');
 await load('supabase/migrations/20260928012054_leader20_batch_provider_ledger.sql');
 await db.exec(`alter table leader20_control add column clock_capture_enabled boolean default true;
 create table leader20_epochs(id uuid primary key,snapshot jsonb);
 create table test_watch(symbol text,roles jsonb);
 insert into test_watch values('C0USDT','["SCANNER_LEADER"]'),('HELDUSDT','["SCANNER_LEADER","OPEN_POSITION"]'),('BTCUSDT','["MARKET_SENSOR"]');
 create function doa_capture_rpc_before_clock(text,jsonb) returns jsonb language sql as $$
  select jsonb_build_object('enabled',true,'watch',(select coalesce(jsonb_agg(to_jsonb(w)),'[]') from public.test_watch w),'action',$1,'body',$2)
 $$;
 create function doa_capture_rpc(text,jsonb default '{}') returns jsonb language sql as 'select doa_capture_rpc_before_clock($1,$2)';`);
 await load('supabase/migrations/20260928122619_leader20_funded_capture.sql');
 const epoch=crypto.randomUUID();
 await q("insert into leader20_control(singleton,epoch_id,generation,observation_enabled,active_strategy) values(true,$1,4,true,'LEADER20_DYNAMIC_1')",[epoch]);
 await q('insert into leader20_epochs values($1,$2)',[epoch,{capture_slot_ms:slot}]);
 await q("insert into trading_account_snapshots values('binance_futures',$1,true,0,'[]')",[iso(slot-150000)]);
 const watch=async()=> (await q("select doa_capture_rpc('watch','{}') r"))[0].r;
 const symbols=w=>w.watch.map(x=>x.symbol).sort();
 const balance=amount=>q('update trading_account_snapshots set available_quote=$1,captured_at=test_now(),positions_complete=true',[amount]);
 const at=async ms=>{await q('update test_clock set at=$1',[iso(ms)]);await q('update trading_account_snapshots set captured_at=test_now()');};
 await t.test('below actual fee-inclusive minimum retains only held roles, including held BTC',async()=>{
  await balance('152.121374');const w=await watch();assert.equal(w.entry_capture.funded,false);assert.deepEqual(symbols(w),['HELDUSDT']);
  await db.exec("update test_watch set roles='[\"MARKET_SENSOR\",\"OPEN_POSITION\"]' where symbol='BTCUSDT'");
  assert.deepEqual(symbols(await watch()),['BTCUSDT','HELDUSDT']);
  await db.exec("update test_watch set roles='[\"MARKET_SENSOR\"]' where symbol='BTCUSDT'");
 });
 await t.test('no capital and no holdings produces an empty watch without stopping control heartbeats',async()=>{
  await db.exec('begin');try{
   await db.exec("delete from test_watch where symbol='HELDUSDT'");
   const w=await watch();assert.equal(w.enabled,true);assert.deepEqual(w.watch,[]);
  }finally{await db.exec('rollback');}
 });
 await t.test('exact existing capital minimum admits preparation and the full capture interval',async()=>{
  await balance('152.121375');const w=await watch();assert.equal(w.entry_capture.funded,true);assert.equal(w.entry_capture.enabled,true);
  assert.deepEqual(symbols(w),['BTCUSDT','C0USDT','HELDUSDT']);
  await at(slot-120000);assert.equal((await watch()).entry_capture.enabled,true);
 });
 await t.test('capital loss closes candidate capture; recovery in the same window waits for the next window',async()=>{
  await at(slot-90000);await balance(10);assert.deepEqual(symbols(await watch()),['HELDUSDT']);
  await balance(500);const w=await watch();assert.equal(w.entry_capture.enabled,false);assert.equal(w.entry_capture.reason,'WAITING_FOR_NEXT_CAPTURE_WINDOW');
  assert.deepEqual(symbols(w),['BTCUSDT','HELDUSDT']);
  await at(slot+450000);await q('update leader20_epochs set snapshot=$1',[{capture_slot_ms:slot+600000}]);
  assert.equal((await watch()).entry_capture.enabled,true);
  await at(slot+600001);assert.equal((await watch()).entry_capture.enabled,true);
  await at(slot+601000);assert.equal((await watch()).entry_capture.enabled,false);
  assert.deepEqual(symbols(await watch()),['BTCUSDT','HELDUSDT']);
 });
 await t.test('reserved capital, stale account and unreadable balance cannot open entry streams',async()=>{
  await at(slot+450000);await balance(500);
  await db.exec("insert into v11_long_regime_orders(state,response_payload,intent) values('PLANNED','{}','OPEN_LONG')");
  assert.deepEqual(symbols(await watch()),['HELDUSDT']);await db.exec('delete from v11_long_regime_orders');
  await q('update trading_account_snapshots set captured_at=$1',[iso(slot)]);
  assert.deepEqual(symbols(await watch()),['HELDUSDT']);
  await balance(null);assert.deepEqual(symbols(await watch()),['HELDUSDT']);
 });
 await t.test('non-watch actions and disabled clock preserve the existing RPC; public callers remain denied',async()=>{
  const r=(await q("select doa_capture_rpc('ingest','{\"batch_id\":\"fixture\"}') r"))[0].r;
  assert.equal(r.action,'ingest');assert.equal(r.body.batch_id,'fixture');assert.equal(r.entry_capture,undefined);
  await db.exec('update leader20_control set clock_capture_enabled=false');assert.equal((await watch()).entry_capture,undefined);
  await db.exec('set role anon');await assert.rejects(watch(),/permission denied/);await db.exec('reset role');
 });
});
