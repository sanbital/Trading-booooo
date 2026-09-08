// Locks in the ACTIVATED cost-breakeven / profit-lock protection on the live
// one-minute cadence. If EXIT_REVIEW_CANDIDATE ever stops reaching the effective
// policy, or its thresholds drift, these fail rather than silently reverting the
// account to the bare -2.5% stop.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {POLICY} from '../../supabase/functions/_shared/leader-momentum-v17.mjs';
import {nextExitReviewed, EXIT_REVIEW_CANDIDATE as C} from '../../supabase/functions/_shared/leader-exit-review.mjs';

const ACTIVE = {...POLICY, ...C};
const BASE = {...POLICY};
const entry = {entryPrice: 100, entryAt: 0, entryFee: 0.06, quantity: 10};
const MIN = 60000;

// Replays a price path at the production cron spacing, feeding the ratcheted stop
// back in the way the executor persists it to hard_stop_price.
function replay(prices, policy) {
  let peakPrice = entry.entryPrice, stopPrice = entry.entryPrice * (1 - POLICY.stopPct), lastHighAt = 0, at = 0;
  for (const price of prices) {
    at += MIN;
    const o = nextExitReviewed({...entry, peakPrice, stopPrice, lastHighAt}, price, at, policy);
    ({peakPrice, stopPrice, lastHighAt} = o);
    if (o.action === 'CLOSE') return {closed: true, atMin: at / MIN, price, stopPrice, reason: o.reason};
  }
  return {closed: false, stopPrice};
}

test('a give-back after +2% is stopped out at the profit lock, not at entry', () => {
  const path = [...Array(4).fill(102.5), ...Array(30).fill(100)];
  assert.equal(replay(path, BASE).closed, false, 'baseline is expected to ride it back down');
  const active = replay(path, ACTIVE);
  assert.equal(active.closed, true);
  // entry + (peak - entry) * 0.5
  assert.equal(active.stopPrice, 101.25);
});

test('a give-back after +1% is stopped out at cost breakeven, above entry', () => {
  const path = [...Array(3).fill(101.2), ...Array(30).fill(100)];
  const active = replay(path, ACTIVE);
  assert.equal(active.closed, true);
  assert.ok(active.stopPrice > entry.entryPrice,
    `breakeven stop ${active.stopPrice} must clear entry so fees and slippage are covered`);
  assert.ok(active.stopPrice < 100.5, 'breakeven must not overshoot into a needless early exit');
});

test('the loss stop is not weakened by activation', () => {
  const path = [99.5, 99, 98, 97.4, 97];
  const base = replay(path, BASE), active = replay(path, ACTIVE);
  assert.deepEqual(active, base);
  assert.equal(active.reason, 'V17_HARD_STOP');
});

test('a running winner is not cut short by activation', () => {
  const path = [101, 102, 103, 104, 105, 106, 107];
  assert.deepEqual(replay(path, ACTIVE), replay(path, BASE));
});

test('protection can only raise the stop, never lower it', () => {
  let peakPrice = 100, stopPrice = 97.5, lastHighAt = 0, at = 0;
  for (const price of [101, 103, 102, 106, 99, 104, 100.5]) {
    at += MIN;
    const o = nextExitReviewed({...entry, peakPrice, stopPrice, lastHighAt}, price, at, ACTIVE);
    assert.ok(o.stopPrice >= stopPrice, `stop fell from ${stopPrice} to ${o.stopPrice}`);
    ({peakPrice, stopPrice, lastHighAt} = o);
    if (o.action === 'CLOSE') break;
  }
});

test('the executor puts the candidate in the effective policy and degrades safely', () => {
  const src = readFileSync(new URL('../../supabase/functions/v10-lane-executor/index.ts', import.meta.url), 'utf8');
  assert.match(src, /const policy=\{\.\.\.POLICY,[^\n]*EXIT_REVIEW_CANDIDATE/,
    'candidate must reach the effective policy');
  // Without this fallback an unusable fee/quantity makes costBreakeven throw, which
  // aborts the evaluation and leaves the position with no stop at all.
  assert.match(src, /costUsable/);
});

test('the candidate carries the inputs costBreakeven needs', () => {
  for (const k of ['breakEvenArmPct', 'profitLockArmPct', 'profitLockCapture',
                   'estimatedExitFeeRate', 'exitSlippageBudgetPct']) {
    assert.ok(Number.isFinite(C[k]), `EXIT_REVIEW_CANDIDATE.${k} must be a finite number`);
  }
  assert.ok(C.profitLockArmPct >= C.breakEvenArmPct, 'profit lock must arm at or above breakeven');
});
