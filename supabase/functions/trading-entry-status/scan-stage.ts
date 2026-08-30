// Scan-stage rejection classification and aggregation.
//
// Kept apart from the request handler so the mapping from raw gate keys to operator-facing
// reasons is unit-testable without a database or a live Supabase function.

export const SCAN_REASON_SAMPLE_LIMIT = 600;

export type ScanCandidateRow = {
  decision?: unknown;
  failed_gates?: unknown;
  failed_gate_count?: unknown;
};

// Every key here is a gate key the scanner can write into
// `scanner_candidates.feature_vector.failed_gates`: the named gates from the engine's
// checklist, plus the LOB entry reasons that are carried through lowercased. An unmapped
// key still renders -- as its raw key -- because an unnamed reason the operator can look up
// is strictly better than a rejection that disappears.
export const SCAN_GATE_LABELS: Record<string, { reason: string; detail: string }> = {
  // Trend / universe gates
  data: { reason: "기간 데이터 부족", detail: "5분·15분·4시간·일봉 최소 표본을 확보하지 못했습니다." },
  market_event: { reason: "거래소 시장경보", detail: "유의·주의·경고 지정 종목이라 진입 대상에서 제외했습니다." },
  external_event: { reason: "뉴스·공시 이벤트 위험", detail: "언락·상장폐지 등 외부 이벤트 위험이 감지됐습니다." },
  liquidity: { reason: "거래대금 부족", detail: "최소 거래대금 기준을 충족하지 못했습니다." },
  freshness: { reason: "체결 최신성 부족", detail: "최근 체결이 충분히 최신이 아니었습니다." },
  live_price: { reason: "실시간 기준가 확보 실패", detail: "실시간 호가 기준가격을 확보하지 못했습니다." },
  trend_15m: { reason: "15분 추세 미달", detail: "15분봉 추세 조건을 통과하지 못했습니다." },
  trend_4h: { reason: "4시간 추세 미달", detail: "4시간봉 추세 조건을 통과하지 못했습니다." },
  trend_context: { reason: "중기 추세 맥락 미달", detail: "중기 추세 맥락이 진입 조건과 맞지 않았습니다." },
  overheat: { reason: "과열 제한", detail: "단기 과열 구간이라 진입을 제한했습니다." },
  micro_data: { reason: "호가·체결 표본 부족", detail: "동적 호가·체결 관측 표본이 부족했습니다." },
  spread: { reason: "스프레드 과다", detail: "매수·매도 호가 차이가 비용 기준을 넘었습니다." },
  depth: { reason: "호가 깊이 부족", detail: "주문을 소화할 호가 깊이·예상 슬리피지가 기준을 넘었습니다." },
  micro_pressure: { reason: "초단기 수급 미달", detail: "최근 체결 압력이 진입 기준에 미치지 못했습니다." },
  dynamic_safety: { reason: "동적 호가 안전성 미달", detail: "실시간 호가 안전성 판정을 통과하지 못했습니다." },
  minimum_edge: { reason: "최소 기대이동 미달", detail: "비용을 넘길 최소 기대 이동폭이 나오지 않았습니다." },
  stop: { reason: "손절폭 조건 미달", detail: "허용 손절폭 구조를 만들지 못했습니다." },
  target_structure: { reason: "목표가 구조 미달", detail: "목표가 구조가 진입 조건을 충족하지 못했습니다." },
  operator_fit: { reason: "운용 방식 부적합", detail: "자동 감시·청산 가능한 보유 구조가 아니었습니다." },
  reward_risk: { reason: "손익비 기준 미달", detail: "비용 포함 손익비가 최소 기준에 미치지 못했습니다." },
  score: { reason: "기간 추세점수 미달", detail: "기간 추세점수가 기준선 아래였습니다." },
  // LOB gates
  lob_data: { reason: "호가창 표본 부족·지연", detail: "LOB 표본이 부족하거나 호가가 최신이 아니었습니다." },
  lob_spread: { reason: "LOB 스프레드 과다", detail: "호가 스프레드가 진입 허용 범위를 넘었습니다." },
  lob_activity: { reason: "호가창 활동도 부족", detail: "호가창이 진입 기준만큼 활발하지 않았습니다." },
  lob_pattern: { reason: "호가창 패턴 미검출", detail: "진입 근거가 되는 주 호가 패턴이 검출되지 않았습니다." },
  lob_pressure: { reason: "체결압력 음수", detail: "실제 체결 압력이 매도 우위였습니다." },
  lob_spoof: { reason: "스푸핑 경고", detail: "허수 주문으로 의심되는 호가가 감지됐습니다." },
  lob_reward_risk: { reason: "비용 차감 손익비 미달", detail: "비용을 뺀 손익비가 최소 기준에 미치지 못했습니다." },
  lob_stop: { reason: "손실 상한 초과", detail: "필요한 손절폭이 절대 상한을 넘었습니다." },
  // Unnamed LOB reasons, carried through as lowercased gate keys
  outside_24h_gainer_top10: { reason: "24시간 상승률 Top10 이탈", detail: "관측 대상 상위 상승 종목 범위를 벗어났습니다." },
  turnover_too_low: { reason: "거래대금 부족", detail: "관측 시점 거래대금이 최소 기준 아래였습니다." },
  trade_speed_declining: { reason: "체결 속도 둔화", detail: "체결 속도가 관측 구간 동안 줄어들고 있었습니다." },
  notional_flow_declining: { reason: "체결대금 흐름 둔화", detail: "체결대금 유입이 관측 구간 동안 줄어들고 있었습니다." },
  no_live_buy_tape: { reason: "실시간 매수 체결 없음", detail: "관측 구간에 유효한 매수 체결 흐름이 없었습니다." },
  buy_pressure_not_confirmed: { reason: "매수 압력 확인 부족", detail: "공격 매수 우위가 확인되지 않았습니다." },
  buy_pressure_below_primary_threshold: { reason: "매수 압력 기준 미달", detail: "매수 압력이 1차 기준선 아래였습니다." },
  aggressive_buy_notional_below_primary_threshold: { reason: "공격 매수 대금 부족", detail: "공격 매수 체결대금이 1차 기준선 아래였습니다." },
  sell_pressure_dominant: { reason: "매도 압력 우세", detail: "매도 압력이 매수 압력보다 강했습니다." },
  two_sided_spoof_risk: { reason: "양방향 허수호가 위험", detail: "매수·매도 양쪽에서 허수성 호가가 감지됐습니다." },
  bid_spoof_confirmed_by_weak_flow: { reason: "매수 허수호가 확인", detail: "매수벽이 실제 체결로 뒷받침되지 않았습니다." },
  support_breakdown_risk: { reason: "지지 붕괴 위험", detail: "관측 중 지지 호가가 무너질 위험이 감지됐습니다." },
  unexecutable_orderbook_depth: { reason: "체결 가능 깊이 부족", detail: "주문 수량을 소화할 체결 가능 호가가 없었습니다." },
  net_ev_not_positive: { reason: "순 기대수익 음수", detail: "비용을 반영한 기대수익이 0 이하였습니다." },
  ev_lower_bound_not_positive: { reason: "기대수익 하한 음수", detail: "기대수익의 보수적 하한이 0 이하였습니다." },
  net_payoff_too_weak: { reason: "순 손익 구조 취약", detail: "비용 차감 후 남는 손익 구조가 너무 얇았습니다." },
  target_net_cushion_too_small: { reason: "목표가 여유 부족", detail: "비용을 뺀 목표가 여유폭이 최소 기준 아래였습니다." },
  target_net_profit_too_low: { reason: "목표 순이익 부족", detail: "목표 도달 시 순이익이 최소 기준 아래였습니다." },
  stop_target_asymmetry: { reason: "손절·목표 비대칭", detail: "손절폭 대비 목표폭 비율이 허용 범위를 벗어났습니다." },
  stop_to_target_ratio_failed: { reason: "손절·목표 비율 미달", detail: "손절 대비 목표 비율이 기준을 통과하지 못했습니다." },
  extreme_24h_range: { reason: "24시간 변동폭 과다", detail: "하루 변동폭이 과도해 진입에서 제외했습니다." },
  extreme_24h_drawdown: { reason: "24시간 낙폭 과다", detail: "고점 대비 낙폭이 과도해 진입에서 제외했습니다." },
  lob_dynamic_evidence_insufficient: { reason: "실시간 근거 부족", detail: "실시간 호가·체결 교차검증 근거가 부족했습니다." },
  insufficient_lob_samples: { reason: "호가 표본 부족", detail: "호가창 관측 표본이 최소 기준에 미치지 못했습니다." },
  insufficient_effective_observation: { reason: "유효 관측시간 부족", detail: "유효 관측 시간이 최소 기준에 미치지 못했습니다." },
  stale_orderbook: { reason: "호가 데이터 지연", detail: "호가 스냅샷이 충분히 최신이 아니었습니다." },
  spread_too_wide: { reason: "스프레드 과다", detail: "호가 스프레드가 허용 범위를 넘었습니다." },
  book_not_hot_enough: { reason: "호가창 활동도 부족", detail: "호가창 활동도가 진입 기준 아래였습니다." },
  no_primary_lob_pattern: { reason: "호가창 패턴 미검출", detail: "주 호가 패턴이 검출되지 않았습니다." },
  negative_trade_pressure: { reason: "체결압력 음수", detail: "체결 압력이 매도 우위였습니다." },
  spoof_warning: { reason: "스푸핑 경고", detail: "허수 주문으로 의심되는 호가가 감지됐습니다." },
  reward_risk_failed: { reason: "손익비 기준 미달", detail: "비용 차감 손익비가 기준을 통과하지 못했습니다." },
  preorder_support_evaporation_confirmed: { reason: "주문 직전 지지 소멸", detail: "최종 재검증에서 매수 지지가 사라졌습니다." },
  m1_candle_data_unavailable: { reason: "1분봉 데이터 없음", detail: "1분봉 데이터를 확보하지 못했습니다." },
  m1_candle_data_insufficient: { reason: "1분봉 데이터 부족", detail: "1분봉 표본이 최소 기준에 미치지 못했습니다." },
  m1_previous_candle_not_bullish: { reason: "직전 1분봉 음봉", detail: "직전 1분봉이 상승 마감하지 않았습니다." },
  m1_upper_band_not_touched: { reason: "1분봉 상단밴드 미접촉", detail: "직전 1분봉이 볼린저 상단에 닿지 않았습니다." },
  m1_upper_band_not_rising: { reason: "1분봉 상단밴드 하락", detail: "볼린저 상단 밴드가 상승 전환하지 않았습니다." },
  m1_band_width_not_expanding: { reason: "1분봉 밴드폭 미확장", detail: "변동성 확장이 확인되지 않았습니다." },
  m1_stoch_k_not_above_d: { reason: "1분봉 스토캐스틱 미교차", detail: "스토캐스틱 %K가 %D 위로 올라오지 않았습니다." },
  m1_late_extension_chase: { reason: "1분봉 과확장 추격", detail: "이미 확장된 뒤라 추격 진입으로 판정했습니다." },
  m1_momentum_chase_volume_fade: { reason: "1분봉 거래량 소진", detail: "상승 중 거래량이 줄어드는 추격 구간이었습니다." },
  m1_prebreakout_setup_not_ready: { reason: "돌파 전 셋업 미완성", detail: "돌파 직전 셋업 조건이 아직 완성되지 않았습니다." },
  m1_auxiliary_score_too_low: { reason: "1분봉 보조점수 미달", detail: "1분봉 보조 지표 점수가 기준 아래였습니다." },
  calibration_not_ready: { reason: "캘리브레이션 미완료", detail: "검증된 캘리브레이션이 아직 준비되지 않았습니다." },
  pfill_lower_bound_too_low: { reason: "체결 확률 하한 미달", detail: "지정가 체결 확률의 보수적 하한이 기준 아래였습니다." },
};

export function classifyScanGate(key: string): { reason: string; detail: string } {
  const normalized = String(key || "").trim().toLowerCase();
  if (!normalized) return { reason: "기타 스캔 조건 미달", detail: "세부 스캔 조건을 통과하지 못했습니다." };
  const known = SCAN_GATE_LABELS[normalized];
  if (known) return known;
  return {
    reason: `기타 스캔 조건 미달 (${normalized.replaceAll("_", " ").slice(0, 60)})`,
    detail: "라벨이 정의되지 않은 스캔 게이트입니다. 원본 게이트 키를 그대로 표시합니다.",
  };
}

export type ScanStageSummary = {
  observed: number;
  buy: number;
  rejected: number;
  reason_sample_size: number;
  reason_sample_truncated: boolean;
  reasons_available: boolean;
  top_reasons: Array<{ reason: string; count: number; detail: string }>;
};

export const EMPTY_SCAN_STAGE: ScanStageSummary = {
  observed: 0,
  buy: 0,
  rejected: 0,
  reason_sample_size: 0,
  reason_sample_truncated: false,
  reasons_available: true,
  top_reasons: [],
};

/**
 * Turn a sample of refused scanner candidates into the operator-facing reason histogram.
 *
 * `observed` and `buy` are exact counts taken separately, so a truncated sample can never
 * understate how many books were refused -- only which gates are shown for them.
 */
export function summarizeScanStage(
  observed: number,
  buy: number,
  sample: ScanCandidateRow[] | null,
): ScanStageSummary {
  const rejected = Math.max(0, observed - buy);
  if (!Array.isArray(sample)) {
    // The counts above are still exact and still worth showing. Only the per-gate
    // breakdown is unavailable, and saying so beats printing an empty list that reads
    // as "no reasons".
    return { ...EMPTY_SCAN_STAGE, observed, buy, rejected, reasons_available: false };
  }

  const counts = new Map<string, { count: number; detail: string }>();
  let attributed = 0;
  for (const row of sample) {
    const gates = Array.isArray(row?.failed_gates) ? row.failed_gates as unknown[] : [];
    if (!gates.length) {
      // The row failed something (it is not a BUY) but the gate list did not survive.
      // Bucketing it explicitly keeps the histogram total honest against `rejected`.
      const fallback = classifyScanGate("");
      const current = counts.get(fallback.reason) || { count: 0, detail: fallback.detail };
      current.count += 1;
      counts.set(fallback.reason, current);
      attributed += 1;
      continue;
    }
    // A book is counted once per distinct gate it failed, so "which gate is blocking
    // everything" stays answerable even when a single market fails several at once.
    const seen = new Set<string>();
    for (const key of gates) {
      const classified = classifyScanGate(String(key));
      if (seen.has(classified.reason)) continue;
      seen.add(classified.reason);
      const current = counts.get(classified.reason) || { count: 0, detail: classified.detail };
      current.count += 1;
      counts.set(classified.reason, current);
    }
    attributed += 1;
  }

  return {
    observed,
    buy,
    rejected,
    reason_sample_size: attributed,
    reason_sample_truncated: sample.length >= SCAN_REASON_SAMPLE_LIMIT,
    reasons_available: true,
    top_reasons: [...counts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 8)
      .map(([reason, value]) => ({ reason, count: value.count, detail: value.detail })),
  };
}
