// backtest/neutral-micro.ts
// 백테스트 전용: "중립" microstructure 스텁.
//
// 왜 필요한가:
//   동적 호가/체결 분석(computeDynamicOrderflow)은 실시간 오더북 스트림이 있어야
//   동작한다. 그런데 거래소 공개 REST는 과거 오더북 히스토리를 주지 않는다.
//   따라서 과거 캔들만으로는 마이크로구조 게이트를 "재현"할 수 없다.
//
//   해결책은 이것을 숨기는 게 아니라 명시적으로 격리하는 것이다.
//   여기서는 마이크로 게이트를 모두 '통과(NEUTRAL)'시키는 중립 스텁을 주입한다.
//   그 결과 백테스트가 측정하는 것은 순수 TA 엔진(기간추세·모멘텀·목표/손절 구조)의
//   조건부 예측력이다. 실시간 필터가 손실 신호를 제거하면 승률·기대값이 좋아질 수도,
//   이익 신호를 제거하면 나빠질 수도 있으므로 라이브 성과의 상한/하한으로 부르지 않는다.
//
//   마이크로 게이트 자체의 가치는 백테스트가 아니라 전진 페이퍼 트레이딩으로만
//   검증할 수 있다. README 참조.

import type { Microstructure } from "../supabase/functions/market-scanner/engine.ts";

export function neutralMicro(price: number): Microstructure {
  const bid = price * 0.9995;
  const ask = price * 1.0005;
  return {
    samples: 40,
    best_bid: bid,
    best_ask: ask,
    spread_bps: 10, // spread 게이트(<=35bp) 통과
    book_imbalance: 0, // micro_pressure 게이트(> -0.5) 통과
    imbalance_stability: 0.8,
    trade_pressure: 0, // micro_pressure 게이트(> -0.45) 통과
    trade_count: 40,
    buy_notional: 1,
    sell_notional: 1,
    micro_score: 50, // 중립 — 최종점수에 ±0 기여
    dynamic: {
      status: "NEUTRAL", // dynamic_safety 게이트 통과
      label: "동적 특이 위험 없음",
      sufficient: true, // micro_data 게이트 통과
      observation_ms: 60_000,
      distinct_book_updates: 40,
      aligned_trade_count: 40,
      covered_phases: 3,
      phase_book_updates: [14, 13, 13],
      phase_trade_counts: [14, 13, 13],
      phase_consistent: true,
      data_quality: 0.8,
      spoof_like_score: 0,
      ask_absorption_score: 0,
      breakout_score: 0,
      persistent_bid_wall_price: null,
      persistent_ask_wall_price: null,
      confirmed_support_price: null,
      target_cap_price: null,
      evidence: [],
      warnings: [],
    },
  };
}
