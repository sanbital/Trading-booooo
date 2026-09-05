// Trading-booooo v5.12 — outcome forecast contract and conservative order-time bridge.
//
// The long-term Champion is a calibrated multinomial barrier model plus separate timeout,
// fill and holding-time models. This module provides the concrete, versioned contract and
// a conservative bridge from the v5.11 calibrated conditional pWin while historical
// day/regime blocks are accumulated. It never emits an independent pNetPositive value:
// that probability is derived from the mutually-exclusive outcomes by candidate-gate.ts.

export type StrategyProfile = "LOB_SCALP" | "HF_SCALP" | "INTRADAY_SCALP";
export type ExpectedOrderType = "IOC_LIMIT" | "MARKET" | "POST_ONLY";

export interface FeatureVector {
  strategyProfile: StrategyProfile;
  exchange: string;
  symbol: string;
  generatedAtMs: number;
  timeOfDaySec: number;
  return1m: number;
  return5m: number;
  realizedVol1m: number;
  realizedVol5m: number;
  realizedVol15m: number;
  atrPct: number;
  spreadBps: number;
  microPriceDeviationBps: number;
  bookImbalanceL1: number;
  bookImbalanceL5: number;
  orderFlowImbalance: number;
  tradePressure1s: number;
  tradePressure5s: number;
  quoteUpdateRate: number;
  tradeArrivalRate: number;
  absorptionScore: number;
  depthAt10BpsQuote: number;
  requestedNotional: number;
  expectedOrderType: ExpectedOrderType;
  priceOffsetBps: number;
  bookAgeMs: number;
  signalAgeMs: number;
  targetPct: number;
  stopPct: number;
  maxHoldingMinutes: number;
  estimatedRoundTripFeeRate: number;
  estimatedSlippageRate: number;
  regimeBucket: string;
  volatilityBucket: string;
  liquidityBucket: string;
}

export interface ForecastScenario {
  pTarget: number;
  pStop: number;
  pTimeout: number;
  timeoutPositiveProbability: number;
  /** Net of entry, exit and slippage costs. */
  timeoutReturnNet: number;
  pFill: number;
  expectedHoldingMinutes: number;
}

export interface OutcomeForecast {
  point: ForecastScenario;
  uncertaintyScenarios: ForecastScenario[];
  effectiveSamples: number;
  independentBlocks: number;
  calibrationReady: boolean;
  modelVersion: string;
  calibrationVersion: string;
  labelSource: "ACTUAL_TRADE" | "SHADOW_REPLAY" | "MIXED" | "PRIOR";
  executionCostQuality: "ACTUAL" | "ESTIMATED" | "STRESSED";
  fillLabelQuality: "ACTUAL" | "SIMULATED" | "UNKNOWN";
}

export interface BridgeForecastInput {
  conditionalTargetProbability: number;
  resolveProbability: number;
  timeoutPositiveProbability?: number;
  timeoutReturnNet: number;
  expectedHoldingMinutes: number;
  expectedOrderType: ExpectedOrderType;
  depthCoverageRatio: number;
  spreadBps: number;
  bookImbalance: number;
  signalAgeMs: number;
  effectiveSamples: number;
  independentBlocks?: number;
  calibrationReady: boolean;
  modelVersion: string;
  calibrationVersion: string;
  labelSource?: OutcomeForecast["labelSource"];
  executionCostQuality?: OutcomeForecast["executionCostQuality"];
  fillLabelQuality?: OutcomeForecast["fillLabelQuality"];
}

function clamp(x: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : lo));
}

export function normalizeBarrierProbabilities(
  pTarget: number,
  pStop: number,
  pTimeout: number,
): Pick<ForecastScenario, "pTarget" | "pStop" | "pTimeout"> {
  const values = [pTarget, pStop, pTimeout].map((x) => clamp(x));
  const total = values[0] + values[1] + values[2];
  if (!(total > 0)) return { pTarget: 0, pStop: 0, pTimeout: 1 };
  return {
    pTarget: values[0] / total,
    pStop: values[1] / total,
    pTimeout: values[2] / total,
  };
}

/**
 * Conservative pFill estimate used until an exchange/order-type fill model is promoted.
 * It deliberately avoids assigning a cash loss to an unfilled order. The separate pFill
 * lower-bound gate carries the resource/throughput risk.
 */
export function estimateFillProbability(input: Pick<BridgeForecastInput,
  "expectedOrderType" | "depthCoverageRatio" | "spreadBps" | "bookImbalance" | "signalAgeMs"
>): number {
  const depth = clamp(input.depthCoverageRatio, 0, 2);
  const freshness = Math.exp(-Math.max(0, input.signalAgeMs) / 30_000);
  const spreadPenalty = clamp(Math.max(0, input.spreadBps - 2) / 40, 0, 0.35);
  if (input.expectedOrderType === "MARKET") {
    return clamp(0.985 - spreadPenalty * 0.08 - Math.max(0, 1 - depth) * 0.2, 0.55, 0.995);
  }
  if (input.expectedOrderType === "IOC_LIMIT") {
    return clamp(0.94 - spreadPenalty * 0.18 - Math.max(0, 1 - depth) * 0.35, 0.35, 0.98);
  }
  // POST_ONLY at the bid: queue position is unknown. Balanced books and fresh signals are
  // favoured, while a strongly bid-heavy book is penalised because the queue is likely long.
  const queuePenalty = Math.max(0, input.bookImbalance) * 0.16;
  return clamp(0.52 + 0.10 * freshness + 0.08 * Math.min(depth, 1) - spreadPenalty - queuePenalty, 0.18, 0.78);
}

function scenario(
  conditionalWin: number,
  resolve: number,
  timeoutPositive: number,
  timeoutReturnNet: number,
  pFill: number,
  holding: number,
): ForecastScenario {
  const p = normalizeBarrierProbabilities(
    clamp(conditionalWin) * clamp(resolve),
    (1 - clamp(conditionalWin)) * clamp(resolve),
    1 - clamp(resolve),
  );
  return {
    ...p,
    timeoutPositiveProbability: clamp(timeoutPositive),
    timeoutReturnNet: Number.isFinite(timeoutReturnNet) ? timeoutReturnNet : 0,
    pFill: clamp(pFill),
    expectedHoldingMinutes: Math.max(1, Number.isFinite(holding) ? holding : 1),
  };
}

/**
 * Builds a deterministic scenario ensemble around the promoted v5.11 conditional barrier
 * probability. This is intentionally conservative and version-labelled as a bridge, not a
 * trained Champion. Offline block-bootstrap forecasts can be supplied directly through the
 * OutcomeForecast interface without changing the gate.
 */
export function buildBridgeOutcomeForecast(input: BridgeForecastInput): OutcomeForecast {
  const pointFill = estimateFillProbability(input);
  const point = scenario(
    input.conditionalTargetProbability,
    input.resolveProbability,
    input.timeoutPositiveProbability ?? 0,
    input.timeoutReturnNet,
    pointFill,
    input.expectedHoldingMinutes,
  );

  const n = Math.max(0, Math.floor(input.effectiveSamples));
  // Thin samples receive a wider probability band. Even a large sample retains a floor to
  // account for day/regime correlation that a simple trade count misses.
  const winBand = Math.max(0.035, Math.min(0.16, 0.5 / Math.sqrt(Math.max(10, n))));
  const resolveBand = Math.max(0.04, Math.min(0.14, 0.45 / Math.sqrt(Math.max(10, n))));
  const fillBand = input.expectedOrderType === "POST_ONLY" ? 0.16 : 0.06;
  const holdBand = 0.25;
  const uncertaintyScenarios: ForecastScenario[] = [];
  for (const dw of [-winBand, 0, winBand]) {
    for (const dr of [-resolveBand, 0, resolveBand]) {
      for (const df of [-fillBand, 0, fillBand]) {
        // Adverse combinations are intentionally retained rather than assuming independent
        // normal errors. The lower quantile therefore sees weak win/resolve/fill together.
        uncertaintyScenarios.push(scenario(
          input.conditionalTargetProbability + dw,
          input.resolveProbability + dr,
          input.timeoutPositiveProbability ?? 0,
          input.timeoutReturnNet,
          pointFill + df,
          input.expectedHoldingMinutes * (1 + (dw < 0 || dr < 0 ? holdBand : -holdBand / 2)),
        ));
      }
    }
  }

  return {
    point,
    uncertaintyScenarios,
    effectiveSamples: n,
    independentBlocks: Math.max(0, Math.floor(input.independentBlocks ?? n / 20)),
    calibrationReady: Boolean(input.calibrationReady),
    modelVersion: input.modelVersion,
    calibrationVersion: input.calibrationVersion,
    labelSource: input.labelSource ?? (n > 0 ? "MIXED" : "PRIOR"),
    executionCostQuality: input.executionCostQuality ?? "STRESSED",
    fillLabelQuality: input.fillLabelQuality ?? "SIMULATED",
  };
}

export function validateOutcomeForecast(forecast: OutcomeForecast): string[] {
  const errors: string[] = [];
  const all = [forecast.point, ...forecast.uncertaintyScenarios];
  if (!forecast.uncertaintyScenarios.length) errors.push("NO_UNCERTAINTY_SCENARIOS");
  for (const [index, s] of all.entries()) {
    const sum = s.pTarget + s.pStop + s.pTimeout;
    if (Math.abs(sum - 1) > 1e-6) errors.push(`INVALID_PROBABILITY_SUM:${index}`);
    for (const [name, value] of Object.entries({
      pTarget: s.pTarget,
      pStop: s.pStop,
      pTimeout: s.pTimeout,
      timeoutPositiveProbability: s.timeoutPositiveProbability,
      pFill: s.pFill,
    })) {
      if (!Number.isFinite(value) || value < 0 || value > 1) errors.push(`INVALID_${name.toUpperCase()}:${index}`);
    }
    if (!Number.isFinite(s.timeoutReturnNet)) errors.push(`INVALID_TIMEOUT_RETURN:${index}`);
    if (!(s.expectedHoldingMinutes >= 1)) errors.push(`INVALID_HOLDING_TIME:${index}`);
  }
  return [...new Set(errors)];
}
