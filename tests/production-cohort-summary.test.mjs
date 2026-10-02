import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeCohort} from '../ops/execution-infra/cohort-summary.mjs';
const row=(id,period='24h',reason='DISPATCH_MISSING',outcome_class='SYSTEM_FAILURE_OR_UNRESOLVED')=>({
  decision_id:id,period,reason,outcome_class,utc_start:period==='24h'?'2026-10-01T02:00:00Z':'2026-09-25T02:00:00Z',
  utc_cutoff:'2026-10-02T02:00:00Z',dispatch_persisted:false,executor_claimed:false,validation_pass:false,
  submit_attempted:false,exchange_acknowledged:false,partial_or_filled:false,position_attributed:false,protection_installed:false,
});
test('each window has its own denominator and one mutually exclusive final reason per decision',()=>{
  const rows=[row('A'),row('B','24h','CAPACITY_REJECTED','STRATEGIC_OR_VENUE_REFUSAL'),
    row('A','7d'),row('B','7d','CAPACITY_REJECTED','STRATEGIC_OR_VENUE_REFUSAL'),row('C','7d')];
  const result=summarizeCohort(rows);
  assert.equal(result.periods['24h'].final_buy,2);assert.equal(result.periods['7d'].final_buy,3);
  assert.equal(result.periods['24h'].system_failure_or_unresolved_rate,50);
  assert.equal(result.periods['7d'].system_failure_or_unresolved_rate,66.67);
  assert.equal(Object.values(result.periods['24h'].reasons).reduce((a,b)=>a+b),2);
});
test('duplicate decisions and mixed query cutoffs are rejected rather than yielding an inflated funnel',()=>{
  assert.throws(()=>summarizeCohort([row('A'),row('A')]),/COHORT_EVIDENCE_INVALID/);
  assert.throws(()=>summarizeCohort([row('A'),{...row('B'),utc_cutoff:'2026-10-02T02:01:00Z'}]),/COHORT_EVIDENCE_INVALID/);
});
test('downstream success does not manufacture missing upstream evidence',()=>{
  const r={...row('A','24h','PROTECTED','SUCCESS'),exchange_acknowledged:true,partial_or_filled:true,
    position_attributed:true,protection_installed:true};
  const p=summarizeCohort([r]).periods['24h'];
  assert.equal(p.stages.submit_attempted,0);assert.equal(p.stages.exchange_acknowledged,1);
  assert.equal(p.evidence_gaps.exchange_acknowledged_WITHOUT_submit_attempted,1);
});
test('no BUY sample cannot be reported as zero-percent failure or 100-percent success',()=>{
  assert.deepEqual(summarizeCohort([]),{status:'NO_COHORT_ROWS',success_rate:null,periods:{}});
});
test('unknown error context remains unclassified, separate from strategic refusal and known system failure',()=>{
  const p=summarizeCohort([row('A','24h','TERMINAL_ERROR_CONTEXT_MISSING','UNCLASSIFIED')]).periods['24h'];
  assert.equal(p.unclassified_rate,100);assert.equal(p.outcomes.SUCCESS,undefined);
});
