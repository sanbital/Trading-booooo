/**
 * E1 decision primitives and Binance USD-M aggregate-trade reader.
 *
 * E1 is an operator-forced, unvalidated execution policy.  The functions in this
 * module never submit an order.  They make missing, stale, truncated, or malformed
 * microstructure explicit so the executor can defer instead of silently treating a
 * data outage as a pass.
 */

export const E1_POLICY = Object.freeze({
  policyVersion: 'E1_FAST_WEAK_RECOVERY_OVERRIDE_1',
  fastWeakReturnLt: -0.002,
  fastWeakBuyShareLt: 0.45,
  watchMs: 30_000,
  blockMs: 5_000,
  requiredConsecutiveBlocks: 2,
  minTradesPerBlock: 2,
  recoveryReturnGte: 0,
  recoveryBuyShareGte: 0.50,
  maxQuoteAgeMs: 1_000,
  aggregateTradeLimit: 1_000,
  parametersValidatedByBacktest: false,
  activationBasis: 'OPERATOR_OVERRIDE_UNVALIDATED',
});

const finite = value => Number.isFinite(Number(value));
const n = value => Number(value);

function decision(core, update = {}) {
  return {
    allowed: false,
    defer: false,
    reject: false,
    reasonCodes: [],
    decisionAt: core.decisionAt,
    signalId: core.signalId,
    symbol: core.symbol,
    policyVersion: E1_POLICY.policyVersion,
    featureAsOf: core.featureAsOf ?? null,
    featureHash: core.featureHash ?? null,
    sourceTier: core.sourceTier ?? null,
    signalAgeMs: core.signalAgeMs ?? null,
    quoteAgeMs: core.quoteAgeMs ?? null,
    bookGap: core.bookGap ?? null,
    evaluatedPrice: core.evaluatedPrice ?? null,
    expectedEntryVWAP: core.expectedEntryVWAP ?? null,
    expectedExitVWAP: core.expectedExitVWAP ?? null,
    expectedCostBps: core.expectedCostBps ?? null,
    confirmationState: core.confirmationState,
    expiresAt: core.expiresAt ?? null,
    rawHashes: core.rawHashes ?? [],
    observations: core.observations ?? [],
    parametersValidatedByBacktest: false,
    activationBasis: E1_POLICY.activationBasis,
    executionEnabled: true,
    ...update,
  };
}

function quoteValid(quote, at, policy = E1_POLICY) {
  const bid = n(quote?.bid), ask = n(quote?.ask), receivedAt = n(quote?.receivedAt);
  return bid > 0 && ask >= bid && quote?.bookGap === false &&
    Number.isSafeInteger(receivedAt) && at - receivedAt >= 0 &&
    at - receivedAt <= policy.maxQuoteAgeMs;
}

/** Strict decimal inequalities from the preregistration. */
export function isFastWeak(last10sReturn, takerBuyQuoteShare10s, policy = E1_POLICY) {
  if (!finite(last10sReturn) || !finite(takerBuyQuoteShare10s)) return null;
  const share = n(takerBuyQuoteShare10s);
  if (share < 0 || share > 1) return null;
  return n(last10sReturn) < policy.fastWeakReturnLt && share < policy.fastWeakBuyShareLt;
}

/**
 * Aggregate Binance aggTrades over one exact half-open interval.  `m=true` means the
 * buyer was maker, therefore the aggressive side was SELL.
 */
export function aggregateAggTrades(rows, startAt, endAt, policy = E1_POLICY) {
  if (!Number.isSafeInteger(startAt) || !Number.isSafeInteger(endAt) || endAt <= startAt ||
      !Array.isArray(rows)) return {available: false, reason: 'E1_TAPE_INVALID'};
  if (rows.length >= policy.aggregateTradeLimit)
    return {available: false, reason: 'E1_TAPE_TRUNCATED', rowCount: rows.length};
  const seen = new Set(), trades = [];
  for (const row of rows) {
    const id = row?.a ?? row?.id, eventAt = n(row?.T ?? row?.time),
      price = n(row?.p ?? row?.price), quantity = n(row?.q ?? row?.qty),
      buyerIsMaker = row?.m ?? row?.isBuyerMaker;
    if (id == null || !Number.isSafeInteger(eventAt) || !(price > 0) || !(quantity > 0) ||
        typeof buyerIsMaker !== 'boolean') return {available: false, reason: 'E1_TAPE_ROW_INVALID'};
    // Binance documents startTime/endTime as inclusive. The request uses endAt - 1,
    // but preserve this guard so an upstream boundary change cannot contaminate blocks.
    if (eventAt < startAt || eventAt >= endAt) continue;
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    trades.push({tradeId: key, eventAt, price, quantity, quote: price * quantity,
      takerBuy: buyerIsMaker === false});
  }
  trades.sort((a, b) => a.eventAt - b.eventAt || a.tradeId.localeCompare(b.tradeId));
  if (!trades.length) return {available: false, reason: 'E1_TAPE_EMPTY', tradeCount: 0};
  const totalQuote = trades.reduce((sum, trade) => sum + trade.quote, 0),
    buyQuote = trades.reduce((sum, trade) => sum + (trade.takerBuy ? trade.quote : 0), 0);
  if (!(totalQuote > 0)) return {available: false, reason: 'E1_TAPE_ZERO_QUOTE'};
  return {available: true, source: 'BINANCE_FUTURES_AGGTRADES_REST', startAt, endAt,
    tradeCount: trades.length, firstTradeAt: trades[0].eventAt,
    lastTradeAt: trades.at(-1).eventAt, firstPrice: trades[0].price,
    lastPrice: trades.at(-1).price, last10sReturn: trades.at(-1).price / trades[0].price - 1,
    takerBuyQuoteShare: buyQuote / totalQuote, totalQuote, buyQuote, trades};
}

export function depthVwap(levels, quantity) {
  if (!Array.isArray(levels) || !(n(quantity) > 0)) return null;
  let remaining = n(quantity), quote = 0;
  for (const level of levels) {
    const price = n(level?.price ?? level?.[0]), size = n(level?.size ?? level?.[1]);
    if (!(price > 0) || !(size >= 0)) return null;
    const take = Math.min(remaining, size);
    quote += take * price;
    remaining -= take;
    if (remaining <= Math.max(1e-12, n(quantity) * 1e-10)) return quote / n(quantity);
  }
  return null;
}

/** Convert the gateway's independent REST depth snapshot to E1 evidence. */
export function e1QuoteEvidence(raw, quantity, at, feeRate = 0.0005, policy = E1_POLICY) {
  const bid = n(raw?.best_bid), ask = n(raw?.best_ask), receivedAt = n(raw?.timing?.received_at_ms),
    entryVwap = depthVwap(raw?.asks, quantity), exitVwap = depthVwap(raw?.bids, quantity);
  const quote = {bid, ask, receivedAt, bookGap: false, bookMode: 'INDEPENDENT_REST_SNAPSHOT',
    sequenceState: 'NOT_APPLICABLE_TO_SNAPSHOT'};
  const valid = quoteValid(quote, at, policy), fullDepth = entryVwap > 0 && exitVwap > 0;
  const expectedCostBps = fullDepth && feeRate >= 0 && feeRate < 1
    ? (entryVwap * (1 + feeRate) / (exitVwap * (1 - feeRate)) - 1) * 10_000 : null;
  return {...quote, valid, fullDepth, expectedEntryVWAP: entryVwap,
    expectedExitVWAP: exitVwap, expectedCostBps,
    quoteAgeMs: Number.isSafeInteger(receivedAt) ? at - receivedAt : null,
    sourceTier: 'RECEIVED_REST_L2_100'};
}

export function startE1(input, policy = E1_POLICY) {
  const {decisionAt, signalId, symbol, signalExpiresAt, baselineEligible,
    baselineReasonCodes = [], tape, quote, featureAsOf = null, featureHash = null,
    rawHash = null} = input;
  if (!Number.isSafeInteger(decisionAt) || !Number.isSafeInteger(signalExpiresAt) ||
      !signalId || !symbol) throw Error('E1_INVALID_IDENTITY');
  const common = {decisionAt, signalId, symbol, featureAsOf, featureHash,
    sourceTier: quote?.sourceTier ?? null, signalAgeMs: featureAsOf == null ? null : decisionAt-featureAsOf,
    quoteAgeMs: quote?.quoteAgeMs ?? null, bookGap: quote?.bookGap ?? null,
    evaluatedPrice: quote?.ask ?? null, expectedEntryVWAP: quote?.expectedEntryVWAP ?? null,
    expectedExitVWAP: quote?.expectedExitVWAP ?? null, expectedCostBps: quote?.expectedCostBps ?? null,
    expiresAt: signalExpiresAt, rawHashes: rawHash ? [rawHash] : [], observations: []};
  if (baselineEligible !== true) return decision({...common, confirmationState: 'BASELINE_INELIGIBLE'},
    {reject: true, reasonCodes: baselineReasonCodes.length ? baselineReasonCodes : ['BASELINE_INELIGIBLE']});
  if (signalExpiresAt <= decisionAt) return decision({...common, confirmationState: 'EXPIRED'},
    {reject: true, reasonCodes: ['ORIGINAL_SIGNAL_EXPIRED']});
  if (!tape?.available || !quoteValid(quote, decisionAt, policy))
    return decision({...common, confirmationState: 'UNKNOWN'}, {defer: true,
      reasonCodes: [!tape?.available ? tape?.reason ?? 'E1_TAPE_UNKNOWN' : 'E1_QUOTE_UNKNOWN']});
  const weak = isFastWeak(tape.last10sReturn, tape.takerBuyQuoteShare, policy);
  const observation = {startAt: tape.startAt, endAt: tape.endAt, tradeCount: tape.tradeCount,
    return: tape.last10sReturn, buyShare: tape.takerBuyQuoteShare, quoteReceivedAt: quote.receivedAt};
  if (weak !== true) return decision({...common, confirmationState: 'BASELINE_ELIGIBLE',
    observations: [observation]}, {allowed: true, reasonCodes: ['E1_NOT_FAST_WEAK']});
  const deadline = Math.min(signalExpiresAt, decisionAt + policy.watchMs);
  return decision({...common, confirmationState: 'WATCH_FAST_WEAK', expiresAt: deadline,
    observations: [observation]}, {defer: true, reasonCodes: ['E1_FAST_WEAK_WATCH'],
    watch: {t0: decisionAt, t0Mid: (n(quote.bid)+n(quote.ask))/2, deadline,
      nextBlockStartAt: decisionAt, consecutivePasses: 0, observedBlocks: 0}});
}

export function advanceE1(previous, input, policy = E1_POLICY) {
  if (previous?.confirmationState !== 'WATCH_FAST_WEAK' || !previous.watch)
    throw Error('E1_NOT_WATCHING');
  const {observedAt, tape, quote, entryGuardPassed, liquidityPassed, rawHash = null} = input;
  if (!Number.isSafeInteger(observedAt)) throw Error('E1_INVALID_OBSERVATION_TIME');
  if (observedAt >= previous.watch.deadline) return decision({...previous, decisionAt: observedAt,
    confirmationState: 'EXPIRED'}, {reject: true, defer: false,
      reasonCodes: ['E1_RECOVERY_DEADLINE']});
  const expectedStart = previous.watch.nextBlockStartAt,
    exact = tape?.available && tape.startAt === expectedStart && tape.endAt === expectedStart + policy.blockMs,
    enough = exact && tape.tradeCount >= policy.minTradesPerBlock,
    freshQuote = quoteValid(quote, observedAt, policy);
  const observed = {startAt: tape?.startAt ?? expectedStart, endAt: tape?.endAt ?? expectedStart+policy.blockMs,
    tradeCount: tape?.tradeCount ?? 0, return: tape?.last10sReturn ?? null,
    buyShare: tape?.takerBuyQuoteShare ?? null, available: tape?.available === true,
    reason: tape?.reason ?? null, quoteReceivedAt: quote?.receivedAt ?? null};
  const rawHashes = rawHash ? [...previous.rawHashes, rawHash] : previous.rawHashes;
  if (!enough || !freshQuote) {
    const watch = {...previous.watch, nextBlockStartAt: expectedStart + policy.blockMs,
      consecutivePasses: 0, observedBlocks: previous.watch.observedBlocks + 1};
    return decision({...previous, decisionAt: observedAt, rawHashes,
      observations: [...previous.observations, observed]}, {defer: true,
      reasonCodes: [!enough ? tape?.reason ?? 'E1_BLOCK_UNKNOWN' : 'E1_QUOTE_UNKNOWN'], watch});
  }
  const pass = tape.last10sReturn >= policy.recoveryReturnGte &&
    tape.takerBuyQuoteShare >= policy.recoveryBuyShareGte;
  const consecutivePasses = pass ? previous.watch.consecutivePasses + 1 : 0;
  const watch = {...previous.watch, nextBlockStartAt: expectedStart + policy.blockMs,
    consecutivePasses, observedBlocks: previous.watch.observedBlocks + 1};
  const currentMid = (n(quote.bid)+n(quote.ask))/2,
    economicsKnown = [quote.expectedEntryVWAP,quote.expectedExitVWAP,quote.expectedCostBps].every(finite),
    confirmed = consecutivePasses >= policy.requiredConsecutiveBlocks && currentMid >= previous.watch.t0Mid &&
      entryGuardPassed === true && liquidityPassed === true && economicsKnown;
  if (confirmed) return decision({...previous, decisionAt: observedAt,
    confirmationState: 'RECOVERY_CONFIRMED', quoteAgeMs: quote.quoteAgeMs,
    evaluatedPrice: quote.ask, expectedEntryVWAP: quote.expectedEntryVWAP,
    expectedExitVWAP: quote.expectedExitVWAP, expectedCostBps: quote.expectedCostBps,
    rawHashes, observations: [...previous.observations, observed]}, {allowed: true, defer: false,
      reasonCodes: ['E1_TWO_BLOCK_RECOVERY'], watch});
  return decision({...previous, decisionAt: observedAt, rawHashes,
    observations: [...previous.observations, observed]}, {defer: true,
      reasonCodes: [pass ? currentMid < previous.watch.t0Mid ? 'E1_MID_NOT_RECOVERED' :
        'E1_RECOVERY_GUARD_PENDING' : 'E1_RECOVERY_BLOCK_FAILED'], watch});
}

export async function fetchE1AggTrades(symbol, startAt, endAt,
  {fetchImpl = fetch, timeoutMs = 1_800, policy = E1_POLICY} = {}) {
  if (!Number.isSafeInteger(startAt) || !Number.isSafeInteger(endAt) || endAt <= startAt)
    return {available: false, reason: 'E1_TAPE_RANGE_INVALID'};
  const requestedAt = Date.now(), controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL('https://fapi.binance.com/fapi/v1/aggTrades');
    url.searchParams.set('symbol', String(symbol).toUpperCase());
    url.searchParams.set('startTime', String(startAt));
    url.searchParams.set('endTime', String(endAt - 1));
    url.searchParams.set('limit', String(policy.aggregateTradeLimit));
    const response = await fetchImpl(url, {signal: controller.signal, headers: {'accept': 'application/json'}});
    if (!response.ok) return {available: false, reason: `E1_TAPE_HTTP_${response.status}`,
      requestedAt, receivedAt: Date.now()};
    const raw = await response.json(), receivedAt = Date.now(), aggregate = aggregateAggTrades(raw,startAt,endAt,policy);
    return {...aggregate, requestedAt, receivedAt, raw};
  } catch (error) {
    return {available: false, reason: `E1_TAPE_FETCH:${String(error?.message ?? error)}`,
      requestedAt, receivedAt: Date.now()};
  } finally { clearTimeout(timer); }
}
