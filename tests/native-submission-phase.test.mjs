import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createBudget} from '../supabase/functions/_shared/leader-ops-isolation.mjs';
const source=readFileSync(new URL('../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8');
function harness({budget=createBudget(),verify=async()=>{},transport=async()=>({algoId:'123'})}={}){
 const db={},calls=[],context={cycleBudgets:new WeakMap(),verifyExecutionLease:verify,
  exchangeGateway:async(...args)=>{calls.push(args);return transport(...args)},Error,Math,Object};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function scopedGateway('),source.indexOf('function capacityRefreshGateway('))+';this.gateway=scopedGateway;',context);
 return {run:context.gateway(db,budget),calls};
}
for(const action of ['create_order','v17_create_stop','v17_cancel_stop']){
 test(`${action}: exhausted budget before transport is explicit NOT_SENT`,async()=>{
  const h=harness({budget:createBudget({calls:0})});
  await assert.rejects(h.run({action}),e=>e.message==='V18_API_BUDGET_EXHAUSTED'&&e.exchangeSubmissionAttempted===false&&e.submissionPhase==='PRE_SEND');
  assert.equal(h.calls.length,0);
 });
 test(`${action}: budget or fence failure after transport stays ambiguous`,async()=>{
  let verifies=0;const h=harness({verify:async()=>{if(++verifies===2)throw Error('V18_API_BUDGET_EXHAUSTED')}});
  await assert.rejects(h.run({action}),e=>e.message==='V18_API_BUDGET_EXHAUSTED'&&e.exchangeSubmissionAttempted===undefined);
  assert.equal(h.calls.length,1);
 });
}
test('lease failure before transport is explicit NOT_SENT, transport abort is ambiguous',async()=>{
 const before=harness({verify:async()=>{throw Error('V17_EXECUTION_LEASE_EXPIRED')}});
 await assert.rejects(before.run({action:'v17_create_stop'}),e=>e.exchangeSubmissionAttempted===false);
 assert.equal(before.calls.length,0);
 const after=harness({transport:async()=>{throw Error('The signal has been aborted')}});
 await assert.rejects(after.run({action:'v17_create_stop'}),e=>e.exchangeSubmissionAttempted===undefined);
 assert.equal(after.calls.length,1);
});
