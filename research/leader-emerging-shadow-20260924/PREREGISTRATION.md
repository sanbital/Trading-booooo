# LE-SHADOW-1 사전등록 (Top30 Leader/Emerging order-free SHADOW)

- 등록 시각: 2026-09-24 (UTC), **첫 배포와 첫 GPT 호출 전에** 이 문서를 커밋한다.
- 코드: `supabase/functions/leader-emerging-shadow/` (PATCH `LE-SHADOW-1`, lane 규칙 `LE_LANES_1`, 결과 라벨 `LE_OUTCOME_1`, GPT 계약 `LE_GPT_ALT1_1`)
- 근거 감사: `research/leader-emerging-shadow-20260924/README.md` (조건부 권장)
- 이 문서의 모든 수치는 **결과를 보기 전에 고정**한다. 변경은 새 버전(`LE_LANES_2` 등)과 새 표본 시작일로만 한다. 이전 표본과 섞지 않는다.

## 1. 목적과 범위

이 SHADOW는 **데이터 수집 도구**다. production 진입·주문·포지션·GPT 판단·control·사이징(200 USDT × 3)을 바꾸지 않는다.
답하려는 질문은 과거 데이터로 답할 수 없는 세 가지다.

1. 11~30위(Emerging)의 **실제 실행비용**(spread, 600 USDT 슬리피지, depth)이 기대 edge(비용 전 15~25 bps)를 이미 잠식하는가.
2. Emerging/Leader 첫 진입의 **비용 차감 후** 60/120분 성과가 대조군보다 나은가.
3. (2단계) SKIP 봉쇄를 제거한 GPT(ALT1)가 결정론적 규칙보다 **판별력**이 있는가, WAIT가 진입가·결과를 개선하는가.

## 2. 가설 (방향 고정)

| ID | 가설 | 근거(감사) | 판정 지표 |
|---|---|---|---|
| H1 | EMERGING 첫 선정의 60분 순 bps(현실 비용) > 0 | 1h +0.15~0.25% 비용 전, t 1.7~2.2 | RULE_BASELINE 의 EMERGING BUY, `hyp_net_bps_real_60m` |
| H2 | EMERGING BUY − 같은 사이클 CONTROL(관찰자 라벨) 60분 초과 > 0 | 위와 동일 | v_compare 3군 − 5군 |
| H3 | Top10 & vr15 ≥ 4 는 60분 수익이 음(−) | 최초 진입 1h −0.415%, t −2.96 (견고) | SOFT `VOLUME_OVERHEATED` true 인 선정 후보 |
| H4 | 순위 4~10 CONTROL 의 60분 초과수익은 음(−) | 초과 t −3.17 (견고) | CONTROL rank 4~10 관찰자 라벨 |
| H5 | LEADER 첫 Top3 진입의 60분 순 bps ≤ 0 | 최초 진입 1h −0.162% | RULE_BASELINE LEADER BUY |
| H6 (2단계) | GPT_ALT1 BUY 의 순 bps > RULE_BASELINE BUY 의 순 bps | 없음(탐색) | 같은 후보 짝비교 |
| H7 (2단계) | WAIT_MECHANICAL 진입가 < 같은 후보 BUY-now 진입가, 만료 WAIT 의 기회비용 포함 순효과 > 0 | 없음(탐색) | `wait_events` + outcomes |

H1·H2 가 주 가설이다. 나머지는 부 가설이며 다중비교 보정 없이 **판정에 쓰지 않고 보고만** 한다.

## 3. Universe, 순위, velocity (고정)

- Universe: `market_regime_observations` (`MARKET-REGIME-OBSERVER-v2-C01-HYSTERESIS-v1-FULLMARKET`) 의 `liquid_prices` `BF:<SYMBOL>` 가격, 5분마다. Binance weight 0.
  관찰자 행이 6분보다 오래되면 `GET /fapi/v1/ticker/price`(weight 2) fallback (`cycles.source='TICKER'`).
- COIN perpetual 필터: production `activeSymbols()` (TRADING, PERPETUAL, USDT, `underlyingType='COIN'`, 110×15m warm-up) 를 KST 일 1회 `exchangeInfo` 로 적용.
- KST 일시가: 15:00Z 이후 **첫 관찰자 스냅샷**(`shadow_le.day_anchor`). 6분 초과 지연이면 `anchor_quality='LATE'`.
- 순위: `day_return_live = price / anchor − 1` 내림차순(동률은 심볼순). anchor 없는 신규 상장은 제외하고 수를 기록한다.
- 과거 순위: 자체 이전 SCAN 사이클 중 15/30/60분 전(±150초)에 가장 가까운 것.
- **velocity_valid**: KST 00:00 후 60분 이내이면 무효. 참조 스냅샷이 이전 KST 일이면 그 lookback 은 무효.
  (분석 시 `minutes_since_kst_midnight` 로 층화한다. 임계값은 바꾸지 않는다.)

## 4. Lane / Shortlist (고정, `LE_LANES_1`)

- `LEADER`: rank ≤ 3
- `EMERGING`: rank 4~30 AND velocity_valid AND ((rank_60m − rank ≥ 20) OR (rank_15m − rank ≥ 10))
- 나머지 top30: `CONTROL`
- shortlist(사이클당 ≤ 3):
  - LEADER ≤ 1: 당일 Top3 첫 진입 또는 60분 이상 Top3 밖에 있다가 재진입. 복수면 rank 순.
  - EMERGING ≤ 2: velocity = max(rank_15m − rank, rank_60m − rank) 내림차순 → 동률이면 vr15 낮은 순 → rank → 심볼.
    (동률이 정원 경계에 걸릴 때만 해당 심볼들의 15m klines 를 읽어 vr15 를 구한다.)
  - 심볼 cooldown 30분(직전 30분 안에 선정된 심볼 제외).
- vr15 = production V17 정의(마지막 완료 15m 거래대금 / 직전 20개 평균).

## 5. 결정 arm (1단계, GPT 없음)

- `RULE_BASELINE`: HARD 차단 → `SKIP_DETERMINISTIC`. LEADER 는 당일 첫 Top3 진입 AND ¬(Top10 & vr15 ≥ 4) 일 때 BUY (재진입은 SKIP).
  EMERGING 은 ¬(Top10 & vr15 ≥ 4) 일 때 BUY. 그 외 SKIP.
- `TAKE_ALL`: shortlist 전부 BUY (HARD 차단 포함; 무필터 기준선).
- HARD 실행 차단(전략 판단이 아니라 600 USDT 실행 불가): spread > 25 bps, ask_depth_to_order < 1.5, est_buy_slippage_bps ≥ 25, 호가 사실 결측.
- 가상 진입가: 결정 시점 `GET /fapi/v1/depth?limit=5` 의 best ask.

## 6. 2단계 GPT ALT1 (별도 GO 필요, 현재 `gpt_enabled=false`)

- 모델 `gpt-5.4-mini-2026-03-17`, strict JSON schema, 8초, 재시도 없음, 무효 → ABSTAIN.
- 선택지 BUY/WAIT/SKIP/ABSTAIN 이 항상 존재. SKIP 사유 `NO_EDGE_OVER_COST` 는 언제나 인용 가능, SOFT 카테고리는 서버가 true 로 계산했을 때만.
- SOFT: `VOLUME_OVERHEATED`(Top10 & vr15 ≥ 4), `EXTENDED_LEADER`(day ≥ 20% & 당일 Top10 첫 진입 1h 이내), `RANK_FADING`(rank_15m − rank ≤ −5), `COST_EXCEEDS_EDGE`(spread + 슬리피지@600 + 수수료 10 ≥ 35 bps).
- BUY 는 `expected_move_bps > breakeven_bps` 와 사실 키 2개 이상을 요구.
- WAIT: TTL 10분 고정, trigger 1개(`PULLBACK_HOLD` X∈[15,60], `BREAKOUT_CONFIRM` Y∈[10,50] & 1m taker > 0.5, `SPREAD_NORMALIZE`, `BOOK_IMPROVE`, `FLOW_TURN`, `RANK_CONFIRM`),
  무효화 가격 ±1%·순위 −10·TTL, trigger 충족 시 `WAIT_MECHANICAL` 가상 진입 + GPT 재질의 1회(WAIT 불가).
- 가상 진입가: GPT 응답 **후** best ask.
- 예산: 별도 키 `OPENAI_API_KEY_SHADOW`, `shadow_le.budget` 250콜/일·$1.00/일·동시 2·사이클 3. production FD1 60분 429/quota ≥1, 오류율 > 20%, 당일 production 원장 ≥ 250콜이면 정지.

## 7. 결과 정의와 비용 (고정, `LE_OUTCOME_1`)

- 정밀 라벨(선정 후보, GPT/WAIT BUY): 진입 분부터 1m klines 241개. `hyp_fwd_{5,15,30,60,120,240}m`, MFE/MAE 60·240.
- 청산 시뮬레이션: production `replayP142Target` (style `retestAnchor`, LOW_FIRST/HIGH_FIRST/CLOSE_ONLY 3경로 평균), 4시간 창 밖은 마지막 가격 평가(`CENSORED_240M`).
- 현실 비용: 수수료 5 + 5 bps + 측정 진입 슬리피지(600 USDT, ask 초과분) + 청산 5 bps. 스트레스: 44 bps.
- notional 600 USDT 고정. 450 USDT 슬리피지는 보조 컬럼(`hyp_cost_bps_real_450`).
- CONTROL 및 전 top30: 관찰자 5분 가격 라벨(±150초), 가정 비용 20 bps / 스트레스 44 bps.
- production 연결: 같은 심볼 [관측 −15분, +30분] 의 signals / FD1 PRODUCTION 리뷰 / orders / positions (읽기 전용).
- 1슬롯 용량 제약 포트폴리오: `shadow_le.portfolio_1slot(arm, from, to)`.

## 8. KPI

- 운영(매일): 사이클 실행률 ≥ 95%, 관찰자 ≤ 6분 비율, velocity_valid 비율, micro_complete ≥ 90%, 사이클 weight ≤ 100, used-weight 최대, shadow role 의 production 쓰기 0.
- 비용: lane 별 spread, 슬리피지@600(ask 초과분), ask_depth_to_order, `COST_EXCEEDS_EDGE` 비율, HARD 차단 비율.
- 행태: arm × lane 결정 분포, (2단계) WAIT trigger/만료/무효화, SKIP 사유 분포.
- 성과(판정 아님, n 과 95% CI 만): v_compare 5군 × 60/120분 순 bps(현실/44), 시뮬레이션 순 bps, MFE/MAE, 승률.

## 9. 판정 규칙

- **판정 최소 표본**: ≥ 15 거래일 AND ≥ 300 EMERGING-BUY(RULE_BASELINE). 그 전에는 어떤 성과 판정도 하지 않는다. 내일 오전 소표본으로 판정하지 않는다.
- 주 검정: EMERGING-BUY 의 `hyp_net_bps_real_60m` 일자 평균에 대한 day-clustered t (단측, α = 0.05) 와 1슬롯 시뮬레이션 순손익 > 0. 둘 다 충족해야 "H1 지지".
- H2: 같은 날의 3군 − 5군 60분 초과(관찰자 라벨 기준, 같은 비용 가정) 일자 평균의 day-clustered t.
- **중단 규칙**: 배포 7일 후 EMERGING-BUY `hyp_net_bps_real_60m` 평균 < −10 bps AND 95% CI 상한 < 0 이면 수집 종료(가설 기각).
- 운영 중단(즉시): shadow role 의 production 쓰기 1건, production scanner `SHARED_IP_WEIGHT_HIGH` 또는 Binance 418/429, production FD1 API 오류/quota 증가, executor `last_error` 회귀. micro_complete < 90% 구간은 결과 무효.

## 10. 하지 않는 것

production 반영 논의는 §9 최소 표본 이후에만 한다. 임계값·lane·비용·horizon 을 결과를 보고 바꾸지 않는다.
사이징(200 × 3)은 이 연구와 무관하며 바꾸지 않는다.
