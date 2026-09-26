import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {Book,closedCandle,btcCandleFields} from './core.mjs';
import {validateMarketSensor} from '../../supabase/functions/_shared/gpt-final-decision/market-sensor.mjs';
import {validateCapture120} from '../../supabase/functions/_shared/gpt-final-decision/capture-context.mjs';
import {frozenReview,dualEntryDecision} from '../../supabase/functions/_shared/gpt-final-decision/dual.mjs';
import {computeFacts} from '../../supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {buildDecisionPacket,MODEL} from '../../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {src} from '../../development/gpt-final-decision/tests/fixtures.mjs';
import {finalFields} from '../../test-support/arbitration-fixtures.mjs';
const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href);
test('role contracts T01-T14: actual Postgres RPC, collector and model wiring',async t=>{
 const db=new PGlite();
 try{
 await db.exec("create role anon;create role authenticated;create role service_role bypassrls;create table public.v11_long_regime_signals(id uuid,symbol text,created_at timestamptz,status text,features jsonb);create table public.v11_long_regime_positions(id uuid,signal_id uuid,symbol text,entry_at timestamptz,entry_price numeric,state text,metadata jsonb);create table public.v17_market_scan_runs(captured_at timestamptz,details jsonb);grant select on public.v11_long_regime_signals,public.v11_long_regime_positions,public.v17_market_scan_runs to service_role;");
 for(const n of ['20260925131209_doa_capture_live','20260925135156_doa_gpt_capture_context','20260926125702_continuous_capture_arbitration','20260926144820_exit_authority_120s_context','20260926145639_exit_capture_flow_causality'])await db.exec(await readFile(new URL('../../supabase/migrations/'+n+'.sql',import.meta.url),'utf8'));
 const definition=async()=> (await db.query("select pg_get_functiondef(oid) d from pg_proc where proname='doa_gpt_capture_context_v3'")).rows[0].d;
 const before=await definition();
 await db.exec(await readFile(new URL('../../supabase/migrations/20260926162456_market_sensor_context_v1.sql',import.meta.url),'utf8'));
 assert.equal(await definition(),before,'trade validator definition must be byte-identical');
 await db.exec("insert into doa_capture.control(id,enabled,gpt_context_enabled,production_enabled,protocol_sha256,starts_at,ends_at,heartbeat_at) values(1,true,true,true,repeat('a',64),now()-interval '1 day',now()+interval '1 day',clock_timestamp());");
 const anchor=Math.floor(Date.now()/5000)*5000-5000,iso=t=>new Date(t).toISOString(),id='00000000-0000-0000-0000-000000000001';
 for(let i=0;i<25;i++){
  const at=anchor-(24-i)*5000,end=at+100,mid=100+i*.001,candleEnd=Math.floor((end-1000)/60000)*60000;
  const candle=closedCandle({E:candleEnd+10,k:{x:true,t:candleEnd-60000,T:candleEnd-1,o:'100',c:'101'}},candleEnd+30);
  const p={interval_start:iso(end-5000),interval_end:iso(end),interval_ms:5000,exchange_at:iso(end-200),received_at:iso(end-100),flow_causal:true,
   trade_event_at:iso(end-150),trade_received_at:iso(end-100),bucket_complete:true,book_complete:true,trade_sequence_complete:true,
   coverage_25:false,depth_coverage_complete:false,mid,best_bid:mid-.001,best_ask:mid+.001,spread_bps:.2,
   ask_25_usdt:10000,bid_25_usdt:11000,observed_bid_depth_usdt:11000,observed_ask_depth_usdt:10000,
   depth_bid_coverage_bps:8,depth_ask_coverage_bps:9,depth_bid_boundary:99.9,depth_ask_boundary:100.2,
   trade_count:10,buy_quote_5s:100+i,sell_quote_5s:60,displayed_ask_added_5s:50,displayed_ask_removed_5s:30,
   displayed_bid_added_5s:40,displayed_bid_removed_5s:20,buy_vwap_450:mid*1.002,sell_vwap_450:mid*.998,...btcCandleFields(candle,end)};
  for(const symbol of ['BTCUSDT','QUSDT'])await db.query("insert into doa_capture.live_micro(kind,symbol,at,payload,received_at) values('micro',$1,$2,$3,clock_timestamp())",[symbol,iso(at),JSON.stringify({...p,coverage_25:symbol==='QUSDT'})]);
 }
 const sensor=async()=> (await db.query("select public.doa_market_sensor_context_v1('BTCUSDT',clock_timestamp()) r")).rows[0].r;
 const trade=async(symbol='QUSDT',role='TRADE_CANDIDATE',position=null)=>(await db.query("select public.doa_context_for_role_v1($1,clock_timestamp(),$2,$3) r",[symbol,role,position])).rows[0].r;
 const corrupt=async(change,symbol='BTCUSDT')=>{await db.exec('begin');await db.query('update doa_capture.live_micro set '+change+' where symbol=$1 and at=$2',[symbol,iso(anchor)]);};
 await t.test('T01 BTC shallow snapshot is MARKET_SENSOR AVAILABLE with all horizons',async()=>{
  const b=new Book();b.snapshot({lastUpdateId:1,bids:[['99.99','1'],['99.98','2']],asks:[['100.01','1'],['100.02','2']]},anchor);
  b.event({U:1,u:2,pu:1,E:anchor,b:[],a:[]},anchor);assert.equal(b.metrics(anchor).coverage_25,false);assert.equal(b.needsCoverageRefresh(anchor+100000),false);
  const raw=await sensor(),c=validateMarketSensor(raw,Date.now());assert.equal(c.status,'AVAILABLE',JSON.stringify(c));assert.equal(c.market_sensor_trajectory.length,24);
  for(const sec of [5,15,30,60,120])assert.ok(c['return_'+sec+'s']>0);assert.equal(c.depth_coverage_complete,false);
 });
 await t.test('T02 BTC trade request fails closed despite sensor availability',async()=>{assert.equal((await trade('BTCUSDT')).reason,'TRADE_CONTEXT_UNAVAILABLE_DEPTH_COVERAGE');assert.equal((await sensor()).status,'AVAILABLE');});
 await t.test('T03 candidate lacking coverage stays unavailable',async()=>{await corrupt("payload=jsonb_set(payload,'{coverage_25}','false')",'QUSDT');assert.equal((await trade()).status,'UNAVAILABLE');await db.exec('rollback');});
 await t.test('T04 candidate full coverage passes unchanged V3 client',async()=>{const c=await trade();assert.equal(c.status,'AVAILABLE');assert.equal(validateCapture120(c,Date.now()).status,'AVAILABLE');assert.equal(c.contract,'TRADE_CONTEXT_V3');});
 await t.test('T05 stale book timestamps fail sensor',async()=>{await corrupt("payload=jsonb_set(payload,'{received_at}',to_jsonb((at-interval '20 seconds')::text))");assert.equal((await sensor()).status,'UNAVAILABLE');await db.exec('rollback');});
 await t.test('T06 future exchange, receive, ingest timestamps fail sensor',async()=>{
  for(const change of ["payload=jsonb_set(payload,'{exchange_at}',to_jsonb((at+interval '1 minute')::text))","payload=jsonb_set(payload,'{received_at}',to_jsonb((at+interval '1 minute')::text))","received_at=clock_timestamp()+interval '1 minute'"]){await corrupt(change);assert.equal((await sensor()).status,'UNAVAILABLE');await db.exec('rollback');}
 });
 await t.test('T07 trade sequence gap fails sensor',async()=>{await corrupt("payload=jsonb_set(payload,'{trade_sequence_complete}','false')");assert.equal((await sensor()).status,'UNAVAILABLE');await db.exec('rollback');});
 await t.test('T08 stale/missing candle evidence fails closed, including SQL nulls',async()=>{
  for(const change of ["payload=jsonb_set(payload,'{btc_candle_end_ms}',to_jsonb((extract(epoch from at)*1000-120000)::bigint))","payload=payload-'btc_candle_received_ms'","payload=payload-'btc_return_1m'"]){await corrupt(change);assert.equal((await sensor()).status,'UNAVAILABLE');await db.exec('rollback');}
 });
 await t.test('T09 closed candle return injection is exact and causal',async()=>{
  const c=closedCandle({E:anchor,k:{x:true,t:anchor-60000,T:anchor-1,o:'200',c:'201'}},anchor+50),f=btcCandleFields(c,anchor+100);
  assert.equal(f.btc_return_1m,201/200-1);assert.equal(btcCandleFields(c,anchor+49).btc_return_1m,null);assert.equal(btcCandleFields(c,anchor+65001).btc_return_1m,null);
  const q=(await trade()).trajectory.at(-1);assert.equal(q.btc_return_1m,(await sensor()).market_sensor_trajectory.at(-1).btc_return_1m);
 });
 await t.test('T10 contracts cannot be interchanged',async()=>{const c=await sensor();assert.equal(validateCapture120(c,Date.now()).status,'UNAVAILABLE');assert.equal(validateMarketSensor(await trade(),Date.now()).status,'UNAVAILABLE');});
 await t.test('T11 partial depth has only observed names and excludes levels beyond snapshot',async()=>{
  const raw=await sensor();assert.equal(/"(bid|ask)(_depth)?_25_usdt"/.test(JSON.stringify(raw)),false);
  const b=new Book();b.snapshot({lastUpdateId:1,bids:[['100','1'],['99.99','2']],asks:[['100.01','1'],['100.02','2']]},anchor);
  b.event({U:1,u:2,pu:1,E:anchor,b:[['99.98','100']],a:[['100.03','100']]},anchor);
  const m=b.metrics(anchor);assert.equal(m.observed_bid_depth_usdt,100+99.99*2);assert.equal(m.depth_coverage_complete,false);
 });
 await t.test('T12 OPEN position strict regression and dual-role watch',async()=>{
  await db.query("insert into public.v11_long_regime_positions values($1,null,'BTCUSDT',now(),100,'OPEN','{}')",[id]);
  assert.equal((await trade('BTCUSDT','OPEN_POSITION',id)).reason,'TRADE_CONTEXT_UNAVAILABLE_DEPTH_COVERAGE');
  const w=(await db.query("select public.doa_capture_rpc('watch','{\"worker_id\":\"sensor-test-worker\"}') r")).rows[0].r.watch.find(x=>x.symbol==='BTCUSDT');
  assert.equal(w.priority,0);assert.ok(w.roles.includes('MARKET_SENSOR'));assert.ok(w.roles.includes('OPEN_POSITION'));
  await db.query("update public.v11_long_regime_positions set symbol='QUSDT' where id=$1",[id]);assert.equal((await trade('QUSDT','OPEN_POSITION',id)).status,'AVAILABLE');
  await db.query("update public.v11_long_regime_positions set state='CLOSED' where id=$1",[id]);assert.equal((await trade('QUSDT','OPEN_POSITION',id)).status,'UNAVAILABLE');
 });
 let rawSensor=await sensor();const now=Date.now();
 const facts=computeFacts(src(now),{asOf:now});facts.market_sensor=validateMarketSensor(rawSensor,now);facts.capture_context=validateCapture120(await trade(),Date.now());
 const packet=await buildDecisionPacket({task:'HOLD',subjectId:'sensor-fixture',symbol:'QUSDT',dataMode:'LIVE',facts,position:{event:'REVIEW'}});
 await t.test('T13 GPT FIRST and DeepSeek actual provider payloads share identical sensor snapshot',async()=>{
  let first,ds,final;
  const fetchFn=async(url,init)=>{const b=JSON.parse(init.body),isDS=String(url).includes('deepseek'),input=JSON.parse(isDS?b.messages[1].content:b.input[1].content);
   if(isDS){ds=input;return Response.json({model:'deepseek-flash',choices:[{finish_reason:'stop',message:{content:JSON.stringify({task:'HOLD',candidate_id:input.candidate_id,snapshot_hash:input.snapshot.snapshot_hash,decision_preference:'HOLD',confidence:.5,thesis_state:'WEAKENING',bullish_evidence:[],bearish_evidence:['market_sensor.return_120s'],risk_flags:[],trajectory_interpretation:'Measured BTC return',strongest_counterargument:'Candidate differs',recommended_action:'HOLD',reason:'Context only'})}}]});}
   if(input.independent_reviews)final=input;else first=input;
   const wire={t:'HOLD',c:input.candidate_id,d:'HOLD',reasons:[],support:['return_5m'],n:'Review measured context',...(input.independent_reviews?{arbitration:finalFields(input)}:{})};
   return Response.json({model:MODEL,status:'completed',usage:{input_tokens:1000,output_tokens:100},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(wire)}]}]});};
  const result=await dualEntryDecision(packet,{apiKey:'fixture',deepseekKey:'fixture',fetchFn,now:()=>now,snapshotAtMs:now});
  assert.equal(result.valid,true,result.error);assert.ok(Buffer.byteLength(JSON.stringify(result))<300000);
  assert.deepEqual(first,ds);assert.equal(first.market_sensor.status,'AVAILABLE');assert.equal(final.market_sensor.status,'AVAILABLE');assert.equal(first.snapshot.market_sensor_hash,ds.snapshot.market_sensor_hash);
 });
 await t.test('T14 FINAL cutoff excludes later BTC events and does not substitute new history',async()=>{
  const corrupted=structuredClone(packet);corrupted.facts.market_sensor.market_sensor_trajectory[23].flow_event_ms=now+1;
  const frozen=await frozenReview(corrupted,{snapshotAtMs:now});assert.equal(frozen.market_input.market_sensor.status,'UNAVAILABLE');assert.equal(frozen.market_input.market_sensor.market_sensor_trajectory,undefined);
  assert.equal(validateMarketSensor(rawSensor,rawSensor.end_ms+25001).status,'UNAVAILABLE');
 });
 await t.test('missing anchor/gap, null metric, future as_of and public access fail closed',async()=>{
  await db.exec('begin');await db.query("delete from doa_capture.live_micro where symbol='BTCUSDT' and at=$1",[iso(anchor-120000)]);assert.equal((await sensor()).status,'UNAVAILABLE');await db.exec('rollback');
  await corrupt("payload=payload-'received_at'");assert.equal((await sensor()).status,'UNAVAILABLE');await db.exec('rollback');
  assert.equal((await db.query("select public.doa_market_sensor_context_v1('BTCUSDT',clock_timestamp()+interval '1 minute') r")).rows[0].r.status,'UNAVAILABLE');
  await db.exec('set role anon');await assert.rejects(sensor(),/permission denied/);
 });
 }finally{await db.close();}
});
