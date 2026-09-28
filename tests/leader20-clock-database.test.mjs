import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {buildBatch} from '../supabase/functions/_shared/leader20/batch.mjs';
import {validateCapture120} from '../supabase/functions/_shared/gpt-final-decision/capture-context.mjs';
import {selectEpoch} from '../supabase/functions/_shared/leader20/universe.mjs';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');

test('PostgreSQL fixed cutoff, 20-member claim, duplicate admission, expiry and held delegation',async t=>{
 const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href),db=new PGlite();t.after(()=>db.close());
 const q=async(s,a=[]) => (await db.query(s,a)).rows;
 const rpc=async(n,a=[]) => (await q(`select public.${n}(${a.map((_,i)=>'$'+(i+1)).join(',')}) r`,a))[0].r;
 // Inject only the wall clock; every production SQL predicate/body remains unchanged.
 await db.exec("create table public.test_clock(at timestamptz);create function public.test_now() returns timestamptz language sql as 'select at from public.test_clock';");
 const slot=Math.floor(Date.now()/600000)*600000,iso=x=>new Date(x).toISOString();
 await q('insert into test_clock values($1)',[iso(slot+10000)]);
 const load=async p=>db.exec((await read(p)).replaceAll('clock_timestamp()','public.test_now()').replaceAll('now()','public.test_now()').replaceAll('public.test_public.test_now()','public.test_now()'));
 await load('test-support/leader20-ledger-schema.sql');
 await load('supabase/migrations/20260928012054_leader20_batch_provider_ledger.sql');
 await load('test-support/leader20-clock-schema.sql');
 await load('test-support/leader20-production-baseline.sql');
 await load('supabase/migrations/20260928032022_leader20_campaign_execution_lifecycle.sql');
 await load('supabase/migrations/20260928040914_leader20_strict_ten_minute_batch.sql');
 await load('supabase/migrations/20260928114749_leader20_clock_capture_top20.sql');
 await load('supabase/migrations/20260928122619_leader20_funded_capture.sql');
 const epoch=crypto.randomUUID();
 await q("insert into leader20_control(singleton,epoch_id,generation,observation_enabled,active_strategy,clock_capture_enabled) values(true,$1,3,true,'LEADER20_DYNAMIC_1',true)",[epoch]);
 await q('insert into leader20_epochs(id,next_refresh_at,snapshot) values($1,$2,$3)',[epoch,iso(slot+420000),{capture_slot_ms:slot}]);
 await q("insert into doa_capture.control values(1,true,true,true,$1,$2)",[iso(slot+86400000),iso(slot+10000)]);
 await q("insert into trading_account_snapshots values('binance_futures',$1,true,500,'[]')",[iso(slot+10000)]);
 await db.exec(`update leader20_batch_control set enabled=true,release_receipt='{"budget_verified":true,"recall_verified":true,"concurrency_verified":true,"protection_verified":true}'`);
 for(let i=0;i<20;i++){
  await q('insert into leader20_members(epoch_id,symbol,rank) values($1,$2,$3)',[epoch,`C${i}USDT`,i+1]);
  await q('insert into leader20_campaigns(symbol,epoch_id) values($1,$2)',[`C${i}USDT`,epoch]);
 }
 for(let i=0;i<26;i++){
  const at=slot-120000+i*5000,end=at+100,mid=1+i*.001;
  const payload={interval_start:iso(end-5000),interval_end:iso(end),interval_ms:5000,exchange_at:iso(end-200),received_at:iso(end-100),
   flow_causal:true,trade_event_at:iso(end-150),trade_received_at:iso(end-100),bucket_complete:true,book_complete:true,trade_sequence_complete:true,coverage_25:true,mid,spread_bps:2,
   ask_25_usdt:10000,bid_25_usdt:11000,trade_count:10,buy_quote_5s:100,sell_quote_5s:60,
   displayed_ask_added_5s:50,displayed_ask_removed_5s:30,displayed_bid_added_5s:40,displayed_bid_removed_5s:20,
   buy_vwap_450:mid*1.002,sell_vwap_450:mid*.998,btc_return_1m:.002};
  await q("insert into doa_capture.live_micro select 'micro',symbol,$1,$2,$3 from leader20_members",[iso(at),iso(end+100),payload]);
 }
 const get=(symbol='C0USDT',at=slot+10000)=>rpc('doa_context_for_role_v1',[symbol,iso(at),'TRADE_CANDIDATE',null]);
 let packet,batch;
 await t.test('31.442s delivery jitter admits once; 60s cutoff and original 120s expiry stay fixed',async()=>{
  await q('update test_clock set at=$1',[iso(slot+31442)]);
  const rows=await Promise.all(Array.from({length:20},async(_,i)=>({symbol:`C${i}USDT`,rank:i+1,capture:await get(`C${i}USDT`,slot+27000)})));
  const delayed=await buildBatch(rows,{asOf:slot+27000,epochId:epoch,generation:3});
  assert.equal((await rpc('leader20_batch_claim',[delayed,'old-cutoff',false])).reason,'CLOCK_BATCH_NOT_DUE');
  await load('supabase/migrations/20260928134337_clock_batch_dispatch_jitter.sql');
  await db.exec('begin');
  const claim=await rpc('leader20_batch_claim',[delayed,'jitter',false]);
  assert.equal(claim.created,true,JSON.stringify(claim));
  assert.equal(claim.row.packet.entry_window.expires_at_ms,slot+120000);
  assert.equal((await rpc('leader20_batch_claim',[delayed,'duplicate',false])).reason,'NOT_DUE');
  await q('update test_clock set at=$1',[iso(slot+60000)]);
  assert.equal((await rpc('leader20_batch_claim',[delayed,'too-late',false])).reason,'CLOCK_BATCH_NOT_DUE');
  await db.exec('rollback');
  await q('update test_clock set at=$1',[iso(slot+10000)]);
 });
 await t.test('post-boundary observations cannot move the frozen path; gaps and future receipts still fail',async()=>{
  const c=await get();assert.equal(c.status,'AVAILABLE',JSON.stringify(c));
  assert.equal(c.trajectory.at(-1).bucket_ms,slot);assert.equal(c.trajectory[0].bucket_ms,slot-115000);
  assert.equal(validateCapture120(c,slot+60000).status,'AVAILABLE');
  await db.exec('begin');await q("delete from doa_capture.live_micro where symbol='C0USDT' and at=$1",[iso(slot-50000)]);
  assert.notEqual((await get()).status,'AVAILABLE');await db.exec('rollback');
  await db.exec('begin');await q("update doa_capture.live_micro set received_at=$1 where symbol='C0USDT' and at=$2",[iso(slot+20000),iso(slot)]);
  assert.notEqual((await get()).status,'AVAILABLE');await db.exec('rollback');
 });
 await t.test('held and sensor reads keep the existing live role; idle watches exclude other symbols',async()=>{
  const id=crypto.randomUUID();assert.equal((await rpc('doa_context_for_role_v1',['HELDUSDT',iso(slot+10000),'OPEN_POSITION',id])).position_id,id);
  assert.equal((await rpc('doa_context_for_role_v1',['BTCUSDT',iso(slot+10000),'MARKET_SENSOR',null])).delegated_role,'MARKET_SENSOR');
  const watch=await rpc('doa_capture_rpc',['watch',{}]);assert.deepEqual(watch.watch.map(x=>x.symbol),['HELDUSDT','BTCUSDT']);
 });
 await t.test('twenty distinct members bind exact evidence and claim a slot only once',async()=>{
  const rows=await Promise.all(Array.from({length:20},async(_,i)=>({symbol:`C${i}USDT`,rank:i+1,capture:await get(`C${i}USDT`)})));
  packet=await buildBatch(rows,{asOf:slot+10000,epochId:epoch,generation:3});
  await assert.rejects(rpc('leader20_batch_claim',[{...packet,symbols:packet.symbols.slice(0,10)},'bad',false]),/BATCH_MEMBERSHIP/);
  const tampered=structuredClone(packet);tampered.symbols[0].entry_window.capture_hash='changed';
  await assert.rejects(rpc('leader20_batch_claim',[tampered,'changed',false]),/CLOCK_BATCH_CAPTURE_BINDING/);
  const claim=await rpc('leader20_batch_claim',[packet,'good',false]);assert.equal(claim.created,true,JSON.stringify(claim));batch=claim.row;
  assert.equal((await rpc('leader20_batch_claim',[packet,'same',true])).reason,'NOT_DUE');
 });
 await t.test('materialization binds slot, expires at minute two, and cannot grant the next cycle',async()=>{
  const advice={id:'C0USDT',version:packet.symbols[0].data_version,last_ms:packet.symbols[0].last_ms,decision:'WAIT',valid:true};
  await q("update leader20_batches set state='DONE' where id=$1",[batch.id]);
  const event=(await q("insert into leader20_review_events(epoch_id,symbol,generation,requested_at,snapshot_end_ms,snapshot_hash,result) values($1,'C0USDT',3,$2,$3,'test',$4) returning id",[epoch,iso(slot+10000),slot+100,{batch_id:batch.id,batch_advice:advice}]))[0].id;
  const c=await get(),f={referenceClose:1,execution_snapshot:{complete:true,causal:true,bucket_count:24,end_ms:c.end_ms,entry_window:c.entry_window,trajectory_hash:'hash'}};
  const made=await rpc('leader20_materialize_event',[event,f]);assert.equal(made.created,true,JSON.stringify(made));
  const signal=(await q('select * from v11_long_regime_signals where id=$1',[made.signal_id]))[0];
  assert.equal(signal.features.leader20.expires_at_ms,slot+120000);
  assert.equal((await rpc('leader20_entry_authority',[made.signal_id])).allowed,true);
  await q('update test_clock set at=$1',[iso(slot+120000)]);
  assert.equal((await get('C0USDT',slot+120000)).reason,'CLOCK_OUTSIDE_ENTRY_WINDOW');
  assert.equal((await rpc('leader20_entry_authority',[made.signal_id])).allowed,false);
 });
 await t.test('service-only RPCs cannot be called by anonymous clients',async()=>{
  await db.exec('set role anon');await assert.rejects(get(),/permission denied/);await db.exec('reset role');
 });
 await t.test('next preparation publishes all twenty current ranks atomically and rejects a duplicate refresh',async()=>{
  const at=slot+421000;await q('update test_clock set at=$1',[iso(at)]);
  const symbols=Array.from({length:25},(_,i)=>({symbol:`N${i}USDT`,status:'TRADING',contractType:'PERPETUAL',quoteAsset:'USDT',marginAsset:'USDT',underlyingType:'COIN'}));
  const snapshot=await selectEpoch({exchangeInfo:{symbols},tickers:symbols.map((s,i)=>({symbol:s.symbol,priceChangePercent:String(i),quoteVolume:'100',openTime:at-86400000,closeTime:at})),requestedAt:at,observedAt:at,clock:true});
  const published=await rpc('leader20_publish_epoch',[snapshot,epoch]);assert.equal(published.published,true);
  assert.equal((await q('select count(*)::int n from leader20_members where epoch_id=$1',[published.epoch_id]))[0].n,20);
  assert.equal((await rpc('leader20_publish_epoch',[snapshot,epoch])).reason,'EPOCH_RACE');
  await assert.rejects(rpc('leader20_publish_epoch',[snapshot,published.epoch_id]),/EPOCH_NOT_DUE/);
 });
});
