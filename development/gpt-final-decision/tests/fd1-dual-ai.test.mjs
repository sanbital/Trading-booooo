// Dual-AI ENTRY (2026-09-26): GPT and DeepSeek judge the same packet independently; GPT
// arbitrates a split; an unresolved BUY split places no order.
import test from 'node:test';
import assert from 'node:assert/strict';
import {computeFacts,modelJudgments} from '../../../supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {buildDecisionPacket} from '../../../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {validateDecision} from '../../../supabase/functions/_shared/gpt-final-decision/contract.mjs';
import {dualEntryDecision,disagreement,arbitrationPayload,reviewsFor,ARBITRATION_PROMPT} from '../../../supabase/functions/_shared/gpt-final-decision/dual.mjs';
import {FD1_ENTRY_ENGINE} from '../../../supabase/functions/_shared/gpt-final-decision/engine.mjs';
import {T,src,entryWire} from './fixtures.mjs';
const packet=()=>buildDecisionPacket({task:'ENTRY',subjectId:'dual-1',symbol:'ABCUSDT',dataMode:'LIVE',
  facts:computeFacts(src(T),{asOf:T+2000,referenceClose:1.1,dayReturn:.2,rank:3}),judgments:modelJudgments({})});
const buyWire=p=>entryWire({t:'ENTRY',c:p.candidate_id,d:'BUY',reasons:[],support:['return_5m','taker_buy_ratio_5m'],n:'상승 지속'});
const skipWire=p=>entryWire({t:'ENTRY',c:p.candidate_id,d:'SKIP',reasons:[{r:'GPT_JUDGMENT',e:['return_60m']}],support:[],n:'소진'});
const gptOf=(p,wire)=>({valid:true,decision:wire.d,wire,answer:validateDecision(wire,p),request_id:'req-'+wire.d,api_cost_usd:.002});
const ds=decision=>({valid:true,answer:{decision,summary:'x',evidence:['return_5m'],failure_risk:'LOW',continuation_strength:'NORMAL',chase_risk:'LOW',expected_value:'NEUTRAL'},model:'deepseek-flash'});
const run=async(p,{gpt,counter,arbiter})=>{const calls=[];
  const r=await dualEntryDecision(p,{apiKey:'k',deepseekKey:'d',now:()=>T,deadlineMs:T+8000,
    gptCall:async(pk,o)=>{calls.push(o.payloadFn?'ARB':'GPT');return o.payloadFn?arbiter(pk,o):gpt;},counterCall:async()=>counter});
  return {r,calls};};

test('agreement or DeepSeek UNCERTAIN: GPT answer stands, no arbitration call',async()=>{
  const p=await packet(),g=gptOf(p,buyWire(p));
  for(const c of [ds('SUPPORT_BUY'),ds('UNCERTAIN')]){
    const {r,calls}=await run(p,{gpt:g,counter:c});
    assert.equal(r.decision,'BUY');assert.deepEqual(calls,['GPT']);assert.equal(r.dual.final,'GPT');assert.equal(r.dual.disagreement,null);
  }
});
test('DeepSeek failure never blocks GPT (availability): GPT alone',async()=>{
  const p=await packet(),g=gptOf(p,buyWire(p));
  const {r}=await run(p,{gpt:g,counter:{valid:false,error:'COUNTER_TIMEOUT'}});
  assert.equal(r.decision,'BUY');assert.equal(r.dual.path,'GPT_ONLY_DEEPSEEK_UNAVAILABLE');
});
test('split: GPT arbitrates on both independent reviews; the arbiter answer is final and server-valid',async()=>{
  const p=await packet(),g=gptOf(p,buyWire(p));let seen=null;
  const {r,calls}=await run(p,{gpt:g,counter:ds('OPPOSE_BUY'),arbiter:async(pk,o)=>{seen=o.payloadFn(pk);return gptOf(p,skipWire(p));}});
  assert.deepEqual(calls,['GPT','ARB']);assert.equal(r.decision,'SKIP');assert.equal(r.dual.final,'ARBITRATION');
  assert.equal(r.dual.disagreement,'GPT_BUY_DEEPSEEK_OPPOSE');assert.equal(r.request_id,'req-SKIP');
  const user=JSON.parse(seen.input[1].content);assert.equal(user.independent_reviews.gpt.decision,'BUY');
  assert.equal(user.independent_reviews.deepseek.decision,'OPPOSE_BUY');assert.match(seen.input[0].content,/중재 과제/);
  assert.deepEqual(seen.text.format.schema,arbitrationPayload(p,reviewsFor(g,ds('OPPOSE_BUY'))).text.format.schema);
  // the reverse split can create a BUY the first GPT answer did not give
  const s=gptOf(p,skipWire(p));
  const rev=await run(p,{gpt:s,counter:ds('SUPPORT_BUY'),arbiter:async()=>gptOf(p,buyWire(p))});
  assert.equal(rev.r.decision,'BUY');assert.equal(rev.r.dual.disagreement,'GPT_SKIP_DEEPSEEK_SUPPORT');
});
test('unresolved BUY split (arbiter invalid) places no order; an unresolved SKIP stands',async()=>{
  const p=await packet();
  const {r}=await run(p,{gpt:gptOf(p,buyWire(p)),counter:ds('OPPOSE_BUY'),arbiter:async()=>({valid:false,decision:'ABSTAIN',error:'API_TIMEOUT'})});
  assert.equal(r.valid,false);assert.equal(r.decision,'ABSTAIN');assert.equal(r.dual.final,'UNRESOLVED_NO_ENTRY');
  const s=await run(p,{gpt:gptOf(p,skipWire(p)),counter:ds('SUPPORT_BUY'),arbiter:async()=>({valid:false,decision:'ABSTAIN',error:'API_TIMEOUT'})});
  assert.equal(s.r.decision,'SKIP');assert.equal(s.r.dual.final,'GPT');
  assert.equal(disagreement({valid:false},ds('OPPOSE_BUY')),null);
});
test('engine binding covers the arbitration prompt; the engine uses GPT alone without a DeepSeek key',()=>{
  assert.ok(FD1_ENTRY_ENGINE.promptText.includes(ARBITRATION_PROMPT));assert.equal(FD1_ENTRY_ENGINE.deepseekKey,null);
});
test('live regression 2026-09-26 v92: a BUY/HOLD that also names concerns stays a BUY/HOLD (concerns recorded)',async()=>{
  const p=await packet();
  const w=entryWire({t:'ENTRY',c:p.candidate_id,d:'BUY',reasons:[{r:'GPT_JUDGMENT',e:['return_60m']}],support:['return_5m'],n:'상승 지속, 소진 위험 감수'});
  const a=validateDecision(w,p);
  assert.equal(a.decision,'BUY');assert.deepEqual(a.reasons,[]);assert.equal(a.noted_risks[0].category,'GPT_JUDGMENT');
});
