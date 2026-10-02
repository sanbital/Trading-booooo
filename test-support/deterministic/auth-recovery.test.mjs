import test from 'node:test';import assert from 'node:assert/strict';
import {authenticateInternalToken} from '../../supabase/functions/_shared/internal-token-auth.mjs';
import {dependencyFailure} from '../../gateway/scheduler-orchestrator.mjs';
import {evaluateModule,mockDb} from './harness.mjs';
const request=token=>new Request('https://fixture.invalid',{method:'POST',headers:token?{'x-internal':token}:{}});
test('authentication distinguishes invalid caller credentials from an unavailable credential dependency',async()=>{
 for(const response of [{error:{message:'private dependency detail'}},{data:null}]){
  const {db}=mockDb(()=>response),r=await authenticateInternalToken({db,request:request('valid'),name:'executor',header:'x-internal'});
  assert.equal(r.allowed,false);assert.equal(r.status,503);assert.equal(dependencyFailure({status:r.status}).retryable,true);
  assert.doesNotMatch(JSON.stringify(r),/private/);
 }
 const {db}=mockDb(()=>{throw new DOMException('private timeout','TimeoutError');});
 assert.equal((await authenticateInternalToken({db,request:request('valid'),name:'executor',header:'x-internal'})).status,503);
});
test('missing or wrong tokens remain unauthorized and never grant execution',async()=>{
 let reads=0;const {db}=mockDb(()=>{reads++;return {data:{token:'valid'}};});
 assert.equal((await authenticateInternalToken({db,request:request(),name:'executor',header:'x-internal'})).status,401);assert.equal(reads,0);
 assert.equal((await authenticateInternalToken({db,request:request('wrong'),name:'executor',header:'x-internal'})).status,401);
 assert.equal((await authenticateInternalToken({db,request:request('valid'),name:'executor',header:'x-internal'})).allowed,true);
});
test('both live handlers return retryable 503 before any cycle on failed token lookup',async()=>{
 for(const [path,header] of [[undefined,'x-v10-executor-token'],[new URL('../../supabase/functions/v10-lane-signal-generator/index.ts',import.meta.url),'x-v10-lane-token']]){
  const {db,writes}=mockDb(q=>{assert.equal(q.table,'edge_internal_tokens');return {error:{message:'private timeout'}};});
  const h=await evaluateModule(path,{client:db,env:{SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture'}});
  const r=await h.served[0](new Request('https://fixture.invalid',{method:'POST',headers:{[header]:'valid'},body:'{}'}));
  assert.equal(r.status,503);assert.equal((await r.json()).error,'AUTH_DEPENDENCY_UNAVAILABLE');assert.equal(writes.length,0);
 }
});
test('external scheduler account recovery reaches only the fenced recovery path',async()=>{
 const {db}=mockDb(q=>{assert.equal(q.table,'edge_internal_tokens');return {data:{token:'valid'}};}),h=await evaluateModule(undefined,{client:db});
 h.ctx.loadAccountExecutionMode=async()=>{h.value('shortWriterModes').set(db,true);h.value('accountHostScopes').set(db,{critical:async(client,operation)=>{assert.equal(client,db);return operation();}});};
 let recovered=0;h.ctx.ensureShortWriterRecovery=async()=>{recovered++;return true;};
 h.ctx.run=()=>assert.fail('recovery cannot run entries');h.ctx.runEntryQueue=()=>assert.fail('recovery cannot run entries');
 const r=await h.served[0](new Request('https://fixture.invalid',{method:'POST',headers:{'x-v10-executor-token':'valid'},body:JSON.stringify({mode:'account-recovery'})}));
 assert.equal(r.status,200);assert.equal((await r.json()).ready,true);assert.equal(recovered,1);
});
