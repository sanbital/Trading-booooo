import test from 'node:test';
import assert from 'node:assert/strict';
import {captureForInference} from '../supabase/functions/_shared/gpt-final-decision/capture-context.mjs';
import {hash} from '../supabase/functions/_shared/gpt-final-decision/snapshot-hash.mjs';
import {validCapture} from '../test-support/dynamic-fixtures.mjs';
const T=1800000000200;
const missing=()=>({status:'UNAVAILABLE',reason:'TIMEOUT',valid:false});
test('missing initial capture can recover and pass the exact packet hasher without inventing a prior time',async()=>{
 let at=T;const before=missing();const saved=structuredClone(before);
 const result=await captureForInference('ONEUSDT',before,{now:()=>at,sleep:async ms=>{at+=ms;},read:async()=>validCapture(at)});
 assert.equal(result.status,'AVAILABLE');assert.equal(result.bucket_count,24);
 // This hash failed with NONFINITE in the production CAPTURE stage.
 await assert.doesNotReject(()=>hash({facts:{capture_context:result}}));
 assert.equal(result.pre_inference_refresh.previous_end_ms,null);
 assert.equal(result.pre_inference_refresh.previous_age_ms,null);
 assert.deepEqual(result.trajectory,validCapture(at).trajectory);
 assert.deepEqual(before,saved);
});
test('missing initial capture still fails closed at its deadline and its diagnostic can be hashed',async()=>{
 let at=T;
 const result=await captureForInference('ONEUSDT',missing(),{now:()=>at,sleep:async ms=>{at+=ms;},deadlineMs:T+2000,read:async()=>missing()});
 assert.equal(result.status,'UNAVAILABLE');assert.equal(result.reason,'INFERENCE_CAPTURE_NOT_READY');
 assert.equal(result.valid,false);assert.equal(result.pre_inference_refresh.advanced,false);
 assert.ok(at<=T+2000);
 await assert.doesNotReject(()=>hash({facts:{capture_context:result}}));
 assert.equal(result.pre_inference_refresh.previous_end_ms,null);
 assert.equal(result.pre_inference_refresh.previous_age_ms,null);
});
test('finite previous capture and explicit retry boundary retain original time and age',async()=>{
 for(const source of [validCapture(T),missing()]){
  let at=T+3000;const prior=validCapture(T).end_ms;
  const result=await captureForInference('ONEUSDT',source,{now:()=>at,sleep:async ms=>{at+=ms;},afterEndMs:prior,read:async()=>validCapture(at)});
  assert.equal(result.status,'AVAILABLE');assert.ok(result.end_ms>prior);
  assert.equal(result.pre_inference_refresh.previous_end_ms,prior);
  assert.equal(result.pre_inference_refresh.previous_age_ms,T+3000-prior);
  await assert.doesNotReject(()=>hash(result));
 }
});
