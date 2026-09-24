import test from 'node:test';
import assert from 'node:assert/strict';
import {baselineAllowed,baselineAllowedV30,v30FrontDecision,decisionIdentity,canonical,hash,VERSION,MODEL,OUTPUT_SCHEMA,LIMITS,validateAnswer} from '../../../supabase/functions/_shared/gpt-final-review/contract.mjs';
import {FinalReviewCoordinator,MemoryReviewStore} from '../../../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
import {compactInputV6,expandWireV6,toWireV6,wireSchema} from '../../../supabase/functions/_shared/gpt-final-review/wire-v4.mjs';
import {payloadFor,profileOf} from '../../../supabase/functions/_shared/gpt-final-review/openai.mjs';
import {SYSTEM_PROMPT_V6,SYSTEM_PROMPT_V6S,promptFor} from '../../../supabase/functions/_shared/gpt-final-review/prompt.mjs';
import {buildPacket} from '../../../supabase/functions/_shared/gpt-final-review/market.mjs';
import {T,candidate,marketData,answerV6,transport,config} from './helpers.mjs';
// A candidate B06133 REJECTED, whose stable factors satisfy V30.
function rejectedButV30(){
  const s=candidate('v30');const b=s.features.b06133;
  b.allowed=false;b.result=false;b.branch=null;b.reason='B06133_REJECT';
  b.factors={...b.factors,fresh5over15:true,volumeTails:false};
  // keep the stamped factors arithmetically honest: return5m large vs return15m, volumeRatio in (1,4)
  b.source.featureValues={volumeRatio:2,return5m:.01,return15m:.02,return30m:.03,return60m:.04};
  s.status='REJECTED';s.features.cec0040=undefined;return s;
}
test('production identity and binding are unchanged when no front policy is present',async()=>{
  const s=candidate();assert.ok(!('front_policy' in decisionIdentity(s)));
  const c=new FinalReviewCoordinator({config:config(),store:new MemoryReviewStore(),profile:'V6'});
  const old=await hash({version:VERSION,model:MODEL,prompt:promptFor('V6'),schema:OUTPUT_SCHEMA,wireSchema:wireSchema('V6'),limits:LIMITS,profile:profileOf('V6'),purpose:'PRODUCTION'});
  assert.equal(await c.binding,old);
});
test('V30 decision never rewrites B06133: a rejected stamp stays rejected and visible',()=>{
  const s=rejectedButV30(),v=v30FrontDecision(s.features.b06133);
  assert.equal(v.admitted,true);assert.equal(v.b06133.allowed,false);assert.equal(v.b06133.reason,'B06133_REJECT');
  assert.equal(s.features.b06133.allowed,false);
  assert.equal(baselineAllowed({...s,features:{...s.features,v30Front:v}}),false,'production baseline still refuses');
  assert.equal(baselineAllowedV30({...s,features:{...s.features,v30Front:v}}),true);
});
test('V30 baseline refuses failed/unknown factors and a tampered stamp',()=>{
  const s=rejectedButV30();
  const bad=structuredClone(s);bad.features.b06133.factors.fresh5over15=false;const v=v30FrontDecision(bad.features.b06133);
  assert.equal(v.admitted,true);assert.deepEqual(v.negativeEvidence,['fresh5over15']);
  assert.equal(baselineAllowedV30({...bad,features:{...bad.features,v30Front:v}}),true);
  const failed=structuredClone(s);failed.features.b06133.factors.volumeTails=true;
  const fv=v30FrontDecision(failed.features.b06133);
  assert.equal(fv.admitted,false);assert.deepEqual(fv.failed,['volumeTails']);
  assert.equal(baselineAllowedV30({...failed,features:{...failed.features,v30Front:fv}}),false);
  const unk=structuredClone(s);unk.features.b06133.factors.volumeTails=null;assert.deepEqual(v30FrontDecision(unk.features.b06133).unknown,['volumeTails']);
  const forged={...s,features:{...s.features,v30Front:{...v30FrontDecision(s.features.b06133),b06133:{allowed:true}}}};
  assert.equal(baselineAllowedV30(forged),false,'claiming B06133 allowed when it was not');
  const forged2={...s,features:{...s.features,v30Front:{...v30FrontDecision(s.features.b06133),factors:{...v30FrontDecision(s.features.b06133).factors,absorption:!v30FrontDecision(s.features.b06133).factors.absorption}}}};
  assert.equal(baselineAllowedV30(forged2),false);
});
test('GPT input states the V30 admission and the B06133 REJECT as reference; prompt V6S differs only in who selected',async()=>{
  const s=rejectedButV30();s.features.v30Front=v30FrontDecision(s.features.b06133);
  const p=await buildPacket(decisionIdentity(s),marketData(s),T+1000),i=compactInputV6(p);
  assert.equal(i.machine_decision.status,'ADMITTED_BY_V30_FRONT_SCORE_SHADOW_2_FRESH_EVIDENCE');assert.equal(i.machine_decision.b06133_rule.result,'REJECT');
  assert.equal(i.machine_decision.b06133_rule.role,'REFERENCE_ONLY');
  assert.notEqual(SYSTEM_PROMPT_V6S,SYSTEM_PROMPT_V6);
  const a=SYSTEM_PROMPT_V6.split('\n'),b=SYSTEM_PROMPT_V6S.split('\n');assert.equal(a.length,b.length);
  assert.equal(a.filter((x,k)=>x!==b[k]).length,1);
  assert.equal(payloadFor(p,'V6S').input[0].content,SYSTEM_PROMPT_V6S);
  // The same V6 risk validation applies unchanged.
  assert.equal(validateAnswer(expandWireV6(toWireV6(answerV6(p,'PASS')),p),p).decision,'PASS');
});
test('shadow coordinator reviews a V30 candidate end to end; production coordinator refuses it',async()=>{
  const s=rejectedButV30();s.features.v30Front=v30FrontDecision(s.features.b06133);
  const mk=o=>new FinalReviewCoordinator({config:config(),store:new MemoryReviewStore(),apiKey:()=>'MOCK',now:()=>T+1000,
    market:async()=>marketData(s),fetchFn:transport(),...o});
  const prod=mk({});assert.equal((await prod.consider(s)).reason,'BASELINE_REJECT_OR_INVALID');
  const sh=mk({purpose:'DRYRUN',profile:'V6S',baseline:baselineAllowedV30,expiry:x=>Number(x.features.v17Setup.triggerAt)+180000});
  await sh.consider(s);await Promise.all([...sh.pending.values()]);const r=await sh.consider(s);
  assert.equal(r.decision,'PASS');
});
