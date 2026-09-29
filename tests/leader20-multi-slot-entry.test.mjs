import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {buildBatch} from '../supabase/functions/_shared/leader20/batch.mjs';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const MIGRATION='supabase/migrations/20260928161500_leader20_multi_slot_entry_continuity.sql';
const REVIEW_ALL_MIGRATION='supabase/migrations/20260929104932_leader20_review_all_ready_before_capacity.sql';
// Production sizing authority, unchanged and read (not redefined) by the migration.
const SLOT_COST=152.021375,BUFFER=.10,MAX_SLOTS=10,ARM_LEAD_MS=25000;
const ARM_DEADLINE=slot=>slot-120000-ARM_LEAD_MS;
const marginFor=n=>n*SLOT_COST+BUFFER;

// Every production SQL body is loaded verbatim; only the wall clock is injected.
async function harness(t,{slot,at,watch}){
 const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href),db=new PGlite();
 t.after(()=>db.close());
 const q=async(s,a=[])=>(await db.query(s,a)).rows;
 const rpc=async(n,a=[])=>(await q(`select public.${n}(${a.map((_,i)=>'$'+(i+1)).join(',')}) r`,a))[0].r;
 const iso=x=>new Date(x).toISOString();
 await db.exec("create table public.test_clock(at timestamptz);create function public.test_now() returns timestamptz language sql as 'select at from public.test_clock';");
 await q('insert into test_clock values($1)',[iso(at)]);
 const load=async p=>db.exec((await read(p)).replaceAll('clock_timestamp()','public.test_now()')
  .replaceAll('now()','public.test_now()').replaceAll('public.test_public.test_now()','public.test_now()'));
 await load('test-support/leader20-ledger-schema.sql');
 await db.exec(`alter table gpt_final_entry_reviews add column completed_at timestamptz,
  add column api_started_at timestamptz,add column api_completed_at timestamptz,add column decision text;
  alter table v11_long_regime_signals alter column id set default gen_random_uuid();`);
 await load('supabase/migrations/20260928012054_leader20_batch_provider_ledger.sql');
 await load('test-support/leader20-clock-schema.sql');
 // The clock fixture's watch RPC becomes this suite's configurable pre-clock watch source;
 // 20260928114749 renames it to doa_capture_rpc_before_clock exactly as it does in production.
 await db.exec(`create table test_watch(ord int,symbol text,roles jsonb);
  create or replace function doa_capture_rpc(text,jsonb default '{}') returns jsonb language sql as $$
   select jsonb_build_object('enabled',true,'action',$1,'body',$2,
    'watch',(select coalesce(jsonb_agg(jsonb_build_object('symbol',symbol,'roles',roles) order by ord),'[]'::jsonb) from public.test_watch))
  $$;`);
 for(const [i,w] of watch.entries())await q('insert into test_watch values($1,$2,$3)',[i,w.symbol,w.roles]);
 await load('test-support/leader20-production-baseline.sql');
 await load('supabase/migrations/20260928032022_leader20_campaign_execution_lifecycle.sql');
 await load('supabase/migrations/20260928040914_leader20_strict_ten_minute_batch.sql');
 await load('supabase/migrations/20260928114749_leader20_clock_capture_top20.sql');
 await load('supabase/migrations/20260928122619_leader20_funded_capture.sql');
 await load('supabase/migrations/20260928134337_clock_batch_dispatch_jitter.sql');
 await load('supabase/migrations/20260928135658_clock_frozen_handoff.sql');
 await load('supabase/migrations/20260928145300_clock_completion_telemetry.sql');
 await load('supabase/migrations/20260928151000_clock_entry_only_telemetry.sql');
 const epoch=crypto.randomUUID();
 await q("insert into leader20_control(singleton,epoch_id,generation,observation_enabled,active_strategy,clock_capture_enabled) values(true,$1,3,true,'LEADER20_DYNAMIC_1',true)",[epoch]);
 await q('insert into leader20_epochs(id,next_refresh_at,snapshot) values($1,$2,$3)',[epoch,iso(slot+420000),{capture_slot_ms:slot}]);
 await q('insert into doa_capture.control values(1,true,true,true,$1,$2)',[iso(slot+86400000),iso(at)]);
 await db.exec(`update leader20_batch_control set enabled=true,release_receipt='{"budget_verified":true,"recall_verified":true,"concurrency_verified":true,"protection_verified":true}'`);
 const tick=async ms=>{await q('update test_clock set at=$1',[iso(ms)]);};
 const fund=async(quote,capturedAt)=>{
  await q('delete from trading_account_snapshots');
  await q("insert into trading_account_snapshots values('binance_futures',$1,true,$2,'[]')",[iso(capturedAt??(await q('select at from test_clock'))[0].at.getTime?.()??Date.now()),quote]);
 };
 return {db,q,rpc,iso,load,tick,epoch,
  fundAt:async(quote,capturedAt)=>{await q('delete from trading_account_snapshots');
   await q("insert into trading_account_snapshots values('binance_futures',$1,true,$2,'[]')",[iso(capturedAt),quote]);},
  fund,watch:async()=>rpc('doa_capture_rpc',['watch',{}]),
  capacity:async()=>rpc('leader20_batch_capacity')};
}
const symbolsOf=w=>w.watch.map(x=>x.symbol).sort();
const TOP20=Array.from({length:20},(_,i)=>`C${i}USDT`);

test('00:50 incident replay: a late Top20 publication no longer costs the whole slot',async t=>{
 const slot=Math.floor(Date.now()/600000)*600000+600000;
 const previous=slot-600000;
 // The collector polls the watch RPC every 15 seconds. These are the four polls that fall in
 // the 00:50 preparation window; the epoch for this slot publishes at T-130s (a 50s lag,
 // exactly as recorded for the 00:50, 01:00 and 01:20 KST slots on 2026-09-29).
 const POLLS=[slot-178000,slot-163000,slot-148000,slot-133000,slot-118000];
 const EPOCH_PUBLISHED_AT=slot-130000;
 const h=await harness(t,{slot,at:POLLS[0],
  watch:[...TOP20.map(s=>({symbol:s,roles:['SCANNER_LEADER']})),{symbol:'HBARUSDT',roles:['OPEN_POSITION']},{symbol:'BTCUSDT',roles:['MARKET_SENSOR']}]});
 await h.q("insert into v11_long_regime_positions(symbol,state,remaining_quantity,metadata) values('HBARUSDT','OPEN',1,'{}')");
 // Until it publishes, leader20_control still points at the previous, already-closed slot.
 const rewindEpoch=async()=>{await h.q('update leader20_epochs set snapshot=$1',[{capture_slot_ms:previous}]);
  await h.q('update leader20_control set entry_capture_slot_ms=null');};
 // Two affordable slots beside the held HBAR position.
 const step=async at=>{
  await h.tick(at);await h.fundAt(marginFor(2),at);
  if(at>=EPOCH_PUBLISHED_AT)await h.q('update leader20_epochs set snapshot=$1',[{capture_slot_ms:slot}]);
  return h.watch();
 };

 await t.test('the recorded outcome reproduces exactly on the migration in production today',async()=>{
  await rewindEpoch();
  const seen=[];
  for(const at of POLLS){const w=await step(at);seen.push({at:at-slot,enabled:w.entry_capture.enabled,symbols:symbolsOf(w)});}
  // Before publication the RPC reports the PREVIOUS slot, whose capture window closed long ago:
  // captureDisposition() has connect=false, so the collector holds no candidate stream at all.
  for(const x of seen.slice(0,4)){
   assert.equal(x.enabled,false,'no entry capture at T'+x.at);
   assert.deepEqual(x.symbols,['BTCUSDT','HBARUSDT'],'BTCUSDT + HBARUSDT only: the recorded archive');
  }
  // The 10-second gap between publication (T-130s) and the end of the arming band (T-120s)
  // falls between two polls, so the slot is never armed at all.
  assert.equal(seen[4].enabled,false);
  assert.equal(seen[4].symbols.length,2);
  const stuck=(await h.watch()).entry_capture;
  assert.equal(stuck.reason,'WAITING_FOR_NEXT_CAPTURE_WINDOW');
 });

 await t.test('after the fix the first poll of the window already holds all twenty candidates',async()=>{
  await h.load(MIGRATION);
  await rewindEpoch();
  const expected=[...TOP20,'BTCUSDT','HBARUSDT'].sort();
  for(const at of POLLS){
   const w=await step(at);
   assert.equal(w.entry_capture.enabled,true,'armed from the clock at T'+(at-slot)+': '+JSON.stringify(w.entry_capture));
   assert.equal(Number(w.entry_window.slot_ms),slot,'the entry window is the clock slot, not the published epoch');
   assert.equal(w.entry_capture.epoch_published,at>=EPOCH_PUBLISHED_AT,'publication lag stays visible');
   assert.deepEqual(symbolsOf(w),expected,
    'HBAR open-position capture + BTC market sensor + Top20 entry capture, together');
  }
  // ...and it holds through the whole 120-second path to the boundary.
  for(const at of [slot-60000,slot-1,slot]){
   const w=await step(at);
   assert.equal(w.entry_capture.enabled,true,'armed at T'+(at-slot));
   assert.deepEqual(symbolsOf(w),expected);
  }
 });

 await t.test('a live entry order takes one slot, not the account',async()=>{
  await rewindEpoch();
  await h.q("insert into v11_long_regime_orders(symbol,state,intent,response_payload) values('HBARUSDT','RECONCILIATION_PENDING','OPEN_LONG','{}')");
  const w=await step(POLLS[0]);
  const cap=await h.capacity();
  assert.equal(cap.open_positions,1);assert.equal(cap.pending_entry_orders,1);assert.equal(cap.certain,true);
  assert.equal(cap.available,1,'two funded slots minus the one the live order holds');
  assert.equal(w.entry_capture.enabled,true,'a settling fill does not end the batch');
  assert.deepEqual(symbolsOf(w),[...TOP20,'BTCUSDT','HBARUSDT'].sort());
  await h.q('delete from v11_long_regime_orders');
 });

 await t.test('an armed path survives a lost account read, and still admits no order',async()=>{
  await rewindEpoch();
  await step(POLLS[0]);
  for(const at of [POLLS[2],slot-60000,slot]){
   await h.tick(at);await h.q('update trading_account_snapshots set captured_at=$1',[h.iso(slot-400000)]);
   const w=await h.watch();
   assert.equal(w.entry_capture.certain,false);
   assert.equal(w.entry_capture.enabled,true,'CAPACITY_UNCERTAIN holds the armed path at T'+(at-slot));
   assert.deepEqual(symbolsOf(w),[...TOP20,'BTCUSDT','HBARUSDT'].sort());
  }
  const refused=await h.rpc('leader20_reserve_entry_slot',['C0USDT',slot,null,h.iso(slot+120000)]);
  assert.equal(refused.reserved,false);
  assert.equal(refused.reason,'ACCOUNT_SNAPSHOT_STALE_OR_INCOMPLETE');
  // Uncertainty can never CREATE an admission for a slot that was not armed in time.
  await h.q('update leader20_control set entry_capture_slot_ms=null');
  const w=await h.watch();
  assert.equal(w.entry_capture.enabled,false);
  assert.equal(w.entry_capture.reason,'CAPACITY_UNCERTAIN');
 });
});

test('slots are an entry ceiling, never a reason to stop scanning',async t=>{
 const slot=Math.floor(Date.now()/600000)*600000+600000;
 const h=await harness(t,{slot,at:slot-170000,
  watch:[...TOP20.map(s=>({symbol:s,roles:['SCANNER_LEADER']})),{symbol:'BTCUSDT',roles:['MARKET_SENSOR']}]});
 await h.load(MIGRATION);
 const held=async(...symbols)=>{
  await h.q('delete from v11_long_regime_positions');await h.q('delete from test_watch where roles ? $1',['OPEN_POSITION']);
  for(const [i,s] of symbols.entries()){
   await h.q("insert into v11_long_regime_positions(symbol,state,remaining_quantity,metadata) values($1,'OPEN',1,'{}')",[s]);
   await h.q('insert into test_watch values($1,$2,$3)',[100+i,s,['OPEN_POSITION']]);
  }
 };
 const arm=async(openSymbols,extraSlots,when=slot-170000)=>{
  await held(...openSymbols);await h.tick(when);await h.fundAt(marginFor(extraSlots),when);
  await h.q('update leader20_control set entry_capture_slot_ms=null');
  return h.watch();
 };
 await t.test('TEST A: OPEN=0, AVAILABLE=3 -> entry capture on, three new positions allowed',async()=>{
  const w=await arm([],3);const cap=await h.capacity();
  assert.equal(cap.open_positions,0);assert.equal(cap.available,3);assert.equal(cap.available_for_new_entry,3);
  assert.equal(w.entry_capture.enabled,true);
  assert.deepEqual(symbolsOf(w),[...TOP20,'BTCUSDT'].sort());
 });
 await t.test('TEST B: OPEN=1, AVAILABLE=2 -> the held symbol never costs the other two slots',async()=>{
  const w=await arm(['HBARUSDT'],2);const cap=await h.capacity();
  assert.equal(cap.open_positions,1);assert.equal(cap.available,2);assert.deepEqual(cap.held,['HBARUSDT']);
  assert.equal(w.entry_capture.enabled,true);
  assert.deepEqual(symbolsOf(w),[...TOP20,'BTCUSDT','HBARUSDT'].sort());
 });
 await t.test('TEST C: OPEN=2, AVAILABLE=1 -> both holdings tracked, entry capture still on',async()=>{
  const w=await arm(['HBARUSDT','SOONUSDT'],1);const cap=await h.capacity();
  assert.equal(cap.open_positions,2);assert.equal(cap.available,1);
  assert.equal(w.entry_capture.enabled,true);
  assert.deepEqual(symbolsOf(w),[...TOP20,'BTCUSDT','HBARUSDT','SOONUSDT'].sort());
 });
 await t.test('TEST D: AVAILABLE=0 -> only new entry capture stops; every holding keeps capturing',async()=>{
  const w=await arm(['HBARUSDT','SOONUSDT','QNTUSDT'],0);const cap=await h.capacity();
  assert.equal(cap.open_positions,3);assert.equal(cap.available,0);
  assert.equal(cap.reason,'NO_ENTRY_CAPACITY','the reason string deployed callers compare against is unchanged');
  assert.equal(cap.capacity_detail,'INSUFFICIENT_MARGIN');
  assert.equal(w.entry_capture.enabled,false);
  assert.deepEqual(symbolsOf(w),['BTCUSDT','HBARUSDT','QNTUSDT','SOONUSDT'],
   'three independent position captures plus the sensor their exit evidence cites');
 });
 await t.test('TEST E: one position exits -> the entry pipeline resumes on the next window, unattended',async()=>{
  await arm(['HBARUSDT','SOONUSDT','QNTUSDT'],0);
  assert.equal((await h.watch()).entry_capture.enabled,false);
  // QNT exits. Nothing is reset by hand; only the account and the position table changed.
  await h.q("update v11_long_regime_positions set state='CLOSED',remaining_quantity=0 where symbol='QNTUSDT'");
  await h.q("delete from test_watch where symbol='QNTUSDT'");
  await h.tick(slot-160000);await h.fundAt(marginFor(1),slot-160000);
  const cap=await h.capacity();assert.equal(cap.open_positions,2);assert.equal(cap.available,1);
  const w=await h.watch();
  assert.equal(w.entry_capture.enabled,true,'the freed slot re-armed the same window automatically');
  assert.deepEqual(symbolsOf(w),[...TOP20,'BTCUSDT','HBARUSDT','SOONUSDT'].sort());
 });
 await t.test('TEST G: capacity 1 -> 0 -> 1 re-arms while a full 120s path is still reachable',async()=>{
  await arm([],1,slot-180000);
  assert.equal((await h.watch()).entry_capture.enabled,true);
  await h.tick(slot-170000);await h.fundAt(10,slot-170000);
  assert.equal((await h.watch()).entry_capture.enabled,false,'a confirmed zero disarms');
  assert.equal((await h.q('select entry_capture_slot_ms from leader20_control'))[0].entry_capture_slot_ms,null);
  await h.tick(ARM_DEADLINE(slot));await h.fundAt(marginFor(1),ARM_DEADLINE(slot));
  const back=await h.watch();
  assert.equal(back.entry_capture.enabled,true,'re-armed at the arming deadline');
  assert.equal(Number(back.entry_capture.armed_slot_ms),slot);
  // Past the deadline the 24-bucket path can no longer complete: defer, do not half-start.
  await h.q('update leader20_control set entry_capture_slot_ms=null');
  await h.tick(ARM_DEADLINE(slot)+1);await h.fundAt(marginFor(1),ARM_DEADLINE(slot)+1);
  const late=await h.watch();
  assert.equal(late.entry_capture.enabled,false);
  assert.equal(late.entry_capture.reason,'WAITING_FOR_NEXT_CAPTURE_WINDOW');
  // ...and the next slot arms normally, with no manual intervention.
  await h.q('update leader20_epochs set snapshot=$1',[{capture_slot_ms:slot+600000}]);
  await h.tick(slot+420000);await h.fundAt(marginFor(1),slot+420000);
  assert.equal((await h.watch()).entry_capture.enabled,true);
 });
 await t.test('an uncertain account read holds the armed capture instead of destroying it',async()=>{
  await h.q('update leader20_epochs set snapshot=$1',[{capture_slot_ms:slot}]);
  await arm([],1,slot-180000);
  assert.equal((await h.watch()).entry_capture.enabled,true);
  // A stale snapshot is not evidence that the money is gone.
  await h.tick(slot-60000);await h.fundAt(marginFor(1),slot-200000);
  let w=await h.watch();const cap=await h.capacity();
  assert.equal(cap.certain,false);assert.equal(cap.reason,'ACCOUNT_SNAPSHOT_STALE_OR_INCOMPLETE');
  assert.equal(cap.available,0);
  assert.equal(w.entry_capture.enabled,true,'CAPACITY_UNCERTAIN preserves an armed path');
  assert.equal(w.entry_capture.certain,false);
  assert.deepEqual(symbolsOf(w),[...TOP20,'BTCUSDT'].sort());
  // Uncertainty can never CREATE an admission.
  await h.q('update leader20_control set entry_capture_slot_ms=null');
  w=await h.watch();
  assert.equal(w.entry_capture.enabled,false);assert.equal(w.entry_capture.reason,'CAPACITY_UNCERTAIN');
  // An unreadable balance behaves the same way and still reports the held set.
  await h.q('update trading_account_snapshots set available_quote=null,captured_at=public.test_now()');
  const unreadable=await h.capacity();
  assert.equal(unreadable.certain,false);assert.equal(unreadable.reason,'ACCOUNT_SNAPSHOT_UNREADABLE');
  assert.deepEqual(unreadable.held,[]);
 });
});

test('capacity follows every fill, and concurrent BUY candidates cannot overbook the account',async t=>{
 const slot=Math.floor(Date.now()/600000)*600000+600000;
 const h=await harness(t,{slot,at:slot-170000,watch:[{symbol:'BTCUSDT',roles:['MARKET_SENSOR']}]});
 await h.load(MIGRATION);
 await h.fundAt(marginFor(2),slot-170000);
 const reserve=(symbol,expires=slot+120000)=>h.rpc('leader20_reserve_entry_slot',[symbol,slot,null,h.iso(expires)]);
 await t.test('TEST F: three simultaneous BUYs against two slots -> two reserve, the third is refused',async()=>{
  const cap=await h.capacity();
  assert.equal(cap.available_for_new_entry,2);assert.equal(cap.max_slots,MAX_SLOTS);
  assert.equal(Number(cap.target_margin_per_slot),SLOT_COST,'production slot cost is read, never redefined');
  const [btc,eth,sol]=await Promise.all([reserve('BTCUSDT'),reserve('ETHUSDT'),reserve('SOLUSDT')]);
  const ok=[btc,eth,sol].filter(x=>x.reserved===true),no=[btc,eth,sol].filter(x=>x.reserved!==true);
  assert.equal(ok.length,2,JSON.stringify([btc,eth,sol]));
  assert.equal(no.length,1);assert.equal(no[0].reason,'NO_ENTRY_CAPACITY');
  const after=await h.capacity();
  assert.equal(after.reserved_slots,2);
  assert.equal(after.available_for_new_entry,0,'no third position can be opened');
  assert.equal(after.available,2,'but the capture and the paid review of the two live candidates stay funded');
  assert.equal(after.reason,null,'reservations never present the account as out of capacity');
  assert.equal(after.capacity_detail,'ENTRY_SLOTS_RESERVED');
  assert.equal((await reserve('XRPUSDT')).reason,'NO_ENTRY_CAPACITY');
 });
 await t.test('a reservation is never a permanent hold: it expires, releases and is auditable',async()=>{
  assert.equal((await reserve('BTCUSDT')).reason,'SYMBOL_ALREADY_HELD','one symbol = one open position');
  // A refused order returns its slot at once.
  const live=await h.q("select id,symbol from leader20_entry_reservations where state='RESERVED' order by symbol");
  const sid=crypto.randomUUID();
  await h.q("insert into v11_long_regime_signals(id,symbol,status,features) values($1,$2,'NEW','{}')",[sid,live[0].symbol]);
  await h.rpc('leader20_bind_entry_reservation',[live[0].id,sid]);
  await h.q("insert into v11_long_regime_orders(symbol,state,intent,signal_id,response_payload) values($1,'REJECTED','OPEN_LONG',$2,'{}')",[live[0].symbol,sid]);
  const swept=await h.rpc('leader20_entry_reservation_sweep');
  assert.equal(swept.settled,1,JSON.stringify(swept));
  assert.equal((await h.q('select state,reason from leader20_entry_reservations where id=$1',[live[0].id]))[0].state,'RELEASED');
  assert.equal((await h.capacity()).available_for_new_entry,1,'the refused candidate freed its slot');
  // The surviving reservation cannot outlive its own entry window.
  await h.tick(slot+120001);await h.fundAt(marginFor(2),slot+120001);
  assert.equal((await h.capacity()).reserved_slots,0,'an unswept reservation stops counting at its deadline');
  await h.rpc('leader20_entry_reservation_sweep');
  assert.equal((await h.q("select count(*)::int n from leader20_entry_reservations where state='EXPIRED'"))[0].n,1);
 });
 await t.test('a fill decrements the remaining slots; it does not close the entry system',async()=>{
  await h.tick(slot-170000);await h.fundAt(marginFor(3),slot-170000);
  assert.equal((await h.capacity()).available_for_new_entry,3);
  // First BUY reserves, dispatches, fills.
  const first=await reserve('HBARUSDT');assert.equal(first.reserved,true);
  const sid=crypto.randomUUID();
  await h.q("insert into v11_long_regime_signals(id,symbol,status,features) values($1,'HBARUSDT','ORDERED','{}')",[sid]);
  await h.rpc('leader20_bind_entry_reservation',[first.id,sid]);
  await h.q("insert into v11_long_regime_orders(symbol,state,intent,signal_id,response_payload) values('HBARUSDT','DISPATCHED','OPEN_LONG',$1,'{}')",[sid]);
  let cap=await h.capacity();
  assert.equal(cap.pending_entry_orders,1);assert.equal(cap.available,2,'the in-flight order takes exactly one slot');
  assert.ok(cap.held.includes('HBARUSDT'),'an in-flight entry already owns its symbol');
  await h.q("update v11_long_regime_orders set state='FILLED',response_payload='{\"v18ExposureFinal\":true}' where signal_id=$1",[sid]);
  await h.q("insert into v11_long_regime_positions(symbol,state,remaining_quantity,metadata) values('HBARUSDT','OPEN',1,'{}')");
  await h.fundAt(marginFor(2),slot-170000);
  await h.rpc('leader20_entry_reservation_sweep');
  cap=await h.capacity();
  assert.equal(cap.open_positions,1);assert.equal(cap.available,2);assert.equal(cap.available_for_new_entry,2);
  assert.equal((await h.q("select state from leader20_entry_reservations where id=$1",[first.id]))[0].state,'FILLED');
  // A second BUY in the same batch still has room.
  assert.equal((await reserve('SOONUSDT')).reserved,true,'the second candidate of the same batch can still enter');
  assert.equal((await h.capacity()).available_for_new_entry,1);
 });
 await t.test('no order may ever be admitted on an uncertain account read',async()=>{
  await h.q("delete from leader20_entry_reservations");
  await h.q('update trading_account_snapshots set captured_at=$1',[h.iso(slot-400000)]);
  const refused=await reserve('ETHUSDT');
  assert.equal(refused.reserved,false);assert.equal(refused.reason,'ACCOUNT_SNAPSHOT_STALE_OR_INCOMPLETE');
  await h.q('update trading_account_snapshots set captured_at=public.test_now(),available_quote=null');
  assert.equal((await reserve('ETHUSDT')).reason,'ACCOUNT_SNAPSHOT_UNREADABLE');
 });
 await t.test('reservation and capacity RPCs remain service-role only',async()=>{
  await h.db.exec('set role anon');
  await assert.rejects(h.capacity(),/permission denied/);
  await assert.rejects(reserve('ETHUSDT'),/permission denied/);
  await assert.rejects(h.q('select * from leader20_entry_reservations'),/permission denied/);
  await h.db.exec('reset role');
 });
});

test('every open position keeps an independent 24-bucket path while entries run in parallel',async t=>{
 const slot=Math.floor(Date.now()/600000)*600000+600000;
 const positions=['HBARUSDT','SOONUSDT','QNTUSDT'];
 const h=await harness(t,{slot,at:slot-170000,
  watch:[...TOP20.map(s=>({symbol:s,roles:['SCANNER_LEADER']})),...positions.map(s=>({symbol:s,roles:['OPEN_POSITION']})),{symbol:'BTCUSDT',roles:['MARKET_SENSOR']}]});
 await h.load(MIGRATION);
 for(const s of positions)await h.q("insert into v11_long_regime_positions(id,symbol,state,remaining_quantity,metadata) values(gen_random_uuid(),$1,'OPEN',1,'{}')",[s]);
 await h.fundAt(marginFor(1),slot-170000);
 await t.test('three holdings and the Top20 entry capture are watched at the same time',async()=>{
  const w=await h.watch();
  assert.equal(w.entry_capture.enabled,true);
  assert.deepEqual(symbolsOf(w),[...TOP20,...positions,'BTCUSDT'].sort());
  assert.equal((await h.capacity()).open_positions,3);
 });
 await t.test('each position resolves its own context; one symbol failing does not touch the others',async()=>{
  const ids=await h.q('select id,symbol from v11_long_regime_positions order by symbol');
  for(const p of ids){
   const c=await h.rpc('doa_context_for_role_v1',[p.symbol,h.iso(slot-170000),'OPEN_POSITION',p.id]);
   assert.equal(c.position_id,p.id,'independent per-position read for '+p.symbol);
  }
  // A closed position stops resolving; the other two are unaffected.
  await h.q("update v11_long_regime_positions set state='CLOSED',remaining_quantity=0 where symbol='QNTUSDT'");
  const qnt=ids.find(p=>p.symbol==='QNTUSDT');
  for(const p of ids.filter(x=>x.symbol!=='QNTUSDT'))
   assert.equal((await h.rpc('doa_context_for_role_v1',[p.symbol,h.iso(slot-170000),'OPEN_POSITION',p.id])).position_id,p.id);
  assert.ok(qnt.id);
  // ...and the freed slot is offered to new entries, not withheld.
  await h.fundAt(marginFor(2),slot-170000);
  const cap=await h.capacity();
  assert.equal(cap.open_positions,2);assert.equal(cap.available_for_new_entry,2);
 });
 await t.test('the ten-minute observation row carries the whole slot decision',async()=>{
  const cap=await h.capacity();
  await h.rpc('leader20_clock_note',[h.iso(slot),{
   open_position_count:cap.open_positions,available_slots_before:cap.available_for_new_entry,
   available_slots:cap.available_for_new_entry,available_slots_after:cap.available_for_new_entry,
   reserved_slots:cap.reserved_slots,futures_available_margin:cap.futures_available_margin,
   target_margin_per_slot:cap.target_margin_per_slot,watch_count:20,
   capture_ready_count:20,capture_blocked_count:0,retry_count:0,
   blocked_reasons:{},tracked_positions:cap.held,slot_status:'CAPTURE_COMPLETE'}]);
  const row=(await h.q('select * from leader20_clock_slot_report where slot_at=$1',[h.iso(slot)]))[0];
  assert.equal(row.open_position_count,2);assert.equal(row.available_slots_before,2);
  assert.equal(row.available_slots_after,2);assert.equal(row.reserved_slots,0);
  assert.equal(Number(row.target_margin_per_slot),SLOT_COST);
  assert.equal(Number(row.futures_available_margin),marginFor(2));
  assert.equal(row.watch_count,20);assert.equal(row.capture_ready_count,20);
  assert.equal(row.capture_blocked_count,0);assert.equal(row.slot_status,'CAPTURE_COMPLETE');
  assert.deepEqual(row.tracked_positions,['HBARUSDT','SOONUSDT']);
  assert.equal(Number(row.buy_now_count),0);assert.equal(Number(row.orders_attempted),0);
  assert.equal(Number(row.fills),0);assert.equal(Number(row.reservations),0);
  assert.equal(Number(row.reservations_released),0);
  // An earlier available_slots_before is the slot's opening state and is never overwritten.
  await h.rpc('leader20_clock_note',[h.iso(slot),{available_slots_before:0,available_slots_after:1,reserved_slots:2}]);
  const again=(await h.q('select * from leader20_clock_slot_report where slot_at=$1',[h.iso(slot)]))[0];
  assert.equal(again.available_slots_before,2);assert.equal(again.available_slots_after,1);
  assert.equal(again.reserved_slots,2);
 });
});

test('concurrent GPT BUYs are admitted up to the remaining slots and no further',async t=>{
 const slot=Math.floor(Date.now()/600000)*600000+600000;
 const h=await harness(t,{slot,at:slot+11000,
  watch:[...TOP20.map(s=>({symbol:s,roles:['SCANNER_LEADER']})),{symbol:'BTCUSDT',roles:['MARKET_SENSOR']}]});
 for(const [i,s] of TOP20.entries()){
  await h.q('insert into leader20_members(epoch_id,symbol,rank) values($1,$2,$3)',[h.epoch,s,i+1]);
  await h.q('insert into leader20_campaigns(symbol,epoch_id) values($1,$2)',[s,h.epoch]);
 }
 // 26 contiguous five-second buckets per member: the real 120s/24-bucket path plus its seed.
 for(let i=0;i<26;i++){
  const at=slot-120000+i*5000,end=at+100,mid=1+i*.001;
  const payload={interval_start:h.iso(end-5000),interval_end:h.iso(end),interval_ms:5000,exchange_at:h.iso(end-200),
   received_at:h.iso(end-100),flow_causal:true,trade_event_at:h.iso(end-150),trade_received_at:h.iso(end-100),
   bucket_complete:true,book_complete:true,trade_sequence_complete:true,coverage_25:true,mid,spread_bps:2,
   ask_25_usdt:10000,bid_25_usdt:11000,trade_count:10,buy_quote_5s:100,sell_quote_5s:60,
   displayed_ask_added_5s:50,displayed_ask_removed_5s:30,displayed_bid_added_5s:40,displayed_bid_removed_5s:20,
   buy_vwap_450:mid*1.002,sell_vwap_450:mid*.998,btc_return_1m:.002};
  await h.q("insert into doa_capture.live_micro select 'micro',symbol,$1,$2,$3 from leader20_members",[h.iso(at),h.iso(end+100),payload]);
 }
 await h.load(MIGRATION);
 await h.load(REVIEW_ALL_MIGRATION);
 // Two more positions are affordable. Three candidates come back BUY.
 await h.fundAt(marginFor(2),slot+11000);
 const capture=s=>h.rpc('doa_context_for_role_v1',[s,h.iso(slot+11000),'TRADE_CANDIDATE',null]);
 const rows=await Promise.all(TOP20.map(async(symbol,i)=>({symbol,rank:i+1,capture:await capture(symbol)})));
 assert.equal(rows.filter(r=>r.capture.status==='AVAILABLE').length,20,JSON.stringify(rows[0].capture));
 const packet=await buildBatch(rows,{asOf:slot+11000,epochId:h.epoch,generation:3});
 const claim=await h.rpc('leader20_batch_claim',[{...packet,evidence:[]},'multi-slot',false]);
 assert.equal(claim.created,true,JSON.stringify(claim));
 await h.q("update leader20_batches set state='DONE' where id=$1",[claim.row.id]);
 const materialize=async symbol=>{
  const advice={id:symbol,version:packet.symbols.find(s=>s.id===symbol).data_version,
   last_ms:packet.symbols.find(s=>s.id===symbol).last_ms,decision:'BUY',valid:true};
  const event=(await h.q(`insert into leader20_review_events(epoch_id,symbol,generation,requested_at,snapshot_end_ms,snapshot_hash,result)
   values($1,$2,3,$3,$4,'test',$5) returning id`,[h.epoch,symbol,h.iso(slot+11000),slot+100,{batch_id:claim.row.id,batch_advice:advice}]))[0].id;
  const c=await capture(symbol);
  return h.rpc('leader20_materialize_event',[event,{referenceClose:1,
   execution_snapshot:{complete:true,causal:true,bucket_count:24,end_ms:c.end_ms,entry_window:c.entry_window,trajectory_hash:'hash'}}]);
 };
 await t.test('READY candidates all materialize before capacity is applied',async()=>{
  const first=await materialize('C0USDT');assert.equal(first.created,true,JSON.stringify(first));
  const second=await materialize('C1USDT');assert.equal(second.created,true,JSON.stringify(second));
  const third=await materialize('C2USDT');assert.equal(third.created,true,JSON.stringify(third));
  const cap=await h.capacity();
  assert.equal(cap.reserved_slots,0,'GPT review candidates do not consume order slots');
  assert.equal(cap.available_for_new_entry,2,'the two actual entry slots remain available for post-GPT admission');
  const live=await h.q("select symbol,state,signal_id from leader20_entry_reservations where state in ('RESERVED','ORDER_PENDING')");
  assert.equal(live.length,0,'materialization never creates an entry reservation');
  const states=await h.q("select symbol,state,signal_id from leader20_review_events where symbol in ('C0USDT','C1USDT','C2USDT') order by symbol");
  assert.deepEqual(states.map(r=>r.state),['REVIEWING','REVIEWING','REVIEWING']);
  assert.ok(states.every(r=>r.signal_id!==null),'all READY candidates have a signal for GPT review');
 });
 await t.test('atomic slot reservation still caps actual post-GPT admission',async()=>{
  const signals=await h.q("select symbol,signal_id from leader20_review_events where symbol in ('C0USDT','C1USDT','C2USDT') order by symbol");
  const bySymbol=new Map(signals.map(r=>[r.symbol,r.signal_id]));
  const reserveAfterReview=symbol=>h.rpc('leader20_reserve_entry_slot',[symbol,slot,bySymbol.get(symbol),h.iso(slot+120000)]);
  const [a,b,c]=await Promise.all([reserveAfterReview('C0USDT'),reserveAfterReview('C1USDT'),reserveAfterReview('C2USDT')]);
  const ok=[a,b,c].filter(x=>x.reserved===true),blocked=[a,b,c].filter(x=>x.reserved!==true);
  assert.equal(ok.length,2,JSON.stringify([a,b,c]));
  assert.equal(blocked.length,1);
  assert.equal(blocked[0].reason,'NO_ENTRY_CAPACITY');
  const cap=await h.capacity();
  assert.equal(cap.reserved_slots,2);assert.equal(cap.available_for_new_entry,0);
 });
 await t.test('reviewed candidates can still pay for their final review',async()=>{
  await h.load('supabase/migrations/20260928034100_leader20_transient_capacity_pause.sql');
  await h.load('supabase/migrations/20260928152753_hold_thesis_protection.sql');
  await h.q("insert into ai_provider_limits values('openai',95,3,true) on conflict(provider) do update set enabled=true");
  const reserved=await h.rpc('ai_call_reserve',['a'.repeat(64),'openai','gpt-5.4-mini-2026-03-17','RECHECK',null,'v1',.1]);
  assert.equal(reserved.created,true,JSON.stringify(reserved));
 });
});

test('the ten-minute batch records the whole slot decision and is not stopped by a live order',async()=>{
 const {runEntryBatch,blockedReasons}=await import('../supabase/functions/_shared/leader20/batch-runtime.mjs');
 const {rawCapture}=await import('../test-support/dynamic-fixtures.mjs');
 const {CLOCK_VERSION}=await import('../supabase/functions/_shared/leader20/clock.mjs');
 const slot=Date.parse('2026-09-28T00:50:00+09:00');
 const capture=()=>({...rawCapture(slot+200),entry_window:{version:CLOCK_VERSION,slot_ms:slot,expires_at_ms:slot+120000}});
 // One open position, one live entry order and two funded slots: the account can still take one more.
 const capacity={available:1,available_for_new_entry:1,available_by_margin:2,certain:true,
  held:['HBARUSDT'],open_symbols:['HBARUSDT'],open_positions:1,reserved_slots:0,pending_entry_orders:1,
  max_slots:10,target_margin_per_slot:152.021375,futures_available_margin:456.16,available_quote:304.14,reason:null};
 const members=Array.from({length:20},(_,i)=>({symbol:`C${i}USDT`,rank:i+1}));
 let at=slot+2000;const notes=[];let claimed=false;
 const db={from(){return {select(){return this;},eq(){return this;},lte(){return this;},
  async maybeSingle(){return {data:{decision_reserve_ms:80000,last_periodic_slot:claimed?new Date(slot).toISOString():null}};},
  async order(){return {data:members};}};},async rpc(name,args){
   if(name==='leader20_clock_note'){notes.push(args.p_data);return {data:{recorded:true}};}
   if(name==='leader20_collector_health')return {data:{live:true}};
   if(name==='leader20_batch_capacity')return {data:capacity};
   // A terminally invalid bucket is not a "wait and retry" state, so the slot proceeds with 19.
   if(name==='doa_context_for_role_v1')return {data:args.p_symbol==='C7USDT'
    ?{status:'UNAVAILABLE',reason:'CLOCK_INVALID_OR_NONCAUSAL_BUCKET'}:capture()};
   if(name==='leader20_batch_claim'){claimed=true;return {data:{created:true,row:{id:'b',owner:'o'}}};}
   if(name==='leader20_batch_start')return {data:{allowed:true}};
   if(name==='ai_call_reserve_owned')return {data:{created:true,row:{owner:'p'}}};
   if(name==='ai_call_transition')return {data:{}};
   if(name==='leader20_batch_finish')return {data:{events:19}};
   throw Error('Unexpected RPC '+name);
  }};
 const r=await runEntryBatch(db,{clock_capture_enabled:true,epoch_id:'e',generation:4},
  {now:()=>at,apiKey:'fixture',sleep:async ms=>{at+=ms;},
   fetchFn:async(url,init)=>{if(url.startsWith('https://fapi'))throw Error('offline momentum');
    at+=9000;return new Response(JSON.stringify({model:'deepseek-flash',
     choices:[{finish_reason:'stop',message:{content:'invalid JSON'}}],usage:{prompt_tokens:10,completion_tokens:1}}));}});
 assert.equal(r.batch_created,true,JSON.stringify(r));
 assert.equal(r.available_slots,1,'one more position may still be opened');
 assert.equal(r.open_position_count,1);assert.equal(r.reserved_slots,0);
 assert.equal(r.watch_count,20);assert.equal(r.capture_ready_count,19);assert.equal(r.capture_blocked_count,1);
 assert.equal(Number(r.target_margin_per_slot),152.021375);
 assert.equal(Number(r.futures_available_margin),456.16);
 assert.deepEqual(r.tracked_positions,['HBARUSDT']);
 assert.deepEqual(r.blocked_reasons,{CLOCK_INVALID_OR_NONCAUSAL_BUCKET:1});
 assert.equal(r.retry_count,0,'a funded slot with one terminally invalid symbol does not spin');
 const last=notes.at(-1);
 assert.equal(last.available_slots_before,1);assert.equal(last.open_position_count,1);
 assert.equal(Number(last.target_margin_per_slot),152.021375);
 assert.equal(last.watch_count,20);assert.deepEqual(last.tracked_positions,['HBARUSDT']);
 // The blocked-reason tally names each watched symbol that was not READY, held ones included.
 assert.deepEqual(blockedReasons([
  {symbol:'A',capture:{status:'AVAILABLE'}},
  {symbol:'HBARUSDT',capture:{status:'UNAVAILABLE',reason:'CLOCK_STALE_BUCKET'}},
  {symbol:'B',capture:{status:'UNAVAILABLE',reason:'CLOCK_INCOMPLETE_TRAJECTORY'}},
  {symbol:'C',capture:{status:'UNAVAILABLE',reason:'CLOCK_INCOMPLETE_TRAJECTORY'}},
  {symbol:'D'}],['HBARUSDT']),
  {ALREADY_HELD:1,CLOCK_INCOMPLETE_TRAJECTORY:2,CAPTURE_UNAVAILABLE:1});
});
