// Trading-booooo v6.2.0-HEAT — order-book trap detection.
//
// WHY THIS EXISTS
// ---------------
// v6.1 computed three hazard measures (bid spoof, ask absorption, support breakdown) and
// then used almost none of them at entry. `entry.ts` blocked only on
// `spoofLikeScore >= 0.97`, while the scanner's own risk label fires at 0.65 — so a book
// the system itself had flagged as SPOOF_LIKE_RISK was still buyable. Ask-side icebergs,
// which are the single most reliable way to lose on a 10–60bp target, were only a small
// negative term inside one pattern's confidence. Chop was not measured at all.
//
// WHAT A TRAP IS HERE
// -------------------
// A trap is a book condition under which the *pattern evidence is real but the trade is
// still unwinnable*. That distinction matters: these are not "extra confirmations". Each
// one below names a specific mechanism by which the target becomes unreachable or the stop
// becomes a coin flip.
//
// THROUGHPUT
// ----------
// A veto here rejects one symbol, not the cycle. The scanner ranks the whole market by
// heat and the autotrader walks that list until its per-scan entry budget is filled, so a
// vetoed book is replaced by the next hottest one rather than leaving the bot idle.
//
// Pure functions only — no I/O.

export type LobTrapName =
  | "ASK_ICEBERG"
  | "BID_SPOOF"
  | "ASK_SPOOF"
  | "CHOP_NO_VIABLE_STOP"
  | "QUOTE_FLICKER";

export interface LobTrapFeatures {
  /** Refilling resting ask that keeps absorbing aggressive buys. 0..1 */
  askAbsorptionScore: number;
  /** Refilled quantity / executed quantity at ask walls. >1 means it grows back faster than it is eaten. */
  askRefillRatio: number;
  /** Bid walls shrinking without matching sell prints (허매수). 0..1 */
  bidSpoofScore: number;
  /** Ask walls shrinking without matching buy prints (허매도). 0..1 */
  askSpoofScore: number;
  /** |net displacement| / total path length over the observation window. 1 = straight, ~0 = chop. */
  pathEfficiency: number;
  /** Share of consecutive mid-price steps that reverse direction. 0..1 */
  reversalRate: number;
  /** Typical adverse excursion, in bps, for a long opened at a random point in the window. */
  noiseBandBps: number;
  /** Top-of-book size changes per second. */
  quoteFlickerRate: number;
  /** Executed trades per second over the same window. */
  tradeArrivalRate: number;
  /** 0..1 confidence that the observation window carried enough samples to judge any of this. */
  dataQuality: number;
}

export interface LobTrapConfig {
  askIcebergAbsorption: number;
  askIcebergRefillRatio: number;
  bidSpoofScore: number;
  askSpoofScore: number;
  minPathEfficiency: number;
  maxReversalRate: number;
  /** A stop must clear the observed noise band by this multiple to be more than a coin flip. */
  stopNoiseMultiple: number;
  /** Above this stop width the trade stops being a scalp regardless of what noise demands. */
  maxViableStopBps: number;
  flickerPerTrade: number;
  /** Below this data quality the trap scores are not trusted enough to veto on. */
  minDataQuality: number;
}

export const DEFAULT_LOB_TRAP_CONFIG: LobTrapConfig = {
  askIcebergAbsorption: 0.55,
  askIcebergRefillRatio: 0.60,
  bidSpoofScore: 0.60,
  askSpoofScore: 0.70,
  minPathEfficiency: 0.12,
  maxReversalRate: 0.72,
  stopNoiseMultiple: 1.25,
  maxViableStopBps: 200,
  flickerPerTrade: 25,
  minDataQuality: 0.25,
};

export interface LobTrapHit {
  name: LobTrapName;
  severity: number;
  veto: boolean;
  detail: string;
}

export interface LobTrapAssessment {
  traps: LobTrapHit[];
  vetoes: LobTrapName[];
  /** Multiplier applied to pattern confidence for non-vetoing hazards. 0..1 */
  confidenceMultiplier: number;
  /** Smallest stop width, in bps, that is not inside this book's own noise. */
  requiredStopBps: number;
  noiseBandBps: number;
  /** True when the window was too thin to judge; caller should treat scores as unknown, not clean. */
  unreliable: boolean;
}

function clamp(value: number, low = 0, high = 1): number {
  return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Judge one book. `plannedStopBps` is the stop the entry model wants to use; the returned
 * `requiredStopBps` is what this book's own noise says is the minimum honest stop.
 */
export function assessLobTraps(
  features: LobTrapFeatures,
  plannedStopBps: number,
  overrides: Partial<LobTrapConfig> = {},
): LobTrapAssessment {
  const cfg = { ...DEFAULT_LOB_TRAP_CONFIG, ...overrides };
  const traps: LobTrapHit[] = [];
  const dataQuality = clamp(finite(features.dataQuality));
  const unreliable = dataQuality < cfg.minDataQuality;

  const noiseBandBps = Math.max(0, finite(features.noiseBandBps));
  const requiredStopBps = noiseBandBps * cfg.stopNoiseMultiple;

  // 1. Ask-side iceberg. A resting seller that reloads at the same price is a hard ceiling:
  //    the target sits above a level that keeps being refilled, so the position times out
  //    or stops out while the pattern evidence still reads bullish. This is the failure
  //    mode that a purely bullish reading of REPLENISHMENT_ICEBERG cannot see.
  const askAbsorption = clamp(finite(features.askAbsorptionScore));
  const askRefill = Math.max(0, finite(features.askRefillRatio));
  if (askAbsorption >= cfg.askIcebergAbsorption && askRefill >= cfg.askIcebergRefillRatio) {
    traps.push({
      name: "ASK_ICEBERG",
      severity: clamp(askAbsorption * 0.6 + clamp(askRefill) * 0.4),
      veto: !unreliable,
      detail: `매도 흡수 ${(askAbsorption * 100).toFixed(0)}% · 재충전비 ${askRefill.toFixed(2)} — 목표가 위에 반복 재충전되는 매도벽`,
    });
  }

  // 2. Bid spoof (허매수). The support the long is leaning on is being cancelled rather
  //    than executed. Book imbalance and depth ratio both read bullish while the depth is
  //    not actually there, which makes the stop far more likely to fill badly.
  const bidSpoof = clamp(finite(features.bidSpoofScore));
  if (bidSpoof >= cfg.bidSpoofScore) {
    traps.push({
      name: "BID_SPOOF",
      severity: bidSpoof,
      veto: !unreliable,
      detail: `매수벽 감소분이 매도 체결로 설명되지 않음 ${(bidSpoof * 100).toFixed(0)}% — 지지 잔량이 실체결이 아니라 취소로 사라지는 중`,
    });
  }

  // 3. Ask spoof (허매도). On its own this is not bearish for a long — a fake wall lifting
  //    is often the setup. What it does mean is that book-derived features are being
  //    manipulated, so it degrades confidence, and it vetoes only alongside bid spoof,
  //    where both sides are being painted and no book reading survives.
  const askSpoof = clamp(finite(features.askSpoofScore));
  if (askSpoof >= cfg.askSpoofScore) {
    traps.push({
      name: "ASK_SPOOF",
      severity: askSpoof,
      veto: !unreliable && bidSpoof >= cfg.bidSpoofScore * 0.75,
      detail: `매도벽도 체결 없이 소멸 ${(askSpoof * 100).toFixed(0)}% — 양방향 호가 조작 가능성`,
    });
  }

  // 4. Chop with no viable stop. This is the whipsaw case, expressed economically rather
  //    than as a mood: if the book's own typical adverse excursion is wider than any stop
  //    that still counts as a scalp, then the stop is noise and the trade is a coin flip
  //    no matter how good the pattern looks.
  const pathEfficiency = clamp(finite(features.pathEfficiency));
  const reversalRate = clamp(finite(features.reversalRate));
  const choppy = pathEfficiency < cfg.minPathEfficiency || reversalRate > cfg.maxReversalRate;
  if (requiredStopBps > cfg.maxViableStopBps) {
    traps.push({
      name: "CHOP_NO_VIABLE_STOP",
      severity: 1,
      veto: !unreliable,
      detail: `노이즈 ${noiseBandBps.toFixed(1)}bp — 스캘핑 손절폭(${cfg.maxViableStopBps}bp) 안에서는 손절이 노이즈에 걸림`,
    });
  } else if (choppy && plannedStopBps > 0 && plannedStopBps < requiredStopBps) {
    // Not a veto: the entry model can widen the stop instead. It becomes a veto only if
    // widening it destroys the expected value, which entry.ts decides with real costs.
    traps.push({
      name: "CHOP_NO_VIABLE_STOP",
      severity: clamp(1 - pathEfficiency / Math.max(cfg.minPathEfficiency, 1e-9)) * 0.5 + 0.25,
      veto: false,
      detail: `경로효율 ${(pathEfficiency * 100).toFixed(0)}% · 반전율 ${(reversalRate * 100).toFixed(0)}% — 손절폭을 ${requiredStopBps.toFixed(1)}bp 이상으로 넓혀야 함`,
    });
  }

  // 5. Quote flicker. Size at the touch churning with almost no prints behind it means the
  //    queue is being rewritten by other algorithms. A maker order will keep losing its
  //    place, so the fill assumption behind the whole maker-entry design stops holding.
  const flicker = Math.max(0, finite(features.quoteFlickerRate));
  const arrivals = Math.max(0, finite(features.tradeArrivalRate));
  const flickerPerTrade = arrivals > 0 ? flicker / arrivals : flicker > 0 ? Infinity : 0;
  if (flickerPerTrade > cfg.flickerPerTrade) {
    traps.push({
      name: "QUOTE_FLICKER",
      severity: clamp(flickerPerTrade / (cfg.flickerPerTrade * 3)),
      veto: false,
      detail: `체결 대비 호가 변경 ${Number.isFinite(flickerPerTrade) ? flickerPerTrade.toFixed(0) : "∞"}배 — 메이커 주문의 큐 우선순위가 유지되지 않음`,
    });
  }

  const vetoes = traps.filter((trap) => trap.veto).map((trap) => trap.name);
  const penalty = traps
    .filter((trap) => !trap.veto)
    .reduce((product, trap) => product * (1 - clamp(trap.severity) * 0.35), 1);

  return {
    traps,
    vetoes,
    confidenceMultiplier: clamp(penalty, 0.2, 1),
    requiredStopBps,
    noiseBandBps,
    unreliable,
  };
}

/**
 * Mid-price path statistics for one observation window.
 *
 * `noiseBandBps` is deliberately the median *adverse* excursion rather than a symmetric
 * dispersion measure: what decides whether a stop survives is how far price typically goes
 * against a long opened at an arbitrary moment, not how far it moves in general.
 */
export function midPathStatistics(mids: number[]): {
  pathEfficiency: number;
  reversalRate: number;
  noiseBandBps: number;
} {
  const series = mids.filter((value) => Number.isFinite(value) && value > 0);
  if (series.length < 3) return { pathEfficiency: 1, reversalRate: 0, noiseBandBps: 0 };

  // Keep the cost bounded on very active books; the shape of the path is preserved.
  const stride = Math.max(1, Math.ceil(series.length / 300));
  const path = stride === 1 ? series : series.filter((_, index) => index % stride === 0);
  const base = path[0];

  let pathLength = 0;
  let reversals = 0;
  let steps = 0;
  let previousSign = 0;
  for (let i = 1; i < path.length; i++) {
    const delta = path[i] - path[i - 1];
    pathLength += Math.abs(delta);
    if (delta === 0) continue;
    const sign = delta > 0 ? 1 : -1;
    steps++;
    if (previousSign !== 0 && sign !== previousSign) reversals++;
    previousSign = sign;
  }
  const net = Math.abs(path[path.length - 1] - base);
  const pathEfficiency = pathLength > 0 ? clamp(net / pathLength) : 1;
  const reversalRate = steps > 1 ? clamp(reversals / (steps - 1)) : 0;

  const excursions: number[] = [];
  for (let start = 0; start < path.length - 1; start++) {
    let worst = path[start];
    for (let i = start + 1; i < path.length; i++) if (path[i] < worst) worst = path[i];
    excursions.push((path[start] - worst) / path[start] * 10_000);
  }
  excursions.sort((left, right) => left - right);
  const noiseBandBps = excursions.length
    ? excursions[Math.floor(excursions.length / 2)]
    : 0;

  return { pathEfficiency, reversalRate, noiseBandBps: Math.max(0, noiseBandBps) };
}
