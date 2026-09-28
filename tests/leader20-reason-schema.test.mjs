import test from 'node:test';
import assert from 'node:assert/strict';
import {batchFinalPayload} from '../supabase/functions/_shared/leader20/final.mjs';
import {payloadFor,buildDecisionPacket} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {computeFacts} from '../supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {CATEGORIES,validateShape} from '../supabase/functions/_shared/gpt-final-decision/contract.mjs';
import {src} from '../development/gpt-final-decision/tests/fixtures.mjs';
import {validCapture} from '../test-support/dynamic-fixtures.mjs';
const T=1800000000200;
async function packet(){
 const facts=computeFacts(src(T),{asOf:T});facts.capture_context=validCapture(T);
 Object.assign(facts.values,{est_buy_slippage_bps:12,spread_bps:12,taker_buy_ratio_5m:.3});
 const p=await buildDecisionPacket({task:'ENTRY',subjectId:'category-evidence',symbol:'INXUSDT',dataMode:'LIVE',facts});
 return Object.assign(p,{dynamic_policy:'DYNAMIC_FLOW_LIFECYCLE_1',dynamic_as_of_ms:T,
  leader20:{version:'LEADER20_DYNAMIC_1',batch_advice:{id:'INXUSDT',decision:'SKIP',last_ms:T-6000}}});
}
function expand(x,root){
 if(x?.$ref)return expand(root.$defs[x.$ref.slice('#/$defs/'.length)],root);
 if(Array.isArray(x))return x.map(v=>expand(v,root));
 return x&&typeof x==='object'?Object.fromEntries(Object.entries(x).map(([k,v])=>[k,expand(v,root)])):x;
}
test('category/evidence mismatch cannot be generated; independent judgment keeps all observed facts',async()=>{
 const p=await packet(),s=batchFinalPayload(p).text.format.schema;
 const branches=expand(s.properties.reasons.items,s).anyOf;
 const branch=id=>branches.find(x=>x.properties.r.enum.includes(id));
 assert.throws(()=>validateShape({r:'FILL_WORSE',e:['est_buy_slippage_bps','spread_bps']},branch('FILL_WORSE')),/ENUM/);
 assert.throws(()=>validateShape({r:'SELL_DOMINANCE',e:['spread_bps']},branch('SELL_DOMINANCE')),/ENUM/);
 validateShape({r:'FILL_WORSE',e:['est_buy_slippage_bps']},branch('FILL_WORSE'));
 validateShape({r:'SPREAD_ABNORMAL',e:['spread_bps']},branch('SPREAD_ABNORMAL'));
 for(const id of ['GPT_JUDGMENT','EV_UNFAVORABLE']){
  validateShape({r:id,e:['est_buy_slippage_bps','spread_bps','return_5m']},branch(id));
  assert.equal(branch(id).properties.e.minItems,1);
 }
 for(const b of branches){
  const id=b.properties.r.enum[0];
  if(CATEGORIES[id]&&id!=='DATA_INCOMPLETE')assert.ok(b.properties.e.items.enum.every(k=>CATEGORIES[id].facts.includes(k)));
 }
});
test('batch schema restriction preserves decisions, source packet, every trajectory row and output budget',async()=>{
 const p=await packet(),saved=structuredClone(p),old=payloadFor(p),next=batchFinalPayload(p);
 assert.deepEqual(p,saved);
 const oldSchema=expand(old.text.format.schema,old.text.format.schema),newSchema=expand(next.text.format.schema,next.text.format.schema);
 delete oldSchema.$defs;delete newSchema.$defs;delete oldSchema.properties.reasons.items;delete newSchema.properties.reasons.items;
 assert.deepEqual(newSchema,oldSchema);
 const input=JSON.parse(next.input[1].content),before=JSON.parse(old.input[1].content);
 delete input.deepseek_prior_review;assert.deepEqual(input,before);
 assert.equal(input.capture_context.ordered_path.length,24);
 assert.equal(next.max_output_tokens,old.max_output_tokens);
 assert.equal(next.model,old.model);
 assert.ok(Buffer.byteLength(JSON.stringify(next))<130000);
});
