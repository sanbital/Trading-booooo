import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  CLOCK_BATCH_MIN_REMAINING_MS,
  clockBatchAdmissionDeadline,
} from '../supabase/functions/_shared/leader20/batch-runtime.mjs';

const root=new URL('../',import.meta.url);
const read=p=>readFile(new URL(p,root),'utf8');

test('late leader20 wake survives while the immutable T+120 authority still has 55s',()=>{
  const slot=Date.parse('2026-09-29T12:20:00Z');
  const window={
    slot_ms:slot,
    decision_deadline_ms:slot+120000,
    latest_batch_start_ms:slot+40000,
    decision_reserve_ms:80000,
  };
  const admission=clockBatchAdmissionDeadline(window);
  assert.equal(CLOCK_BATCH_MIN_REMAINING_MS,55000);
  assert.equal(admission,slot+65000);
  assert.ok(slot+59000<admission,'observed +59s production wake must still be admitted');
  assert.ok(slot+65000>=admission,'55s remaining is the hard start boundary');
  assert.equal(window.decision_deadline_ms,slot+120000,'authority itself is never widened');
});

test('a stricter configured reserve is preserved instead of weakened',()=>{
  const slot=1_800_000_000_000;
  const window={decision_deadline_ms:slot+120000,decision_reserve_ms:30000};
  assert.equal(clockBatchAdmissionDeadline(window),slot+90000);
});

test('SQL batch claim mirrors the late-wake boundary and keeps both absolute expiry checks',async()=>{
  const sql=await read('supabase/migrations/20260929122500_leader20_late_wake_multislot_recovery.sql');
  assert.equal((sql.match(/least\(c\.decision_reserve_ms,55000\)/g)||[]).length,2,
    'both pre-claim and pre-insert reserve checks must use the 55s floor');
  assert.ok(sql.includes("at_time>=slot_at+interval '120 seconds'"));
  assert.ok(sql.includes("DECISION_WINDOW_EXPIRED"));
  assert.ok(sql.includes("DECISION_WINDOW_INSUFFICIENT"));
});

test('post-fill capacity proof has a separate read-only budget, never a write escape hatch',async()=>{
  const src=await read('supabase/functions/v10-lane-executor/index.ts');
  assert.ok(src.includes('const CAPACITY_REFRESH_BUDGET=Object.freeze({ms:6000,calls:4})'));
  assert.ok(src.includes('capacityRefreshGateway(db)'));
  assert.ok(src.includes('{allowCycleBudgetExceeded:true}'));
  assert.ok(src.includes('CAPACITY_REFRESH_WRITE_FORBIDDEN'));
  assert.ok(src.includes('const safetyGateway=typeof capacityRefreshGateway==="function"?capacityRefreshGateway(db):undefined'));
  assert.ok(src.includes('readOpsPair(db,safetyGateway)'));
  assert.ok(src.includes('await verifyExecutionLease(db,allowCycleBudgetExceeded)'));
});

test('malformed retry book gets one bounded fresh quote and must pass all safety again',async()=>{
  const src=await read('supabase/functions/v10-lane-executor/index.ts');
  const marker='A one-shot malformed REST depth must not consume an otherwise valid second slot.';
  assert.equal(src.split(marker).length-1,1,'one recovery site only');
  assert.ok(src.includes('const freshQuote=await gateway({action:"quote",market:s.symbol},refreshTimeout)'));
  assert.ok(src.includes('retryDynamic=executionDynamicSafety(s,attempt.gptFinalReview,attempt.finalRecheck,retryNow)'));
  assert.ok(src.includes('if(!retryBook.health.bookHealthy)'));
  assert.ok(src.includes('EXECUTION_SAFETY_REJECT:INVALID_BOOK'));
});
