import test from 'node:test';import assert from 'node:assert/strict';import {readFile,readdir} from 'node:fs/promises';import {pathToFileURL} from 'node:url';
async function fixture(t){
 const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href),db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table leader20_execution_dispatches(signal_id uuid primary key,symbol text,state text,gpt_completed_at timestamptz,valid_until timestamptz,
 dispatch_requested_at timestamptz default clock_timestamp(),executor_claimed_at timestamptz,execution_started_at timestamptz,
 claim_owner uuid,claim_lease_until timestamptz,claim_attempts integer default 0,order_id uuid,terminal_at timestamptz,terminal_reason text,last_error text,updated_at timestamptz);
 create table leader20_clock_executions(signal_id uuid primary key,order_sent_at timestamptz,executor_claimed_at timestamptz,terminal_reason text,execution_failure_reason text,updated_at timestamptz);
 create table v11_long_regime_orders(id uuid primary key,signal_id uuid,intent text,created_at timestamptz default clock_timestamp(),symbol text,request_payload jsonb,response_payload jsonb,requested_quantity numeric,state text,position_id uuid);
 create table v11_long_regime_positions(id uuid primary key,signal_id uuid,symbol text,original_quantity numeric,metadata jsonb);`);
 const dir=new URL('../supabase/migrations/',import.meta.url),files=(await readdir(dir)).filter(f=>f.endsWith('_dispatch_no_resubmit_recovery.sql'));assert.equal(files.length,1);await db.exec(await readFile(new URL(files[0],dir),'utf8'));
 const owner=crypto.randomUUID();
 const insert=async({state='READY_TO_EXECUTE',expired=false,leaseActive=false,order=false,seconds=60}={})=>{
  const id=crypto.randomUUID(),orderId=order?crypto.randomUUID():null;
  await db.query(`insert into leader20_execution_dispatches(signal_id,symbol,state,gpt_completed_at,valid_until,claim_owner,claim_lease_until,order_id)
   values($1,'ABCUSDT',$2,clock_timestamp()-interval '60 seconds',clock_timestamp()+($3||' seconds')::interval,$4,
    clock_timestamp()+($5||' seconds')::interval,$6)`,[id,state,expired?-1:seconds,crypto.randomUUID(),leaseActive?50:-1,orderId]);
  await db.query('insert into leader20_clock_executions(signal_id) values($1)',[id]);
  if(order)await db.query("insert into v11_long_regime_orders(id,signal_id,intent) values($1,$2,'OPEN_LONG')",[orderId,id]);
  return id;
 };
 return {db,owner,insert,claim:async id=>(await db.query('select leader20_execution_claim($1,$2,24000) result',[id??null,owner])).rows[0].result,
 row:async id=>(await db.query('select * from leader20_execution_dispatches where signal_id=$1',[id])).rows[0]};
}
for(const expired of [false,true])test(`lost acknowledgement ${expired?'after':'before'} deadline stays UNKNOWN and is never claimed`,async t=>{
 const f=await fixture(t),id=await f.insert({state:'ORDER_SUBMITTING',expired});const r=await f.claim(id);
 assert.equal(r.claimed,false);assert.equal(r.reason,'ORDER_IDENTITY_RECONCILIATION_REQUIRED');
 const d=await f.row(id);assert.equal(d.state,'UNKNOWN');assert.equal(d.claim_attempts,0);assert.equal(d.terminal_at,null);
 assert.equal((await f.claim(id)).claimed,false);assert.equal((await f.db.query('select count(*)::int n from leader20_execution_recovery_events')).rows[0].n,1);
});
for(const state of ['READY_TO_EXECUTE','EXECUTION_CLAIMED'])test(`${state} with an existing order cannot submit another entry`,async t=>{
 const f=await fixture(t),id=await f.insert({state,order:true});assert.equal((await f.claim(id)).claimed,false);assert.equal((await f.row(id)).state,'UNKNOWN');
});
test('an active claim is not stolen, including SUBMITTING',async t=>{
 const f=await fixture(t),id=await f.insert({state:'ORDER_SUBMITTING',leaseActive:true});assert.equal((await f.claim(id)).reason,'EXECUTION_ALREADY_CLAIMED');assert.equal((await f.row(id)).state,'ORDER_SUBMITTING');
});
test('worker death before any intent permits safe takeover inside the original deadline',async t=>{
 const f=await fixture(t),id=await f.insert({state:'EXECUTION_CLAIMED'});const r=await f.claim(id);assert.equal(r.claimed,true);assert.equal(r.row.claim_owner,f.owner);assert.equal(r.row.claim_attempts,1);
});
test('a no-intent expired BUY never becomes claimed or submitted',async t=>{
 const f=await fixture(t),id=await f.insert({expired:true});assert.equal((await f.claim(id)).reason,'CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION');assert.equal((await f.row(id)).claim_attempts,0);
});
test('existing 24-second reserve remains unchanged',async t=>{
 const f=await fixture(t),id=await f.insert({seconds:20});assert.equal((await f.claim(id)).reason,'EXECUTION_WINDOW_INSUFFICIENT');assert.equal((await f.row(id)).claim_attempts,0);
});
test('ambiguous and expired heads cannot starve a newer valid durable BUY',async t=>{
 const f=await fixture(t),unknown=await f.insert({state:'ORDER_SUBMITTING'}),expired=await f.insert({expired:true}),valid=await f.insert();const r=await f.claim();
 assert.equal(r.claimed,true);assert.equal(r.row.signal_id,valid);assert.equal((await f.row(unknown)).state,'UNKNOWN');assert.equal((await f.row(expired)).state,'CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION');
});
test('a duplicate generic tick cannot steal or duplicate an active claim',async t=>{
 const f=await fixture(t),id=await f.insert();assert.equal((await f.claim()).row.signal_id,id);assert.equal((await f.claim()).claimed,false);assert.equal((await f.row(id)).claim_attempts,1);
});
test('SUBMITTING transition cannot release an ambiguous request back to READY',async t=>{
 const f=await fixture(t),id=await f.insert({state:'ORDER_SUBMITTING',leaseActive:true}),d=await f.row(id);
 const r=await f.db.query("select leader20_execution_transition($1,$2,'READY_TO_EXECUTE',null,null) result",[id,d.claim_owner]);
 assert.equal(r.rows[0].result.row.state,'UNKNOWN');assert.equal((await f.row(id)).last_error,'SUBMISSION_OUTCOME_UNKNOWN');
});
async function orderEvidence(f,id,{quantity=10,filled=10,state='FILLED',wrongDecision=false,attributed=true}={}){
 const d=await f.row(id),orderId=crypto.randomUUID(),position=crypto.randomUUID();
 const completed=Number((await f.db.query('select (extract(epoch from gpt_completed_at)*1000)::bigint m from leader20_execution_dispatches where signal_id=$1',[id])).rows[0].m)+(wrongDecision?1:0);
 const request={order:{side:'BUY',position_effect:'OPEN'},entry_gpt_decision:{clockFinalAuthority:{signal_id:id,completed_at_ms:completed,authority_version:'TOP20_CLOCK_GPT_FINAL_3'}}};
 const response={v18ExposureFinal:true,orderStateEvidence:{state,quantityConsistent:true,requestedQty:quantity,executedQty:filled,remainingQty:quantity-filled,rawStatus:state==='FILLED'?'FILLED':'EXPIRED',reconciliation:{observed:true}}};
 await f.db.query("insert into v11_long_regime_orders(id,signal_id,intent,symbol,request_payload,response_payload,requested_quantity,state,position_id) values($1,$2,'OPEN_LONG','ABCUSDT',$3,$4,$5,$6,$7)",[orderId,id,request,response,quantity,state,attributed?position:null]);
 if(attributed)await f.db.query("insert into v11_long_regime_positions values($1,$2,'ABCUSDT',$3,$4)",[position,id,filled,{executionMode:'LEADER_MOMENTUM_V17'}]);
 return orderId;
}
test('after process crash, same-decision reconciled full fill becomes FILLED without another submission',async t=>{
 const f=await fixture(t),id=await f.insert({state:'UNKNOWN'});await orderEvidence(f,id);
 assert.equal((await f.db.query('select leader20_reconcile_execution_dispatches(20) result')).rows[0].result.reconciled,1);assert.equal((await f.row(id)).state,'FILLED');
 assert.equal((await f.claim(id)).claimed,false);
});
test('a terminal partial fill remains partial and is not reported as fully FILLED',async t=>{
 const f=await fixture(t),id=await f.insert({state:'UNKNOWN'});await orderEvidence(f,id,{filled:4,state:'PARTIALLY_FILLED_CANCELED'});
 await f.db.query('select leader20_reconcile_execution_dispatches(20)');assert.equal((await f.row(id)).state,'PARTIALLY_FILLED_CANCELED');
});
for(const [name,opts] of [['wrong decision',{wrongDecision:true}],['missing attribution',{attributed:false}],['partial mislabeled FILLED',{filled:4,state:'FILLED'}]])test(`recovery rejects ${name} and preserves UNKNOWN`,async t=>{
 const f=await fixture(t),id=await f.insert({state:'UNKNOWN'});await orderEvidence(f,id,opts);const r=await f.db.query('select leader20_reconcile_execution_dispatches(20) result');
 assert.equal(r.rows[0].result.reconciled,0);assert.equal((await f.row(id)).state,'UNKNOWN');assert.equal((await f.claim(id)).claimed,false);
});
