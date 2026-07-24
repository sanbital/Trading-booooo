import type { FinalCandidate, RiskConfig, TargetStrategy } from "./engine.ts";

export type Exchange = "upbit" | "binance";
export type ExitPolicy = "FIXED_T1" | "SCALE_OUT" | "TRAIL_AFTER_T1";

export type LearningParameters = {
  scoreThreshold: number;
  minNetRR: number;
  shortTargetAtrMult: number;
  stopAtrMult: number;
  mediumTargetAtr4hMult: number;
  mediumTargetAtrDayMult: number;
  minStructuralHeadroomNetPct: number;
  minCostMultiple: number;
  minTradePressure: number;
  maxNegativeBookImbalance: number;
  minDepthCoverage: number;
  maxSlippageBps: number;
  maxSpreadBps: number;
  stopMinAtr4hMult: number;
  stopMinAtr15mMult: number;
  firstTargetAllocationPct: number;
  exitPolicy: ExitPolicy;
};

export type RuntimeProfile = {
  version: number;
  source: "CODE_DEFAULT" | "FORWARD_AUTO" | "FORWARD_ROLLBACK";
  parameters: LearningParameters;
  samples: number;
  validationSamples: number;
  objective: number;
  promotedAt: string | null;
  parentVersion: number | null;
};

export type StoredCandidate = {
  id: string;
  scan_id: string;
  exchange: Exchange;
  market: string;
  created_at: string;
  decision: "BUY" | "WAIT" | "AVOID";
  score: number;
  period_score: number;
  entry_low: number | null;
  entry_high: number | null;
  stop_price: number | null;
  target_1: number | null;
  target_2: number | null;
  net_rr: number | null;
  estimated_cost_pct: number | null;
  intended_horizon_hours: number;
  active_policy_key: string;
  profile_version: number;
  feature_vector: Record<string, unknown>;
  applied_parameters: Partial<LearningParameters>;
  snapshot: Record<string, unknown>;
};

export type Bar = { t: number; o: number; h: number; l: number; c: number };

export type PolicyOutcome = {
  policy_key: string;
  entered: boolean;
  entry_price: number | null;
  entry_time: string | null;
  exit_price: number | null;
  exit_time: string | null;
  outcome: string;
  net_return_pct: number;
  mfe_pct: number;
  mae_pct: number;
  peak_capture_ratio: number | null;
  target_1_hit: boolean;
  target_2_hit: boolean;
  stop_first: boolean;
  post_stop_mfe_pct: number;
};

export type HorizonOutcome = {
  candidate_id: string;
  horizon_hours: number;
  is_final: boolean;
  evaluated_until: string;
  active_policy_key: string;
  active_outcome: PolicyOutcome;
  policy_outcomes: Record<string, PolicyOutcome>;
  optimal_policy_key: string | null;
  optimal_net_return_pct: number;
  failure_causes: Array<{ code: string; severity: "INFO" | "WARNING" | "CRITICAL"; evidence: string }>;
};

type LearningRow = {
  id: string;
  created_at: string;
  market: string;
  exchange: Exchange;
  decision: string;
  profile_version: number;
  period_score: number;
  net_rr: number;
  feature_vector: Record<string, unknown>;
  active_policy_key: string;
  policy_outcomes: Record<string, PolicyOutcome>;
};

export type Metrics = {
  value: number;
  n: number;
  expectancy: number;
  profitFactor: number;
  maxDrawdown: number;
  equity: number;
  winRate: number;
  capture: number;
  tailLoss: number;
  marketConcentration: number;
};

const CHECKPOINTS = [24, 72, 168, 480] as const;
const FINAL_MIN_SAMPLES = 120;
const FINAL_MIN_VALIDATION = 40;
const FINAL_MIN_SELECTED = 30;
const MAX_FORWARD_ROWS = 5000;
const MAX_RECONCILE_BATCH = 120;
const RECONCILE_CONCURRENCY = 4;

function env(name: string): string {
  return (Deno.env.get(name) || "").trim();
}

function configured(): boolean {
  return Boolean(env("SUPABASE_URL") && env("SUPABASE_SERVICE_ROLE_KEY"));
}

function headers(extra: Record<string, string> = {}): HeadersInit {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${env("SUPABASE_URL")}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers || {}) },
  });
  if (!response.ok) {
    throw new Error(`forward store ${response.status}: ${await response.text()}`);
  }
  return response;
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Number.isFinite(value) ? value : low));
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function median(values: number[]): number {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return 0;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

function quantile(values: number[], p: number): number {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return 0;
  return clean[Math.min(clean.length - 1, Math.floor((clean.length - 1) * clamp(p, 0, 1)))];
}

function withDefaults(parameters: Partial<LearningParameters>, defaults: LearningParameters): LearningParameters {
  return { ...defaults, ...parameters };
}

export async function loadRuntimeProfile(defaults: LearningParameters): Promise<RuntimeProfile> {
  if (!configured()) {
    return {
      version: 0,
      source: "CODE_DEFAULT",
      parameters: defaults,
      samples: 0,
      validationSamples: 0,
      objective: 0,
      promotedAt: null,
      parentVersion: null,
    };
  }
  try {
    const rows = await (await rest(
      "scanner_runtime_profiles?active=eq.true&select=*&order=version.desc&limit=1",
    )).json();
    const row = rows?.[0];
    if (!row?.parameters) throw new Error("no active profile");
    return {
      version: Number(row.version),
      source: row.source === "FORWARD_ROLLBACK" ? "FORWARD_ROLLBACK" : "FORWARD_AUTO",
      parameters: withDefaults(row.parameters, defaults),
      samples: Number(row.samples || 0),
      validationSamples: Number(row.validation_samples || 0),
      objective: Number(row.objective || 0),
      promotedAt: row.promoted_at || null,
      parentVersion: row.parent_version == null ? null : Number(row.parent_version),
    };
  } catch {
    return {
      version: 0,
      source: "CODE_DEFAULT",
      parameters: defaults,
      samples: 0,
      validationSamples: 0,
      objective: 0,
      promotedAt: null,
      parentVersion: null,
    };
  }
}

/**
 * Weekly walk-forward parameters are the hard safety floor. Forward learning may
 * tighten filters or make bounded target/stop refinements, but can never loosen
 * score/RR/microstructure safety below the weekly code profile.
 */
export function applyRuntimeRisk(
  risk: RiskConfig,
  profile: RuntimeProfile,
  weekly: LearningParameters,
): RiskConfig {
  const forward = profile.parameters;
  return {
    ...risk,
    scoreThreshold: Math.max(risk.scoreThreshold ?? weekly.scoreThreshold, weekly.scoreThreshold, forward.scoreThreshold),
    minNetRR: Math.max(risk.minNetRR, weekly.minNetRR, forward.minNetRR),
    shortTargetAtrMult: clamp(
      forward.shortTargetAtrMult,
      weekly.shortTargetAtrMult * 0.9,
      weekly.shortTargetAtrMult * 1.1,
    ),
    stopAtrMult: clamp(
      forward.stopAtrMult,
      weekly.stopAtrMult * 0.95,
      weekly.stopAtrMult * 1.1,
    ),
    mediumTargetAtr4hMult: clamp(
      forward.mediumTargetAtr4hMult,
      weekly.mediumTargetAtr4hMult * 0.9,
      weekly.mediumTargetAtr4hMult * 1.1,
    ),
    mediumTargetAtrDayMult: clamp(
      forward.mediumTargetAtrDayMult,
      weekly.mediumTargetAtrDayMult * 0.9,
      weekly.mediumTargetAtrDayMult * 1.1,
    ),
    minStructuralHeadroomNetPct: Math.max(
      weekly.minStructuralHeadroomNetPct,
      forward.minStructuralHeadroomNetPct,
    ),
    minCostMultiple: Math.max(weekly.minCostMultiple, forward.minCostMultiple),
    minTradePressure: Math.max(weekly.minTradePressure, forward.minTradePressure),
    maxNegativeBookImbalance: Math.max(
      weekly.maxNegativeBookImbalance,
      forward.maxNegativeBookImbalance,
    ),
    minDepthCoverage: Math.max(weekly.minDepthCoverage, forward.minDepthCoverage),
    maxSlippageBps: Math.min(weekly.maxSlippageBps, forward.maxSlippageBps),
    maxSpreadBps: Math.min(weekly.maxSpreadBps, forward.maxSpreadBps),
    stopMinAtr4hMult: Math.max(weekly.stopMinAtr4hMult, forward.stopMinAtr4hMult),
    stopMinAtr15mMult: Math.max(weekly.stopMinAtr15mMult, forward.stopMinAtr15mMult),
    firstTargetAllocationPct: clamp(forward.firstTargetAllocationPct, 50, 80),
    exitPolicy: forward.exitPolicy,
  };
}

function featureVector(candidate: FinalCandidate, risk: RiskConfig): Record<string, unknown> {
  return {
    period_score: candidate.period_score,
    composite_score: candidate.score,
    net_rr: candidate.trade_plan.net_rr,
    structural_headroom_net_pct: candidate.trade_plan.structural_headroom_net_pct,
    estimated_cost_pct: candidate.trade_plan.estimated_round_trip_cost_pct,
    spread_bps: candidate.microstructure.spread_bps,
    slippage_bps: candidate.trade_plan.estimated_entry_slippage_bps,
    depth_coverage: candidate.trade_plan.depth_coverage_ratio,
    trade_pressure: candidate.microstructure.trade_pressure,
    book_imbalance: candidate.microstructure.book_imbalance,
    average_trade_notional: candidate.microstructure.average_trade_notional,
    assumed_order_notional: candidate.trade_plan.assumed_order_notional_quote,
    average_trade_to_order_ratio: candidate.trade_plan.assumed_order_notional_quote > 0
      ? candidate.microstructure.average_trade_notional / candidate.trade_plan.assumed_order_notional_quote
      : 0,
    atr15: candidate.timeframes.m15.atr14,
    atr4h: candidate.timeframes.h4.atr14,
    atr_day: candidate.timeframes.day.atr14,
    event_status: candidate.event_risk.status,
    dynamic_status: candidate.microstructure.dynamic.status,
    horizon_code: candidate.horizon.code,
    intended_horizon_hours: candidate.horizon.intended_holding_hours,
    low_touch_compatible: candidate.execution_plan.low_touch_compatible,
    failed_gates: candidate.failed_gates,
    quote_currency: candidate.quote_currency,
    turnover_24h_quote: candidate.turnover_24h_quote,
    target_strategy: candidate.trade_plan.target_strategy,
    first_target_allocation_pct: candidate.trade_plan.first_target_allocation_pct,
    max_holding_hours: candidate.execution_plan.max_holding_hours,
    risk_snapshot: risk,
  };
}

function candidateRows(
  scanId: string,
  exchange: Exchange,
  candidates: FinalCandidate[],
  profile: RuntimeProfile,
  risk: RiskConfig,
) {
  return candidates.map((candidate) => ({
    scan_id: scanId,
    exchange,
    market: candidate.market,
    created_at: new Date().toISOString(),
    decision: candidate.decision,
    score: candidate.score,
    period_score: candidate.period_score,
    confidence: candidate.confidence,
    entry_low: candidate.trade_plan?.entry_low ?? candidate.watch_entry_plan?.zone_low,
    entry_high: candidate.trade_plan?.entry_execution_estimate ?? candidate.watch_entry_plan?.zone_high,
    stop_price: candidate.trade_plan?.stop_execution_estimate ?? candidate.watch_entry_plan?.stop_price,
    target_1: candidate.trade_plan?.short_target_execution_estimate ?? candidate.watch_entry_plan?.reference_target,
    target_2: candidate.trade_plan?.medium_target_execution_estimate,
    net_rr: candidate.trade_plan?.net_rr ?? candidate.watch_entry_plan?.estimated_net_rr,
    estimated_cost_pct: candidate.trade_plan?.estimated_round_trip_cost_pct,
    failed_gate_count: candidate.failed_gates?.length || 0,
    intended_horizon_hours: candidate.horizon.intended_holding_hours,
    recommendation_valid_until: candidate.execution_plan.valid_until,
    active_policy_key: candidate.trade_plan.target_strategy === "SHORT_ONLY"
      ? "FIXED_T1"
      : candidate.trade_plan.target_strategy === "TRAIL_AFTER_T1"
      ? `TRAIL_AFTER_T1_${Math.round(candidate.trade_plan.first_target_allocation_pct)}`
      : `SCALE_OUT_${Math.round(candidate.trade_plan.first_target_allocation_pct)}`,
    profile_version: profile.version,
    feature_vector: featureVector(candidate, risk),
    applied_parameters: profile.parameters,
    snapshot: candidate,
  }));
}

export async function persistScan(
  result: any,
  profile: RuntimeProfile,
  risks: { upbit: RiskConfig; binance: RiskConfig },
): Promise<{ stored: boolean; reason?: string }> {
  if (!configured()) return { stored: false, reason: "SUPABASE persistence not configured" };
  const scanId = String(result.scan_id);
  await rest("scanner_scan_runs", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      id: scanId,
      created_at: result.meta?.generated_at || new Date().toISOString(),
      mode: result.meta?.exchange || "combined",
      engine_version: result.meta?.engine_version,
      status: result.status,
      profile_version: profile.version,
      profile_source: profile.source,
      summary: { coverage: result.coverage, assumptions: result.assumptions },
    }),
  });
  const rows: any[] = [];
  if (result.meta?.exchange === "combined") {
    rows.push(...candidateRows(scanId, "upbit", result.exchanges?.upbit?.finalists || [], profile, risks.upbit));
    rows.push(...candidateRows(scanId, "binance", result.exchanges?.binance?.finalists || [], profile, risks.binance));
  } else {
    const exchange = result.meta.exchange as Exchange;
    rows.push(...candidateRows(scanId, exchange, result.finalists || [], profile, risks[exchange]));
  }
  if (rows.length) {
    await rest("scanner_candidates?on_conflict=scan_id,exchange,market", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
  }
  return { stored: true };
}

function intervalForHours(hours: number): { binance: string; upbit: number; ms: number; max: number } {
  if (hours <= 24) return { binance: "5m", upbit: 5, ms: 5 * 60_000, max: 1000 };
  if (hours <= 72) return { binance: "15m", upbit: 15, ms: 15 * 60_000, max: 1000 };
  if (hours <= 168) return { binance: "1h", upbit: 60, ms: 60 * 60_000, max: 1000 };
  return { binance: "4h", upbit: 240, ms: 4 * 60 * 60_000, max: 1000 };
}

async function fetchJson(url: string, attempts = 3): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (response.ok) return await response.json();
      if (response.status === 429) await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
      else throw new Error(`${response.status} ${await response.text()}`);
    } catch (error) {
      last = error;
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

async function pricePath(exchange: Exchange, market: string, from: number, to: number, hours: number): Promise<Bar[]> {
  const interval = intervalForHours(hours);
  if (exchange === "binance") {
    const output: Bar[] = [];
    let cursor = from;
    while (cursor < to && output.length < 5000) {
      const url = new URL("https://api.binance.com/api/v3/klines");
      url.searchParams.set("symbol", market);
      url.searchParams.set("interval", interval.binance);
      url.searchParams.set("startTime", String(cursor));
      url.searchParams.set("endTime", String(to));
      url.searchParams.set("limit", String(interval.max));
      const rows = await fetchJson(url.toString());
      if (!Array.isArray(rows) || !rows.length) break;
      const mapped = rows.map((row: any[]) => ({ t: +row[0], o: +row[1], h: +row[2], l: +row[3], c: +row[4] }));
      output.push(...mapped);
      const next = mapped.at(-1)!.t + interval.ms;
      if (next <= cursor) break;
      cursor = next;
      if (rows.length < interval.max) break;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return output.filter((bar) => bar.t >= from && bar.t <= to);
  }
  const output: Bar[] = [];
  let cursorTo = to;
  while (cursorTo > from && output.length < 5000) {
    const count = Math.min(200, Math.ceil((cursorTo - from) / interval.ms) + 3);
    const url = `https://api.upbit.com/v1/candles/minutes/${interval.upbit}?market=${encodeURIComponent(market)}&count=${count}&to=${encodeURIComponent(new Date(cursorTo).toISOString())}`;
    const rows = await fetchJson(url);
    if (!Array.isArray(rows) || !rows.length) break;
    const mapped = rows.map((row: any) => ({
      t: new Date(`${row.candle_date_time_utc}Z`).getTime(),
      o: +row.opening_price,
      h: +row.high_price,
      l: +row.low_price,
      c: +row.trade_price,
    }));
    output.push(...mapped);
    const oldest = Math.min(...mapped.map((bar) => bar.t));
    const next = oldest - 1;
    if (next >= cursorTo) break;
    cursorTo = next;
    if (rows.length < count) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const unique = new Map(output.map((bar) => [bar.t, bar]));
  return [...unique.values()].filter((bar) => bar.t >= from && bar.t <= to).sort((a, b) => a.t - b.t);
}

function policyKey(policy: ExitPolicy, allocation: number): string {
  return policy === "FIXED_T1" ? "FIXED_T1" : `${policy}_${Math.round(allocation)}`;
}

function simulatePolicy(
  candidate: StoredCandidate,
  bars: Bar[],
  until: number,
  policy: ExitPolicy,
  allocationPct: number,
): PolicyOutcome {
  const entry = finite(candidate.entry_high);
  const stop = finite(candidate.stop_price);
  const target1 = finite(candidate.target_1);
  const target2 = finite(candidate.target_2, target1);
  const cost = finite(candidate.estimated_cost_pct);
  const allocation = clamp(allocationPct / 100, 0.5, 0.8);
  const key = policyKey(policy, allocationPct);
  if (!(entry > 0) || !(stop > 0) || !(target1 > entry) || !(stop < entry) || !bars.length) {
    return {
      policy_key: key,
      entered: false,
      entry_price: null,
      entry_time: null,
      exit_price: null,
      exit_time: null,
      outcome: "INVALID_PLAN",
      net_return_pct: 0,
      mfe_pct: 0,
      mae_pct: 0,
      peak_capture_ratio: null,
      target_1_hit: false,
      target_2_hit: false,
      stop_first: false,
      post_stop_mfe_pct: 0,
    };
  }

  let maxHigh = entry;
  let minLow = entry;
  let target1Hit = false;
  let target2Hit = false;
  let stopFirst = false;
  let exit = bars.at(-1)!.c;
  let exitTime = bars.at(-1)!.t;
  let outcome = "TIMEOUT";
  let firstExitNet = 0;
  let trailingStop = stop;
  const atr15 = Math.max(entry * 0.002, finite(candidate.feature_vector.atr15, entry * 0.01));
  let stopIndex = -1;

  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index];
    maxHigh = Math.max(maxHigh, bar.h);
    minLow = Math.min(minLow, bar.l);
    const hitStop = bar.l <= (target1Hit && policy === "TRAIL_AFTER_T1" ? trailingStop : stop);
    const hitT1 = !target1Hit && bar.h >= target1;
    if (!target1Hit && hitStop && hitT1) {
      stopFirst = true;
      stopIndex = index;
      exit = stop;
      exitTime = bar.t;
      outcome = "AMBIGUOUS_STOP_FIRST";
      break;
    }
    if (!target1Hit && hitStop) {
      stopFirst = true;
      stopIndex = index;
      exit = stop;
      exitTime = bar.t;
      outcome = "STOP_FIRST";
      break;
    }
    if (hitT1) {
      target1Hit = true;
      firstExitNet = (target1 / entry - 1) * 100 - cost;
      if (policy === "FIXED_T1") {
        exit = target1;
        exitTime = bar.t;
        outcome = "TARGET_1";
        break;
      }
      trailingStop = Math.max(stop, target1 - atr15 * 1.1);
    }
    if (target1Hit) {
      if (policy === "TRAIL_AFTER_T1") {
        trailingStop = Math.max(trailingStop, maxHigh - atr15 * 1.1);
        if (bar.l <= trailingStop) {
          exit = trailingStop;
          exitTime = bar.t;
          outcome = "TRAIL_EXIT";
          break;
        }
      } else if (target2 > target1) {
        const hitT2 = bar.h >= target2;
        const hitPostT1Stop = bar.l <= stop;
        if (hitT2 && hitPostT1Stop) {
          exit = stop;
          exitTime = bar.t;
          outcome = "AMBIGUOUS_PARTIAL_STOP";
          stopFirst = true;
          stopIndex = index;
          break;
        }
        if (hitPostT1Stop) {
          exit = stop;
          exitTime = bar.t;
          outcome = "PARTIAL_STOP";
          stopFirst = true;
          stopIndex = index;
          break;
        }
        if (hitT2) {
          target2Hit = true;
          exit = target2;
          exitTime = bar.t;
          outcome = "TARGET_2";
          break;
        }
      }
    }
  }

  const finalNet = (exit / entry - 1) * 100 - cost;
  const net = policy === "FIXED_T1" || !target1Hit
    ? finalNet
    : firstExitNet * allocation + finalNet * (1 - allocation);
  const mfe = (maxHigh / entry - 1) * 100;
  const mae = Math.max(0, (1 - minLow / entry) * 100);
  const maxNet = Math.max(0, mfe - cost);
  const capture = maxNet > 0 ? clamp(net / maxNet, -1, 1) : null;
  const postStopHigh = stopIndex >= 0
    ? Math.max(...bars.slice(stopIndex + 1).map((bar) => bar.h), entry)
    : entry;
  return {
    policy_key: key,
    entered: true,
    entry_price: entry,
    entry_time: candidate.created_at,
    exit_price: round(exit),
    exit_time: new Date(exitTime || until).toISOString(),
    outcome,
    net_return_pct: round(net),
    mfe_pct: round(mfe),
    mae_pct: round(mae),
    peak_capture_ratio: capture == null ? null : round(capture),
    target_1_hit: target1Hit,
    target_2_hit: target2Hit,
    stop_first: stopFirst,
    post_stop_mfe_pct: round((postStopHigh / entry - 1) * 100),
  };
}

export function evaluatePath(
  candidate: StoredCandidate,
  bars: Bar[],
  until: number,
  horizonHours = 24,
): HorizonOutcome {
  const allocations = [50, 60, 70];
  const policies: Record<string, PolicyOutcome> = {};
  policies.FIXED_T1 = simulatePolicy(candidate, bars, until, "FIXED_T1", 100);
  for (const allocation of allocations) {
    policies[policyKey("SCALE_OUT", allocation)] = simulatePolicy(candidate, bars, until, "SCALE_OUT", allocation);
    policies[policyKey("TRAIL_AFTER_T1", allocation)] = simulatePolicy(candidate, bars, until, "TRAIL_AFTER_T1", allocation);
  }
  const active = policies[candidate.active_policy_key] || policies.FIXED_T1;
  const ranked = Object.values(policies).filter((row) => row.entered).sort((a, b) => b.net_return_pct - a.net_return_pct);
  const optimal = ranked[0] || null;
  const targetGross = finite(candidate.target_1) > finite(candidate.entry_high)
    ? (finite(candidate.target_1) / finite(candidate.entry_high) - 1) * 100
    : 0;
  const failureCauses: HorizonOutcome["failure_causes"] = [];
  if (active.stop_first && active.post_stop_mfe_pct >= targetGross) {
    failureCauses.push({ code: "STOP_TOO_TIGHT", severity: "WARNING", evidence: `손절 후 MFE ${active.post_stop_mfe_pct.toFixed(2)}%가 1차 목표 거리 ${targetGross.toFixed(2)}% 이상` });
  }
  if (active.outcome === "TIMEOUT" && active.mfe_pct < finite(candidate.estimated_cost_pct) * 1.5) {
    failureCauses.push({ code: "NO_FOLLOW_THROUGH", severity: "WARNING", evidence: `보유기간 중 MFE ${active.mfe_pct.toFixed(2)}%로 비용 우위를 만들지 못함` });
  }
  if (active.outcome === "TIMEOUT" && active.mfe_pct >= targetGross * 0.75 && !active.target_1_hit) {
    failureCauses.push({ code: "TARGET_TOO_HIGH", severity: "INFO", evidence: `목표의 75% 이상 진행했으나 미도달` });
  }
  if (optimal && optimal.policy_key !== active.policy_key && optimal.net_return_pct > active.net_return_pct + 0.35) {
    failureCauses.push({ code: "EXIT_POLICY_SUBOPTIMAL", severity: "INFO", evidence: `${optimal.policy_key}가 활성 정책보다 ${round(optimal.net_return_pct - active.net_return_pct, 3)}%p 우수` });
  }
  if (String(candidate.feature_vector.event_status || "") !== "CLEAR") {
    failureCauses.push({ code: "EVENT_EXPOSURE", severity: "CRITICAL", evidence: `이벤트 상태 ${candidate.feature_vector.event_status}` });
  }
  if (finite(candidate.feature_vector.trade_pressure) < 0 && active.net_return_pct < 0) {
    failureCauses.push({ code: "NEGATIVE_TAPE", severity: "WARNING", evidence: `진입 당시 체결압력 ${finite(candidate.feature_vector.trade_pressure).toFixed(3)}` });
  }
  return {
    candidate_id: candidate.id,
    horizon_hours: horizonHours,
    is_final: horizonHours >= candidate.intended_horizon_hours,
    evaluated_until: new Date(until).toISOString(),
    active_policy_key: candidate.active_policy_key,
    active_outcome: active,
    policy_outcomes: policies,
    optimal_policy_key: optimal?.policy_key || null,
    optimal_net_return_pct: optimal?.net_return_pct || 0,
    failure_causes: failureCauses,
  };
}

async function pendingForCheckpoint(hours: number, limit = MAX_RECONCILE_BATCH): Promise<StoredCandidate[]> {
  if (!configured()) return [];
  const matured = new Date(Date.now() - hours * 3600_000).toISOString();
  const previousCheckpoint = hours === 24 ? 0 : hours === 72 ? 24 : hours === 168 ? 72 : 168;
  const candidates = await (await rest(
    `scanner_candidates?decision=eq.BUY&created_at=lte.${encodeURIComponent(matured)}&intended_horizon_hours=gt.${previousCheckpoint}&select=id,scan_id,exchange,market,created_at,decision,score,period_score,entry_low,entry_high,stop_price,target_1,target_2,net_rr,estimated_cost_pct,intended_horizon_hours,active_policy_key,profile_version,feature_vector,applied_parameters,snapshot&order=created_at.asc&limit=${limit}`,
  )).json() as StoredCandidate[];
  if (!candidates.length) return [];
  const ids = candidates.map((row) => row.id);
  const existing = await (await rest(
    `scanner_signal_horizon_outcomes?candidate_id=in.(${ids.join(",")})&horizon_hours=eq.${hours}&select=candidate_id`,
  )).json() as Array<{ candidate_id: string }>;
  const done = new Set(existing.map((row) => row.candidate_id));
  return candidates.filter((row) => !done.has(row.id));
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

export async function reconcileForwardOutcomes(): Promise<{ evaluated: number; errors: number; byHorizon: Record<string, number> }> {
  if (!configured()) return { evaluated: 0, errors: 0, byHorizon: {} };
  let evaluated = 0;
  let errors = 0;
  const byHorizon: Record<string, number> = {};
  for (const hours of CHECKPOINTS) {
    const pending = await pendingForCheckpoint(hours);
    const settled = await mapLimit(pending, RECONCILE_CONCURRENCY, async (candidate) => {
      const from = new Date(candidate.created_at).getTime();
      const to = Math.min(Date.now(), from + hours * 3600_000);
      const bars = await pricePath(candidate.exchange, candidate.market, from, to, hours);
      if (!bars.length) throw new Error("empty price path");
      return evaluatePath(candidate, bars, to, hours);
    });
    const outcomes = settled.flatMap((row) => row.status === "fulfilled" ? [row.value] : []);
    errors += settled.filter((row) => row.status === "rejected").length;
    if (outcomes.length) {
      await rest("scanner_signal_horizon_outcomes?on_conflict=candidate_id,horizon_hours", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(outcomes),
      });
    }
    evaluated += outcomes.length;
    byHorizon[String(hours)] = outcomes.length;
  }
  return { evaluated, errors, byHorizon };
}

function matches(row: LearningRow, parameters: LearningParameters): boolean {
  const f = row.feature_vector || {};
  return row.decision === "BUY" &&
    finite(row.period_score) >= parameters.scoreThreshold &&
    finite(row.net_rr) >= parameters.minNetRR &&
    finite(f.structural_headroom_net_pct) >= parameters.minStructuralHeadroomNetPct &&
    finite(f.trade_pressure, -99) > parameters.minTradePressure &&
    finite(f.book_imbalance, -99) > parameters.maxNegativeBookImbalance &&
    finite(f.depth_coverage) >= parameters.minDepthCoverage &&
    finite(f.slippage_bps, 999) <= parameters.maxSlippageBps &&
    finite(f.spread_bps, 999) <= parameters.maxSpreadBps &&
    f.low_touch_compatible === true && String(f.event_status) === "CLEAR";
}

function selectedOutcome(row: LearningRow, parameters: LearningParameters): PolicyOutcome | null {
  const key = policyKey(parameters.exitPolicy, parameters.firstTargetAllocationPct);
  return row.policy_outcomes?.[key] || row.policy_outcomes?.FIXED_T1 || null;
}

function metrics(rows: LearningRow[], parameters: LearningParameters): Metrics {
  const selected = rows.filter((row) => matches(row, parameters))
    .map((row) => ({ row, outcome: selectedOutcome(row, parameters) }))
    .filter((item): item is { row: LearningRow; outcome: PolicyOutcome } => Boolean(item.outcome?.entered));
  if (!selected.length) {
    return { value: -999, n: 0, expectancy: 0, profitFactor: 0, maxDrawdown: 100, equity: 0, winRate: 0, capture: 0, tailLoss: 100, marketConcentration: 1 };
  }
  const returns = selected.map((item) => item.outcome.net_return_pct);
  const expectancy = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const gains = returns.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(returns.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  const profitFactor = losses > 0 ? gains / losses : gains > 0 ? 5 : 0;
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of returns) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const capture = median(selected.map((item) => item.outcome.peak_capture_ratio ?? 0));
  const tailLoss = Math.abs(quantile(returns, 0.1));
  const byMarket = new Map<string, number>();
  for (const item of selected) byMarket.set(item.row.market, (byMarket.get(item.row.market) || 0) + Math.abs(item.outcome.net_return_pct));
  const totalAbs = [...byMarket.values()].reduce((sum, value) => sum + value, 0);
  const marketConcentration = totalAbs > 0 ? Math.max(...byMarket.values()) / totalAbs : 1;
  const winRate = returns.filter((value) => value > 0).length / returns.length;
  const value = expectancy * 5 + Math.min(profitFactor, 4) * 0.8 + capture * 0.6 + equity * 0.03 -
    maxDrawdown * 0.18 - tailLoss * 0.3 - Math.max(0, marketConcentration - 0.35) * 3;
  return { value, n: selected.length, expectancy, profitFactor, maxDrawdown, equity, winRate, capture, tailLoss, marketConcentration };
}

function boundedStep(current: LearningParameters, candidate: LearningParameters, weekly: LearningParameters): LearningParameters {
  const step = (next: number, before: number, pct: number) => clamp(next, before * (1 - pct), before * (1 + pct));
  return {
    ...candidate,
    scoreThreshold: Math.max(weekly.scoreThreshold, clamp(candidate.scoreThreshold, current.scoreThreshold - 2, current.scoreThreshold + 2)),
    minNetRR: Math.max(weekly.minNetRR, clamp(candidate.minNetRR, current.minNetRR - 0.1, current.minNetRR + 0.1)),
    shortTargetAtrMult: step(candidate.shortTargetAtrMult, current.shortTargetAtrMult, 0.05),
    stopAtrMult: step(candidate.stopAtrMult, current.stopAtrMult, 0.05),
    mediumTargetAtr4hMult: step(candidate.mediumTargetAtr4hMult, current.mediumTargetAtr4hMult, 0.05),
    mediumTargetAtrDayMult: step(candidate.mediumTargetAtrDayMult, current.mediumTargetAtrDayMult, 0.05),
    minStructuralHeadroomNetPct: Math.max(weekly.minStructuralHeadroomNetPct, clamp(candidate.minStructuralHeadroomNetPct, current.minStructuralHeadroomNetPct, current.minStructuralHeadroomNetPct + 0.2)),
    minCostMultiple: Math.max(weekly.minCostMultiple, clamp(candidate.minCostMultiple, current.minCostMultiple, current.minCostMultiple + 0.25)),
    minTradePressure: Math.max(weekly.minTradePressure, clamp(candidate.minTradePressure, current.minTradePressure, current.minTradePressure + 0.08)),
    maxNegativeBookImbalance: Math.max(weekly.maxNegativeBookImbalance, clamp(candidate.maxNegativeBookImbalance, current.maxNegativeBookImbalance, current.maxNegativeBookImbalance + 0.08)),
    minDepthCoverage: Math.max(weekly.minDepthCoverage, clamp(candidate.minDepthCoverage, current.minDepthCoverage, current.minDepthCoverage + 0.5)),
    maxSlippageBps: Math.min(weekly.maxSlippageBps, clamp(candidate.maxSlippageBps, current.maxSlippageBps - 3, current.maxSlippageBps)),
    maxSpreadBps: Math.min(weekly.maxSpreadBps, clamp(candidate.maxSpreadBps, current.maxSpreadBps - 5, current.maxSpreadBps)),
    stopMinAtr4hMult: Math.max(weekly.stopMinAtr4hMult, clamp(candidate.stopMinAtr4hMult, current.stopMinAtr4hMult, current.stopMinAtr4hMult + 0.1)),
    stopMinAtr15mMult: Math.max(weekly.stopMinAtr15mMult, clamp(candidate.stopMinAtr15mMult, current.stopMinAtr15mMult, current.stopMinAtr15mMult + 0.15)),
    firstTargetAllocationPct: clamp(candidate.firstTargetAllocationPct, 50, 80),
  };
}

function challengerSet(current: LearningParameters, weekly: LearningParameters): LearningParameters[] {
  const candidates: LearningParameters[] = [{ ...current }];
  const push = (patch: Partial<LearningParameters>) => candidates.push(boundedStep(current, { ...current, ...patch }, weekly));
  push({ scoreThreshold: current.scoreThreshold + 2 });
  push({ minNetRR: current.minNetRR + 0.1 });
  push({ minStructuralHeadroomNetPct: current.minStructuralHeadroomNetPct + 0.2 });
  push({ minTradePressure: current.minTradePressure + 0.08 });
  push({ minDepthCoverage: current.minDepthCoverage + 0.5 });
  push({ maxSpreadBps: current.maxSpreadBps - 5 });
  push({ maxSlippageBps: current.maxSlippageBps - 3 });
  push({ stopAtrMult: current.stopAtrMult * 1.05 });
  push({ shortTargetAtrMult: current.shortTargetAtrMult * 0.95 });
  for (const allocation of [50, 60, 70]) {
    push({ exitPolicy: "SCALE_OUT", firstTargetAllocationPct: allocation });
    push({ exitPolicy: "TRAIL_AFTER_T1", firstTargetAllocationPct: allocation });
  }
  push({ exitPolicy: "FIXED_T1", firstTargetAllocationPct: 100 });
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = JSON.stringify(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validationFolds(rows: LearningRow[]): LearningRow[][] {
  const size = Math.floor(rows.length / 3);
  if (size < 10) return [rows];
  return [rows.slice(0, size), rows.slice(size, size * 2), rows.slice(size * 2)];
}

async function loadLearningRows(): Promise<LearningRow[]> {
  const rows = await (await rest(
    `scanner_candidates?decision=eq.BUY&select=id,created_at,market,exchange,decision,profile_version,period_score,net_rr,feature_vector,active_policy_key,scanner_signal_horizon_outcomes!inner(is_final,policy_outcomes)&scanner_signal_horizon_outcomes.is_final=eq.true&order=created_at.desc&limit=${MAX_FORWARD_ROWS}`,
  )).json() as any[];
  return rows.map((row) => {
    const outcome = Array.isArray(row.scanner_signal_horizon_outcomes)
      ? row.scanner_signal_horizon_outcomes[0]
      : row.scanner_signal_horizon_outcomes;
    return {
      id: row.id,
      created_at: row.created_at,
      market: row.market,
      exchange: row.exchange,
      decision: row.decision,
      profile_version: Number(row.profile_version || 0),
      period_score: finite(row.period_score),
      net_rr: finite(row.net_rr),
      feature_vector: row.feature_vector || {},
      active_policy_key: row.active_policy_key || "FIXED_T1",
      policy_outcomes: outcome?.policy_outcomes || {},
    } satisfies LearningRow;
  }).reverse();
}

export function promotionDecision(
  champion: Metrics,
  challenger: Metrics,
  folds: Array<{ champion: Metrics; challenger: Metrics }>,
): { accepted: boolean; reason: string; foldsPassed: number } {
  const foldsPassed = folds.filter((fold) =>
    fold.challenger.n >= 10 && fold.challenger.expectancy > 0 &&
    fold.challenger.profitFactor >= 1.05 && fold.challenger.value >= fold.champion.value
  ).length;
  if (challenger.n < FINAL_MIN_SELECTED) {
    return { accepted: false, reason: `selected validation samples ${challenger.n}/${FINAL_MIN_SELECTED}`, foldsPassed };
  }
  if (!(challenger.expectancy > 0)) return { accepted: false, reason: "non-positive expectancy", foldsPassed };
  if (challenger.profitFactor < 1.15) return { accepted: false, reason: "profit factor below 1.15", foldsPassed };
  if (challenger.value < champion.value + 0.12) return { accepted: false, reason: "objective improvement below 0.12", foldsPassed };
  if (challenger.maxDrawdown > champion.maxDrawdown + 1) return { accepted: false, reason: "drawdown deterioration", foldsPassed };
  if (challenger.marketConcentration > 0.5) return { accepted: false, reason: "single-market concentration above 50%", foldsPassed };
  if (foldsPassed < 2) return { accepted: false, reason: `rolling folds ${foldsPassed}/${folds.length}`, foldsPassed };
  return { accepted: true, reason: "all forward promotion guards passed", foldsPassed };
}

async function activateProfile(
  current: RuntimeProfile,
  parameters: LearningParameters,
  samples: number,
  validationSamples: number,
  challenger: Metrics,
  champion: Metrics,
  source: RuntimeProfile["source"] = "FORWARD_AUTO",
): Promise<RuntimeProfile> {
  await rest("scanner_runtime_profiles?active=eq.true", {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ active: false }),
  });
  const version = current.version + 1;
  const promotedAt = new Date().toISOString();
  await rest("scanner_runtime_profiles", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      version,
      active: true,
      source,
      parent_version: current.version || null,
      parameters,
      samples,
      validation_samples: validationSamples,
      objective: challenger.value,
      champion_objective: champion.value,
      promoted_at: promotedAt,
      evidence: { challenger, champion },
    }),
  });
  return {
    version,
    source,
    parameters,
    samples,
    validationSamples,
    objective: challenger.value,
    promotedAt,
    parentVersion: current.version || null,
  };
}

export async function autoRollbackIfDegraded(
  current: RuntimeProfile,
  weekly: LearningParameters,
): Promise<{ rolledBack: boolean; reason: string; profile: RuntimeProfile }> {
  if (!configured() || current.version <= 0) return { rolledBack: false, reason: "no forward profile", profile: current };
  const rows = (await loadLearningRows()).filter((row) => row.profile_version === current.version).slice(-60);
  if (rows.length < 30) return { rolledBack: false, reason: `rollback samples ${rows.length}/30`, profile: current };
  const currentMetrics = metrics(rows, current.parameters);
  if (!(currentMetrics.expectancy < 0 && currentMetrics.profitFactor < 0.9)) {
    return { rolledBack: false, reason: "recent profile not degraded", profile: current };
  }
  const priorRows = await (await rest(
    `scanner_runtime_profiles?version=lt.${current.version}&select=*&order=version.desc&limit=1`,
  )).json();
  const prior = priorRows?.[0];
  const parameters = prior?.parameters ? withDefaults(prior.parameters, weekly) : weekly;
  const profile = await activateProfile(
    current,
    parameters,
    rows.length,
    rows.length,
    metrics(rows, parameters),
    currentMetrics,
    "FORWARD_ROLLBACK",
  );
  return { rolledBack: true, reason: "recent expectancy and PF triggered automatic rollback", profile };
}

export async function autoCalibrateForward(
  current: RuntimeProfile,
  weekly: LearningParameters,
): Promise<{ promoted: boolean; reason: string; profile: RuntimeProfile }> {
  if (!configured()) return { promoted: false, reason: "storage disabled", profile: current };
  const rollback = await autoRollbackIfDegraded(current, weekly);
  if (rollback.rolledBack) return { promoted: true, reason: rollback.reason, profile: rollback.profile };
  const rows = await loadLearningRows();
  if (rows.length < FINAL_MIN_SAMPLES) {
    return { promoted: false, reason: `settled BUY samples ${rows.length}/${FINAL_MIN_SAMPLES}`, profile: current };
  }
  const split = Math.floor(rows.length * 0.7);
  const train = rows.slice(0, split);
  const validation = rows.slice(split);
  if (validation.length < FINAL_MIN_VALIDATION) {
    return { promoted: false, reason: `validation ${validation.length}/${FINAL_MIN_VALIDATION}`, profile: current };
  }
  const candidates = challengerSet(current.parameters, weekly);
  const ranked = candidates.map((parameters) => ({ parameters, metrics: metrics(train, parameters) }))
    .filter((row) => row.metrics.n >= FINAL_MIN_SELECTED)
    .sort((a, b) => b.metrics.value - a.metrics.value);
  const best = ranked[0];
  if (!best) return { promoted: false, reason: "no challenger with enough selected BUY samples", profile: current };
  const champion = metrics(validation, current.parameters);
  const challenger = metrics(validation, best.parameters);
  const folds = validationFolds(validation).map((fold) => ({
    champion: metrics(fold, current.parameters),
    challenger: metrics(fold, best.parameters),
  }));
  const decision = promotionDecision(champion, challenger, folds);
  if (!decision.accepted) {
    return {
      promoted: false,
      reason: `challenger rejected: ${decision.reason}; n=${challenger.n} exp=${challenger.expectancy.toFixed(3)} PF=${challenger.profitFactor.toFixed(2)} folds=${decision.foldsPassed}/${folds.length} obj=${challenger.value.toFixed(3)} vs ${champion.value.toFixed(3)}`,
      profile: current,
    };
  }
  const profile = await activateProfile(current, best.parameters, rows.length, validation.length, challenger, champion);
  return { promoted: true, reason: "guarded forward challenger promoted", profile };
}
