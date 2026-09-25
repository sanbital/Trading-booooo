# LE-SHADOW-2 사전등록 (SHADOW V2: DISCOVERY + PARITY)

- 등록: 2026-09-25 00:50Z, **V2 첫 배포와 첫 V2 GPT 호출 전**, V2 outcome 0건 상태.
- 코드: `supabase/functions/leader-emerging-shadow/v2/` (PATCH `LE-SHADOW-2`, 축 `LE_AXES_2`/밴드 `LE_AXES_2_BANDS`, GPT 계약 `LE_GPT_ALT2_1`, 결과 `LE_OUTCOME_2`)
- 스키마: `supabase/migrations/20260925004814_leader_emerging_shadow_v2.sql` (shadow_le 전용)
- LE-SHADOW-1 사전등록(`PREREGISTRATION.md`)의 lane·shortlist·RULE_BASELINE·결과 정의는 **그대로** 유지한다. V2 는 그 위에 추가만 한다.

## 1. 왜 V2 인가 (밤사이 V1 실측, DB 재계산 2026-09-25 00:25Z)

- 175 SCAN 사이클, 236 shortlist, Binance 오류 0, 최대 사이클 weight 104 이하(공유 IP used-weight 최대 104).
- RULE_BASELINE ALT-only BUY(`3_CURRENT_SKIP_OR_NOT_SEEN_ALT_BUY`) n=152: 60m 순 −48.2 bps, 120m 순 −41.4 bps, 60m 승률 35.5%.
  (보고치 −47.2 / −38.1 / 36.1% 는 그 시점까지 성숙한 표본 기준. 방향·크기 일치.)
- 큰 손실(60m ≤ −100 bps, n=58) vs 큰 수익(≥ +100 bps, n=33): 15m 순위 개선 41.5 vs 27.2 계단, 5m 거래량 배수 3.23 vs 2.53,
  vr15 평균 2.49 vs 1.96(중앙값 1.32 vs 1.33, 차이는 꼬리). **taker buy 5m 는 0.534 vs 0.537 로 사실상 동일** — "손실 후보의 taker buy 가 더 높다"는 보고는 교정한다.
- V1 의 CURRENT/ALT 는 production 결정과 같은 순간·같은 스냅샷이 아니다(±15/30분 창 연결). V2 PARITY 가 이를 해결한다.

## 2. 고정 항목

| 항목 | 값 |
|---|---|
| DISCOVERY GPT 대상 | V1 shortlist 중 hard safety 통과, LEADER ≤1 + EMERGING ≤1, 순서: overheat 플래그 수 → continuation 상태 → execution 상태 → rank (속도·거래량은 양의 정렬키가 아님) |
| PARITY 대상 | production `gpt_final_entry_reviews` PURPOSE=PRODUCTION, task=ENTRY, 생성 15분 이내. 같은 facts/execution_ref/model_judgments 재사용, production 답은 비공개 |
| PARITY 지연 한도 | 스냅샷 후 5분 초과 → ALT 미질의(`PARITY_LAG_EXCEEDED`) |
| 스냅샷 신선도 | ≤25 s 그대로, 25~120 s 호가만 재조회(`SHADOW_LIVE_READ_BOOK_REFRESHED`), >120 s GPT 미질의(`STALE_SNAPSHOT`) |
| BUY 조건(서버 검증) | phase ∈ {EARLY, MID}_CONTINUATION, overheat_view ≠ OVERHEATED, expected_move > breakeven, 사실 ≥2 중 비강도 사실 ≥1, hard_safety 비어 있음, 부정 advisory 모델(CEC0040 REJECT / B06133 불허 / V30 불인정)에는 override(열거 코드 + 사실 ≥2) |
| WAIT | reason + trigger 1개 + TTL 5~15분. trigger → 재질의 1회(BUY/SKIP/ABSTAIN), TTL/무효화(가격 −1.2%/+2%, 순위 −10, RANK_HOLD 실패) → 결정론적 SKIP |
| 비용 | 수수료 5+5 bps(production taker), 진입 슬리피지 = FD1 est_buy_slippage(600 USDT) − spread/2, 청산 슬리피지 5 bps(가정). 모르면 net=null(`GROSS_ONLY`) |
| 결과 | 5/15/30/60/120/240분 ret, MFE, MAE, gross, net; 진입 = 이벤트 스냅샷 ask (WAIT→BUY 는 trigger 후 ask) |
| 예산 | DISCOVERY 300콜/1.50 USD, PARITY 200콜/1.00 USD (UTC 일), 동시 3, 소진 시 `SHADOW_BUDGET_EXHAUSTED` |
| Binance | V2 가드 cycle cap 60, 공유 used-weight ≥1000 중단, 418/429/451 당일 정지, production scanner 가 weight/429 차단을 보고하면 V2 는 읽지 않음 |

## 3. 비교 그룹과 판정

`shadow_le.v2_compare` / `shadow_le.v2_group_stats(from,to,60|120)`.
PARITY 1~7, DISCOVERY 8~10 (명세 §16). 판정은 사전등록 V1 §9 와 같은 원칙: **≥15 거래일 AND PARITY ALT_BUY ≥100, DISCOVERY ALT_BUY ≥100** 전에는 성과 판정 없음.
주 질문(방향 고정):
- P1: 4군(CURRENT_SKIP/ALT_BUY) 60m net > 0, 그리고 3군(CURRENT_BUY/ALT_SKIP) 60m net < 1군(CURRENT_BUY/ALT_BUY).
- P2: 2군 WAIT→BUY 진입가가 이벤트 스냅샷 ask 보다 낮고, 만료 WAIT 의 기회비용 포함 순효과 > 0.
- D1: 8군 60m net > 10군 60m net, 그리고 8군 60m net > 0.
보고만(판정 없음): overheat 수준별 net, 큰 수익 포착률, 큰 손실 회피율, override 사용 빈도와 결과.
