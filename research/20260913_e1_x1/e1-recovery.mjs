/**
 * E1 fast-weak recovery candidate.
 *
 * Pure research implementation: no network, database, timer, reservation, or order
 * side effects. Decimal returns are unleveraged price fractions. A host must re-run
 * the existing entry, ownership, cash/slot, and executable-liquidity guards before
 * dispatch. This module deliberately cannot dispatch an order.
 */

export const E1_POLICY = Object.freeze({
  policyVersion: 'E1_FAST_WEAK_RECOVERY_SHADOW_1',
  fastWeakReturnLt: -0.002,
  fastWeakBuyShareLt: 0.45,
  watchMs: 30_000,
  blockMs: 5_000,
  requiredConsecutiveBlocks: 2,
  minTradesPerBlock: 2,
  recoveryReturnGte: 0,
  recoveryBuyShareGte: 0.50,
  maxQuoteAgeMs: 1_000,
  parametersValidatedByBacktest: false,
  executionEnabled: false,
});

const finite = value => Number.isFinite(Number(value));
const n = value => Number(value);

function requireTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`INVALID_${label}`);
}

function validQuote(quote, at, maxAgeMs) {
  if (!quote || quote.bookGap !== false) return false;
  const bid = n(quote.bid), ask = n(quote.ask), receivedAt = n(quote.receivedAt);
  return bid > 0 && ask >= bid && Number.isSafeInteger(receivedAt) &&
    at - receivedAt >= 0 && at - receivedAt <= maxAgeMs;
}

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
    parametersValidatedByBacktest: false,
    executionEnabled: false,
    ...update,
  };
}

/** Strict inequalities intentionally match the preregistered decimal rule. */
export function isFastWeak(last10sReturn, takerBuyQuoteShare10s, policy = E1_POLICY) {
  if (!finite(last10sReturn) || !finite(takerBuyQuoteShare10s)) return null;
  const share = n(takerBuyQuoteShare10s);
  if (share < 0 || share > 1) return null;
  return n(last10sReturn) < policy.fastWeakReturnLt && share < policy.fastWeakBuyShareLt;
}

/**
 * Starts E1 only after the existing baseline eligibility decision.
 * Missing/stale/gapped microstructure never silently becomes a pass or a rejection.
 */
export function startE1(input, policy = E1_POLICY) {
  const {
    decisionAt, signalId, symbol, signalExpiresAt, baselineEligible,
    baselineReasonCodes = [], microstructure = {},
  } = input;
  requireTimestamp(decisionAt, 'DECISION_AT');
  requireTimestamp(signalExpiresAt, 'SIGNAL_EXPIRY');
  if (!signalId || !symbol || !Array.isArray(baselineReasonCodes)) throw new Error('INVALID_IDENTITY');

  const common = {
    decisionAt, signalId, symbol,
    featureAsOf: microstructure.featureAsOf ?? null,
    featureHash: microstructure.featureHash ?? null,
    sourceTier: microstructure.sourceTier ?? null,
    signalAgeMs: microstructure.signalAgeMs ?? null,
    quoteAgeMs: microstructure.quoteAgeMs ?? null,
    bookGap: microstructure.quote?.bookGap ?? null,
    evaluatedPrice: microstructure.quote?.ask ?? null,
    expectedEntryVWAP: microstructure.expectedEntryVWAP ?? null,
    expectedExitVWAP: microstructure.expectedExitVWAP ?? null,
    expectedCostBps: microstructure.expectedCostBps ?? null,
    expiresAt: signalExpiresAt,
  };

  if (baselineEligible !== true) {
    return decision({...common, confirmationState: 'BASELINE_INELIGIBLE'}, {
      reject: true,
      reasonCodes: baselineReasonCodes.length ? baselineReasonCodes : ['BASELINE_INELIGIBLE'],
    });
  }
  if (signalExpiresAt <= decisionAt) {
    return decision({...common, confirmationState: 'EXPIRED'}, {
      reject: true,
      reasonCodes: ['ORIGINAL_SIGNAL_EXPIRED'],
    });
  }

  const weak = isFastWeak(microstructure.last10sReturn, microstructure.takerBuyQuoteShare10s, policy);
  const quote = microstructure.quote;
  if (weak === null || !validQuote(quote, decisionAt, policy.maxQuoteAgeMs)) {
    return decision({...common, confirmationState: 'UNKNOWN'}, {
      defer: true,
      reasonCodes: [weak === null ? 'E1_TAPE_UNKNOWN' : 'E1_QUOTE_UNKNOWN'],
    });
  }
  if (!weak) {
    return decision({...common, confirmationState: 'BASELINE_ELIGIBLE'}, {
      allowed: true,
      reasonCodes: ['E1_NOT_FAST_WEAK'],
    });
  }

  const deadline = Math.min(decisionAt + policy.watchMs, signalExpiresAt);
  return decision({...common, confirmationState: 'WATCH_FAST_WEAK', expiresAt: deadline}, {
    defer: true,
    reasonCodes: ['E1_FAST_WEAK_WATCH'],
    watch: {
      t0: decisionAt,
      t0Mid: (n(quote.bid) + n(quote.ask)) / 2,
      deadline,
      lastBlockEndAt: null,
      passedBlocks: [],
      observedBlocks: 0,
    },
  });
}

function aggregateBlock(block, policy) {
  const startAt = n(block?.startAt), endAt = n(block?.endAt);
  if (!Number.isSafeInteger(startAt) || !Number.isSafeInteger(endAt) ||
      endAt - startAt !== policy.blockMs || !Array.isArray(block?.trades)) return null;
  const seen = new Set(), trades = [];
  for (const raw of block.trades) {
    const eventAt = n(raw.eventAt), price = n(raw.price);
    const quote = finite(raw.quote) ? n(raw.quote) : n(raw.quantity) * price;
    const takerBuy = typeof raw.takerBuy === 'boolean' ? raw.takerBuy :
      (typeof raw.buyerIsMaker === 'boolean' ? !raw.buyerIsMaker : null);
    const id = raw.tradeId == null ? `${eventAt}:${price}:${quote}:${takerBuy}` : String(raw.tradeId);
    if (!Number.isSafeInteger(eventAt) || eventAt < startAt || eventAt >= endAt ||
        !(price > 0) || !(quote > 0) || takerBuy === null) return null;
    if (seen.has(id)) continue;
    seen.add(id);
    trades.push({eventAt, price, quote, takerBuy, id});
  }
  trades.sort((a, b) => a.eventAt - b.eventAt || a.id.localeCompare(b.id));
  if (trades.length < policy.minTradesPerBlock) return null;
  const total = trades.reduce((sum, trade) => sum + trade.quote, 0);
  const buy = trades.reduce((sum, trade) => sum + (trade.takerBuy ? trade.quote : 0), 0);
  if (!(total > 0)) return null;
  return {
    startAt, endAt, tradeCount: trades.length,
    return: trades.at(-1).price / trades[0].price - 1,
    buyShare: buy / total,
  };
}

/**
 * Consumes at most one new completed, t0-aligned, non-overlapping five-second block.
 * Confirmation always carries the CURRENT price/VWAP and the original expiry.
 */
export function advanceE1(previous, observation, policy = E1_POLICY) {
  if (previous?.confirmationState !== 'WATCH_FAST_WEAK' || !previous.watch)
    throw new Error('E1_NOT_WATCHING');
  const observedAt = n(observation?.observedAt);
  requireTimestamp(observedAt, 'OBSERVED_AT');
  const watch = previous.watch;

  if (observedAt >= watch.deadline) {
    return decision({...previous, decisionAt: observedAt, confirmationState: 'EXPIRED'}, {
      defer: false,
      reject: true,
      reasonCodes: ['E1_RECOVERY_DEADLINE'],
      watch,
    });
  }

  const block = aggregateBlock(observation.block, policy);
  const aligned = block && block.startAt >= watch.t0 && block.endAt <= observedAt &&
    (block.startAt - watch.t0) % policy.blockMs === 0;
  const currentQuoteOk = validQuote(observation.quote, observedAt, policy.maxQuoteAgeMs);
  if (!aligned || !validQuote(observation.block?.quote, block?.endAt, policy.maxQuoteAgeMs) || !currentQuoteOk) {
    return decision({...previous, decisionAt: observedAt}, {
      defer: true,
      reasonCodes: ['E1_BLOCK_OR_QUOTE_UNKNOWN'],
      quoteAgeMs: finite(observation?.quote?.receivedAt) ? observedAt - n(observation.quote.receivedAt) : null,
      bookGap: observation?.quote?.bookGap ?? null,
      watch,
    });
  }
  if (watch.lastBlockEndAt !== null && block.endAt <= watch.lastBlockEndAt) {
    return decision({...previous, decisionAt: observedAt}, {
      defer: true,
      reasonCodes: ['E1_DUPLICATE_BLOCK_IGNORED'],
      watch,
    });
  }

  const contiguous = watch.lastBlockEndAt === null || block.startAt === watch.lastBlockEndAt;
  const pass = block.return >= policy.recoveryReturnGte && block.buyShare >= policy.recoveryBuyShareGte;
  const passedBlocks = contiguous && pass ? [...watch.passedBlocks, block].slice(-policy.requiredConsecutiveBlocks) :
    (pass ? [block] : []);
  const nextWatch = {
    ...watch,
    lastBlockEndAt: block.endAt,
    passedBlocks,
    observedBlocks: watch.observedBlocks + 1,
  };
  const twoPass = passedBlocks.length === policy.requiredConsecutiveBlocks &&
    passedBlocks.every((candidate, index) => index === 0 || candidate.startAt === passedBlocks[index - 1].endAt);
  const currentMid = (n(observation.quote.bid) + n(observation.quote.ask)) / 2;
  const guardsPass = observation.entryGuardPassed === true && observation.liquidityPassed === true;
  const economicsKnown = [observation.expectedEntryVWAP, observation.expectedExitVWAP,
    observation.expectedCostBps].every(finite);

  if (twoPass && currentMid >= watch.t0Mid && guardsPass && economicsKnown) {
    return decision({...previous, decisionAt: observedAt, confirmationState: 'RECOVERY_CONFIRMED'}, {
      allowed: true,
      defer: false,
      reasonCodes: ['E1_TWO_BLOCK_RECOVERY'],
      quoteAgeMs: observedAt - n(observation.quote.receivedAt),
      bookGap: false,
      evaluatedPrice: n(observation.quote.ask),
      expectedEntryVWAP: n(observation.expectedEntryVWAP),
      expectedExitVWAP: n(observation.expectedExitVWAP),
      expectedCostBps: n(observation.expectedCostBps),
      expiresAt: watch.deadline,
      watch: nextWatch,
    });
  }

  const reasons = [];
  if (!twoPass) reasons.push('E1_RECOVERY_SEQUENCE_INCOMPLETE');
  if (twoPass && currentMid < watch.t0Mid) reasons.push('E1_MID_NOT_RECOVERED');
  if (twoPass && !guardsPass) reasons.push('E1_GUARD_RECHECK_FAILED');
  if (twoPass && !economicsKnown) reasons.push('E1_EXECUTABLE_COST_UNKNOWN');
  return decision({...previous, decisionAt: observedAt}, {
    defer: true,
    reasonCodes: reasons,
    quoteAgeMs: observedAt - n(observation.quote.receivedAt),
    bookGap: false,
    evaluatedPrice: n(observation.quote.ask),
    expectedEntryVWAP: finite(observation.expectedEntryVWAP) ? n(observation.expectedEntryVWAP) : null,
    expectedExitVWAP: finite(observation.expectedExitVWAP) ? n(observation.expectedExitVWAP) : null,
    expectedCostBps: finite(observation.expectedCostBps) ? n(observation.expectedCostBps) : null,
    watch: nextWatch,
  });
}
