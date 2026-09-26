import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {baselineAllowed,baselineAllowedLive,v30FrontDecision,entryBranchOf,V30_FRONT_LIVE_VERSION,V30_FRONT_VERSION,decisionIdentity} from '../../../supabase/functions/_shared/gpt-final-review/contract.mjs';
import {P142_STYLE_BY_BRANCH,p142StyleForBranch} from '../../../supabase/functions/_shared/leader-cec0040.mjs';
import {FinalReviewCoordinator,MemoryReviewStore} from '../../../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
import {coordinatorFor} from '../../../supabase/functions/v10-lane-executor/gpt-final-review-adapter.mjs';
import {V30_HOOKS} from '../executor-hooks-v30.mjs';
import {FD1_HOOKS} from '../executor-hooks-fd1.mjs';
import {RECHECK_HOOKS} from '../executor-hooks-recheck.mjs';
import {T,candidate,marketData,transport,config} from './helpers.mjs';

const stampV30=s=>{s.features.v30Front=v30FrontDecision(s.features.b06133,V30_FRONT_LIVE_VERSION);return s;};
function b06133Rejected(){ // B06133 REJECT, V30 factors satisfied, CEC PROBE
  const s=candidate('v30-live');const b=s.features.b06133;
  b.allowed=false;b.result=false;b.branch=null;b.reason='B06133_REJECT';
  b.factors={...b.factors,fresh5over15:true,volumeTails:false};
  b.source.featureValues={volumeRatio:2,return5m:.01,return15m:.02,return30m:.03,return60m:.04};
  s.features.cec0040={...s.features.cec0040,action:'PROBE'};return stampV30(s);
}

test('live baseline admits a V30 candidate B06133 rejected, and never rewrites B06133',()=>{
  const s=b06133Rejected();
  assert.equal(baselineAllowedLive(s),true);assert.equal(baselineAllowed(s),false);
  assert.equal(s.features.b06133.allowed,false);assert.equal(s.features.b06133.reason,'B06133_REJECT');
  assert.equal(entryBranchOf(s.features),'V30_SCORE');
});
test('live baseline: CEC0040 action is evidence, not a veto; the stamp must be fresh and valid',()=>{
  for(const mut of [c=>{c.ready=false;},c=>{c.decisionAt=T+60000;},c=>{c.version='X';},c=>{c.action='BOGUS';},c=>{c.targetVersion='X';}]){
    const s=b06133Rejected();mut(s.features.cec0040);assert.equal(baselineAllowedLive(s),false);
  }
  for(const mut of [c=>{c.action='ADMIT';},c=>{c.action='PROBE';},c=>{c.effectiveAllowed=false;c.modelAllowed=false;c.action='REJECT';}]){
    const s=b06133Rejected();mut(s.features.cec0040);const before=JSON.stringify(s.features.cec0040);
    assert.equal(baselineAllowedLive(s),true);assert.equal(JSON.stringify(s.features.cec0040),before,'CEC stamp never rewritten');
  }
  const s=b06133Rejected();s.features.cec0040=undefined;assert.equal(baselineAllowedLive(s),false);
});
test('V30 verdicts are evidence: fresh5over15 and volumeTails failures both reach the AI (2026-09-26)',()=>{
  const s=b06133Rejected();s.features.b06133.factors.fresh5over15=false;stampV30(s);
  assert.equal(s.features.v30Front.admitted,true);
  assert.deepEqual(s.features.v30Front.negativeEvidence,['fresh5over15']);
  assert.equal(baselineAllowedLive(s),true);
  const tails=b06133Rejected();tails.features.b06133.factors.fresh5over15=false;
  tails.features.b06133.factors.volumeTails=true;stampV30(tails);
  assert.equal(tails.features.v30Front.admitted,false);
  assert.ok(tails.features.v30Front.failed.includes('volumeTails'));
  assert.equal(baselineAllowedLive(tails),true,'a V30 non-admission is shown to GPT, not a pre-AI reject');
  assert.equal(entryBranchOf(tails.features),'V30_SCORE');
});
test('live baseline refuses a tampered V30 stamp, the shadow version, and a claimed-rejected status',()=>{
  const s=b06133Rejected();s.features.b06133.factors.volumeTails=true;stampV30(s);
  assert.equal(s.features.v30Front.admitted,false);assert.equal(baselineAllowedLive(s),true);
  s.features.v30Front={...s.features.v30Front,admitted:true};assert.equal(baselineAllowedLive(s),false,'a stamp that disagrees with its own factors is refused');
  const t=b06133Rejected();t.features.v30Front=v30FrontDecision(t.features.b06133,V30_FRONT_VERSION);assert.equal(baselineAllowedLive(t),false);
  const u=b06133Rejected();u.status='REJECTED';assert.equal(baselineAllowedLive(u),false);
});
test('entry branch: B06133 branch when B06133 also admitted, V30_SCORE otherwise; exit style mapped',()=>{
  const s=stampV30(candidate('both'));s.features.b06133.factors={...s.features.b06133.factors,fresh5over15:true,volumeTails:false};stampV30(s);
  assert.equal(entryBranchOf(s.features),'R62');
  assert.equal(entryBranchOf({b06133:s.features.b06133}),null,'no V30 stamp -> no branch');
  assert.equal(p142StyleForBranch('V30_SCORE'),'retestAnchor');
  assert.deepEqual(Object.keys(P142_STYLE_BY_BRANCH),['R62','BUYER_SHARE_RESCUE','BOTH','V30_SCORE']);
});
test('production coordinator: FD1 engine (GPT final entry decision) on the live V30 baseline',()=>{
  const c=coordinatorFor({});assert.equal(c.engine?.id,'GPT_FINAL_DECISION_FD1:ENTRY');assert.equal(c.baseline,baselineAllowedLive);
  assert.equal(c.allowDecision(),'BUY');
});
test('V30 executor hooks change no sizing, slot, leverage, stop or lease control',()=>{
  const src=readFileSync(new URL('../../../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8');
  let base=src;for(const h of [...RECHECK_HOOKS].reverse())base=base.replace(h.to,h.from);for(const h of [...FD1_HOOKS].reverse())base=base.replace(h.to,h.from);for(const h of [...V30_HOOKS].reverse())base=base.replace(h.to,h.from);
  for(const token of ['const MAX_SLOTS=10','const SETUP_MAX_CONCURRENT=4','SLOT_SIZING_CONTRACT.targetMarginUsdt','leverage:LEV',
    'POLICY.maxEntryDriftPct','verifyExecutionLease(db)','postFillEntryGuard(','v17_create_stop','stopPct'])
    assert.equal(src.split(token).length,base.split(token).length,token);
  assert.ok(src.includes('throw new Error("B06133_SELECTION_INVALID")'));assert.ok(src.includes('throw new Error("V30_SELECTION_INVALID")'));
  assert.ok(src.includes('p_branch:branch,p_bootstrap:false'));assert.ok(src.includes('branch:meta.entryBranch??rec(meta.b06133).branch'));
});
test('V30 stamp integrity survives a Postgres jsonb round trip (key order), and still rejects a changed factor',()=>{
  const s=b06133Rejected(),f=s.features.v30Front.factors;
  s.features.v30Front.factors=Object.fromEntries(Object.entries(f).reverse());
  assert.equal(baselineAllowedLive(s),true);
  const t=b06133Rejected();t.features.v30Front.factors={...t.features.v30Front.factors,recentHourLead:!t.features.v30Front.factors.recentHourLead};
  assert.equal(baselineAllowedLive(t),false);
  const u=b06133Rejected();delete u.features.v30Front.factors.absorption;assert.equal(baselineAllowedLive(u),false);
});
