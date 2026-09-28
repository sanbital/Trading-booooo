import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
test('clock execution journal keeps primary stale failure separate from later expiry and records true send timing',async t=>{
 const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href),db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create role service_role;
  create table v11_long_regime_signals(id uuid primary key,features jsonb);
  create table gpt_final_entry_reviews(purpose text,valid boolean,decision text,record jsonb);
  create table v11_long_regime_decisions(action text,reason text,details jsonb);
  create table v11_long_regime_orders(signal_id uuid,intent text,state text,created_at timestamptz,reject_reason text,request_payload jsonb,response_payload jsonb);`);
 await db.exec(await readFile(new URL('../supabase/migrations/20260928143800_clock_execution_quote_telemetry.sql',import.meta.url),'utf8'));
 const f=JSON.parse(await readFile(new URL('./fixtures/nmr-clock-quote-20260928-2320.json',import.meta.url))),sid=f.identity.signal_id;
 const record={identity:f.identity,packet:f.packet,result:f.result};
 await db.query("insert into v11_long_regime_signals values($1,'{}')",[sid]);
 await db.query("insert into gpt_final_entry_reviews values('PRODUCTION',true,'BUY',$1)",[record]);
 const row=async()=>(await db.query('select * from leader20_clock_executions where signal_id=$1',[sid])).rows[0];
 const at=f.result.completed_at_ms;
 await db.query("select leader20_clock_execution_note($1,$2)",[sid,{executor_wake_at:at+100,execution_started_at:at+200,
  fresh_quote_requested_at:at+300,fresh_quote_received_at:at+500,quote_age_ms:0,quote_after_gpt_ms:500,
  old_quote_used:false,quote_refresh_attempts:1,clock_safety_result:'CLOCK_EXECUTION_QUOTE_STALE'}]);
 await db.query("insert into v11_long_regime_decisions values('ENTRY_DEFER','CLOCK_EXECUTION_QUOTE_STALE',$1)",
  [{signalId:sid,stage:'ENTRY_ATTEMPT_OUTCOME',clockExecutionTelemetry:{execution_failure_reason:'CLOCK_EXECUTION_QUOTE_STALE'}}]);
 await db.exec('select leader20_clock_execution_expire()');
 let r=await row();assert.equal(r.execution_failure_reason,'CLOCK_EXECUTION_QUOTE_STALE');
 assert.equal(r.terminal_reason,'CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION');assert.equal(r.old_quote_used,false);
 assert.equal(Number(r.gpt_to_executor_wake_ms),100);assert.equal(Number(r.gpt_to_quote_ms),500);
 // An intent is not evidence that an exchange order was sent.
 await db.query("insert into v11_long_regime_orders values($1,'OPEN_LONG','PLANNED',$2,null,'{}','{}')",[sid,new Date(at+600)]);
 r=await row();assert.equal(r.order_sent_at,null);assert.equal(r.old_quote_used,false);
 await db.query("update v11_long_regime_orders set state='FILLED',response_payload=$1 where signal_id=$2",
  [{v22EntryFinality:{sentAt:at+900,clockExecutionTelemetry:{fresh_quote_received_at:at+850,quote_age_ms:0,
   clock_safety_result:'PASS',fill_at:at+1000,old_quote_used:false}}},sid]);
 r=await row();assert.equal(Number(r.gpt_to_order_ms),900);assert.equal(Number(r.quote_to_order_ms),50);
 assert.equal(new Date(r.fill_at).getTime(),at+1000);assert.equal(r.execution_failure_reason,'CLOCK_EXECUTION_QUOTE_STALE');
 assert.equal((await db.query("select relrowsecurity from pg_class where relname='leader20_clock_executions'")).rows[0].relrowsecurity,true);
 assert.equal((await db.query("select has_table_privilege('anon','leader20_clock_executions','select') allowed")).rows[0].allowed,false);
});
