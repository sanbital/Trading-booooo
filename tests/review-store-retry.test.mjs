import test from 'node:test';
import assert from 'node:assert/strict';
import {SupabaseReviewStore} from '../supabase/functions/_shared/gpt-final-review/supabase-store.mjs';
test('journal retries the same completion after lock timeout without repeating provider calls',async()=>{
 const writes=[];const store=new SupabaseReviewStore({rpc:async(name,args)=>{
  writes.push({name,args});return writes.length===1?{error:{code:'55P03'}}:{data:{done:true,duplicate:true}};
 }});
 await store.complete('key','owner',{result:{valid:true,decision:'BUY'}});
 assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);
});
test('snapshot retries transient lock failures and never bypasses owner CAS',async()=>{
 let attempts=0;const responses=[{error:{code:'55P03'}},{data:{job_key:'key'}}];
 const chain={update:()=>chain,eq:()=>chain,select:()=>chain,maybeSingle:async()=>{attempts++;return responses.shift();}};
 const store=new SupabaseReviewStore({from:()=>chain});
 await store.snapshot('key','owner',{});assert.equal(attempts,2);
 responses.push({data:null});await assert.rejects(store.snapshot('key','wrong-owner',{}),/REVIEW_SNAPSHOT_CAS/);
 assert.equal(attempts,3);
});
test('completion retries are bounded and ordinary CAS errors are never retried',async()=>{
 let attempts=0;const store=new SupabaseReviewStore({rpc:async()=>{attempts++;return {error:{code:'55P03'}};}});
 await assert.rejects(store.complete('key','owner',{}),/REVIEW_RESULT_CAS/);assert.equal(attempts,3);
 attempts=0;store.db.rpc=async()=>{attempts++;return {error:{message:'REVIEW_RESULT_CAS'}};};
 await assert.rejects(store.complete('key','owner',{}),/REVIEW_RESULT_CAS/);assert.equal(attempts,1);
});
