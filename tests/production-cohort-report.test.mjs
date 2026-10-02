import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
async function fixture(t){
 const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href),db=new PGlite();t.after(()=>db.close());
 await db.exec(`create table gpt_final_entry_reviews(job_key text primary key,purpose text,state text,valid boolean,decision text,record jsonb);
 create table leader20_execution_dispatches(signal_id uuid,gpt_completed_at timestamptz,state text,terminal_reason text,last_error text,dispatch_requested_at timestamptz,executor_claimed_at timestamptz,valid_until timestamptz,terminal_at timestamptz);
 create table leader20_clock_executions(signal_id uuid,gpt_buy_completed_at timestamptz,clock_safety_result text,order_sent_at timestamptz);
 create table v11_long_regime_orders(id uuid,signal_id uuid,position_id uuid,intent text,created_at timestamptz,exchange_order_id text,requested_quantity numeric,request_payload jsonb,response_payload jsonb,state text);
 create table v11_long_regime_positions(id uuid,signal_id uuid,entry_at timestamptz,state text,metadata jsonb);`);
 const query=await readFile(new URL('../ops/execution-infra/cohort.sql',import.meta.url),'utf8');
 const decision=async(key,{age=3600000,purpose='PRODUCTION',signal=crypto.randomUUID()}={})=>{
  const ms=Date.now()-age;
  await db.query('insert into gpt_final_entry_reviews values($1,$2,\'DONE\',true,\'BUY\',$3)',[key,purpose,
   {identity:{signal_id:signal},result:{completed_at_ms:ms,review_route:'TOP20_CLOCK_GPT_FINAL_3'}}]);
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
 assert.equal(rows.find(r=>r.decision_id==='null-error').reason,'UNCLASSIFIED_TERMINAL_REASON');
 assert.equal(new Set(rows.map(r=>r.decision_id)).size,rows.length);
});
