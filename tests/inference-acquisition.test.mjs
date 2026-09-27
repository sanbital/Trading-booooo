import test from 'node:test';
import assert from 'node:assert/strict';
import {captureForInference} from '../supabase/functions/_shared/gpt-final-decision/capture-context.mjs';
import {validCapture} from '../test-support/dynamic-fixtures.mjs';
import {finalEvidenceTransport,frozenReview,arbitrationPayload,reviewsFor} from '../supabase/functions/_shared/gpt-final-decision/dual.mjs';
import {readFileSync} from 'node:fs';
const T=1800000000200;
test('same bucket is not a refresh: waits for a newer causal full bucket',async()=>{
 const original=validCapture(T);let at=T+3000,reads=0;
 const c=await captureForInference('ABCUSDT',original,{now:()=>at,sleep:async ms=>{at+=ms;},
  read:async()=>{reads++;return at<T+6000?original:validCapture(T+6000);}});
 assert.equal(c.status,'AVAILABLE');assert.ok(reads>=2);assert.ok(c.end_ms>original.end_ms);
 assert.equal(c.pre_inference_refresh.advanced,true);assert.ok(at-c.end_ms<=1500);
 assert.equal(original.end_ms,validCapture(T).end_ms);
});
test('stuck collector stops at acquisition deadline without relabelling data',async()=>{
 const original=validCapture(T);let at=T+3000;
 const c=await captureForInference('ABCUSDT',original,{now:()=>at,sleep:async ms=>{at+=ms;},deadlineMs:T+4500,read:async()=>original});
 assert.equal(c.status,'UNAVAILABLE');assert.equal(c.reason,'INFERENCE_CAPTURE_NOT_READY');
 assert.equal(c.pre_inference_refresh.advanced,false);assert.ok(at<=T+4500);
});
test('an initially fresh capture performs no polling or sleeping',async()=>{
 const c=validCapture(T);
 assert.equal(await captureForInference('ABCUSDT',c,{now:()=>T,read:async()=>assert.fail(),sleep:async()=>assert.fail()}),c);
});
test('final IDs decode only exact enum fields, including referenced anyOf; prose stays intact',()=>{
 const schema={type:'object',$defs:{paths:{anyOf:[{type:'string',enum:['current.facts.x','initial.facts.y']}]},
   dynamic:{type:'string',enum:['dynamics.horizons.s5.return']}},properties:{
  citations:{type:'array',items:{$ref:'#/$defs/paths'}},dynamic:{type:'array',items:{$ref:'#/$defs/dynamic'}},prose:{type:'string'}}};
 const p={text:{format:{schema}},input:[{role:'system',content:'Policy'},{role:'user',content:'{}'}]};
 const t=finalEvidenceTransport(p),id=path=>Object.entries(t.ids).find(([,p])=>p===path)[0];
 const wire={citations:[id('current.facts.x')],dynamic:[id('dynamics.horizons.s5.return')],prose:id('current.facts.x')};
 assert.deepEqual(t.decode(wire),{citations:['current.facts.x'],dynamic:['dynamics.horizons.s5.return'],prose:wire.prose});
 assert.equal(t.decode({citations:['P9999']}).citations[0],'P9999'); // canonical validator must reject it
 assert.deepEqual(p.text.format.schema,schema);assert.equal(JSON.parse(p.input[1].content).evidence_ids,undefined);
});
test('actual stored packet keeps its schema semantics and reduces citation generation',async()=>{
 const f=JSON.parse(readFileSync(new URL('../test-support/production-entry-timeout-20260927.json',import.meta.url)));
 const s=await frozenReview(f.packet,{snapshotAtMs:f.packet.dynamic_as_of_ms}),p=arbitrationPayload(s,s,reviewsFor(null,{valid:false})),t=finalEvidenceTransport(p);
 const paths=Object.values(t.ids),ids=Object.keys(t.ids);
 assert.ok(paths.length>100);assert.ok(ids.join('').length<paths.join('').length*.2);
 function restore(x){if(!x||typeof x!=='object')return x;if(Array.isArray(x))return x.map(restore);
  return Object.fromEntries(Object.entries(x).map(([k,v])=>[k,k==='enum'?v.map(p=>t.ids[p]??p):restore(v)]));}
 assert.deepEqual(restore(t.payload.text.format.schema),p.text.format.schema);
 assert.deepEqual(JSON.parse(t.payload.input[1].content).capture_context,JSON.parse(p.input[1].content).capture_context);
});
