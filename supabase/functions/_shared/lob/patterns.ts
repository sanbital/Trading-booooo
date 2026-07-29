import type { LobFeatureVector, LobPatternName, LobPatternSignal } from "./types.ts";

function clamp(value: number, low = 0, high = 1): number {
  return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
}

function signal(
  name: LobPatternSignal["name"],
  confidence: number,
  primary: boolean,
  evidence: string[],
  invalidations: string[],
): LobPatternSignal {
  return { name, direction: "LONG", confidence: clamp(confidence), primary, evidence, invalidations };
}

function positiveVotes(f: LobFeatureVector): number {
  return (f.tradePressureFast > 0 ? 1 : 0) +
    (f.bookImbalance > 0 ? 1 : 0) +
    (f.micropriceDeviationBps > 0 ? 1 : 0);
}

/**
 * Six LOB pattern families.
 *
 * Momentum continuation is deliberately separate from mean-reversion/queue patterns. A large
 * 24h gain is context only; primary status also requires current ticker-notional acceleration,
 * aggressive buys, positive microprice, tight spread and at least two directional votes.
 */
export function detectLobPatterns(f: LobFeatureVector): LobPatternSignal[] {
  const positiveFlow = clamp((f.tradePressureFast + 1) / 2);
  const positiveBook = clamp((f.bookImbalance + 1) / 2);
  const positiveMicroprice = clamp((f.micropriceDeviationBps + 5) / 10);
  const positiveMicroMomentum = clamp(f.micropriceDeviationBps / 5);
  const depthSupport = clamp((f.depthRatio - 0.5) / 2);
  const lowAskAbsorption = clamp(1 - f.askAbsorptionScore);
  const votes = positiveVotes(f);

  // heatPeriod encodes signed 24h return as change_pct / 400 in trendContext.
  const impliedChange24hPct = clamp(f.trendContext * 400, -100, 100);
  const changeScore = clamp((impliedChange24hPct - 3) / 27);
  const accelerationScore = clamp(f.notionalAcceleration);
  const heatScore = clamp(f.marketHeatScore / 100);
  const momentumPrimary = impliedChange24hPct >= 3 && impliedChange24hPct <= 60 &&
    f.marketHeatScore >= 45 && f.notionalAcceleration >= 0.02 &&
    f.tradePressureFast >= 0.25 && f.micropriceDeviationBps >= 0 &&
    f.bookImbalance > -0.65 && votes >= 2 &&
    f.spreadBps != null && f.spreadBps <= 8 &&
    f.recentNotionalPerSecond > 0 && f.tradeCount >= 8;

  const absorptionPrimary = f.bidAbsorptionScore >= 0.45 &&
    f.micropriceDeviationBps >= -1 &&
    (f.persistentBidWall || f.depthRatio >= 1);
  const depletionPrimary = f.breakoutScore >= 0.60 && votes >= 2;
  const reclaimPrimary = f.sweepReclaimScore >= 0.45 && votes >= 2;
  const ofiPrimary = f.ofiPersistence >= 0.45 && f.tradePressureFast >= 0.15 && votes >= 2 &&
    f.trendContext >= -0.001;

  const momentum = signal(
    "MOMENTUM_CONTINUATION",
    changeScore * 0.24 + positiveFlow * 0.24 + accelerationScore * 0.18 +
      heatScore * 0.14 + positiveMicroMomentum * 0.10 + clamp(votes / 3) * 0.10,
    momentumPrimary,
    [
      "24시간 상승 흐름 위에서 전 종목 거래대금 가속이 재점화됨",
      "공격 매수·마이크로프라이스·근접 호가가 상승 지속을 확인함",
    ],
    [
      "거래대금 가속 소멸",
      "공격 체결압력 음전환",
      "마이크로프라이스 하락 전환",
      "돌파 레벨 재진입",
    ],
  );

  const absorption = signal(
    "ABSORPTION_REVERSAL",
    f.bidAbsorptionScore * 0.45 + (f.persistentBidWall ? 0.18 : 0) +
      depthSupport * 0.15 + clamp(0.5 + f.tradePressureFast * 0.5) * 0.12 +
      positiveMicroprice * 0.10,
    absorptionPrimary,
    [
      "공격적 매도에도 인접 매수 유동성이 반복 재충전됨",
      "현재 가격이 흡수 가격대 위에서 유지됨",
    ],
    ["매수벽이 체결 없이 취소", "매도 체결 가속", "마이크로프라이스 하락 전환"],
  );

  const depletion = signal(
    "QUEUE_DEPLETION_BREAKOUT",
    f.breakoutScore * 0.48 + positiveFlow * 0.20 + positiveBook * 0.12 +
      positiveMicroprice * 0.10 + lowAskAbsorption * 0.10,
    depletionPrimary,
    [
      "매도벽이 취소가 아니라 실제 매수 체결로 소진됨",
      "소진 가격대가 매수 지지로 전환됨",
    ],
    ["돌파 레벨 재진입", "상단 재충전 급증", "OFI 부호 역전"],
  );

  const reclaim = signal(
    "SWEEP_RECLAIM",
    f.sweepReclaimScore * 0.55 + positiveFlow * 0.18 + positiveMicroprice * 0.15 +
      clamp(f.imbalanceStability) * 0.12,
    reclaimPrimary,
    ["다중 호가 스윕 뒤 가격과 호가가 빠르게 복구됨", "추격 매도가 약화됨"],
    ["스윕 저점 재이탈", "복구 호가 소멸", "반대 공격 체결 재가속"],
  );

  const ofi = signal(
    "OFI_CONTINUATION",
    f.ofiPersistence * 0.30 + positiveFlow * 0.26 + positiveBook * 0.18 +
      positiveMicroprice * 0.14 + clamp(f.imbalanceStability) * 0.12,
    ofiPrimary,
    ["주문흐름·공격 체결·마이크로프라이스가 같은 방향", "상대 매도 호가가 지속 소진됨"],
    ["반대 방향 공격 체결 급증", "OFI 부호 역전", "마이크로프라이스 불리한 이동", "핵심 레벨이 체결 없이 취소"],
  );

  const iceberg = signal(
    "REPLENISHMENT_ICEBERG",
    f.bidAbsorptionScore * 0.52 + (f.persistentBidWall ? 0.18 : 0) +
      clamp(f.imbalanceStability) * 0.15 + depthSupport * 0.15,
    false,
    ["표시 수량을 넘는 반복 체결 뒤 동일 가격 유동성이 재충전됨"],
    ["재충전 중단", "벽 가격 하향 이동", "취소 비율 급증"],
  );

  return [momentum, absorption, depletion, reclaim, ofi, iceberg]
    .sort((a, b) => b.confidence - a.confidence);
}

/** Highest-confidence directionally coherent primary pattern. */
export function detectLobPatternName(features: LobFeatureVector): LobPatternName | null {
  const primary = detectLobPatterns(features).find((pattern) => pattern.primary);
  return primary ? primary.name : null;
}
