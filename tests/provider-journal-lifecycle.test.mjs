import test from 'node:test';import assert from 'node:assert/strict';
import {SupabaseReviewStore} from '../supabase/functions/_shared/gpt-final-review/supabase-store.mjs';
import {withReviewContext,withAnalysisContext,currentExecutionContext,assertActiveExecutionRequest,withWriterContext} from '../supabase/functions/v10-lane-executor/account-execution-context.mjs';
import {createProviderJournal} from '../supabase/functions/v10-lane-executor/account-provider-journal.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
test('an already-owned GPT response completes durable journal after analysis lease is released',async()=>{
 const later=deferred(),calls=[],db={};db.providerJournal={assertCanStart:()=>assertActiveExecutionRequest(db),receipts:{rpc:async(name,args)=>{calls.push({name,args});return {data:{done:true}};}}};
 let child;const store=new SupabaseReviewStore(db);
 await withAnalysisContext(db,async()=>{child=(async()=>{await later.promise;assert.throws(()=>assertActiveExecutionRequest(db),/FINISHED/);return store.complete('original-job','original-owner',{result:{decision:'BUY'}});})();});
 later.resolve();assert.equal(await child,true);assert.deepEqual(calls,[{name:'gpt_final_review_complete',args:{p_job_key:'original-job',p_owner:'original-owner',p_record:{result:{decision:'BUY'}}}}]);
});
test('a delayed child cannot start another paid review or borrow a new writer after its analysis ends',async()=>{
 const later=deferred(),db={},calls=[];db.providerJournal={assertCanStart:()=>assertActiveExecutionRequest(db),receipts:{rpc:async()=>{calls.push(1);throw Error('MUST_NOT_CALL');}}};let child;const store=new SupabaseReviewStore(db);
 await withAnalysisContext(db,async()=>{child=(async()=>{await later.promise;await assert.rejects(store.claim('new-job',{},{}),/FINISHED/);await assert.rejects(withWriterContext(db,'new-writer',async()=>{}),/FINISHED/);})();});later.resolve();await child;assert.equal(calls.length,0);
});

test('already-scheduled review completes its FINAL stage independently while scan ends; it never owns order authority',async()=>{
 const later=deferred(),db={},started=deferred();let task;
 await withAnalysisContext(db,async()=>{task=withReviewContext(db,{key:'immutable-review',deadline:Date.now()+60000},async()=>{started.resolve();await later.promise;const c=assertActiveExecutionRequest(db);assert.equal(c.kind,'REVIEW');assert.equal(c.reviewKey,'immutable-review');await assert.rejects(withWriterContext(db,'writer',async()=>{}),/REVIEW_CANNOT_ACQUIRE/);return 'FINAL_STORED';});await started.promise;});
 later.resolve();assert.equal(await task,'FINAL_STORED');assert.equal(currentExecutionContext(db),null);
});
test('finished analysis cannot create a detached review and expired review cannot start a provider',async()=>{
 const db={},later=deferred();let task;await withAnalysisContext(db,async()=>{task=(async()=>{await later.promise;await assert.rejects(withReviewContext(db,{key:'late',deadline:Date.now()+60000},async()=>{}),/FINISHED/);})();});later.resolve();await task;await assert.rejects(withReviewContext(db,{key:'expired',deadline:Date.now()-1},async()=>{}),/REVIEW_TRIGGER_EXPIRED/);
});

test('real journal adapter binds paid stages to the scheduled immutable job and cannot call trading RPCs',async()=>{
 const db={},calls=[],receipts={rpc:async(name,args)=>{calls.push({name,args});return {data:true};}};db.providerJournal=createProviderJournal(db,receipts);const later=deferred();let review;
 await withAnalysisContext(db,async()=>{review=db.providerJournal.reviewScope({key:'same-review',deadline:Date.now()+60000},async()=>{await later.promise;db.providerJournal.assertCanStart('same-review');assert.throws(()=>db.providerJournal.assertCanStart('other-review'),/BINDING_MISMATCH/);await db.providerJournal.ledger.rpc('ai_call_reserve_owned',{p_parent:'same-review'});assert.throws(()=>db.providerJournal.ledger.rpc('ai_call_reserve_owned',{p_parent:'other-review'}),/PARENT_MISMATCH/);assert.throws(()=>db.providerJournal.ledger.rpc('leader20_execution_claim',{}),/RPC_ONLY/);});});later.resolve();await review;assert.equal(calls.length,1);
});
