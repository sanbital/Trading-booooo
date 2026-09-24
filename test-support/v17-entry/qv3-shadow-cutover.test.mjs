// QV3's two-bearish-candle exit stops being authoritative for positions opened under
// the pullback entry timing, and stays authoritative for every position that was
// already open. Both halves matter: the first is the change, the second is the
// promise that a deploy never rewrites a live position's policy.
//
// Why it changes: on the same 7 days, replayed with the new entry, QV3's exit took
// net +27.999 -> +13.456 USDT and profit factor 1.843 -> 1.417 over 43 trades. It
// closes a position that has merely paused, which is the pause the new entry exists
// to buy. The rule is not deleted -- it is evaluated and recorded every cycle, so the
// decision is reversible and the counterfactual stays measurable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SETUP_POLICY_VERSION } from '../../supabase/functions/_shared/leader-pullback-reaccel.mjs';
import { QV3_VERSION, qv3Scope, qv3Stamp } from '../../supabase/functions/_shared/leader-qv3-runtime.mjs';

const SOURCE = readFileSync(
  new URL('../../supabase/functions/v10-lane-executor/index.ts', import.meta.url), 'utf8');
const CUTOVER = Date.parse('2026-09-11T15:20:00.000Z');

// CASE 39 ------------------------------------------------------------------
test('CASE 39: a new-policy position is routed to the shadow, never to a close', () => {
  assert.match(SOURCE,
    /if\(rec\(p\.metadata\)\.entryTimingPolicyVersion===SETUP_POLICY_VERSION\)return await qv3ShadowOnly\(db,p,ctx\);/,
    'the new policy must short-circuit before qv3Scope');
  const shadow = SOURCE.slice(SOURCE.indexOf('async function qv3ShadowOnly('),
    SOURCE.indexOf('async function qv3AfterProtection('));
  assert.ok(!/closePos\(/.test(shadow), 'the shadow path must never call closePos');
  assert.match(shadow, /executed:false/);
  assert.match(shadow, /wouldClose:/, 'the counterfactual verdict is recorded');
  assert.match(shadow, /hypotheticalPnlUsdt:/, 'and so is what it would have cost');
  assert.match(shadow, /timestamp:/);
});

test('CASE 39: the shadow writes its own key and cannot be mistaken for the live one', () => {
  const shadow = SOURCE.slice(SOURCE.indexOf('async function qv3ShadowOnly('),
    SOURCE.indexOf('async function qv3AfterProtection('));
  assert.match(shadow, /qv3ShadowState:/);
  assert.match(shadow, /qv3Shadow:/);
  assert.ok(!/qv3State:/.test(shadow),
    'the authoritative qv3State key belongs to old-policy positions only');
});

// CASE 40 ------------------------------------------------------------------
test('CASE 40: an old-policy position keeps the authoritative QV3 behaviour', () => {
  // qv3Scope is what admits a position to the executing QV3 path. An old position
  // carries the stamp and is admitted; a new-policy position is never stamped.
  const entryAt = CUTOVER + 60_000;
  const old = {
    id: 'p-old', entryAt, entryPrice: 100, side: 'LONG', state: 'OPEN',
    ownership: 'AUTO', qv3: qv3Stamp(CUTOVER, entryAt),
  };
  assert.equal(qv3Scope(old, CUTOVER), true, 'an already-open position keeps its policy');
  assert.equal(qv3Scope({ ...old, qv3: null }, CUTOVER), false,
    'and an unstamped position is outside the executing scope entirely');
  assert.equal(old.qv3.version, QV3_VERSION);
});

test('CASE 40: a new-policy entry is never given the authoritative QV3 stamp', () => {
  assert.match(SOURCE,
    /metadata:\{[\s\S]*?qv3:entryTiming\?\.version===SETUP_POLICY_VERSION\?null:/,
    'the stamp must be withheld at insert, which is what keeps qv3Scope false');
  assert.match(SOURCE, /entryTimingPolicyVersion:entryTiming\?\.version\?\?null/);
});

test('the entry-timing stamp is taken from the ORDER INTENT, so a deploy cannot backfill it', () => {
  // The stamp is fixed when the order is created. A position opened before this
  // policy has no such field, so no later deploy can opt it in.
  assert.match(SOURCE, /entryTiming=rec\(intent\.request_payload\?\.entry_timing_policy\)/);
  assert.match(SOURCE, /entry_timing_policy:setupGoverns\(s\)\?\{version:SETUP_POLICY_VERSION/);
  assert.equal(SETUP_POLICY_VERSION, 'V17_GPT_CONTINUATION_ENTRY_2');
});

test('R5 remains the authoritative exit for both policies', () => {
  // The entry change must not quietly become an exit change. Every position, old or
  // new, still carries the same exit policy version.
  assert.match(SOURCE, /leaderExitPolicyVersion:entryController\?\.version===CEC0040_VERSION[\s\S]*?:EXIT_REVIEW_R5\.policyVersion/);
  const insert = SOURCE.slice(SOURCE.indexOf('v11_long_regime_positions").insert('));
  assert.ok(!/leaderExitPolicy:[^,]*SETUP/.test(insert.slice(0, 4000)),
    'the exit policy is not re-pointed by the entry policy');
});

test('QV3 entry gating is left in place: it blocks none of the measured triggers', () => {
  // Measured, not assumed: across the 43 triggers the 7-day replay produced, QV3's
  // entry filter would have blocked 0. The two rules are opposites -- QV3 refuses two
  // consecutive lower-close bearish 1m bars, the trigger REQUIRES a bullish bar above
  // the previous close -- so a trigger implies a QV3 entry pass. Nothing is weakened
  // here: the gate stays, as an independent check on anything the trigger misses.
  assert.match(SOURCE, /qv3Entry\(bars,Date\.now\(\)\)/, 'the QV3 entry gate is still called');
  const evidence = JSON.parse(readFileSync(
    new URL('./evidence/qv3-entry-overlap.json', import.meta.url), 'utf8'));
  assert.equal(evidence.triggers, 43);
  assert.equal(evidence.wouldBlock, 0);
  assert.equal(evidence.unavailable, 0);
});
