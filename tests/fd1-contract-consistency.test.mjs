import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {refreshExitContext,runHoldReview} from '../supabase/functions/_shared/gpt-final-decision/hold.mjs';
import {assessAdvisory,validateAdvisory,callAdvisory,advisoryTransportSchema} from '../supabase/functions/_shared/gpt-final-decision/advisory.mjs';
import {validateFinalWire,ARBITRATION_PROMPT} from '../supabase/functions/_shared/gpt-final-decision/dual.mjs';
import {DYNAMIC_PROMPT} from '../supabase/functions/_shared/gpt-final-decision/dynamic-contract.mjs';
import {DYNAMIC_POLICY} from '../supabase/functions/_shared/gpt-final-decision/dynamic-flow.mjs';
import {ENTRY_PROMPT} from '../supabase/functions/_shared/gpt-final-decision/prompt.mjs';
import {advisoryWire,finalFields} from '../test-support/arbitration-fixtures.mjs';
import {dynamicWire,dynamicMarketFixture} from '../test-support/dynamic-fixtures.mjs';
import {entryWire,src,T} from '../development/gpt-final-decision/tests/fixtures.mjs';
import {MODEL} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
const near=JSON.parse(readFileSync(new URL('../test-support/near-contract-20260927.json',import.meta.url)));
const shared={packet:near.packet,market_input:near.initial_input,snapshot_hash:near.initial_input.snapshot.snapshot_hash};
const context={entry_price:100,current_price:103,peak:105,mae:0,hard_floor:97.5,
 soft_trigger:{level:102,crossed:false},protection:{approved_soft_stop:101,candidate_soft_stop:102,
 approved_crossed:false,candidate_crossed:false,candidate_above_approved:true,lowering_possible:false}};
for(const bid of [100,101,102,103])test('refreshed protection flags follow bid '+bid+' without changing any stop',()=>{
 const input=structuredClone(context),before=structuredClone(input);
 // An earlier crossing must clear again on recovery, as well as become true on a decline.
 input.protection.approved_crossed=input.protection.candidate_crossed=bid>102;
 const original=structuredClone(input),r=refreshExitContext(input,{bids:[[bid,10]]},1234);
 assert.deepEqual(input,original);
 assert.equal(r.current_price,bid);assert.equal(r.snapshot_at_ms,1234);
 assert.equal(r.protection.approved_crossed,bid<=101);assert.equal(r.protection.candidate_crossed,bid<=102);
 assert.equal(r.soft_trigger.crossed,r.protection.candidate_crossed);
 for(const key of ['approved_soft_stop','candidate_soft_stop','candidate_above_approved','lowering_possible'])
  assert.deepEqual(r.protection[key],before.protection[key]);
 assert.equal(r.hard_floor,before.hard_floor);
});
test('missing protection levels never become crossed; legacy absence stays absent',()=>{
 for(const level of [null,undefined,0,-1]){
  const r=refreshExitContext({...context,protection:{approved_soft_stop:level,candidate_soft_stop:level}}, {bids:[[100,1]]},1);
  assert.equal(r.protection.approved_crossed,false);assert.equal(r.protection.candidate_crossed,false);
 }
 const {protection,...legacy}=context;
 assert.equal(Object.hasOwn(refreshExitContext(legacy,{bids:[[100,1]]},1),'protection'),false);
});
test('legacy decision/action disagreement is rejected consistently, never silently repaired',()=>{
 const a=assessAdvisory(near.deepseek.wire,shared).answer;
 for(const task of ['ENTRY','RECHECK','HOLD']){
  const d=task==='HOLD'?'EXIT':'BUY',other=task==='HOLD'?'HOLD':'SKIP';
  const s={...shared,packet:{...shared.packet,task}};
  const wire={...a,task,decision_preference:d,recommended_action:other};
  assert.throws(()=>assessAdvisory(wire,s),/DEEPSEEK_DECISION_MISMATCH/);
  assert.throws(()=>validateAdvisory(wire,s),/DEEPSEEK_DECISION_MISMATCH/);
 }
});
for(const task of ['ENTRY','RECHECK','HOLD'])test(task+' live advisory has one decision field and canonicalizes the legacy alias',async()=>{
 const s={...shared,packet:{...shared.packet,task},market_input:{...shared.market_input,t:task}};
 const schema=advisoryTransportSchema(s);
 assert.equal(schema.properties.recommended_action,undefined);assert.ok(!schema.required.includes('recommended_action'));
 const a=assessAdvisory(near.deepseek.wire,shared).answer,decision=task==='HOLD'?'EXIT':'SKIP';
 const wire=advisoryWire(s.market_input,{...a,task,decision_preference:decision,recommended_action:'wrong'});
 let calls=0;
 const r=await callAdvisory(s,{apiKey:'fixture',fetchFn:async(_url,init)=>{
  calls++;const request=JSON.parse(init.body);assert.equal(request.response_format.type,'json_object');
  return Response.json({model:'deepseek-flash',choices:[{finish_reason:'stop',message:{content:JSON.stringify(wire)}}]});
 }});
 assert.equal(r.valid,true,r.error);assert.equal(r.answer.decision_preference,decision);
 assert.equal(r.answer.recommended_action,decision);assert.equal(r.wire.recommended_action,undefined);
 assert.deepEqual(r.authority,[]);assert.equal(calls,1);assert.doesNotThrow(()=>validateAdvisory(r.answer,s));
});
test('the stated single-model confidence boundary matches the unchanged server gate',()=>{
 const wire=dynamicWire(entryWire({t:'ENTRY',c:near.packet.candidate_id,d:'BUY',support:['return_5m','return_60m'],n:'Continuation supported'}),near.final_input);
 wire.arbitration={considered:[],adopted:[],rejected:[],supporting:[],opposing:[],reason:'Independent evidence'};
 assert.ok(ARBITRATION_PROMPT.includes('dynamic single-model BUY follows the stated confidence/propulsion rule'));
 for(const prompt of [ENTRY_PROMPT,DYNAMIC_PROMPT]){
  assert.ok(prompt.includes('advisor_valid'));assert.ok(prompt.includes(String(DYNAMIC_POLICY.singleModelBuyConfidence)));
  assert.ok(prompt.includes('ACCELERATING'));assert.ok(prompt.includes('STABLE'));
 }
 for(const [confidence,propulsion,ok] of [[.79,'STABLE',false],[.8,'STABLE',true],[.8,'ACCELERATING',true],[.9,'DECELERATING',false]]){
  const validate=()=>validateFinalWire({...wire,confidence,propulsion_direction:propulsion},near.final_packet,{advisory:{valid:false}});
  if(ok)assert.equal(validate().decision,'BUY');else assert.throws(validate,/SINGLE_MODEL_BUY_UNSUPPORTED/);
 }
});
test('actual HOLD orchestration binds the same fresh protection flags in FIRST and FINAL snapshots',async()=>{
 const market=src(T);let books=0,calls=0;
 const fetchFn=dynamicMarketFixture(async(url,init)=>{
  const u=new URL(url);
  if(u.hostname==='api.openai.com'){
   calls++;const body=JSON.parse(init.body),input=JSON.parse(body.input[1].content);
   const wire=input.independent_reviews?dynamicWire({t:'HOLD',c:input.candidate_id,d:'HOLD',reasons:[],support:['return_5m'],n:'Thesis intact',arbitration:finalFields(input)},input):
    {c:input.candidate_id,d:'HOLD',confidence:.9,evidence:['facts.trend.return_5m'],n:'Thesis intact'};
   return Response.json({model:MODEL,status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(wire)}]}]});
  }
  if(u.pathname.endsWith('/depth')){const bid=++books===1?1.199:1.202;return Response.json({T:T-10,bids:[[bid,50000]],asks:[[bid+.0001,50000]]});}
  if(u.pathname.endsWith('/klines'))return Response.json(u.searchParams.get('symbol')==='BTCUSDT'?market.btc:u.searchParams.get('interval')==='5m'?market.five:market.one);
  if(u.pathname.endsWith('/openInterestHist'))return Response.json(market.oiHist);
  if(u.pathname.endsWith('/premiumIndexKlines'))return Response.json(market.premium);
  return Response.json({lastFundingRate:market.funding.rate});
 });
 const exitContext={...context,entry_price:1.1,peak:1.3,hard_floor:1,
  soft_trigger:{level:1.201,crossed:false},protection:{approved_soft_stop:1.2,candidate_soft_stop:1.201,approved_crossed:false,candidate_crossed:false}};
 const r=await runHoldReview({position:{id:'test-position',symbol:'ABCUSDT',entryPrice:1.1,peakPrice:1.3,stopPrice:1,entryAt:T-60000,lastHighAt:T-30000},
  event:'DYNAMIC_PERIODIC_REVIEW',apiKey:'fixture',now:()=>T+200,fetchFn,exitContext});
 assert.equal(r.result.valid,true,r.result.error);assert.equal(r.result.decision,'HOLD');assert.equal(calls,2);assert.equal(books,1);
 const audit=r.result.arbitration;
 for(const [input,crossed] of [[audit.initial_input,true],[audit.final_input,true]]){
  const p=input.position.exit_context.protection;assert.equal(p.approved_crossed,crossed);assert.equal(p.candidate_crossed,crossed);
  assert.equal(p.approved_soft_stop,1.2);assert.equal(p.candidate_soft_stop,1.201);
 }
 assert.equal(r.packet.position.exit_context.protection.candidate_crossed,true);
});
