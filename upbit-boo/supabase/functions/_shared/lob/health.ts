// Trading-booooo v6.3.0-HEAT — keeping capital deployed.
//
// The three things that stop a working scalper from working, in order of how much idle time
// each one causes. None of them is a bug in the trading logic; all of them are places where
// the machinery around it parks money.
//
//   1. A fixed consecutive-loss halt. At a scalper's trade rate this fires constantly on
//      pure noise. With a 55% win rate a four-loss streak arrives roughly every 24 trades,
//      so the bot spends most of its life halted for a reason that carries no information.
//   2. Maker orders that never fill. Capital is committed to a resting bid, the TTL expires,
//      the order is cancelled, and the cycle repeats without a position ever existing.
//   3. Slots that outnumber candidates. Capital divided six ways while two books qualify
//      leaves two thirds of it doing nothing.
//
// What this module does NOT do is lower the entry bar. Idle time caused by configuration,
// latency or a stale halt is waste. Idle time caused by no book clearing its costs is the
// market declining to pay, and forcing entries into that converts turnover into a fee pump.
//
// Pure functions only — no I/O.

export interface HealthSample {
  /** pTarget the model predicted at order time. */
  predicted: number;
  /** 1 when the target resolved first. */
  outcome: 0 | 1;
}

export interface HealthConfig {
  /** No health judgement is made below this many closed trades. */
  minSamples: number;
  /** Standard deviations below prediction that count as the model being broken. */
  zThreshold: number;
  /**
   * A losing streak halts only when it is rarer than 1-in-this under the model's own loss
   * probability. Replaces a fixed count, which means something different at every win rate.
   */
  streakSurpriseOdds: number;
  /** Hard floor and ceiling on the derived streak length. */
  minStreak: number;
  maxStreak: number;
}

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  minSamples: 40,
  zThreshold: 2.5,
  streakSurpriseOdds: 200,
  minStreak: 5,
  maxStreak: 25,
};

export interface HealthVerdict {
  healthy: boolean;
  reason: "OK" | "UNMEASURED" | "MODEL_UNDERPERFORMING";
  samples: number;
  realizedHitRate: number;
  predictedHitRate: number;
  z: number;
  /** Consecutive losses that would be genuinely surprising at the measured win rate. */
  streakLimit: number;
  note: string;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
}

/**
 * The streak length whose probability under the model falls below 1/odds.
 *
 * At a 55% win rate and 1-in-200 odds this returns 7, not 4. The point is not that 7 is a
 * better number than 4 — it is that the threshold has to move with the win rate, because
 * the same streak is routine at one win rate and alarming at another.
 */
export function surprisingStreak(
  winRate: number,
  odds: number,
  minStreak: number,
  maxStreak: number,
): number {
  const lossRate = clamp(1 - winRate, 0.01, 0.99);
  const raw = Math.log(1 / Math.max(2, odds)) / Math.log(lossRate);
  return Math.round(clamp(Math.ceil(raw), minStreak, maxStreak));
}

/**
 * Is the model performing as it claims? This is the question a halt should be answering.
 * A run of losses at the predicted rate is not evidence of anything; a hit rate that sits
 * several standard errors below what the model promised is.
 */
export function evaluateModelHealth(
  samples: HealthSample[],
  overrides: Partial<HealthConfig> = {},
): HealthVerdict {
  const cfg = { ...DEFAULT_HEALTH_CONFIG, ...overrides };
  const usable = samples.filter((sample) =>
    Number.isFinite(sample.predicted) && (sample.outcome === 0 || sample.outcome === 1)
  );
  const n = usable.length;
  const realized = n ? usable.filter((sample) => sample.outcome === 1).length / n : 0;
  const predicted = n
    ? usable.reduce((sum, sample) => sum + sample.predicted, 0) / n
    : 0;

  if (n < cfg.minSamples) {
    return {
      healthy: true,
      reason: "UNMEASURED",
      samples: n,
      realizedHitRate: realized,
      predictedHitRate: predicted,
      z: 0,
      // Until there is a measurement, fall back to a streak derived from the model's own
      // claim rather than from a realized rate that does not exist yet.
      streakLimit: surprisingStreak(predicted || 0.5, cfg.streakSurpriseOdds, cfg.minStreak, cfg.maxStreak),
      note: `표본 ${n}건 — 최소 ${cfg.minSamples}건 미만이라 모델 성능 판정 보류`,
    };
  }

  const variance = Math.max(1e-9, predicted * (1 - predicted) / n);
  const z = (realized - predicted) / Math.sqrt(variance);
  const streakLimit = surprisingStreak(realized, cfg.streakSurpriseOdds, cfg.minStreak, cfg.maxStreak);

  if (z < -Math.abs(cfg.zThreshold)) {
    return {
      healthy: false,
      reason: "MODEL_UNDERPERFORMING",
      samples: n,
      realizedHitRate: realized,
      predictedHitRate: predicted,
      z,
      streakLimit,
      note: `실현 ${(realized * 100).toFixed(1)}% vs 예측 ${(predicted * 100).toFixed(1)}% (z=${z.toFixed(2)}) — 노이즈로 설명되지 않는 미달`,
    };
  }

  return {
    healthy: true,
    reason: "OK",
    samples: n,
    realizedHitRate: realized,
    predictedHitRate: predicted,
    z,
    streakLimit,
    note: `실현 ${(realized * 100).toFixed(1)}% vs 예측 ${(predicted * 100).toFixed(1)}% (z=${z.toFixed(2)}) — 정상 범위`,
  };
}

export interface MakerFillStats {
  rested: number;
  filled: number;
}

export interface MakerPolicyConfig {
  /** No fill-rate judgement below this many resting orders. */
  minSamples: number;
  /** Below this measured fill rate the maker-only assumption is not holding. */
  minFillRate: number;
}

export const DEFAULT_MAKER_POLICY: MakerPolicyConfig = {
  minSamples: 30,
  minFillRate: 0.35,
};

export interface MakerPolicyDecision {
  convertToTaker: boolean;
  fillRate: number;
  measured: boolean;
  reason: string;
}

/**
 * Whether an unfilled maker entry should be re-sent as a taker.
 *
 * Two conditions, and both are required. The fill rate has to be measured and low — a
 * blanket switch would give back the whole reason maker entry was adopted, since taker
 * execution costs roughly 2.4x more on Upbit. And the trade has to still clear its costs at
 * the taker price, which is the honest test: if the edge only existed because of the spread
 * capture, then chasing it is not turnover, it is paying to lose more often.
 */
export function shouldConvertToTaker(
  stats: MakerFillStats,
  evAtTakerBps: number,
  overrides: Partial<MakerPolicyConfig> = {},
): MakerPolicyDecision {
  const cfg = { ...DEFAULT_MAKER_POLICY, ...overrides };
  const rested = Math.max(0, stats.rested);
  const fillRate = rested > 0 ? clamp(stats.filled / rested, 0, 1) : 0;
  const measured = rested >= cfg.minSamples;

  if (!measured) {
    return {
      convertToTaker: false,
      fillRate,
      measured,
      reason: `체결률 표본 ${rested}건 — ${cfg.minSamples}건 미만이라 전환 판단 보류`,
    };
  }
  if (fillRate >= cfg.minFillRate) {
    return {
      convertToTaker: false,
      fillRate,
      measured,
      reason: `메이커 체결률 ${(fillRate * 100).toFixed(0)}% — 전환 불필요`,
    };
  }
  if (!(evAtTakerBps > 0)) {
    return {
      convertToTaker: false,
      fillRate,
      measured,
      reason: `체결률 ${(fillRate * 100).toFixed(0)}%로 낮지만 테이커 비용 반영 시 기대값 ${evAtTakerBps.toFixed(2)}bp — 전환해도 남는 것이 없음`,
    };
  }
  return {
    convertToTaker: true,
    fillRate,
    measured,
    reason: `체결률 ${(fillRate * 100).toFixed(0)}% · 테이커 기대값 ${evAtTakerBps.toFixed(2)}bp — 전환`,
  };
}

/**
 * How many ways to divide capital right now.
 *
 * A fixed slot count strands capital whenever fewer books qualify than there are slots.
 * Dividing by the number of candidates that actually exist keeps it deployed, bounded by the
 * configured maximum so one candidate can never absorb the whole account.
 */
export function effectiveSlots(
  configuredSlots: number,
  availableCandidates: number,
  openPositions: number,
  minSlots = 1,
): number {
  const configured = Math.max(1, Math.floor(configuredSlots));
  const available = Math.max(0, Math.floor(availableCandidates));
  const open = Math.max(0, Math.floor(openPositions));
  if (available <= 0) return configured;
  // Slots already occupied still hold capital, so they stay in the denominator.
  return Math.round(clamp(Math.min(configured, available + open), Math.max(1, minSlots), configured));
}
