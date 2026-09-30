import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {rawCapture,validCapture} from '../test-support/dynamic-fixtures.mjs';
import {validateCapture120} from '../supabase/functions/_shared/gpt-final-decision/capture-context.mjs';
import {DYNAMIC_POLICY} from '../supabase/functions/_shared/gpt-final-decision/dynamic-flow.mjs';
import {MODEL} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {MODEL_CANDIDATES} from '../supabase/functions/_shared/gpt-final-decision/parallel.mjs';
import {RECHECK_POLICY} from '../supabase/functions/_shared/gpt-final-decision/recheck.mjs';
import {SLOT_SIZING_CONTRACT} from '../supabase/functions/_shared/leader-slot-sizing.mjs';

const T=1800000000200;

test('normal capture still requires and accepts all 24 contiguous five-second buckets',()=>{
 const capture=validCapture(T);
 assert.equal(capture.status,'AVAILABLE');assert.equal(capture.coverage_policy,'ALL_24_REQUIRED');
 assert.equal(capture.bucket_count,24);assert.equal(capture.trajectory.length,24);
 for(let i=1;i<24;i++)assert.equal(capture.trajectory[i].bucket_ms-capture.trajectory[i-1].bucket_ms,5000);
});

test('one invalid bucket still rejects the entire 24-bucket capture',()=>{
 const raw=rawCapture(T);raw.trajectory[12].book_received_at_ms=raw.trajectory[12].end_ms+1;
 const capture=validateCapture120(raw,T);
 assert.equal(capture.status,'UNAVAILABLE');assert.equal(capture.reason,'NONCAUSAL_BUCKET');
 const short=rawCapture(T);short.buckets=23;short.trajectory=short.trajectory.slice(1);
 assert.equal(validateCapture120(short,T).status,'UNAVAILABLE');
});

test('recovery changes preserve production model, strategy, sizing, deadlines and cadences',async()=>{
 assert.deepEqual(DYNAMIC_POLICY,{version:'DYNAMIC_FLOW_LIFECYCLE_1',bucketMs:5000,buckets:24,
  normalAgeMs:5000,absoluteAgeMs:10000,positionReadMs:5000,missingRetryMs:5000,
  periodicReviewMs:120000,fastReviewMs:8000,singleModelBuyConfidence:.8,maxWaitReviews:3});
 assert.equal(MODEL,'gpt-5.4-mini-2026-03-17');
 assert.equal(MODEL_CANDIDATES[0].model,'deepseek-flash');
 assert.equal(RECHECK_POLICY.executionReserveMs,3000);assert.equal(RECHECK_POLICY.requestTimeoutMs,4000);
 assert.equal(SLOT_SIZING_CONTRACT.targetMarginUsdt,150);assert.equal(SLOT_SIZING_CONTRACT.leverage,3);
 const executor=await readFile(new URL('../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8');
 const cadence=await readFile(new URL('../supabase/migrations/20260929133800_v10_executor_30s_cadence.sql',import.meta.url),'utf8');
 assert.match(executor,/const MAX_SLOTS=10,/);assert.match(executor,/const NATIVE_STOP_ENABLED=env\("V17_NATIVE_STOP"\)===\"true\"/);
 assert.match(executor,/time_in_force:\"IOC\"/);assert.match(executor,/immediately before dispatch/);
 assert.match(cadence,/schedule := '30 seconds'/);
});
