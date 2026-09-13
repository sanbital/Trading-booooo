/**
 * Frozen V20 loss-preservation candidates.
 *
 * This module is deliberately pure and side-effect free.  It consumes only the
 * position, quote timing and completed-candle evidence that existed at an
 * evaluation time.  Missing, duplicated, stale or future candle evidence fails
 * closed to PRESERVE_BASELINE.
 */

export const CANDIDATES = Object.freeze({
  C1: 'C1_UNARMED_TWO_BEARISH_BELOW_ENTRY',
  C2: 'C2_FRESH_BID_ARM_TWO_BEARISH',
  C3: 'C3_C1_PLUS_C2',
});

const MINUTE_MS = 60_000;
const FAVORABLE_ARM_RETURN = 0.002;

const finite = value => Number.isFinite(Number(value));

export function normalizeCandle(row) {
  if (Array.isArray(row)) {
    if (row.length < 7) return null;
    return {
      openTimeMs: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      closeTimeMs: Number(row[6]),
    };
  }
  if (!row || typeof row !== 'object') return null;
  return {
    openTimeMs: Number(row.openTimeMs ?? row.open_time_ms),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
    closeTimeMs: Number(row.closeTimeMs ?? row.close_time_ms),
  };
}

export function validCandle(row) {
  const candle = normalizeCandle(row);
  if (!candle) return false;
  const {openTimeMs, open, high, low, close, volume, closeTimeMs} = candle;
  return [openTimeMs, open, high, low, close, volume, closeTimeMs].every(Number.isFinite) &&
    Number.isSafeInteger(openTimeMs) && openTimeMs >= 0 && openTimeMs % MINUTE_MS === 0 &&
    closeTimeMs === openTimeMs + MINUTE_MS - 1 && open > 0 && close > 0 && low > 0 &&
    high >= Math.max(open, close) && low <= Math.min(open, close) && volume >= 0;
}

/** Validate exactly the last two completed post-entry candles at evaluationAtMs. */
export function completedTail2(rows, evaluationAtMs, entryAtMs) {
  if (!Array.isArray(rows) || rows.length !== 2 || !Number.isSafeInteger(evaluationAtMs) ||
      !Number.isSafeInteger(entryAtMs) || evaluationAtMs < entryAtMs) return null;
  const candles = rows.map(normalizeCandle);
  if (!candles.every(validCandle)) return null;
  candles.sort((a, b) => a.openTimeMs - b.openTimeMs);
  const firstPostEntry = Math.ceil(entryAtMs / MINUTE_MS) * MINUTE_MS;
  const expectedLastClose = Math.floor(evaluationAtMs / MINUTE_MS) * MINUTE_MS - 1;
  if (candles[0].openTimeMs < firstPostEntry ||
      candles[1].openTimeMs - candles[0].openTimeMs !== MINUTE_MS ||
      candles[1].closeTimeMs !== expectedLastClose ||
      candles.some(candle => candle.closeTimeMs >= evaluationAtMs)) return null;
  return candles;
}

export function twoBearishDescending(candles) {
  return Array.isArray(candles) && candles.length === 2 &&
    candles.every(candle => candle.close < candle.open) &&
    candles[1].close < candles[0].close;
}

export function freshQuote(decision) {
  if (!decision || !finite(decision.bid)) return false;
  const bid = Number(decision.bid);
  const detected = Number(decision.detectedAtMs);
  const requested = Number(decision.quoteRequestedAtMs);
  const received = Number(decision.quoteReceivedAtMs);
  const book = Number(decision.exchangeBookAtMs);
  if (!(bid > 0) || ![detected, requested, received, book].every(Number.isSafeInteger)) return false;
  const roundTrip = received - requested;
  const bookAge = detected - book;
  const receiveAge = detected - received;
  return roundTrip >= 0 && roundTrip <= 1_000 &&
    bookAge >= 0 && bookAge <= 3_000 &&
    receiveAge >= 0 && receiveAge <= 1_000;
}

export function freshBidArmProof(decision, entryPrice) {
  return finite(entryPrice) && Number(entryPrice) > 0 && freshQuote(decision) &&
    Number(decision.bid) > Number(entryPrice) * (1 + FAVORABLE_ARM_RETURN);
}

function candidateUses(candidate, component) {
  if (!Object.values(CANDIDATES).includes(candidate)) throw new Error('UNKNOWN_CANDIDATE');
  return candidate === component || candidate === CANDIDATES.C3;
}

/**
 * Evaluate one position-management observation.
 *
 * State is position-bound and may only add a fresh-bid proof.  It never changes
 * stop, peak, quantity or order state.  The caller must route any qualifying
 * close through the existing idempotent/reduce-only production close path.
 */
export function evaluateCandidate({
  candidate,
  position,
  decision,
  completedCandles,
  baselineArmed = false,
  priorState = null,
}) {
  if (!position || !decision || position.ownership !== 'AUTO' || position.side !== 'LONG' ||
      position.state !== 'OPEN' || !Number.isSafeInteger(position.entryAtMs) ||
      !(Number(position.entryPrice) > 0)) {
    return {available: true, wouldClose: false, reason: 'PRESERVE_SCOPE', state: priorState};
  }
  const evaluationAtMs = Number(decision.evaluationAtMs ?? decision.detectedAtMs);
  const state = {
    candidate,
    positionId: position.id,
    entryAtMs: position.entryAtMs,
    entryPrice: Number(position.entryPrice),
    freshBidProof: null,
  };
  if (priorState) {
    if (priorState.candidate !== candidate || priorState.positionId !== position.id ||
        priorState.entryAtMs !== position.entryAtMs || priorState.entryPrice !== Number(position.entryPrice)) {
      return {available: false, wouldClose: false, reason: 'PRESERVE_STATE_MISMATCH', state: priorState};
    }
    state.freshBidProof = priorState.freshBidProof;
  }
  if (!state.freshBidProof && candidateUses(candidate, CANDIDATES.C2) &&
      freshBidArmProof(decision, position.entryPrice)) {
    state.freshBidProof = {
      observedAtMs: Number(decision.detectedAtMs),
      bid: Number(decision.bid),
    };
  }

  const tail = completedTail2(completedCandles, evaluationAtMs, position.entryAtMs);
  if (!tail) {
    return {available: false, wouldClose: false, reason: 'PRESERVE_CANDLE_UNAVAILABLE', state};
  }

  const bearishTwo = twoBearishDescending(tail);
  if (!bearishTwo) return {available: true, wouldClose: false, reason: 'CANDIDATE_HOLD', state};

  const belowEntry = tail.every(candle => candle.close < Number(position.entryPrice));
  const c1 = candidateUses(candidate, CANDIDATES.C1) && !baselineArmed && belowEntry;
  const c2 = candidateUses(candidate, CANDIDATES.C2) && (baselineArmed || Boolean(state.freshBidProof));
  if (c1) {
    return {available: true, wouldClose: true, reason: 'C1_EARLY_FAILURE_TWO_BEARISH', state, tail};
  }
  if (c2) {
    return {available: true, wouldClose: true, reason: 'C2_FRESH_BID_ARM_TWO_BEARISH', state, tail};
  }
  return {available: true, wouldClose: false, reason: 'CANDIDATE_HOLD', state};
}

export const CANDIDATE_CONSTANTS = Object.freeze({MINUTE_MS, FAVORABLE_ARM_RETURN});
