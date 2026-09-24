import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {baselineAllowed,baselineAllowedLive,v30FrontDecision,entryBranchOf,V30_FRONT_LIVE_VERSION,V30_FRONT_VERSION,decisionIdentity} from '../../../supabase/functions/_shared/gpt-final-review/contract.mjs';
import {P142_STYLE_BY_BRANCH,p142StyleForBranch} from '../../../supabase/functions/_shared/leader-cec0040.mjs';
import {FinalReviewCoordinator,MemoryReviewStore} from '../../../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
import {coordinatorFor} from '../../../supabase/functions/v10-lane-executor/gpt-final-review-adapter.mjs';
import {V30_HOOKS} from '../executor-hooks-v30.mjs';
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
test('live baseline keeps every CEC0040 check',()=>{
  for(const mut of [c=>{c.effectiveAllowed=false;},c=>{c.ready=false;},c=>{c.action='REJECT';},c=>{c.decisionAt=T+60000;},c=>{c.version='X';}]){
    const s=b06133Rejected();mut(s.features.cec0040);assert.equal(baselineAllowedLive(s),false);
  }
  const s=b06133Rejected();s.features.cec0040=undefined;assert.equal(baselineAllowedLive(s),false);
});
test('live baseline refuses a failed V30 gate, the shadow version, and a claimed-rejected status',()=>{
  const s=b06133Rejected();s.features.b06133.factors.volumeTails=true;stampV30(s);
  assert.equal(s.features.v30Front.admitted,false);assert.equal(baselineAllowedLive(s),false);
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
test('production coordinator uses the V6S prompt and the live baseline',async()=>{
  const c=coordinatorFor({});assert.equal(c.profile,'V6S');assert.equal(c.baseline,baselineAllowedLive);
  const s=b06133Rejected(),r=new FinalReviewCoordinator({config:config(),store:new MemoryReviewStore(),apiKey:()=>'MOCK',now:()=>T+1000,
    market:async()=>marketData(s),fetchFn:transport(),profile:'V6S',baseline:baselineAllowedLive});
  await r.consider(s);await Promise.all([...r.pending.values()]);const out=await r.consider(s);
  assert.equal(out.decision,'PASS');assert.equal(r.check(s).allowed,true);
  assert.equal(decisionIdentity(s).front_policy.b06133_allowed,false);
});
test('V30 executor hooks change no sizing, slot, leverage, stop or lease control',()=>{
  const src=readFileSync(new URL('../../../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8');
  let base=src;for(const h of [...V30_HOOKS].reverse())base=base.replace(h.to,h.from);
  for(const token of ['const MAX_SLOTS=10','const SETUP_MAX_CONCURRENT=4','SLOT_SIZING_CONTRACT.targetMarginUsdt','leverage:LEV',
    'POLICY.maxEntryDriftPct','verifyExecutionLease(db)','postFillEntryGuard(','v17_create_stop','stopPct'])
    assert.equal(src.split(token).length,base.split(token).length,token);
  assert.ok(src.includes('throw new Error("B06133_SELECTION_INVALID")'));assert.ok(src.includes('throw new Error("V30_SELECTION_INVALID")'));
  assert.ok(src.includes('p_branch:branch,p_bootstrap:false'));assert.ok(src.includes('branch:meta.entryBranch??rec(meta.b06133).branch'));
});
