import test from 'node:test';import assert from 'node:assert/strict';
import {SupabaseReviewStore} from '../supabase/functions/_shared/gpt-final-review/supabase-store.mjs';
import {withAnalysisContext,assertActiveExecutionRequest,withWriterContext} from '../supabase/functions/v10-lane-executor/account-execution-context.mjs';
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
