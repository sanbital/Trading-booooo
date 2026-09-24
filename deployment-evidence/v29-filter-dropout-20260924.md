# V29 — 강세장 0거래(필터 연쇄 탈락) 원인 규명 및 수정 (2026-09-24)

## 방법 (재현성)
- 후보: `v11_long_regime_signals` 의 실제 production V17 신호 전부 2,567건 (2026-09-08 → 09-24, 238종목).
- 가격: Binance USDⓈ-M 1m klines 327,098봉 + BTC 15m, production DB `http` 확장으로 읽기 전용 수집(테이블 생성·쓰기 없음).
- 로직: production 모듈을 그대로 import (`leader-pullback-reaccel`, `leader-b06133-entry`, `leader-cec0040`의 P142 청산 커널/EWMA).
  재현 검증: setup 상태 1,200/1,232 일치, B06133 판정 324/325 일치.
- 청산: P142/R5 production 커널, LOW_FIRST/HIGH_FIRST/CLOSE_ONLY 평균. 비용 2종: 현실(수수료 5+5bp, 진입 5bp, 청산 10bp) / 스트레스 44bp(CEC 목표 기준).
- 진입가: 결정 직후 다음 1분봉 시가(lookahead 없음). 600 USDT notional(200×3).
- 보정: 실제 청산 350건 대비 시뮬레이션 −608 vs 실제 −404 USDT (상관 0.61) → 시뮬레이터는 보수적.
- 스크립트: `research/v29-filter-dropout-20260924/`.

## 핵심 결론
1. 최근 16일 V17 후보는 **모든 인과적 진입 타이밍에서 음의 기대값**:
   즉시진입 −1.20, 눌림 재가속 −1.44, 돌파(+1%) 지속 진입 −1.16 USDT/거래.
2. 초강세(dayReturn ≥ 20%) 종목이 가장 나쁨 (16d 눌림 −2.80/거래, 즉시 −1.10, 돌파 −2.07).
3. CHASE_EXPIRED/SETUP_EXPIRED 표본의 “즉시 진입 성과” 비교는 결과로 표본을 고르는 lookahead라 무효.
   인과적 대안(돌파 시점 진입)은 24h +72, 48h −8, 7d −684, 16d −826 USDT → 놓친 상승이 체계적이지 않음.
4. B06133 통과군이 거절군보다 나쁨 (16d −3.36 vs −1.21/거래, 7d −3.54 vs −1.49). 가치는 “거래 수 억제”뿐.
5. CEC0040 EWMA −3.67 은 9/20 시드(+0.99) 이후 **실거래 9건의 실제 target(8건 손실)** 으로 떨어진 값 → 현재 국면 정보.
6. GPT production 판정은 1건(NIL 23:32 VETO). 사후 경로는 하드스탑(−16.2 USDT) → 결과적으로 손실 회피.
   단 근거 중 “ask depth/600 USDT = 36배”를 반대 근거로 인용(방향 오독). V5 핵심 근거(15분 고점 대비 거리)는
   트리거 1,119건에서 성과와 단조 관계 없음.

## Ablation (portfolio: 종목당 1포지션, 동시 4, 현실 비용 / 44bp)
| arm | 12h | 24h | 48h | 7d | 16d |
|---|---|---|---|---|---|
| 즉시진입, 게이트 없음 | −220 (43) | −505 (96) | −605 (209) | −9 (763) | −466 (1437) |
| 눌림만 | −200 (20) | −295 (42) | −467 (103) | −842 (446) | −1050 (777) |
| 눌림+B06133 | −42 (3) | −29 (5) | −87 (18) | −233 (77) | −336 (112) |
| **눌림+B06133+CEC (현행)** | −26 (2) | −13 (4) | −42 (9) | −124 (29) | −118 (42) |
| 눌림+CEC (B06133 제거) | −91 (8) | −154 (18) | −88 (45) | −315 (195) | −466 (342) |
| 눌림+v25 게이트(day<8%,vr≥1.3) | −125 (10) | −125 (10) | −103 (16) | +55 (52) | +184 (105) |
| 눌림+v25+CEC | −66 (5) | −66 (5) | −56 (10) | +123 (40) | +132 (58) |

- 어떤 게이트 제거도 DB24/48에서 현행보다 나쁨 → 게이트 완화는 검증 실패.
- v25 게이트 교체안은 7d/16d 개선이나 12h/24h/48h 악화 → “명확한 개선” 아님 → 배포하지 않음.

## 배포한 변경
- GPT V6 (실시간 위험 검수 전용): B06133/CEC/V17 재검증 제거, 서버 결정론적 위험 플래그(HARD/SOFT),
  VETO는 열거 범주 + 위험 방향의 현재 수치만 유효, HARD/데이터 불완전 시 PASS 불가.
- regime guard: registry 기반 함수 복구 (9/9 23:30 이후 hysteresis revision 행을 전부 false로 강제하던 회귀).
- signal generator 재배포: 신호의 `targetMarginUsdt` 스탬프 30 → 200 (executor 실주문은 이미 200×3).

## 배포 증거 (2026-09-24 UTC)
- 사전 점검 00:39Z (executor `ops-readiness`, 주문 없음): Binance 포지션 0 / 일반주문 0 / 조건부주문 0,
  DB OPEN 0, 미해결 주문 0, circuit=false, lease 비어 있음, operator entry_enabled=true, 가용 363.80 USDT.
- 소스 커밋 `644a8b858d775799cc887f47cbde4e310b47af80`, 수동 release 워크플로(회귀 199/199, deno check, 버전 고정, 번들 동일성 검증):
  - run 35939653634 → `v10-lane-signal-generator` v25 → **v26** (ezbr 86c42357…)
  - run 35939712123 → `v10-lane-executor` v71 → **v72** (ezbr c638ea66…)
- DB 마이그레이션 `20260924003950_restore_registry_regime_influence_guard` 적용.
- 사후 검증:
  - regime: 00:40:03Z 부터 `trading_influence=true` (NEUTRAL, bull 46.6) 연속 기록.
  - 신규 신호 00:45Z 스탬프 `targetMarginUsdt=200, leverage=3, V17_SLOT_SIZING_3_FEASIBLE_LATTICE`.
  - preflight(ETHUSDT): qty 0.224 × 2685.5 = 601.55 USDT notional, margin 200.52, 불변식 6/6.
  - GPT V6 실API 프로브(주문 0): BTCUSDT VETO(SELL_WALL_IMBALANCE, imbalance −0.489, 4.6s),
    ETHUSDT PASS(1.4s). 두 경로 모두 서버 검증 통과.
  - 실거래 cron: v72 가 setup ARMED/PULLBACK_OBSERVED 진행, last_error=null.
