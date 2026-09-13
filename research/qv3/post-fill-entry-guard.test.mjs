import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTRY_EXECUTION_POLICY_VERSION,
  POLICY,
  STRATEGY,
  postFillEntryGuard,
} from '../../supabase/functions/_shared/leader-momentum-v17.mjs';

const features = {strategy: STRATEGY, referenceClose: 100};

test('actual fill outside the existing one-percent drift contract closes', () => {
  const result = postFillEntryGuard(features, 98.99);
  assert.equal(result.version, ENTRY_EXECUTION_POLICY_VERSION);
  assert.equal(result.action, 'CLOSE');
  assert.equal(result.reason, 'V21_POST_FILL_ENTRY_DRIFT');
  assert.ok(result.driftPct < -POLICY.maxEntryDriftPct);
});

test('the exact boundary and the measured large-winner drift remain valid', () => {
  assert.equal(postFillEntryGuard(features, 99).action, 'KEEP');
  // The largest V39 winner filled 0.845% below its reference close.
  assert.equal(postFillEntryGuard(features, 99.155).action, 'KEEP');
});

test('upward drift is symmetric and invalid evidence fails closed', () => {
  assert.equal(postFillEntryGuard(features, 101.01).action, 'CLOSE');
  assert.equal(postFillEntryGuard({...features, referenceClose: 0}, 100).reason,
    'V21_POST_FILL_ENTRY_INPUT_INVALID');
});
