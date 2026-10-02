import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {scenario} from './fixtures.mjs';
const migration=fs.readFileSync(new URL('../../supabase/migrations/20261002102500_deterministic_dynamic_state.sql',import.meta.url),'utf8');
async function setup(){const pg=new PGlite();await pg.exec(fs.readFileSync(new URL('schema.sql',import.meta.url),'utf8'));
 await pg.exec(fs.readFileSync(new URL('capacity-baseline.sql',import.meta.url),'utf8'));await pg.exec(migration);return pg;}
async function snapshot(pg,margin=305){await pg.query("insert into trading_account_snapshots values('binance_futures',clock_timestamp(),true,$1,'[]')",[margin]);}
async function publish(pg){const now=Date.now(),members=Array.from({length:20},(_,i)=>({symbol:'SYMBOL'+i+'USDT',rank:i+1,price_change_percent:20-i,quote_volume:1e8}));
 return (await pg.query('select deterministic_publish_universe($1,$2) result',[{members,requested_at:new Date(now).toISOString(),observed_at:new Date(now).toISOString(),next_refresh_at:new Date(now+60000).toISOString()},'a'.repeat(64)])).rows[0].result;}
async function addCapture(pg,symbol,{malformed=false}={}){
 const at=Date.now(),s=scenario({at}),points=s.raw.trajectory;
 // The 25th preceding boundary is required to derive the first of the 24 returns.
 const preceding={...points[0],start_ms:points[0].start_ms-5000,end_ms:points[0].start_ms,mid:100};
 for(const p of [preceding,...points]){
  const end=new Date(p.end_ms).toISOString(),book=new Date(p.end_ms-100).toISOString(),payload={interval_start:new Date(p.start_ms).toISOString(),interval_end:end,interval_ms:5000,
   bucket_complete:true,book_complete:true,trade_sequence_complete:true,coverage_25:true,flow_causal:true,trade_count:50,trade_event_at:book,trade_received_at:book,
   mid:malformed?'corrupt':p.mid,spread_bps:1.5,bid_25_usdt:20000,ask_25_usdt:18000,buy_quote_5s:3000,sell_quote_5s:1000,
   exchange_at:book,received_at:book,buy_vwap_450:p.mid*1.00015,sell_vwap_450:p.mid*.99985};
  await pg.query("insert into doa_capture.live_micro(kind,symbol,at,received_at,payload) values('micro',$1,$2,$3,$4)",[symbol,end,new Date(p.end_ms+100).toISOString(),payload]);
 }
 return at;
}
test('new migration applies without any provider/history schema and has restricted RPC grants',async()=>{
 const pg=await setup();assert.equal((await pg.query('select enabled from deterministic_control')).rows[0].enabled,false);
 const r=await pg.query("select has_function_privilege('anon','public.deterministic_candidate(text,bigint,jsonb)','execute') anonymous,has_function_privilege('service_role','public.deterministic_candidate(text,bigint,jsonb)','execute') service");
 assert.deepEqual(r.rows[0],{anonymous:false,service:true});await pg.close();
});
test('Top20 publication is unique, complete and atomically replaced; held symbols remain watched',async()=>{
 const pg=await setup(),u=await publish(pg);assert.equal(u.members.length,20);
 await pg.exec("insert into v11_long_regime_positions(symbol,state,remaining_quantity) values('HELDUSDT','OPEN',1)");
 const watch=(await pg.query("select doa_capture_rpc('watch','{\"worker_id\":\"fixture-worker-123\"}') result")).rows[0].result;
 assert.equal(watch.watch.length,22);assert.ok(watch.watch.some(x=>x.symbol==='HELDUSDT'));assert.deepEqual(watch.windows,[]);
 await assert.rejects(()=>pg.query('select deterministic_publish_universe($1,$2)',[{members:u.members.slice(0,10)},'a'.repeat(64)]),/universe evidence invalid/);await pg.close();
});
test('atomic capacity reserves only funded slots and rejects duplicate symbols',async()=>{
 const pg=await setup();await snapshot(pg,305);
 const results=await Promise.all(Array.from({length:20},(_,i)=>pg.query("select deterministic_reserve_entry_slot($1,123,null,clock_timestamp()+interval '2 minutes') result",['S'+i+'USDT'])));
 assert.equal(results.filter(r=>r.rows[0].result.reserved).length,2);
 const duplicate=(await pg.query("select deterministic_reserve_entry_slot('S0USDT',123,null,clock_timestamp()+interval '2 minutes') result")).rows[0].result;
 assert.equal(duplicate.reserved,false);assert.equal(duplicate.reason,'SYMBOL_ALREADY_HELD');await pg.close();
});
test('ambiguous entry orders continue charging capital even after reservation expiry',async()=>{
 const pg=await setup();await snapshot(pg,305);await pg.exec("insert into v11_long_regime_orders(symbol,intent,state) values('UNCERTAINUSDT','OPEN_LONG','RECONCILIATION_PENDING')");
 const cap=(await pg.query('select leader20_batch_capacity() result')).rows[0].result;assert.equal(cap.available_for_new_entry,1);
 await pg.exec("insert into leader20_entry_reservations(symbol,state,expires_at) values('UNCERTAINUSDT','ORDER_PENDING',clock_timestamp()-interval '1 minute')");
 assert.equal((await pg.query('select leader20_batch_capacity() result')).rows[0].result.available_for_new_entry,1);await pg.close();
});
test('unavailable account truth permits no reservation',async()=>{
 const pg=await setup();const r=(await pg.query("select deterministic_reserve_entry_slot('TESTUSDT',123,null,clock_timestamp()+interval '2 minutes') result")).rows[0].result;
 assert.equal(r.reserved,false);assert.equal(r.reason,'ACCOUNT_SNAPSHOT_STALE_OR_INCOMPLETE');await pg.close();
});
test('one malformed symbol is isolated from healthy 24 x 5 second capture',async()=>{
 const pg=await setup();await addCapture(pg,'GOODUSDT');const at=await addCapture(pg,'BADUSDT',{malformed:true});
 const r=(await pg.query('select deterministic_market_context($1,$2) result',[['GOODUSDT','BADUSDT'],new Date(at).toISOString()])).rows[0].result;
 assert.equal(r.GOODUSDT.status,'AVAILABLE');assert.equal(r.GOODUSDT.buckets,24);assert.equal(r.BADUSDT.reason,'MALFORMED_SYMBOL_CAPTURE');await pg.close();
});
test('disabled control or an unconfirmed state cannot materialize an auto-approved candidate',async()=>{
 const pg=await setup();await publish(pg);const now=Math.floor(Date.now()/5000)*5000,
  features={deterministic:{version:'DETERMINISTIC_DYNAMIC_STATE_1',generation:1,decision:{decision:'BUY',setup:'PASS',confirmation:'PASS',trigger:'BREAKOUT'}}};
 const disabled=(await pg.query("select deterministic_candidate('SYMBOL0USDT',$1,$2) result",[now,features])).rows[0].result;assert.equal(disabled.created,false);
 await pg.exec('update deterministic_control set enabled=true');features.deterministic.decision.decision='WAIT';
 assert.equal((await pg.query("select deterministic_candidate('SYMBOL0USDT',$1,$2) result",[now,features])).rows[0].result.created,false);
 features.deterministic.decision.decision='BUY';const valid=(await pg.query("select deterministic_candidate('SYMBOL0USDT',$1,$2) result",[now,features])).rows[0].result;
 assert.equal(valid.created,true);assert.equal((await pg.query('select count(*) n from net.requests')).rows[0].n,1);
 assert.equal((await pg.query('select deterministic_entry_authority($1) result',[valid.id])).rows[0].result.allowed,true);
 await pg.exec('update deterministic_control set generation=2');assert.equal((await pg.query('select deterministic_entry_authority($1) result',[valid.id])).rows[0].result.allowed,false);await pg.close();
});

test('deterministic submit and gateway fences require current BUY, capacity, same identity and current account generation',async()=>{
 const pg=await setup();await publish(pg);await snapshot(pg,305);await pg.exec('update deterministic_control set enabled=true');
 const at=Date.now(),owner='11111111-1111-4111-8111-111111111111',state={version:'DETERMINISTIC_DYNAMIC_STATE_1',decision:'BUY',setup:'PASS',confirmation:'PASS',trigger:'BREAKOUT',at,capture_end_ms:at},
 features={deterministic:{version:state.version,generation:1,decision:state}},signal=(await pg.query("select deterministic_candidate('SYMBOL0USDT',$1,$2) result",[at,features])).rows[0].result.id;
 await pg.query("insert into v17_execution_lease values(true,$1,1,clock_timestamp()+interval '150 seconds',pg_postmaster_start_time())",[owner]);
 const order={market:'SYMBOL0USDT',side:'BUY',type:'LIMIT',price:100,time_in_force:'IOC',quantity:4.5,identifier:'fixed-client',position_effect:'OPEN',position_side:'LONG'},
 command={exchange:'binance_futures',action:'create_order',leverage:3,order},
 intent=(await pg.query("insert into v11_long_regime_orders(symbol,state,signal_id,intent,client_order_id,requested_quantity,request_payload) values('SYMBOL0USDT','PLANNED',$1,'OPEN_LONG','fixed-client',4.5,$2) returning id",[signal,{...command,deterministic:{version:state.version},entry_ioc_attempt:1}])).rows[0].id,
 submit=async s=>(await pg.query('select deterministic_begin_submit($1,$2,$3) result',[intent,owner,s])).rows[0].result,
 auth=async c=>(await pg.query('select v17_gateway_authorize($1,$2,$3,1,$4) result',['proof-key-0123456789','binance_futures:futures',owner,c])).rows[0].result;
 assert.equal((await submit(state)).reason,'CAPACITY_RESERVATION_MISSING');
 await pg.query("insert into leader20_entry_reservations(symbol,signal_id,expires_at,state) values('SYMBOL0USDT',$1,clock_timestamp()+interval '2 minutes','RESERVED')",[signal]);
 assert.equal((await submit({...state,decision:'WAIT'})).updated,false);
 assert.equal((await submit({...state,at:Date.now()-3100})).reason,'CURRENT_STATE_STALE');
 assert.equal((await submit({...state,at:Date.now(),capture_end_ms:Date.now()})).updated,true);
 assert.equal(await auth(command),true);assert.equal(await auth({...command,order:{...order,quantity:4}}),false);
 await pg.exec('update deterministic_control set generation=2');assert.equal(await auth(command),false);
 await pg.exec("update deterministic_control set generation=1;update v17_execution_lease set postmaster_started_at=postmaster_started_at-interval '1 minute'");
 assert.equal(await auth(command),false);await pg.close();
});

test('a malformed ingest row does not roll back another symbol in the same batch',async()=>{
 const pg=await setup(),body={worker_id:'fixture-worker-123',batch_id:'22222222-2222-4222-8222-222222222222',rows:[
  {kind:'micro',symbol:'GOODUSDT',at:new Date().toISOString(),payload:{mid:100}},
  {kind:'micro',symbol:'BADUSDT',at:'corrupt-timestamp',payload:{mid:100}}
 ]};const result=(await pg.query("select doa_capture_rpc('ingest',$1) result",[body])).rows[0].result;
 assert.equal(result.inserted,1);assert.equal(result.rejected_rows,1);
 assert.equal((await pg.query('select symbol from doa_capture.live_micro')).rows[0].symbol,'GOODUSDT');await pg.close();
});
