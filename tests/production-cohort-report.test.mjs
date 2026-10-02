import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
async function fixture(t){
 const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href),db=new PGlite();t.after(()=>db.close());
 await db.exec(`create table gpt_final_entry_reviews(job_key text primary key,purpose text,state text,valid boolean,decision text,record jsonb);
 create table leader20_execution_dispatches(signal_id uuid,gpt_completed_at timestamptz,state text,terminal_reason text,last_error text,dispatch_requested_at timestamptz,executor_claimed_at timestamptz,valid_until timestamptz,terminal_at timestamptz);
 create table leader20_clock_executions(signal_id uuid,gpt_buy_completed_at timestamptz,clock_safety_result text,order_sent_at timestamptz,trace jsonb);
 create table v11_long_regime_orders(id uuid,signal_id uuid,position_id uuid,intent text,created_at timestamptz,exchange_order_id text,requested_quantity numeric,request_payload jsonb,response_payload jsonb,state text);
 create table v11_long_regime_positions(id uuid,signal_id uuid,entry_at timestamptz,state text,metadata jsonb);`);
 const query=await readFile(new URL('../ops/execution-infra/cohort.sql',import.meta.url),'utf8');
 const decision=async(key,{age=3600000,purpose='PRODUCTION',signal=crypto.randomUUID(),origin='OPENAI_API'}={})=>{
  const ms=Date.now()-age;
  await db.query('insert into gpt_final_entry_reviews values($1,$2,\'DONE\',true,\'BUY\',$3)',[key,purpose,
   {identity:{signal_id:signal},result:{completed_at_ms:ms,review_route:'TOP20_CLOCK_GPT_FINAL_3',origin}}]);
  return {key,signal,ms};
 };
 const dispatch=async(d,{reason=null,error=null,claimed=true}={})=>db.query(`insert into leader20_execution_dispatches values
  ($1,to_timestamp($2::numeric/1000),'EXECUTION_WINDOW_INSUFFICIENT',$3,$4,to_timestamp($2::numeric/1000),
   case when $5 then to_timestamp(($2::numeric+10)/1000) end,to_timestamp(($2::numeric+120000)/1000),statement_timestamp())`,
  [d.signal,d.ms,reason,error,claimed]);
 return {db,decision,dispatch,report:()=>db.query(query).then(x=>x.rows)};
}
test('24h and 7d use identical cutoff, exact completion cohorts and exclude test/replay purposes',async t=>{
 const f=await fixture(t);await f.decision('recent');await f.decision('old',{age:2*86400000});
 await f.decision('test',{purpose:'TEST'});await f.decision('replay',{purpose:'REPLAY'});await f.decision('dry',{purpose:'DRYRUN'});
 await f.decision('tagged-replay',{purpose:'PRODUCTION',origin:'REPLAY'});
 const rows=await f.report();assert.equal(rows.length,3);
 assert.equal(rows.filter(r=>r.period==='24h').length,1);assert.equal(rows.filter(r=>r.period==='7d').length,2);
 assert.ok(rows.every(r=>new Date(r.utc_cutoff).getTime()===new Date(rows[0].utc_cutoff).getTime()));
 assert.ok(rows.every(r=>r.reason==='DISPATCH_MISSING'));
});
test('same-symbol/signal orders cannot be borrowed by another production decision',async t=>{
 const f=await fixture(t),signal=crypto.randomUUID(),a=await f.decision('A',{signal}),b=await f.decision('B',{signal,age:3500000});
 await f.dispatch(a,{reason:'EXPIRED',error:'EXECUTOR_BUSY'});
 await f.db.query(`insert into v11_long_regime_orders values($1,$2,null,'OPEN_LONG',statement_timestamp()-interval '1 minute','123',1,$3,$4,'FILLED')`,
  [crypto.randomUUID(),signal,{entry_gpt_decision:{jobKey:'A'}},{v22EntryFinality:{executedQty:1,finalStatus:'FILLED'}}]);
 const rows=(await f.report()).filter(r=>r.period==='24h');
 assert.equal(rows.find(r=>r.decision_id==='A').exchange_acknowledged,true);
 assert.equal(rows.find(r=>r.decision_id==='B').exchange_acknowledged,false);
 assert.equal(rows.find(r=>r.decision_id==='B').reason,'DISPATCH_MISSING');
});
test('partial quantity in legacy FILLED state is counted as partial, never a full fill',async t=>{
 const f=await fixture(t),d=await f.decision('partial');await f.dispatch(d,{reason:'PARTIALLY_FILLED'});
 await f.db.query(`insert into v11_long_regime_orders values($1,$2,null,'OPEN_LONG',statement_timestamp()-interval '1 minute','123',1,$3,$4,'FILLED')`,
  [crypto.randomUUID(),d.signal,{entry_gpt_decision:{jobKey:d.key}},{v22EntryFinality:{executedQty:.2,finalStatus:'PARTIALLY_FILLED'}}]);
 const rows=await f.report();assert.ok(rows.every(r=>r.partial_or_filled&&!r.fully_filled));
 assert.ok(rows.every(r=>r.reason==='FILL_ATTRIBUTION_MISSING'));
});
test('one exclusive reason separates busy/unclaimed/null-error window failures',async t=>{
 const f=await fixture(t);
 for(const [key,claimed,error]of [['busy',true,'EXECUTOR_BUSY'],['unclaimed',false,null],['null-error',true,null]]){
  const d=await f.decision(key);await f.dispatch(d,{reason:'EXECUTION_WINDOW_INSUFFICIENT',claimed,error});
 }
 const rows=(await f.report()).filter(r=>r.period==='24h');
 assert.equal(rows.find(r=>r.decision_id==='busy').reason,'EXECUTOR_BUSY');
 assert.equal(rows.find(r=>r.decision_id==='unclaimed').reason,'UNCLAIMED_DEADLINE_EXPIRED');
 assert.equal(rows.find(r=>r.decision_id==='null-error').reason,'TERMINAL_ERROR_CONTEXT_MISSING');
 assert.equal(new Set(rows.map(r=>r.decision_id)).size,rows.length);
});
test('a passed quote check cannot inflate validation when latest 24-bucket validity failed',async t=>{
 const f=await fixture(t);
 for(const [key,result,gpt,expected]of [['invalid','INVALID',null,false],['uncertain','UNCERTAIN','CANCEL_BUY',false],
  ['confirmed','UNCERTAIN','KEEP_BUY',true],['valid','VALID',null,true]]){
  const d=await f.decision(key);await f.dispatch(d);
  await f.db.query(`insert into leader20_clock_executions values($1,to_timestamp($2::numeric/1000),'PASS',null,$3)`,
   [d.signal,d.ms,{validity_result:result,gpt_recheck_result:gpt}]);
  const row=(await f.report()).find(r=>r.period==='24h'&&r.decision_id===key);
  assert.equal(row.market_validation_pass,expected,key);
  assert.equal(row.validation_pass,false,'market evidence alone cannot prove all order guards passed');
 }
});
test('pre-order validation requires the same decision boundary proof inside its original authority deadline',async t=>{
 const f=await fixture(t);
 for(const [key,offset,expected]of [['bound',10,true],['at-deadline',120000,false],['after-deadline',130000,false],['before-buy',-10,false]]){
  const d=await f.decision(key);await f.dispatch(d);
  await f.db.query(`insert into v11_long_regime_orders values($1,$2,null,'OPEN_LONG',statement_timestamp()-interval '1 minute','123',1,$3,$4,'FILLED')`,
   [crypto.randomUUID(),d.signal,{entry_gpt_decision:{jobKey:d.key}},
    {v22EntryFinality:{clockExecutionSafety:{checked_at_ms:d.ms+offset,validity_result:'VALID'}}}]);
  const row=(await f.report()).find(r=>r.period==='24h'&&r.decision_id===key);
  assert.equal(row.validation_pass,expected,key);
 }
});
test('ack timestamp alone, rejected stop and malformed metadata never prove protection installed',async t=>{
 const f=await fixture(t);
 for(const [key,orders,expected]of [['timestamp-only',[{ackAt:Date.now()-1000}],false],
  ['rejected',[{ackAt:Date.now()-1000,algoId:'123',status:'REJECTED'}],false],
  ['malformed',{ackAt:Date.now()-1000},false],
  ['active',[{ackAt:Date.now()-1000,algoId:'123',status:'ACTIVE'}],true]]){
  const d=await f.decision(key);await f.dispatch(d);const pos=crypto.randomUUID();
  await f.db.query(`insert into v11_long_regime_positions values($1,$2,statement_timestamp()-interval '1 minute','OPEN',$3)`,
   [pos,d.signal,{exitProtection:{orders}}]);
  await f.db.query(`insert into v11_long_regime_orders values($1,$2,$3,'OPEN_LONG',statement_timestamp()-interval '1 minute','123',1,$4,$5,'FILLED')`,
   [crypto.randomUUID(),d.signal,pos,{entry_gpt_decision:{jobKey:d.key}},{v22EntryFinality:{executedQty:1,finalStatus:'FILLED'}}]);
  const row=(await f.report()).find(r=>r.period==='24h'&&r.decision_id===key);
  assert.equal(row.protection_installed,expected,key);
 }
});

test('GPT recheck cancellation and stale protection backlog have different outcome classes',async t=>{
 const f=await fixture(t);
 for(const [key,error,reason,category]of [
  ['cancel','PRE_EXECUTION_GPT_CANCEL_OR_ERROR:CANCEL_BUY','GPT_RECHECK_CANCELED','STRATEGIC_OR_VENUE_REFUSAL'],
  ['protection','STALE_PROTECTION_SYMBOL_LOCKED','PROTECTION_RECONCILIATION_PENDING','SYSTEM_FAILURE_OR_UNRESOLVED']]) {
  const d=await f.decision(key);await f.dispatch(d,{reason:'REJECTED',error});
  const row=(await f.report()).find(r=>r.period==='24h'&&r.decision_id===key);
  assert.equal(row.reason,reason);assert.equal(row.outcome_class,category);
 }
});
test('malformed signal identity stays a missing dispatch rather than crashing the complete cohort',async t=>{
 const f=await fixture(t);await f.decision('malformed',{signal:'invalid-uuid'});
 const rows=await f.report();assert.ok(rows.every(r=>r.reason==='DISPATCH_MISSING'));
});

test('production clock authority binds order and position to exact signal and GPT completion, not an absent jobKey',async t=>{
 const f=await fixture(t),signal=crypto.randomUUID(),a=await f.decision('authority-A',{signal}),b=await f.decision('authority-B',{signal,age:3500000});
 await f.dispatch(a);await f.dispatch(b);const pos=crypto.randomUUID();
 const payload={entry_gpt_decision:{clockFinalAuthority:{signal_id:signal,completed_at_ms:a.ms,authority_version:'TOP20_CLOCK_GPT_FINAL_3'}}};
 await f.db.query(`insert into v11_long_regime_orders values($1,$2,$3,'OPEN_LONG',statement_timestamp()-interval '1 minute','123',1,$4,$5,'FILLED')`,
  [crypto.randomUUID(),signal,pos,payload,{v22EntryFinality:{executedQty:1,finalStatus:'FILLED'}}]);
 await f.db.query(`insert into v11_long_regime_positions values($1,$2,statement_timestamp()-interval '1 minute','CLOSED','{}')`,[pos,signal]);
 const rows=(await f.report()).filter(r=>r.period==='24h'),ra=rows.find(r=>r.decision_id==='authority-A'),rb=rows.find(r=>r.decision_id==='authority-B');
 assert.equal(ra.exchange_acknowledged,true);assert.equal(ra.fully_filled,true);assert.equal(ra.position_attributed,true);
 assert.equal(rb.exchange_acknowledged,false);assert.equal(rb.position_attributed,false);
});

test('dynamic reversal, insufficient margin and infrastructure errors retain exclusive honest reasons',async t=>{
 const f=await fixture(t);
 for(const [error,reason,category]of [
  ['PRE_EXECUTION_INVALID:DYNAMIC_MULTI_AXIS_CHANGE','LATEST_DATA_VALIDATION_FAILED','STRATEGIC_OR_VENUE_REFUSAL'],
  ['INSUFFICIENT_MARGIN:100<150','CAPACITY_REJECTED','STRATEGIC_OR_VENUE_REFUSAL'],
  ['V17_CONTROLS_UNAVAILABLE','CONTROL_STATE_UNAVAILABLE','SYSTEM_FAILURE_OR_UNRESOLVED'],
  ['The signal has been aborted','DEPENDENCY_TIMEOUT_OR_5XX','SYSTEM_FAILURE_OR_UNRESOLVED'],
  ['PRE_EXECUTION_GPT_CANCEL_OR_ERROR:EXECUTION_WINDOW_INSUFFICIENT','WINDOW_EXPIRED_CAUSE_UNRESOLVED','UNCLASSIFIED'],
  ['IOC_RETRY_FILLED','RETRY_FILL_ATTRIBUTION_EVIDENCE_MISSING','SYSTEM_FAILURE_OR_UNRESOLVED']]){
  const d=await f.decision(error);await f.dispatch(d,{reason:'REJECTED',error});
  const row=(await f.report()).find(r=>r.period==='24h'&&r.decision_id===error);
  assert.equal(row.reason,reason);assert.equal(row.outcome_class,category);
 }
});
