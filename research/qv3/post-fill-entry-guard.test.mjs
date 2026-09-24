import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTRY_EXECUTION_POLICY_VERSION,
  POLICY,
  STRATEGY,
  postFillEntryGuard,
} from '../../supabase/functions/_shared/leader-momentum-v17.mjs';

const features = {strategy: STRATEGY, referenceClose: 100};

test('actual fill outside the one-percent band is recorded as evidence, not locally closed', () => {
  const result = postFillEntryGuard(features, 98.99);
  assert.equal(result.version, ENTRY_EXECUTION_POLICY_VERSION);
  assert.equal(result.action, 'KEEP');
  assert.equal(result.reason, 'FD1_POST_FILL_DRIFT_EVIDENCE');
  assert.equal(result.driftExceeded, true);
  assert.ok(result.driftPct < -POLICY.maxEntryDriftPct);
});

test('the exact boundary and ordinary fill remain valid', () => {
  assert.equal(postFillEntryGuard(features, 99).action, 'KEEP');
  assert.equal(postFillEntryGuard(features, 99.155).action, 'KEEP');
  assert.equal(postFillEntryGuard(features, 100).driftExceeded, false);
});

test('upward drift is also evidence; malformed safety input still fails closed', () => {
  const up = postFillEntryGuard(features, 101.01);
  assert.equal(up.action, 'KEEP');
  assert.equal(up.reason, 'FD1_POST_FILL_DRIFT_EVIDENCE');
  assert.equal(up.driftExceeded, true);
  const bad = postFillEntryGuard({...features, referenceClose: 0}, 100);
  assert.equal(bad.action, 'CLOSE');
  assert.equal(bad.reason, 'V21_POST_FILL_ENTRY_INPUT_INVALID');
});
