import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assessAdvisory,callAdvisory,advisoryEvidenceIds,advisoryTransportSchema,evidenceCatalog} from '../supabase/functions/_shared/gpt-final-decision/advisory.mjs';
import {validateFinalWire,dualEntryDecision,arbitrationPayload,reviewsFor,revalidateArbitration,DUAL_VERSION} from '../supabase/functions/_shared/gpt-final-decision/dual.mjs';
import {payloadFor,MODEL} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {wireSchema} from '../supabase/functions/_shared/gpt-final-decision/contract.mjs';
import {FinalReviewCoordinator} from '../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
import {advisoryWire} from '../test-support/arbitration-fixtures.mjs';
import {dynamicWire} from '../test-support/dynamic-fixtures.mjs';
import {entryWire} from '../development/gpt-final-decision/tests/fixtures.mjs';
const f=JSON.parse(readFileSync(new URL('../test-support/near-contract-20260927.json',import.meta.url)));
const shared={packet:f.packet,market_input:f.initial_input,snapshot_hash:f.initial_input.snapshot.snapshot_hash,snapshot_at_ms:f.deepseek.snapshot_at_ms};
const catalog={...evidenceCatalog(f.initial_input,'initial'),...evidenceCatalog(f.final_input,'current')};
const clone=structuredClone;
const response=wire=>Response.json({model:'deepseek-flash',choices:[{finish_reason:'stop',message:{content:JSON.stringify(wire)}}]});
function admission(answer){
 const signal={id:'near'},now=f.final_snapshot_at_ms;
 const gate=Object.create(FinalReviewCoordinator.prototype);
 Object.assign(gate,{config:{mode:'ENFORCE'},authorized:()=>true,baseline:()=>true,identity:()=>({}),now:()=>now,
  engine:{allow:'BUY'},tickets:new Map([['near',{identityJson:'{}',decision:answer.decision,validUntil:now+5000,expires:now+60000}]])});
 const result=gate.check(signal);assert.equal(gate.beginExecution(signal),null);return result;
}
test('actual NEAR: identity and snapshot match; reject only the mislocated relative strength path',()=>{
 assert.equal(f.first.decision,'WAIT');assert.equal(f.first.latency_ms,1434);
 assert.equal(f.old_result.error,'FD_DYNAMIC_DUAL_STATUS_MISMATCH');assert.equal(f.old_result.latency_ms,10777);
 assert.equal(f.deepseek.wire.candidate_id,f.packet.candidate_id);
 assert.equal(f.deepseek.wire.snapshot_hash,shared.snapshot_hash);
 assert.equal(f.deepseek.wire.decision_preference,'SKIP');
 const r=assessAdvisory(f.deepseek.wire,shared);
 assert.equal(r.status,'DEGRADED_VALID');assert.equal(r.valid,true);assert.equal(r.answer.decision_preference,'SKIP');
 assert.deepEqual(r.invalid_evidence,[{field:'bullish_evidence',citation:'facts.trend.relative_strength_60m',reason:'DEEPSEEK_UNSUPPORTED_EVIDENCE'}]);
 assert.equal(r.valid_evidence.length,5);assert.equal(r.answer.bullish_evidence.length,2);assert.equal(r.answer.bearish_evidence.length,3);
 assert.equal(Object.hasOwn(evidenceCatalog(f.initial_input),'facts.market.relative_strength_60m'),true);
 assert.ok(!r.valid_evidence.some(p=>p.includes('relative_strength_60m')),'do not silently alias/repair a rejected citation');
});
test('actual FINAL SKIP survives legacy false status with INVALID advice, with no entry ticket/order',()=>{
 assert.equal(f.deepseek.valid,false);assert.equal(f.final_wire.dual_confidence_degraded,false);
 const a=validateFinalWire(f.final_wire,f.final_packet,{catalog,advisory:f.deepseek});
 assert.equal(a.decision,'SKIP');assert.equal(a.dual_confidence_degraded,true);assert.equal(admission(a).allowed,false);
 const result={wire:f.final_wire,arbitration:{version:DUAL_VERSION,authority:'GPT_FINAL_ONLY',initial_input:f.initial_input,final_input:f.final_input,deepseek:f.deepseek}};
 assert.equal(revalidateArbitration(result,f.final_packet).decision,'SKIP');
 assert.equal(f.deepseek.valid,false,'historical invalid status is never laundered');
});
test('live FINAL schema contains no server-owned status; input explicitly labels INVALID',()=>{
 const current={...shared,packet:f.final_packet,base_payload:payloadFor(f.final_packet),market_input:f.final_input};
 const p=arbitrationPayload(current,shared,reviewsFor(f.first,f.deepseek)),input=JSON.parse(p.input[1].content);
 assert.equal(input.advisor_status,'INVALID');assert.equal(input.advisor_valid,false);assert.equal(input.advisor_available,true);
 assert.equal(input.advisor_error,'DEEPSEEK_UNSUPPORTED_EVIDENCE');assert.equal(input.independent_reviews.deepseek.answer,null);
 for(const k of ['dual_confidence_degraded','advisor_status','advisor_valid','deepseek_status']){
  assert.equal(p.text.format.schema.properties[k],undefined);assert.ok(!p.text.format.schema.required.includes(k));
 }
 assert.equal(wireSchema('ENTRY',f.packet).properties.dual_confidence_degraded,undefined);
});
test('snapshot/candidate/task/decision/schema violations remain whole-opinion invalid',async()=>{
 for(const mutate of [w=>w.snapshot_hash='f'.repeat(64),w=>w.candidate_id='other',w=>w.task='HOLD',
  w=>w.decision_preference='SELL',w=>w.unexpected=true,w=>w.confidence=2,w=>w.bullish_evidence_ids=[42]]){
  const wire=advisoryWire(f.initial_input,f.deepseek.wire);mutate(wire);
  const r=await callAdvisory(shared,{apiKey:'fixture',fetchFn:async()=>response(wire)});
  assert.equal(r.valid,false);assert.equal(r.status,'INVALID');assert.equal(r.answer,null);assert.deepEqual(r.valid_evidence,[]);
 }
});
test('ID transport restores only exact paths; mixed invalid IDs degrade, all invalid or empty forbid opinion',async()=>{
 const ids=advisoryEvidenceIds(shared),id=Object.keys(ids).find(k=>ids[k]==='facts.market.relative_strength_60m');
 assert.ok(id);assert.deepEqual(ids,advisoryEvidenceIds(clone(shared)));
 const wire=advisoryWire(f.initial_input,f.deepseek.wire);
 wire.bullish_evidence_ids=[id,'E999'];wire.bearish_evidence_ids=[];
 const r=await callAdvisory(shared,{apiKey:'fixture',fetchFn:async()=>response(wire)});
 assert.equal(r.status,'DEGRADED_VALID');assert.deepEqual(r.answer.bullish_evidence,['facts.market.relative_strength_60m']);
 assert.equal(r.invalid_evidence[0].citation,'E999');assert.deepEqual(r.authority,[]);
 for(const bad of [['E999'],['facts.market.relative_strength_60m'],[]]){
  const x=await callAdvisory(shared,{apiKey:'fixture',fetchFn:async()=>response({...wire,bullish_evidence_ids:bad})});
  assert.equal(x.status,'INVALID');assert.equal(x.answer,null);assert.equal(x.valid,false);
 }
 const good=await callAdvisory(shared,{apiKey:'fixture',fetchFn:async()=>response({...wire,bullish_evidence_ids:[id]})});
 assert.equal(good.status,'VALID');assert.equal(good.error,null);
 const schema=advisoryTransportSchema(shared);assert.equal(schema.properties.bullish_evidence,undefined);
 assert.match(id,new RegExp(schema.properties.bullish_evidence_ids.items.pattern));
});
test('missing key, timeout, HTTP/network unavailable; malformed received JSON invalid; no retry',async()=>{
 for(const [mode,status] of [['key','UNAVAILABLE'],['timeout','UNAVAILABLE'],['http','UNAVAILABLE'],['network','UNAVAILABLE'],['json','INVALID']]){
  let calls=0;const r=await callAdvisory(shared,{apiKey:mode==='key'?null:'fixture',timeoutMs:5,fetchFn:async()=>{
   calls++;if(mode==='timeout')return new Promise(()=>{});if(mode==='network')throw Error('offline');
   return mode==='http'?new Response('{}',{status:503}):new Response('{bad');
  }});assert.equal(r.status,status,mode);assert.equal(r.answer,null);assert.equal(calls,mode==='key'?0:1);
 }
});
test('unavailable advisor keeps the existing single-model confidence and propulsion requirements',()=>{
 const wire=dynamicWire(entryWire({t:'ENTRY',c:f.packet.candidate_id,d:'BUY',support:['return_5m','return_60m'],n:'Evidence supports continuation'}),f.final_input);
 wire.arbitration={considered:[],adopted:[],rejected:[],supporting:[],opposing:[],reason:'Independent current evidence'};
 assert.equal(validateFinalWire(wire,f.final_packet,{catalog,advisory:{valid:false}}).decision,'BUY');
 for(const change of [{confidence:.5},{propulsion_direction:'DECELERATING'}])
  assert.throws(()=>validateFinalWire({...wire,...change},f.final_packet,{catalog,advisory:{valid:false}}),/SINGLE_MODEL_BUY_UNSUPPORTED/);
});
test('a rejected citation can never be adopted by FINAL even when advice remains usable',()=>{
 const advisory=assessAdvisory(f.deepseek.wire,shared),wire=clone(f.final_wire);
 wire.arbitration.adopted=['initial.facts.trend.relative_strength_60m'];
 assert.throws(()=>validateFinalWire(wire,f.final_packet,{catalog,advisory}),/ARBITRATION_EVIDENCE/);
});
for(const scenario of ['partial-skip','partial-buy','all-invalid','snapshot','candidate','unavailable'])
test('NEAR orchestration '+scenario+': FINAL SKIP retains authority and no retry/order',async()=>{
 let gptCalls=0,dsCalls=0,requests=[],seen;
 const at=f.final_snapshot_at_ms;
 const r=await dualEntryDecision(f.final_packet,{apiKey:'fixture',deepseekKey:scenario==='unavailable'?null:'fixture',now:()=>at,snapshotAtMs:at,
  fetchFn:async(url,init)=>{
   requests.push(String(url));const body=JSON.parse(init.body),ds=String(url).includes('deepseek');
   const input=JSON.parse(ds?body.messages[1].content:body.input[1].content);
   if(ds){dsCalls++;const a={...clone(f.deepseek.wire),snapshot_hash:input.snapshot.snapshot_hash};
    if(scenario==='partial-buy')a.decision_preference=a.recommended_action='BUY';
    const wire=advisoryWire(input,a);
    if(scenario==='snapshot')wire.snapshot_hash='0'.repeat(64);
    if(scenario==='candidate')wire.candidate_id='other';
    if(scenario==='all-invalid'){wire.bullish_evidence_ids=['E999'];wire.bearish_evidence_ids=['E998'];}
    return response(wire);
   }
   gptCalls++;let wire;
   if(!input.independent_reviews)wire=clone(f.first.wire);
   else{
    seen=input;assert.equal(body.text.format.schema.properties.dual_confidence_degraded,undefined);
    wire=clone(f.final_wire);delete wire.dual_confidence_degraded;
    const advice=input.independent_reviews.deepseek;
    if(advice.valid){const key='initial.'+advice.valid_evidence[0];wire.arbitration={considered:[key],adopted:[],rejected:[key],supporting:[],opposing:[],reason:'Independent FINAL rejects advisory claims and skips'};}
   }
   return Response.json({model:MODEL,status:'completed',usage:{input_tokens:100,output_tokens:100},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(wire)}]}]});
  }});
 assert.equal(r.valid,true,r.error);assert.equal(r.decision,'SKIP');assert.equal(admission(r.answer).allowed,false);
 assert.equal(gptCalls,2);assert.equal(dsCalls,scenario==='unavailable'?0:1);assert.equal(requests.length,scenario==='unavailable'?2:3);
 assert.equal(r.arbitration.api_calls,requests.length);assert.equal(r.arbitration.final_decision,'SKIP');
 const usable=scenario.startsWith('partial');
 assert.equal(r.arbitration.deepseek_status,usable?'DEGRADED_VALID':scenario==='unavailable'?'UNAVAILABLE':'INVALID');
 assert.equal(r.answer.dual_confidence_degraded,!usable);assert.equal(r.arbitration.deepseek_valid,usable);
 assert.equal(r.arbitration.final_advisor_usage,usable?'REJECTED':'IGNORED');
 assert.equal(seen.advisor_valid,usable);assert.equal(revalidateArbitration(r,r.final_packet).decision,'SKIP');
 if(scenario==='partial-buy')assert.equal(r.arbitration.deepseek_decision_preference,'BUY');
 if(!usable){assert.equal(seen.independent_reviews.deepseek.answer,null);assert.deepEqual(r.arbitration.deepseek_valid_evidence,[]);}
});
