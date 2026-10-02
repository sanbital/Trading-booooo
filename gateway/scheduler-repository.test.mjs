import test from 'node:test';
import assert from 'node:assert/strict';
import {createScheduledJobRunner} from './scheduler-repository.mjs';
test('audited endpoint auth binds deterministic tick without exposing tokens to state',async()=>{
 let request,reads=0;const runner=createScheduledJobRunner({url:'https://db.example',repository:{token:async name=>{reads++;assert.equal(name,'market-regime-observer');return 'internal-test-token';}},fetchImpl:async(url,init)=>{request={url,...init};return {ok:true,json:async()=>({ok:true})};}});
 await runner({target:{endpoint:'market-regime-observer',body:{action:'tick'}},scheduler_key:'production',job_key:'observer',tick:1,owner:'owner',fence:2,idempotency_key:'production:observer:1'},{signal:new AbortController().signal});
 assert.equal(reads,1);assert.equal(request.headers['x-regime-token'],'internal-test-token');assert.equal(request.headers['x-scheduler-idempotency-key'],'production:observer:1');
 assert.deepEqual(JSON.parse(request.body).scheduler,{key:'production',job:'observer',tick:1,owner:'owner',fence:2,idempotency_key:'production:observer:1'});
 assert.ok(!request.body.includes('internal-test-token'));
});
test('existing autotrader credential is preserved rather than replaced by another auth namespace',async()=>{
 let headers;const runner=createScheduledJobRunner({url:'https://db.example',staticTokens:{'market-autotrader':'existing-test-token'},repository:{token:async()=>{throw Error('MUST_NOT_READ_ANOTHER_TOKEN');}},fetchImpl:async(u,i)=>{headers=i.headers;return {ok:true,json:async()=>({ok:true})};}});
 await runner({target:{endpoint:'market-autotrader',body:{action:'monitor'}}},{signal:new AbortController().signal});assert.equal(headers['x-autotrade-token'],'existing-test-token');
});
test('only bounded receipt recovery RPC and audited endpoints can be dispatched',async()=>{
 let limit;const runner=createScheduledJobRunner({url:'https://db.example',repository:{rpc:async(n,a)=>{assert.equal(n,'gpt_final_review_recover_ready');limit=a.p_limit;return {};}}});
 await runner({target:{rpc:'gpt_final_review_recover_ready',limit:500}},{signal:new AbortController().signal});assert.equal(limit,100);
 await assert.rejects(runner({target:{rpc:'submit_order'}},{}),e=>e.status===400);
 await assert.rejects(runner({target:{endpoint:'unknown'}},{}),e=>e.status===400);
});
