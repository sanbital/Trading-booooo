import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {paidTransport} from '../supabase/functions/_shared/leader20/paid-transport.mjs';
const fixture=JSON.parse(await readFile(new URL('../test-support/production-unknown-http200-20260928.json',import.meta.url)));
const migration=new URL('../supabase/migrations/20260928081300_preserve_unknown_provider_receipt.sql',import.meta.url);
test('observed HTTP200 without usage retains its receipt and reserve without provider retry',async()=>{
 const events=[];let calls=0,clock=0;
 const db={rpc:async(name,p)=>{events.push({name,p});return {data:name==='ai_call_reserve_owned'?{created:true,row:{owner:fixture.owner}}:{state:p.p_state}};}};
 const response=new Response('{incomplete',{status:200,headers:{'x-request-id':fixture.observed_first.request_id}});
 const result=await paidTransport(db,{parentKey:fixture.source_review,purpose:'RECHECK',now:()=>clock,fetchFn:async()=>{calls++;clock=2500;return response;}})('https://api.openai.com/v1/responses',{body:JSON.stringify({model:fixture.model,max_output_tokens:100,input:'original-receipt-replay'})});
 assert.equal(result,response);assert.equal(calls,1);
 assert.deepEqual(events.map(e=>e.name==='ai_call_reserve_owned'?'RESERVED':e.p.p_state),['RESERVED','DISPATCHED','UNKNOWN']);
 const u=events.at(-1).p;assert.equal(u.p_request_id,fixture.observed_first.request_id);assert.equal(u.p_latency_ms,2500);assert.equal(u.p_usage,undefined);assert.equal(u.p_error,'USAGE_UNAVAILABLE_HTTP_200');
});
test('pre-header transport failure keeps only observed elapsed time and never invents a receipt',async()=>{
 let clock=0,calls=0;const events=[],db={rpc:async(n,p)=>{events.push(p);return {data:n==='ai_call_reserve_owned'?{created:true,row:{owner:fixture.owner}}:{state:p.p_state}};}};
 await assert.rejects(paidTransport(db,{parentKey:'preheader',purpose:'HOLD',now:()=>clock,fetchFn:async()=>{calls++;clock=1200;throw Error('timeout');}})('https://api.deepseek.com/chat/completions',{body:JSON.stringify({model:'deepseek-flash',max_tokens:100,messages:[]})}),/timeout/);
 assert.equal(calls,1);assert.equal(events.at(-1).p_state,'UNKNOWN');assert.equal(events.at(-1).p_latency_ms,1200);assert.equal(events.at(-1).p_request_id,undefined);assert.equal(events.some(e=>e.p_state==='CANCELLED'),false);
});
test('UNKNOWN metadata is owner-bound, idempotent and cost-neutral through later settlement',async t=>{
 const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href),db=new PGlite();t.after(()=>db.close());
 await db.exec(`create table gpt_final_entry_reviews(job_key text primary key,state text,record jsonb);
 create table ai_call_ledger(call_key text primary key,owner uuid,state text,provider text,parent_key text,reserved_usd numeric,actual_usd numeric,input_tokens bigint,output_tokens bigint,cached_input_tokens bigint,request_id text,cost_basis text,latency_ms bigint,settled_at timestamptz,error text);`);
 const q=async(s,p=[]) => (await db.query(s,p)).rows;
 const transition=(state,usage=null,id=null,ms=null,owner=fixture.owner)=>q('select ai_call_transition($1,$2::uuid,$3,$4::jsonb,$5,$6::bigint,$7) r',[fixture.call_key,owner,state,usage,id,ms,'USAGE_UNAVAILABLE_HTTP_200']);
 await q('insert into ai_call_ledger(call_key,owner,state,provider,parent_key,reserved_usd) values($1,$2,\'DISPATCHED\',\'openai\',$3,$4)',[fixture.call_key,fixture.owner,fixture.source_review,fixture.reserved_usd]);
 await db.exec(fixture.original_transition_definition);
 await transition('UNKNOWN',null,fixture.observed_first.request_id,2500);
 assert.equal((await q('select request_id from ai_call_ledger'))[0].request_id,null,'original source reproduces missing metadata');
 await db.exec(await readFile(migration,'utf8'));
 const before=(await q('select coalesce(actual_usd,reserved_usd)::text charged from ai_call_ledger'))[0].charged;
 await assert.rejects(transition('UNKNOWN',null,'wrong-owner',1,crypto.randomUUID()),/API_CALL_OWNER/);
 await transition('UNKNOWN',null,fixture.observed_first.request_id,2500);
 await transition('UNKNOWN',null,'conflicting-retry',9999);
 let row=(await q('select * from ai_call_ledger'))[0];
 assert.equal(row.request_id,fixture.observed_first.request_id);assert.equal(row.latency_ms,2500);assert.equal(row.actual_usd,null);assert.equal(row.input_tokens,null);assert.equal(row.output_tokens,null);assert.equal(row.state,'UNKNOWN');assert.equal(row.settled_at,null);
 assert.equal((await q('select coalesce(actual_usd,reserved_usd)::text charged from ai_call_ledger'))[0].charged,before);
 await assert.rejects(transition('CANCELLED'),/API_CALL_TRANSITION/);
 await transition('SETTLED',{input_tokens:18050,output_tokens:735,cached_input_tokens:6400});
 row=(await q('select * from ai_call_ledger'))[0];assert.equal(Number(row.actual_usd),.012525);assert.equal(row.request_id,fixture.observed_first.request_id,'late usage without a new ID preserves known receipt');
 await transition('SETTLED');assert.equal(Number((await q('select actual_usd from ai_call_ledger'))[0].actual_usd),.012525);
 await q("update ai_call_ledger set state='DISPATCHED',actual_usd=null,input_tokens=null,output_tokens=null,request_id=null,latency_ms=null,settled_at=null");
 await transition('UNKNOWN',null,'new-header',4300);row=(await q('select * from ai_call_ledger'))[0];assert.equal(row.request_id,'new-header');assert.equal(row.latency_ms,4300);assert.equal(row.actual_usd,null);
 await q("update ai_call_ledger set state='RESERVED'");await q("insert into gpt_final_entry_reviews values($1,'DONE','{}')",[fixture.source_review]);
 await assert.rejects(transition('DISPATCHED'),/API_PARENT_EXPIRED_OR_TERMINAL/);
});

