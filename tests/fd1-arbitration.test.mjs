import test from 'node:test';
import assert from 'node:assert/strict';
import {dualEntryDecision,revalidateArbitration,DUAL_VERSION} from '../supabase/functions/_shared/gpt-final-decision/dual.mjs';
import {evidenceCatalog,callAdvisory} from '../supabase/functions/_shared/gpt-final-decision/advisory.mjs';
import {buildDecisionPacket,MODEL,hash} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {computeFacts} from '../supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {T,src,entryWire} from '../development/gpt-final-decision/tests/fixtures.mjs';
export function finalFields(input){
 const all=evidenceCatalog(input),key=Object.keys(all).find(k=>k.startsWith('facts.')&&k.endsWith('return_5m'));
 const ds=input.independent_reviews?.deepseek;
 const cited=ds?.valid?[...ds.answer.bullish_evidence,...ds.answer.bearish_evidence].slice(0,6).map(k=>'initial.'+k):[];
 return {considered:cited,adopted:[],rejected:cited,supporting:key?['current.'+key]:[],opposing:[],reason:'Reviewed independent claims against current evidence'};
}
export function gptResponse(input,decision='BUY'){
 const base=input.t==='ENTRY'?entryWire({t:'ENTRY',c:input.candidate_id,d:decision,reasons:decision==='SKIP'?[{r:'GPT_JUDGMENT',e:['return_5m']}]:[],support:decision==='ABSTAIN'?[]:['return_5m','taker_buy_ratio_5m'],n:'Evidence review'}):
 {t:input.t,c:input.candidate_id,d:decision,reasons:decision==='EXIT'?[{r:'GPT_JUDGMENT',e:['return_5m']}]:[],support:['return_5m'],n:'Evidence review'};
  if(input.independent_reviews)base.arbitration=finalFields(input);
 if(base.arbitration&&['SKIP','EXIT'].includes(decision)){
   base.arbitration.adopted=base.arbitration.rejected;base.arbitration.rejected=[];
 }
 return Response.json({model:MODEL,status:'completed',usage:{input_tokens:1000,output_tokens:200},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(base)}]}]});
}
async function packet(task='ENTRY') {return buildDecisionPacket({task,subjectId:'arb-test',symbol:'QUSDT',dataMode:'LIVE',
 facts:computeFacts(src(T),{asOf:T}),position:task==='HOLD'?{event:'STRATEGIC_EXIT_CANDIDATE'}:null});}
function dsAnswer(input,preference){const k=Object.keys(evidenceCatalog(input)).find(k=>k.endsWith('return_5m'));return {
 task:input.t,candidate_id:input.candidate_id,snapshot_hash:input.snapshot.snapshot_hash,decision_preference:preference,
 confidence:.8,thesis_state:'WEAKENING',bullish_evidence:[],bearish_evidence:[k],risk_flags:['POSSIBLE_EXHAUSTION'],
 trajectory_interpretation:'Use supplied ordered observations; absent flow remains unknown',strongest_counterargument:'Trend may persist',recommended_action:preference,reason:'Independent evidence review'};}
function dsResponse(a){return Response.json({model:'deepseek-flash',usage:{prompt_tokens:1000,completion_tokens:200},choices:[{finish_reason:'stop',message:{content:JSON.stringify(a)}}]});}
for(const final of ['BUY','SKIP'])test('independent parallel FIRST; DeepSeek SKIP can yield FINAL '+final,async()=>{
 let firstInput,dsInput,finalInput,release;const barrier=new Promise(r=>release=r);let entered=0;
 const fetchFn=async(url,init)=>{
  const b=JSON.parse(init.body),ds=String(url).includes('deepseek'),input=JSON.parse(ds?b.messages[1].content:b.input[1].content);
  if(input.independent_reviews){assert.equal(entered,2);finalInput=input;return gptResponse(input,final);}
  if(ds)dsInput=input;else firstInput=input;
  if(++entered===2)release();await barrier;
  return ds?dsResponse(dsAnswer(input,'SKIP')):gptResponse(input,'BUY');
 };
 const r=await dualEntryDecision(await packet(),{apiKey:'fixture',deepseekKey:'fixture',fetchFn,now:()=>T,snapshotAtMs:T,deadlineMs:T+15000});
 assert.deepEqual(firstInput,dsInput);assert.equal(firstInput.independent_reviews,undefined);
 assert.equal(finalInput.independent_reviews.deepseek.answer.decision_preference,'SKIP');
 assert.equal(r.valid,true,r.error);assert.equal(r.decision,final);assert.equal(r.arbitration.authority,'GPT_FINAL_ONLY');
 assert.equal(r.arbitration.deepseek_agreement,'DISAGREE');assert.equal(r.arbitration.api_calls,3);
 assert.ok((final==='BUY'?r.arbitration.deepseek_rejected:r.arbitration.deepseek_adopted).length>0);
 assert.equal(revalidateArbitration(r,r.final_packet).decision,final);
});
for(const condition of ['agree','missing','timeout','mismatch','fabricated'])test('FINAL mandatory when advice '+condition,async()=>{
 let gpt=0,seen;
 const fetchFn=async(url,init)=>{
  const b=JSON.parse(init.body),ds=String(url).includes('deepseek'),input=JSON.parse(ds?b.messages[1].content:b.input[1].content);
  if(!ds){gpt++;if(input.independent_reviews)seen=input;return gptResponse(input);}
  const a=dsAnswer(input,'BUY');if(condition==='mismatch')a.snapshot_hash='f'.repeat(64);
  if(condition==='fabricated')a.bearish_evidence=['facts.invented.sell_pressure'];
  return dsResponse(a);
 };
 const r=await dualEntryDecision(await packet(),{apiKey:'fixture',deepseekKey:condition==='missing'?null:'fixture',fetchFn,now:()=>T,snapshotAtMs:T,
  ...(condition==='timeout'?{counterCall:async()=>({valid:false,available:false,attempted:true,error:'DEEPSEEK_TIMEOUT'})}:{})});
 assert.equal(gpt,2);assert.equal(r.valid,true,r.error);
 assert.equal(seen.independent_reviews.deepseek.valid,condition==='agree');
 if(condition==='mismatch')assert.equal(seen.independent_reviews.deepseek.error,'DEEPSEEK_INPUT_MISMATCH');
 if(condition==='fabricated')assert.equal(seen.independent_reviews.deepseek.error,'DEEPSEEK_UNSUPPORTED_EVIDENCE');
});
for(const failure of ['http','schema','expired'])test('FINAL '+failure+' never falls back to FIRST BUY',async()=>{
 let now=T;const fetchFn=async(url,init)=>{const input=JSON.parse(JSON.parse(init.body).input[1].content);
  if(!input.independent_reviews)return gptResponse(input);
  if(failure==='http')return new Response('{}',{status:500});
  if(failure==='expired')now=T+15001;
  if(failure==='schema')delete input.independent_reviews;
  return gptResponse(input);
 };
 const r=await dualEntryDecision(await packet(),{apiKey:'fixture',fetchFn,now:()=>now,deadlineMs:T+15000});
 assert.equal(r.arbitration.initial_gpt_decision,'BUY');assert.equal(r.valid,false);assert.equal(r.decision,'ABSTAIN');
});
test('latest snapshot reaches FINAL while FIRST hash remains frozen',async()=>{
 const p=await packet(),next=structuredClone(p);next.facts.values.return_5m+=.01;next.snapshot_hash=await hash({...next,snapshot_hash:''});
 let seen;const fetchFn=async(url,init)=>{const input=JSON.parse(JSON.parse(init.body).input[1].content);if(input.independent_reviews)seen=input;return gptResponse(input);};
 const r=await dualEntryDecision(p,{apiKey:'fixture',fetchFn,now:()=>T,refreshPacket:async()=>({packet:next,captured:T+1})});
 assert.equal(r.valid,true,r.error);assert.notEqual(r.arbitration.snapshot_hash,r.arbitration.final_snapshot_hash);
 assert.ok(seen.snapshot_delta.return_5m>.009);assert.equal(r.final_snapshot_at_ms,T+1);
});
test('legacy first-only journal is never executable',async()=>{
 assert.throws(()=>revalidateArbitration({valid:true,wire:{}},{}),/FD_FINAL_AUTHORITY/);
});
test('production citation contract can review all twelve independent claims with exact initial paths',async()=>{
 const fetchFn=async(url,init)=>{
  const b=JSON.parse(init.body),ds=String(url).includes('deepseek'),input=JSON.parse(ds?b.messages[1].content:b.input[1].content);
  if(ds){const a=dsAnswer(input,'SKIP'),keys=Object.keys(evidenceCatalog(input)).filter(k=>k.startsWith('facts.')).slice(0,12);
   a.bullish_evidence=keys.slice(0,6);a.bearish_evidence=keys.slice(6);return dsResponse(a);}
  if(!input.independent_reviews)return gptResponse(input);
  const schema=b.text.format.schema.properties.arbitration.properties;
  const keys=[...input.independent_reviews.deepseek.answer.bullish_evidence,...input.independent_reviews.deepseek.answer.bearish_evidence].map(k=>'initial.'+k);
  assert.equal(schema.considered.maxItems,12);assert.deepEqual(schema.considered.items.enum,keys);
  assert.ok(!schema.considered.items.enum.includes('current.return_5m'));
  const r=await gptResponse(input).json(),wire=JSON.parse(r.output[0].content[0].text);
  wire.arbitration={...wire.arbitration,considered:keys,adopted:keys.slice(0,6),rejected:keys.slice(6)};
  r.output[0].content[0].text=JSON.stringify(wire);return Response.json(r);
 };
 const r=await dualEntryDecision(await packet(),{apiKey:'fixture',deepseekKey:'fixture',fetchFn,now:()=>T});
 assert.equal(r.valid,true,r.error);assert.equal(r.arbitration.deepseek_evidence_considered.length,12);
});
test('invalid advisory schema preserves bounded diagnostic wire, never a valid answer',async()=>{
 const r=await callAdvisory({packet:await packet(),snapshot_hash:'a'.repeat(64),snapshot_at_ms:T,market_input:{}},{apiKey:'fixture',now:()=>T,
  fetchFn:async()=>dsResponse({task:'ENTRY'})});
 assert.equal(r.valid,false);assert.equal(r.answer,null);assert.equal(r.error,'DEEPSEEK_INVALID_RESPONSE');
 assert.match(r.validation_error,/^REQUIRED:/);assert.deepEqual(r.wire,{task:'ENTRY'});
});
for(const final of ['HOLD','PROTECT','EXIT'])test('DeepSeek EXIT cannot command a close; HOLD FINAL may choose '+final,async()=>{
 const fetchFn=async(url,init)=>{
  const b=JSON.parse(init.body),ds=String(url).includes('deepseek'),input=JSON.parse(ds?b.messages[1].content:b.input[1].content);
  if(ds)return dsResponse(dsAnswer(input,'EXIT'));
  return gptResponse(input,input.independent_reviews?final:'HOLD');
 };
 const r=await dualEntryDecision(await packet('HOLD'),{apiKey:'fixture',deepseekKey:'fixture',fetchFn,now:()=>T});
 assert.equal(r.valid,true,r.error);assert.equal(r.decision,final);assert.equal(r.arbitration.deepseek_preference,'EXIT');
 assert.equal(revalidateArbitration(r,r.final_packet).decision,final);
});
