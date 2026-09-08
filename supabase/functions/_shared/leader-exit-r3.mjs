// Research/review policy. Pure decisions only: no network, orders, or activation.
export const R3_CANDIDATE = Object.freeze({
  policyVersion: 'V17_EXIT_R3_REVIEW', parametersValidatedByBacktest: false,
  softStopPct: 0.025, emergencyStopPct: 0.035,
  breakEvenArmPct: 0.005, profitLockArmPct: 0.02, profitLockFraction: 0.5,
  trailArmPct: 0.03, trailGapPct: 0.025,
  lossConfirmMs: 10000, profitConfirmMs: 10000,
  maxEvidenceGapMs: 3000, maxDataAgeMs: 3000,
  staleMs: 45 * 60000, maxHoldMs: 6 * 3600000,
  estimatedExitFeeRate: 0.0005, slippageBudgetRate: 0.001,
});

export function validateR3Policy(p) {
  const fractions = ['softStopPct','emergencyStopPct','breakEvenArmPct','profitLockArmPct',
    'profitLockFraction','trailArmPct','trailGapPct','estimatedExitFeeRate','slippageBudgetRate'];
  for (const k of fractions) if (!Number.isFinite(p[k]) || p[k] < 0 || p[k] >= 1) throw Error(`INVALID_POLICY:${k}`);
  for (const k of ['lossConfirmMs','profitConfirmMs','maxEvidenceGapMs','maxDataAgeMs','staleMs','maxHoldMs'])
    if (!Number.isFinite(p[k]) || p[k] < 0) throw Error(`INVALID_POLICY:${k}`);
  if (!(p.softStopPct > 0 && p.emergencyStopPct >= p.softStopPct && p.maxEvidenceGapMs > 0 &&
    p.staleMs > 0 && p.maxHoldMs > 0 && p.trailGapPct > 0 && p.trailArmPct > 0)) throw Error('INVALID_POLICY:ORDER');
  return p;
}

export function newR3State({positionId, entryPrice, entryAt, quantity, entryFee}, policy=R3_CANDIDATE) {
  const p=validateR3Policy(policy);
  if (!positionId || ![entryPrice,entryAt,quantity,entryFee].every(Number.isFinite) ||
      entryPrice <= 0 || quantity <= 0 || entryFee < 0 || entryAt < 0) throw Error('INVALID_ENTRY');
  // Fill = trigger*(1-slip); proceeds after exit fee must also recover the entry fee.
  const breakEvenPrice=(entryPrice + entryFee/quantity) /
    ((1-p.slippageBudgetRate)*(1-p.estimatedExitFeeRate));
  return {positionId, policyVersion:p.policyVersion, entryPrice, entryAt, quantity, entryFee,
    breakEvenPrice, peakPrice:entryPrice, lastHighAt:entryAt,
    stopPrice:entryPrice*(1-p.softStopPct), emergencyStopPrice:entryPrice*(1-p.emergencyStopPct),
    breachSince:null, lastEventAt:null, lastSequence:null, closed:false, exitReason:null,
    dataGapCount:0};
}

export function nextR3Exit(s, event, policy=R3_CANDIDATE) {
  const p=policy;
  if (s.policyVersion !== p.policyVersion) throw Error('POLICY_STATE_MISMATCH');
  if (s.closed) return {action:'CLOSED', reason:s.exitReason, state:s};
  const {price, at, receivedAt=at, sequence=null}=event;
  if (![price,at,receivedAt].every(Number.isFinite) || price<=0 || at<s.entryAt || receivedAt<at ||
      (sequence!==null && !Number.isSafeInteger(sequence))) throw Error('INVALID_MARKET_EVENT');
  if ((s.lastEventAt!==null && at<s.lastEventAt) ||
      (sequence!==null && s.lastSequence!==null && sequence<=s.lastSequence))
    return {action:'IGNORE',reason:'OUT_OF_ORDER_OR_DUPLICATE',state:s};
  if (receivedAt-at>p.maxDataAgeMs) return {action:'DATA_GAP', reason:'STALE_MARKET_DATA',
    state:{...s,breachSince:null,dataGapCount:s.dataGapCount+1}};
  const gap=s.lastEventAt!==null && at-s.lastEventAt>p.maxEvidenceGapMs;
  const peakPrice=Math.max(s.peakPrice,price), lastHighAt=price>s.peakPrice?at:s.lastHighAt;
  const mfe=peakPrice/s.entryPrice-1;
  let stopPrice=s.stopPrice;
  if (mfe>=p.breakEvenArmPct) stopPrice=Math.max(stopPrice,s.breakEvenPrice);
  if (mfe>=p.profitLockArmPct) stopPrice=Math.max(stopPrice,s.entryPrice+(peakPrice-s.entryPrice)*p.profitLockFraction);
  if (mfe>=p.trailArmPct) stopPrice=Math.max(stopPrice,peakPrice*(1-p.trailGapPct));
  const breachSince=price<=stopPrice ? (gap || s.breachSince===null ? at : s.breachSince) : null;
  const profitProtection=stopPrice>s.entryPrice*(1-p.softStopPct)+s.entryPrice*1e-12;
  const confirmMs=profitProtection?p.profitConfirmMs:p.lossConfirmMs;
  let reason=null;
  if (price<=s.emergencyStopPrice) reason='R3_EMERGENCY_STOP';
  else if (breachSince!==null && at-breachSince>=confirmMs)
    reason=profitProtection?'R3_CONFIRMED_PROFIT_PROTECTION':'R3_CONFIRMED_LOSS';
  else if (at-s.entryAt>=p.maxHoldMs) reason='R3_MAX_HOLD';
  else if (at-lastHighAt>=p.staleMs) reason='R3_MOMENTUM_STALE';
  const state={...s,peakPrice,lastHighAt,stopPrice,breachSince,lastEventAt:at,
    lastSequence:sequence??s.lastSequence,dataGapCount:s.dataGapCount+Number(gap),
    closed:reason!==null,exitReason:reason};
  // tactical stop is a confirmed software condition, NOT an immediate native stop.
  return {action:reason?'CLOSE':'HOLD',reason,state,observedMfe:mfe,priceReturn:price/s.entryPrice-1,
    emergencyStopPrice:s.emergencyStopPrice,tacticalStopPrice:stopPrice,
    confirmationElapsedMs:breachSince===null?0:at-breachSince};
}

// Restarts must retain peaks/stops. Unobserved time never counts as confirmation.
export function restoreR3State(saved, now) {
  if (!Number.isFinite(now) || now<saved.entryAt || (saved.lastEventAt!==null&&now<saved.lastEventAt))
    throw Error('INVALID_RESTORE_TIME');
  return {...saved,breachSince:null,lastEventAt:null};
}
