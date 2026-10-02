import test from 'node:test';import assert from 'node:assert/strict';
import {currentAccountOwner,currentExecutionContext,contextualOwners,withWriterContext,withAnalysisContext,assertAccountWriterContext,assertAnalysisContext} from '../supabase/functions/v10-lane-executor/account-execution-context.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('a blocked periodic analysis wait does not hold account authority or prevent a BUY critical section',async()=>{
 const db={},blocked=deferred(),started=deferred(),owners=contextualOwners();owners.set(db,'legacy-owner');let submissions=0;
 const analysis=withAnalysisContext(db,async()=>{assertAnalysisContext(db);assert.equal(owners.get(db),null);started.resolve();await blocked.promise;assert.equal(currentAccountOwner(db),null);assert.throws(()=>assertAccountWriterContext(db),/CONTEXT_REQUIRED/);});
 await started.promise;
 await withWriterContext(db,'buy-owner',async()=>{assert.equal(owners.get(db),'buy-owner');assertAccountWriterContext(db);submissions++;});
 assert.equal(submissions,1);blocked.resolve();await analysis;
});
test('parallel analysis cannot borrow another request or writer capability',async()=>{
 const db={},other={},started=deferred(),release=deferred();const writer=withWriterContext(db,'writer',async()=>{started.resolve();await release.promise;assert.equal(currentAccountOwner(db),'writer');});
 await started.promise;await withAnalysisContext(db,async()=>{assert.equal(currentAccountOwner(db),null);assert.equal(currentAccountOwner(other),null);assert.throws(()=>assertAccountWriterContext(db));});release.resolve();await writer;
});
test('a delayed child task loses authority after its writer finishes',async()=>{
 const db={},later=deferred();let child;
 await withWriterContext(db,'holder',async()=>{child=(async()=>{await later.promise;assert.equal(currentAccountOwner(db),null);assert.throws(()=>assertAccountWriterContext(db),/CONTEXT_REQUIRED/);})();});
 later.resolve();await child;assert.equal(currentExecutionContext(db),null);
});
test('AI/capture work is forbidden inside an account critical section',async()=>{
 const db={};await withWriterContext(db,'owner',async()=>{await assert.rejects(withAnalysisContext(db,async()=>{}),/ANALYSIS_INSIDE_ACCOUNT_WRITER_FORBIDDEN/);});
});
test('nested operation reuses only the exact account holder',async()=>{
 const db={};await withWriterContext(db,'owner',async()=>{
  await withWriterContext(db,'owner',async()=>assert.equal(currentAccountOwner(db),'owner'));
  await assert.rejects(withWriterContext(db,'stale-owner',async()=>{}),/NESTED_WRITER_OWNER_MISMATCH/);
 });
});
test('failed heartbeat/cancellation prevents later side effects',async()=>{
 const db={},abort=new AbortController();let submissions=0;
 await withWriterContext(db,'owner',async()=>{abort.abort(Error('HEARTBEAT_FAILED'));assert.throws(()=>assertAccountWriterContext(db),/HEARTBEAT_FAILED/);assert.equal(submissions,0);},{signal:abort.signal});
 assert.equal(currentAccountOwner(db),null);
});
test('exception invalidates capability before delayed cleanup or the next request',async()=>{
 const db={};await assert.rejects(withWriterContext(db,'old',async()=>{throw Error('transport timeout')}),/timeout/);assert.equal(currentAccountOwner(db),null);
 await withWriterContext(db,'new',async()=>assert.equal(currentAccountOwner(db),'new'));
});
