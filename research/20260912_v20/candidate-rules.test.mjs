import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CANDIDATES,
  completedTail2,
  evaluateCandidate,
  freshBidArmProof,
} from './candidate-rules.mjs';

const entryAtMs = Date.parse('2026-09-12T00:00:15Z');
const row = (openTimeMs, open, close) => ({
  openTimeMs,
  open,
  high: Math.max(open, close) + 0.1,
  low: Math.min(open, close) - 0.1,
  close,
  volume: 100,
  closeTimeMs: openTimeMs + 59_999,
});
const first = Date.parse('2026-09-12T00:01:00Z');
const twoRed = [row(first, 100, 99.5), row(first + 60_000, 99.6, 99)];
const base = {
  position: {id: 'p1', ownership: 'AUTO', side: 'LONG', state: 'OPEN', entryAtMs, entryPrice: 100},
  decision: {
    evaluationAtMs: Date.parse('2026-09-12T00:03:05Z'),
    detectedAtMs: Date.parse('2026-09-12T00:03:04Z'),
    quoteRequestedAtMs: Date.parse('2026-09-12T00:03:03.500Z'),
    quoteReceivedAtMs: Date.parse('2026-09-12T00:03:03.800Z'),
    exchangeBookAtMs: Date.parse('2026-09-12T00:03:03Z'),
    bid: 99,
  },
  completedCandles: twoRed,
};

test('C1 cuts only an unarmed two-candle failure below entry', () => {
  const hit = evaluateCandidate({...base, candidate: CANDIDATES.C1, baselineArmed: false});
  assert.equal(hit.available, true);
  assert.equal(hit.wouldClose, true);
  assert.equal(hit.reason, 'C1_EARLY_FAILURE_TWO_BEARISH');
  assert.equal(evaluateCandidate({...base, candidate: CANDIDATES.C1, baselineArmed: true}).wouldClose, false);
  const above = [row(first, 101, 100.8), row(first + 60_000, 100.9, 100.5)];
  assert.equal(evaluateCandidate({...base, completedCandles: above, candidate: CANDIDATES.C1, baselineArmed: false}).wouldClose, false);
});

test('C2 persists only a strictly fresh executable +0.2% bid proof', () => {
  const proofDecision = {...base.decision, bid: 100.21};
  assert.equal(freshBidArmProof(proofDecision, 100), true);
  const armed = evaluateCandidate({...base, completedCandles: [row(first, 100, 100.1), row(first + 60_000, 100.2, 100.3)],
    decision: proofDecision, candidate: CANDIDATES.C2});
  assert.ok(armed.state.freshBidProof);
  const hit = evaluateCandidate({...base, candidate: CANDIDATES.C2, priorState: armed.state});
  assert.equal(hit.wouldClose, true);
  assert.equal(hit.reason, 'C2_FRESH_BID_ARM_TWO_BEARISH');
  assert.equal(freshBidArmProof({...proofDecision, quoteReceivedAtMs: proofDecision.quoteRequestedAtMs + 1_001}, 100), false);
  assert.equal(freshBidArmProof({...proofDecision, bid: 100.2}, 100), false);
});

test('C2 proof survives an observation before two completed candles exist', () => {
  const proofDecision = {...base.decision, evaluationAtMs: Date.parse('2026-09-12T00:01:30Z'), bid: 100.21};
  const early = evaluateCandidate({...base, completedCandles: [], decision: proofDecision, candidate: CANDIDATES.C2});
  assert.equal(early.available, false);
  assert.ok(early.state.freshBidProof);
  const later = evaluateCandidate({...base, candidate: CANDIDATES.C2, priorState: early.state});
  assert.equal(later.wouldClose, true);
});

test('C3 is the union of C1 and C2 without mutating stop or quantity', () => {
  const position = {...base.position, stopPrice: 97.5, remainingQuantity: 1};
  const result = evaluateCandidate({...base, position, candidate: CANDIDATES.C3});
  assert.equal(result.wouldClose, true);
  assert.equal(position.stopPrice, 97.5);
  assert.equal(position.remainingQuantity, 1);
});

test('future, incomplete, duplicate and gapped candles preserve baseline', () => {
  const at = base.decision.evaluationAtMs;
  assert.equal(completedTail2([twoRed[0], {...twoRed[1], closeTimeMs: at + 1}], at, entryAtMs), null);
  assert.equal(completedTail2([twoRed[0], twoRed[0]], at, entryAtMs), null);
  assert.equal(completedTail2([twoRed[0], row(first + 120_000, 99.6, 99)], at + 60_000, entryAtMs), null);
  const unavailable = evaluateCandidate({...base, completedCandles: [twoRed[0]], candidate: CANDIDATES.C3});
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.wouldClose, false);
});

test('pre-entry candles and state from another position fail closed', () => {
  const old = [row(first - 120_000, 100, 99.5), row(first - 60_000, 99.6, 99)];
  assert.equal(evaluateCandidate({...base, completedCandles: old, candidate: CANDIDATES.C1}).available, false);
  const priorState = {candidate: CANDIDATES.C2, positionId: 'other', entryAtMs, entryPrice: 100, freshBidProof: {}};
  const result = evaluateCandidate({...base, candidate: CANDIDATES.C2, priorState});
  assert.equal(result.available, false);
  assert.equal(result.reason, 'PRESERVE_STATE_MISMATCH');
});

test('manual, short and closed positions always preserve scope', () => {
  for (const position of [
    {...base.position, ownership: 'MANUAL'},
    {...base.position, side: 'SHORT'},
    {...base.position, state: 'CLOSED'},
  ]) assert.equal(evaluateCandidate({...base, position, candidate: CANDIDATES.C3}).reason, 'PRESERVE_SCOPE');
});
