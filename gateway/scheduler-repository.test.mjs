import test from 'node:test';
import assert from 'node:assert/strict';
import {createScheduledJobRunner,createSchedulerRepository} from './scheduler-repository.mjs';
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
test('registered DB maintenance sends original bounded arguments; HTTP 200 internal failure is an actual failure',async()=>{
 const calls=[],runner=createScheduledJobRunner({url:'https://db.example',repository:{rpc:async(n,a)=>{calls.push([n,a]);return{};},token:async()=> 'internal'},fetchImpl:async()=>({ok:true,json:async()=>({ok:false})})});
 await runner({target:{rpc:'leader20_clock_telemetry_maintain'}},{});assert.deepEqual(calls[0],['leader20_clock_telemetry_maintain',{}]);
 await runner({target:{rpc:'gpt_final_review_expire',limit:30}},{});assert.deepEqual(calls[1],['gpt_final_review_expire',{p_limit:30}]);
 await assert.rejects(runner({target:{endpoint:'v10-lane-executor',body:{}}},{}),e=>e.status===503&&e.message==='ENDPOINT_REPORTED_FAILURE');
});


test('real HTTP 204 from a void PostgreSQL maintenance RPC records a completed job',async()=>{
 let request;
 const repository=createSchedulerRepository({url:'https://db.example',key:'test-key',fetchImpl:async(url,options)=>{
  request={url,...options};return new Response(null,{status:204});
 }});
 const runner=createScheduledJobRunner({url:'https://db.example',repository});
 assert.equal(await runner({target:{rpc:'leader20_clock_telemetry_maintain'}},{signal:new AbortController().signal}),null);
 assert.equal(request.url,'https://db.example/rest/v1/rpc/leader20_clock_telemetry_maintain');
 assert.deepEqual(JSON.parse(request.body),{});
});


test('successful empty HTTP 200 RPC body is accepted; a malformed JSON body still fails',async()=>{
 const repository=createSchedulerRepository({url:'https://db.example',key:'test-key',fetchImpl:async()=>new Response('',{status:200})});
 assert.equal(await repository.rpc('leader20_clock_telemetry_maintain',{}),null);
 const broken=createSchedulerRepository({url:'https://db.example',key:'test-key',fetchImpl:async()=>new Response('broken',{status:200})});
 await assert.rejects(broken.rpc('leader20_clock_telemetry_maintain',{}),SyntaxError);
});
