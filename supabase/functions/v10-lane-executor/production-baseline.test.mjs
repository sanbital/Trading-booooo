import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executionDispatchAllowsNext,restrictExecutionDispatchCandidates} from './execution-dispatch.mjs';
import {classifyEntryAuthorityError} from './entry-error-scope.mjs';
import {runtimeCycleOutcome} from './cycle-runtime-outcome.mjs';
test('one dispatch cannot execute a different candidate after its own veto',()=>{
 const rows=[{id:'claimed'},{id:'other'}];
 assert.deepEqual(restrictExecutionDispatchCandidates(rows,'claimed'),[{id:'claimed'}]);
 assert.deepEqual(restrictExecutionDispatchCandidates(rows,'missing'),[]);
});
test('unresolved side effects stop bounded account drain',()=>{
 for(const state of ['UNKNOWN','PARTIALLY_FILLED','ORDER_SUBMITTING','READY_TO_EXECUTE'])
  assert.equal(executionDispatchAllowsNext({updated:true,row:{state}}),false,state);
 for(const state of ['FILLED','REJECTED','EXPIRED','PARTIALLY_FILLED_CANCELED'])
  assert.equal(executionDispatchAllowsNext({updated:true,row:{state}}),true,state);
 assert.equal(executionDispatchAllowsNext({updated:false,row:{state:'FILLED'}}),false);
});
test('authority veto after dispatch stays account scoped for reconciliation',()=>{
 for(const reason of ['DEFER_UNIVERSE_STALE_OR_GENERATION','POST_SETTLEMENT_APPROVAL_REQUIRED','CLOCK_ENTRY_WINDOW_EXPIRED_OR_CHANGED']){
  assert.equal(classifyEntryAuthorityError(Error(reason)).candidateVeto,true);
  assert.equal(classifyEntryAuthorityError(Error(reason),{orderDispatched:true}).candidateVeto,false);
 }
 assert.equal(classifyEntryAuthorityError(Error('DB_TIMEOUT')).technical,true);
});
test('current-cycle error replaces historical telemetry without promoting incomplete cycle',()=>{
 assert.deepEqual(runtimeCycleOutcome({entryEvaluationCompleted:true,health:'PROTECTED'}),{successful:true,lastError:null});
 assert.equal(runtimeCycleOutcome({health:'FLAT'}).successful,false);
 assert.equal(runtimeCycleOutcome({fatal:Error('DB_TIMEOUT')}).lastError,'DB_TIMEOUT');
 assert.match(runtimeCycleOutcome({managed:[{error:'PROTECTION_MISSING'}]}).lastError,/PROTECTION_MISSING/);
});
