import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {sharedReview,callCounter,MODEL_CANDIDATES} from '../supabase/functions/_shared/gpt-final-decision/parallel.mjs';
const row=JSON.parse(await readFile(new URL('../research/deepseek-counter-20260925/inputs.json',import.meta.url),'utf8'))[0];
const shared=await sharedReview(row.packet,{snapshotAtMs:row.snapshot_at_ms});
const config={...MODEL_CANDIDATES[0],apiKey:'private-test-key'};
const wire={task:'ENTRY',candidate_id:row.packet.candidate_id,confidence:.5,evidence:['return_5m'],summary:'Short evidence',decision:'UNCERTAIN',failure_risk:'MEDIUM',continuation_strength:'NORMAL',chase_risk:'MEDIUM',expected_value:'NEUTRAL'};
const reply=w=>Response.json({model:config.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(w)}}]});
for(const [name,change,error] of [
 ['long summary',w=>({...w,summary:'x'.repeat(161)}),'COUNTER_SCHEMA_STRING'],
 ['missing field',w=>{delete w.summary;return w;},'COUNTER_SCHEMA_REQUIRED'],
 ['extra field',w=>({...w,private:'private-test-key'}),'COUNTER_SCHEMA_EXTRA'],
 ['invalid enum',w=>({...w,decision:'private-test-key'}),'COUNTER_SCHEMA_ENUM'],
 ['wrong type',w=>({...w,confidence:'private-test-key'}),'COUNTER_SCHEMA_TYPE'],
])test(name+' returns only a fixed diagnostic code',async()=>{
 const result=await callCounter(shared,{...config,fetchFn:async()=>reply(change({...wire}))});
 assert.equal(result.valid,false);assert.equal(result.answer,null);assert.equal(result.error,error);
 assert.equal(JSON.stringify(result).includes('private-test-key'),false);
});
test('valid short structured answer still passes',async()=>{
 const result=await callCounter(shared,{...config,fetchFn:async()=>reply(wire)});
 assert.equal(result.valid,true);assert.deepEqual(result.answer,wire);
});
test('unrecognized error text is never returned',async()=>{
 const result=await callCounter(shared,{...config,fetchFn:async()=>{throw Error('private-test-key');}});
 assert.equal(result.error,'COUNTER_INVALID_RESPONSE');assert.equal(JSON.stringify(result).includes('private-test-key'),false);
});
test('Pro requests explicit low reasoning effort within the original deadline',async()=>{
 const pro=MODEL_CANDIDATES[1];let sent;
 const result=await callCounter(shared,{...pro,apiKey:'test',timeoutMs:4000,fetchFn:async(url,init)=>{
  sent=JSON.parse(init.body);return Response.json({model:pro.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(wire)}}]});
 }});
 assert.equal(sent.thinking.type,'enabled');assert.equal(sent.reasoning_effort,'low');assert.equal(result.valid,true);
});
test('unreviewed effort configurations do not make a provider request',async()=>{
 const result=await callCounter(shared,{...MODEL_CANDIDATES[1],reasoning_effort:'max',apiKey:'test',fetchFn:()=>assert.fail('network')});
 assert.equal(result.error,'COUNTER_MODEL');assert.equal(result.attempted,false);
});


