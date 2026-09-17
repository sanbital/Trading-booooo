// Why 102 of the 144 rejections in the window were SIGNAL_STALE_OR_FUTURE, and why
// the answer is not "raise maxEntryAgeMs".
//
// The measured timings, from the production tables, are unambiguous: every one of
// those 102 signals was WRITTEN promptly -- 2.1 to 10.3 seconds after its 5m bar
// closed, comfortably inside the 120s window -- and every one was FIRST EVALUATED
// 124.8 to 136.5 seconds after that close. Not one was ever looked at while it was
// still fresh. A signal that is never evaluated in time is a scheduling failure, and
// a longer window would only move the same wall further out.
//
// Two defects put them there, and both are structural rather than market-dependent:
//
//   1. E1 judged the quote against maxQuoteAgeMs = 1000, but was handed the
//      admission-time quote and then stamped its decision after its own 10s tape
//      fetch. 118 defers carried a quote age; 0 were inside the policy. The
//      distribution -- 1097ms minimum -- is the signature of a fixed cost, not of a
//      slow venue.
//   2. Any released claim ended the whole run, so the first candidate to hit (1)
//      abandoned every remaining candidate for that cycle. Repeat once a minute and
//      the untouched candidates age out together, which is exactly the 125-136s
//      cluster above.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {POLICY} from '../../supabase/functions/_shared/leader-momentum-v17.mjs';
import {E1_POLICY} from '../../supabase/functions/_shared/leader-e1-runtime.mjs';

const EVIDENCE = JSON.parse(readFileSync(
  new URL('./evidence/stale-timing-20260917.json', import.meta.url), 'utf8'));
const EXECUTOR = readFileSync(
  new URL('../../supabase/functions/v10-lane-executor/index.ts', import.meta.url), 'utf8');

test('the measured evidence rules out a slow signal generator', () => {
  const {staleRejections: s} = EVIDENCE;
  assert.equal(s.generatedPromptlyWithin12s, s.count,
    'every stale signal was written within 12s of its bar close');
  assert.ok(s.generationLagSecondsAfterBarClose.max * 1000 < POLICY.maxEntryAgeMs / 10,
    'generation used under a tenth of the window');
  // So the time was lost between the row existing and the executor looking at it.
  assert.ok(s.queueWaitSeconds.min * 1000 > POLICY.maxEntryAgeMs * 0.9);
});

test('the measured evidence rules out a market-dependent E1 refusal', () => {
  const {e1Defers: e} = EVIDENCE;
  assert.equal(e.policyMaxQuoteAgeMs, E1_POLICY.maxQuoteAgeMs, 'the policy is unchanged');
  assert.equal(e.withinPolicy, 0, `0 of ${e.count} defers had a quote inside the policy`);
  assert.ok(e.quoteAgeMs.min > e.policyMaxQuoteAgeMs,
    'even the FASTEST observed quote was already outside the window: a fixed cost, not a flake');
});

test('E1 now reads its quote at its own decision point', () => {
  const gate = EXECUTOR.slice(EXECUTOR.indexOf('async function runE1Gate('),
    EXECUTOR.indexOf('async function reconcileNativeCloseBeforeDispatch('));
  assert.match(gate, /Promise\.allSettled\(\[\s*fetchE1AggTrades[\s\S]*?gw\(\{action:"quote"/,
    'the quote must be read alongside the tape, at the decision point');
  const read = gate.indexOf('action:"quote"');
  const decision = gate.indexOf('decisionAt=Date.now()');
  assert.ok(read > 0 && read < decision, 'and before decisionAt is stamped');
  // The policy itself must NOT have been widened to make the old ordering work.
  assert.equal(E1_POLICY.maxQuoteAgeMs, 1000);
});

test('the entry-age policy is unchanged; only the scheduling around it moved', () => {
  assert.equal(POLICY.maxEntryAgeMs, 120_000);
  assert.match(EXECUTOR, /now-close>POLICY\.maxEntryAgeMs/,
    'the queue applies the same threshold, just earlier and more cheaply');
  assert.ok(!/maxEntryAgeMs\s*[:=]\s*(?!120_000)/.test(EXECUTOR),
    'nothing in the executor redefines the entry age');
});

test('REPORT: the stale window, measured', () => {
  const {staleRejections: s, e1Defers: e} = EVIDENCE;
  console.log([
    '',
    `stale rejections in window                 ${s.count}`,
    `  written within 12s of bar close          ${s.generatedPromptlyWithin12s}`,
    `  generation lag after bar close (s)       ${s.generationLagSecondsAfterBarClose.min} .. ${s.generationLagSecondsAfterBarClose.max}`,
    `  FIRST evaluation after bar close (s)     ${s.firstEvaluationSecondsAfterBarClose.min} .. ${s.firstEvaluationSecondsAfterBarClose.max}`,
    `  ever evaluated inside the 120s window    ${s.evaluatedWhileStillInsideThe120sWindow}`,
    '',
    `E1 defers carrying a quote age             ${e.count}  (${Object.entries(e.reasonCounts).map(([k, v]) => `${k}=${v}`).join(' ')})`,
    `  quote age observed (ms)                  ${e.quoteAgeMs.min} .. ${e.quoteAgeMs.max}, avg ${e.quoteAgeMs.avg}`,
    `  policy ceiling (ms)                      ${e.policyMaxQuoteAgeMs}`,
    `  inside the policy                        ${e.withinPolicy}`,
    '',
    `entries opened in the window               ${EVIDENCE.entries}`,
    '',
  ].join('\n'));
  assert.equal(EVIDENCE.entries, 0);
});
