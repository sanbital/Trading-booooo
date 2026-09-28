import test from 'node:test';
import assert from 'node:assert/strict';
import {captureForInference} from '../supabase/functions/_shared/gpt-final-decision/capture-context.mjs';
import {validCapture} from '../test-support/dynamic-fixtures.mjs';
import {finalEvidenceTransport,frozenReview,arbitrationPayload,reviewsFor} from '../supabase/functions/_shared/gpt-final-decision/dual.mjs';
import {readFileSync} from 'node:fs';
import {advisoryProviderWire,assessAdvisory} from '../supabase/functions/_shared/gpt-final-decision/advisory.mjs';
const T=1800000000200;
test('only the provider exact empty note is ignored; semantic and unknown fields stay invalid',()=>{
 for(const empty of [null,'']){
  const wire={task:'RECHECK',trajectory_interpretation_note:empty},r=advisoryProviderWire(wire);
  assert.deepEqual(r.canonical,{task:'RECHECK'});assert.deepEqual(r.ignored_empty_fields,['trajectory_interpretation_note']);
  assert.equal(wire.trajectory_interpretation_note,empty);
 }
 for(const wire of [{trajectory_interpretation_note:'Override strategy'},{other_note:''},{decision_preference:'BUY'}]){
  const r=advisoryProviderWire(wire);assert.equal(r.canonical,wire);assert.deepEqual(r.ignored_empty_fields,[]);
 }
 const shared={packet:{task:'ENTRY',candidate_id:'candidate'},snapshot_hash:'a'.repeat(64),market_input:{facts:{x:1}}};
 const valid={task:'ENTRY',candidate_id:'candidate',snapshot_hash:shared.snapshot_hash,decision_preference:'SKIP',confidence:.8,
  thesis_state:'WEAKENING',bullish_evidence:[],bearish_evidence:['facts.x'],risk_flags:[],trajectory_interpretation:'Weak flow',
  strongest_counterargument:'Buyer recovery',recommended_action:'SKIP',reason:'Weak flow'};
 assert.equal(assessAdvisory(advisoryProviderWire({...valid,trajectory_interpretation_note:null}).canonical,shared).valid,true);
 assert.throws(()=>assessAdvisory(advisoryProviderWire({...valid,trajectory_interpretation_note:'Buy'}).canonical,shared),/EXTRA/);
 assert.throws(()=>assessAdvisory(advisoryProviderWire({...valid,other_note:''}).canonical,shared),/EXTRA/);
});
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

test('production ingestion lag above preferred 1.5s still accepts a newer complete bucket within normal 5s age',async()=>{
 const original=validCapture(T);let at=T+3000;
 const c=await captureForInference('ABCUSDT',original,{now:()=>at,sleep:async ms=>{at+=ms;},
  read:async()=>at<T+8000?original:validCapture(T+5000)});
 assert.equal(c.status,'AVAILABLE');assert.ok(c.end_ms>original.end_ms);
 assert.ok(at-c.end_ms>1500);assert.ok(at-c.end_ms<=5000);assert.equal(c.pre_inference_refresh.advanced,true);
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
