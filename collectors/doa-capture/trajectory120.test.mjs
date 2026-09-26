import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {validateCapture120,CAPTURE_VERSION} from '../../supabase/functions/_shared/gpt-final-decision/capture-context.mjs';
const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href);
test('T15-T22: production 120s RPC, exact bucket sequence, causality, gaps and lifecycle isolation',async t=>{
 const db=new PGlite();
 try{
 await db.exec("create role anon;create role authenticated;create role service_role bypassrls;");
 await db.exec("create table public.v11_long_regime_signals(id uuid,symbol text,created_at timestamptz,status text,features jsonb);create table public.v11_long_regime_positions(id uuid,signal_id uuid,symbol text,entry_at timestamptz,entry_price numeric,state text,metadata jsonb);create table public.v17_market_scan_runs(captured_at timestamptz,details jsonb);grant select on public.v11_long_regime_signals,public.v11_long_regime_positions,public.v17_market_scan_runs to service_role;");
 for(const n of ['20260925131209_doa_capture_live','20260925135156_doa_gpt_capture_context','20260926125702_continuous_capture_arbitration','20260926144820_exit_authority_120s_context','20260926145639_exit_capture_flow_causality'])
  await db.exec(await readFile(new URL('../../supabase/migrations/'+n+'.sql',import.meta.url),'utf8'));
 await db.exec("insert into doa_capture.control(id,enabled,gpt_context_enabled,production_enabled,protocol_sha256,starts_at,ends_at,heartbeat_at) values(1,true,true,true,repeat('a',64),now()-interval '1 day',now()+interval '1 day',clock_timestamp());");
 const anchor=Math.floor(Date.now()/5000)*5000-5000,iso=t=>new Date(t).toISOString(),id='00000000-0000-0000-0000-000000000001',newId='00000000-0000-0000-0000-000000000002';
 for(let i=0;i<25;i++){
  const at=anchor-(24-i)*5000,end=at+100,mid=1+i*.001;
  const payload={interval_start:iso(end-5000),interval_end:iso(end),interval_ms:5000,exchange_at:iso(end-200),received_at:iso(end-100),
   flow_causal:true,trade_event_at:iso(end-150),trade_received_at:iso(end-100),bucket_complete:true,book_complete:true,trade_sequence_complete:true,coverage_25:true,mid,spread_bps:2+i*.01,
   ask_25_usdt:10000-i*10,bid_25_usdt:11000+i*10,trade_count:10+i,buy_quote_5s:100+i,sell_quote_5s:60,
   displayed_ask_added_5s:50,displayed_ask_removed_5s:30,displayed_bid_added_5s:40,displayed_bid_removed_5s:20,
   buy_vwap_450:mid*1.002,sell_vwap_450:mid*.998,btc_return_1m:.002};
  await db.query("insert into doa_capture.live_micro(kind,symbol,at,payload,received_at) values('micro','QUSDT',$1,$2,clock_timestamp())",[iso(at),JSON.stringify(payload)]);
 }
 await db.query("insert into public.v11_long_regime_positions values($1,null,'QUSDT',now()-interval '5 minutes',1,'OPEN','{}')",[id]);
 const get=async(positionId=null)=> (await db.query("select public.doa_gpt_capture_context_v3('QUSDT',clock_timestamp(),$1) r",[positionId])).rows[0].r;
 await t.test('T15 24 ordered points with 120s derived dynamics and retained v2',async()=>{
  const raw=await get(),c=validateCapture120(raw,Date.now());assert.equal(c.status,'AVAILABLE',JSON.stringify(c));
  assert.equal(c.version,CAPTURE_VERSION);assert.equal(c.buckets,24);assert.equal(c.window_ms,120000);
  assert.equal(c.trajectory.length,24);assert.ok(c.dynamics.return_120s>0);
  assert.deepEqual(Object.keys(c.dynamics.horizons),['s5','s15','s30','s60','s120']);
  assert.equal((await db.query("select public.doa_gpt_capture_context('QUSDT',clock_timestamp()) r")).rows[0].r.buckets,12);
 });
 await t.test('T16 contiguous sequence rejects an internal gap despite 24 points',async()=>{
  await db.exec('begin');await db.query("update doa_capture.live_micro set at=at-interval '1 second' where at=$1",[iso(anchor-50000)]);
  assert.notEqual((await get()).status,'AVAILABLE');await db.exec('rollback');
 });
 await t.test('T17 future exchange time / bucket / received-at rejected',async()=>{
  for(const change of ["payload=jsonb_set(payload,\'{trade_event_at}\',to_jsonb((clock_timestamp()+interval \'1 minute\')::text))","received_at=clock_timestamp()+interval '1 minute'","payload=jsonb_set(payload,'{exchange_at}',to_jsonb((clock_timestamp()+interval '1 minute')::text))","payload=jsonb_set(payload,'{interval_end}',to_jsonb((clock_timestamp()+interval '1 minute')::text))"]){
   await db.exec('begin');await db.query("update doa_capture.live_micro set "+change+" where at=$1",[iso(anchor)]);
   assert.notEqual((await get()).status,'AVAILABLE');await db.exec('rollback');
  }
  const raw=await get();raw.trajectory[23].received_at_ms=Date.now()+1e5;assert.equal(validateCapture120(raw,Date.now()).status,'UNAVAILABLE');
 });
 await t.test('T18 stale trajectory is unavailable',async()=>{
  const raw=await get();assert.equal(validateCapture120(raw,raw.end_ms+25001).reason,'STALE_OR_FUTURE');
 });
 await t.test('T19 missing bucket is never synthesized or silently replaced',async()=>{
  await db.exec('begin');await db.query("delete from doa_capture.live_micro where at=$1",[iso(anchor-50000)]);
  assert.notEqual((await get()).status,'AVAILABLE');await db.exec('rollback');
 });
 await t.test('T20 OPEN watch priority remains 0',async()=>{
  const w=(await db.query("select public.doa_capture_rpc('watch','{\"worker_id\":\"authority-test-worker\"}') r")).rows[0].r;
  assert.equal(w.watch.find(x=>x.symbol==='QUSDT').priority,0);assert.equal((await get(id)).position_id,id);
 });
 await t.test('T21 CLOSED lifecycle cannot receive strategic context',async()=>{
  await db.query("update public.v11_long_regime_positions set state='CLOSED' where id=$1",[id]);
  assert.equal((await get(id)).reason,'POSITION_NOT_OPEN_OR_MISMATCH');
 });
 await t.test('T22 same-symbol new position has separate identity; no old-position metrics',async()=>{
  await db.query("insert into public.v11_long_regime_positions values($1,null,'QUSDT',now(),1,'OPEN','{}')",[newId]);
  assert.equal((await get(newId)).position_id,newId);assert.equal((await get(id)).status,'UNAVAILABLE');
 });
 await db.exec('set role anon');await assert.rejects(get(),/permission denied/);
 }finally{await db.close();}
});

