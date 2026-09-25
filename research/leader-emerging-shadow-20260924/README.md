# Top30 Leader/Emerging + 점수화 + GPT 최종판단 — order-free SHADOW 타당성 감사 (2026-09-24)

범위: 조사·설계검토·위험검토·권고만. production 코드/설정/주문/포지션/GPT 판단 변경 없음, SHADOW 배포 없음.
DB 접근은 전부 읽기 전용 SELECT. 재현 쿼리: `queries.sql`.

기준 시점: main `3f3a839` (executor v82 `FD1-GPT-FINAL-RECHECK-1`, signal-generator v26), 연구 브랜치
`research/leader-score-gpt-v1` (`f6f3ec5`, Draft PR #182, main 대비 +2 파일 / +83 줄), Supabase `etaajwpernzrcdrifdnw`
(조회 시각 ≈ 2026-09-24 08:30Z).

---

## 1. 한 줄 결론

**조건부 권장.** 과거 데이터로는 답할 수 없는 질문(11~30위 호가·슬리피지, WAIT 효과, GPT의 BUY 편향)을 재는 도구로서 가치가 있고,
production 변경 없이 거의 0에 가까운 추가 Binance weight로 붙일 수 있다. 단,

- (a) 과거 패널이 보여준 edge는 비용 차감 전 **+0.15~0.25% (1h)** 수준에 day-clustered t ≈ 1.7~2.2이며 2h에서 사라진다.
  "대안 모델이 낫다"는 근거가 아니라 "관찰할 가설"이다.
- (b) **내일 오전 데이터로는 성과 판정이 통계적으로 불가능하다** (Emerging 이벤트 ~70~100건, 1h 수익률 표준편차 2~3% → SE 0.25~0.35%p > 기대효과).
  내일 오전은 배관·비용·GPT 행태 점검이다.
- (c) GPT 호출이 포함되는 단계는 별도 OpenAI 키/예산과 크레딧 보호 조건(§11)이 충족될 때만 붙인다.
  오늘 03:15Z경 OpenAI 크레딧 소진으로 production GPT가 전부 ABSTAIN 된 전례가 있다.
  조건이 오늘 안 되면 **1단계(GPT 없는 결정론적 스캔·후보·outcome 기록)만 오늘 붙이고 GPT는 2단계로 미룬다.**

---

## 2. 현재 production 구조 (실제 코드 기준)

| 단계 | 코드 | 내용 |
|---|---|---|
| 스캔 | `v10-lane-signal-generator/index.ts` → `_shared/leader-market-v17.mjs` `scanMarket` | 5분 cron. USDT-M COIN perpetual 전체(≈525)에 15m klines(limit 110, weight 2)를 읽어 KST 일간수익률(15m 종가)로 순위. 1회 weight ≈1,056~1,063, 소요 ≈0.95s. `x-mbx-used-weight-1m ≥ 2100`이면 `SHARED_IP_WEIGHT_HIGH`로 중단. `v17_market_scan_runs.details`에는 **top10만** 저장. |
| 후보 | `_shared/leader-momentum-v17.mjs` `entryReason`/`confirm5` | rank≤10, day≥3%, qv24≥5M, r15>0, r30≥0.75%, r60≥1.5%, **vr15≥1.1**, 5m 확인(r5≥0.2%, r15>0, 양봉). 30분 cooldown. |
| 타이밍 | `_shared/leader-pullback-reaccel.mjs` (`V17_GPT_CONTINUATION_ENTRY_2`) | 15분 setup: 0.25% 눌림 후 재가속 **또는** 눌림 없는 continuation, 종가 ∈ [ref×1.0025, ref×1.01], trigger TTL 60s. |
| 선택 | executor `applyB06133Selection` | B06133 계산·저장(REFERENCE_ONLY), **V30 = fresh5over15 ∧ ¬volumeTails 가 hard gate** (`V30_FRONT_SCORE_1`). |
| 통제 | executor `applyCec0040Selection` → RPC `v11_cec0040_decide` | 전략 전체 EWMA(현재 −4.07 USDT, n=126, reject_run 2). **advisory evidence** (hard gate 아님). RPC는 state `FOR UPDATE` + decisions insert → 상태를 바꾼다. |
| GPT | `_shared/gpt-final-decision/*` (FD1) via `FinalReviewCoordinator` | `gpt-5.4-mini-2026-03-17`, BUY/SKIP/ABSTAIN, 8s, 재시도 없음. 원장 `gpt_final_review_daily_budget` (control: ENFORCE, $3/일, 300콜/일). |
| 재확인 | `_shared/gpt-final-decision/recheck.mjs` | 변화 감지 시 GPT FINAL RECHECK. |
| 주문 | executor `openBull` | BOO gate, E1, 1% drift, IOC(12bps cap), native stop. |
| 사이징 | `_shared/leader-slot-sizing.mjs` | **200 USDT × 3x (600 notional), MAX_SLOTS 10, SETUP_MAX_CONCURRENT 4.** DB `trading_settings.binance_futures_allocation_usdt = 200` (불일치 시 `V17_MARGIN_CONFIG_MISMATCH`). 계정 equity 355.55 USDT → **실제 동시 가능 슬롯 1개.** |

**150 USDT는 현재 main/production 어디에도 없다.** 150으로 바꾸려면 코드 계약과 DB 행을 함께 바꿔야 하며(아니면 전 진입 정지), 이번 SHADOW와 무관한 별도 production 결정이다.

오늘(09-24, ~08:30Z까지) funnel: signals 71(16종목) → trigger 38 → V30 통과 15 → CEC 스탬프 11 → 주문 1.
GPT FD1 PRODUCTION 8건: BUY 5 / SKIP 2 / ABSTAIN 1.

---

## 3. Top30 대안의 기대 장점 (데이터로 뒷받침되는 것만)

1. **순위 4~10위는 cross-section 대비 일관되게 약하다.** 1h 초과수익 −0.123%, day-clustered t = −3.17. 최초 진입 기준, vr<4일 때도 초과 −0.243%(t −2.58).
   production 실거래 351건 중 208건이 이 구간이다.
2. **Top10 + 15m 거래량 4배 이상은 가장 견고한 음(−) 신호다.** 최초 진입 1h −0.415%(t −2.96), 2h −0.585%(t −2.35), n = 1,079 심볼-일.
   V30 production-trigger 연구의 volumeTails 결과와 방향이 같다.
3. **순위 가속(Emerging)은 약한 양(+) 신호다.** 11~20위이면서 60분 내 20계단 이상 상승, 최초 진입 기준 1h +0.151%(t 2.17)이고, 1분 후 진입이면 11~30위 +0.178%(t 1.72)이다.
   Top10 진입 전에 포착할 가치가 **있을 수 있다** (확정 아님).
4. production의 GPT가 볼 수 없는 **11~30위의 실시간 호가·슬리피지·flow**를 SHADOW만이 point-in-time으로 수집할 수 있다. 과거 호가는 존재하지 않는다.
5. Universe를 `market_regime_observations.liquid_prices`(5분마다 528 BF 가격 이미 수집)로 만들면 **추가 Binance weight ≈ 0**이다.

---

## 4. 발견한 치명적 문제 / 편향

| # | 문제 | 근거 | 영향 |
|---|---|---|---|
| F1 | **"4h/8h" 수익률은 실제로 1h/2h다.** `claude_p4.ret4/ret8` = 15m bar 4개/8개 | 자기조인 가격과 상관 0.9994(1h) / 0.9997(2h), 4h·8h와는 0.44 / 0.55 | 모든 연구 수치의 horizon 재해석 필요. 6h 보유 전략과 직접 연결 불가. |
| F2 | **진입가 e = 순위 관측 15분 후 1m 시가** | 300/300 정확 일치(offset +15m), day_return은 cutoff 시점 가격(편차 0.00bps) | lookahead는 아니나, 순위 변화 직후 15분을 측정하지 않음 → Emerging 조기포착 가치를 과소/왜곡 측정. |
| F3 | **KST 일시가 기준 off-by-one**: `claude_ranks` day open = KST 00:00 **−15분** 1m 시가 | production(KST 00:00 정각)과 |Δday_return| 평균 130bps, 정확 순위 일치 44~55%, top10 소속 일치 91.3%(KST 첫 4h 78%), top3 91.1% | 버킷 결론은 대체로 유지되나 순위·속도는 production과 다름. KST 00~01시는 거의 무의미. |
| F4 | **Top3 +0.127%는 지속 리더의 반복 표본 + 꼬리 효과** | 8,595행이 617 심볼-일에서 나옴. 최초 진입 1h **−0.162%**, 2h **−0.494%**. winsorize(1/99%) 1h +0.065%, trimmed +0.031%, 상위 1% 행이 합계의 278% | "Top3 별도 특성"은 진입 가능한 edge가 아님. |
| F5 | **Emerging 신호가 KST 자정 직후에 몰림** | 11~30위 행 중 emerging 비율: KST 00~02시 59.5%, 02~06시 28.5%, 06~12시 16.5%, 12~24시 11.2% | 일시가 리셋으로 인한 기계적 순위 점프. live에서는 lookback이 KST 자정을 넘으면 velocity를 무효 처리해야 함. |
| F6 | **p4 표본 선택**: day_return ≥ 2%만 포함 | top30 행 중 4,661행(5.4%) 제외, 주로 KST 이른 시각 | 약세일·이른 시각 과소대표. |
| F7 | **다중비교**: 이번 감사 + 기존 연구에서 30개 이상 셀 검정 | t≈2 셀 1~2개는 우연히 기대됨 | Emerging 11~20 조건은 가설 수준. |
| F8 | **production FD1 스키마가 BUY 쪽으로 구조적으로 기움** | `contract.mjs wireSchema`: SOFT/HARD 위험 카테고리가 없으면 선택지에서 SKIP 제거(BUY/ABSTAIN만). 프롬프트는 "이미 많이 올랐다는 SKIP 사유 아님"이라고 명시. replay BUY 68%(유효 응답 중 81%). 오늘 BUY 5건 모두 동일 support 6개(return_1m~4h). 대상은 day +10~61% 종목, CEC REJECT여도 BUY. | 대안 GPT에 같은 계약을 쓰면 같은 편향을 재생산함. |
| F9 | **v30-front-shadow는 production 예산 원장을 공유** | `FinalReviewCoordinator`→`gpt_final_review_claim`→`gpt_final_review_daily_budget` (DRYRUN도 같은 day 원장 소비) | 재사용하면 production 한도(300콜/$3)를 잠식. |
| F10 | **공유 IP weight 여유가 생각보다 작음** | 활성 `v16-momentum-broad-shadow`(5분마다, used-weight guard 없음)가 528×5m klines + ~230×(depth100+OI+15m) ≈ **2,400+ weight/회**. scanner는 2,100에서 중단하며 실제 1회 발생(09-08 21:45Z) | 두 번째 전체 universe kline 스캐너 추가는 금지 수준. |
| F11 | **OpenAI 크레딧 소진 전례** | 2026-09-24 ~03:15Z HTTP 429 `insufficient_quota` → production 전 후보 ABSTAIN (FD1 evidence §2) | shadow 지출이 production을 굶길 수 있는 유일한 현실 경로. DB 원장 분리만으로는 막을 수 없음. |

---

## 5. 과거 데이터 재검증

### 5.1 표본 정의 (재검증 결과)

- `claude_ranks`: 1,502,838행, 522심볼, 2,879 cutoff(15분), 2026-08-19 15:15Z ~ 09-18 15:00Z.
- `claude_p4`: 331,175행, 521심볼, 2,870 cutoff. 조건 day_return ≥ 2%. 행당 `rk, rk1/rk2/rk4/rk8`(15/30/60/120분 전 순위), `volume_ratio`, `ret4/ret8`(**1h/2h**), `mfe4/mae4`(1h)를 가진다.
- `volume_ratio`는 production V17 정의(15m bar 거래대금 / 직전 20개 평균)와 일치한다(상대오차 0.1%). `return60`도 일치(1.7bps).
- 비용 기준: 실거래 진입 수수료 **5.00bps**(409건 전부). 왕복 수수료 10bps, 진입 슬리피지 5bps, 청산 슬리피지 5~10bps를 더하면 현실 비용 ≈ **20~25bps**이다. 스트레스 44bps는 CEC 기준.

### 5.2 순위 버킷 (전체 행, 사용자 수치 그대로 재현됨. 단 horizon은 1h/2h)

| 버킷 | 행 | 1h 평균 | 2h 평균 | 1h 중앙값 | 1h 승률 | day-t 1h / 2h | 초과 1h (t) |
|---|---|---|---|---|---|---|---|
| Top3 | 8,595 | +0.127% | +0.252% | −0.096% | 48.9% | 0.83 / 0.84 | +0.093% (0.60) |
| 4~10 | 19,833 | −0.101% | −0.156% | −0.157% | 46.4% | −1.73 / −1.30 | −0.123% (**−3.17**) |
| 11~20 | 27,485 | +0.002% | −0.036% | −0.095% | 47.0% | 0.40 / −0.24 | −0.012% (−0.52) |
| 21~30 | 25,526 | +0.025% | +0.040% | −0.077% | 46.9% | 0.90 / 0.69 | +0.010% (0.57) |
| 31~50 | 43,401 | +0.014% | +0.037% | −0.070% | 46.7% | 0.00 / 0.22 | −0.013% (−1.06) |
| 51+ | 206,335 | +0.078% | +0.176% | +0.053% | 51.9% | −0.61 / −0.48 | +0.021% (2.32) |

- 모든 버킷의 1h 평균이 현실 비용(20~25bps)보다 작다.
- Top3 winsorize 후 1h +0.065%, 4~10은 −0.110%(견고).

### 5.3 최초 진입(심볼-일 첫 이벤트)만 — 중복 제거

| 셀 | n(심볼-일) | 1h | 2h | day-t 1h / 2h |
|---|---|---|---|---|
| Top3 첫 진입 | 617 | −0.162% | −0.494% | 0.08 / −0.41 |
| Top3 2~4번째 관측 | 1,225 | −0.147% | −0.196% | −0.02 / 0.28 |
| Top3 5~12번째 | 1,994 | +0.320% | +0.826% | 1.67 / 1.91 |
| Top3 13번째+ | 4,759 | +0.154% | +0.223% | 0.16 / −0.06 |
| Top10 & vr≥4 | 1,079 | **−0.415%** | **−0.585%** | **−2.96 / −2.35** |
| Top10 & vr<4 | 1,521 | −0.115% | −0.143% | 초과 t −2.58 / −2.10 |
| Top10 & vr1~2 (전체행 +0.101%) | 1,205 | −0.091% | −0.068% | — |
| E: 11~20 & 60분 +20계단 | 2,068 | +0.151% | −0.001% | **2.17** / 0.24 |
| E: 11~30 & 60분 +20계단 | 3,329 | +0.054% | −0.047% | 0.99 / −0.55 |
| E: 4~30 & 60분 +20계단 | 3,550 | +0.009% | −0.131% | 0.19 / −1.47 |
| E: 11~30 & 30분 +15계단 | 3,176 | +0.039% | −0.081% | 0.53 / −1.11 |
| E: 11~30 +20 & vr<4 | 2,988 | +0.066% | +0.009% | 1.12 / 0.31 |
| E: 11~30 +20 & vr≥4 | 1,262 | +0.060% | −0.148% | 0.31 / −1.45 |
| 11~20 & vr2~4 | 1,678 | +0.143% | +0.132% | — |

- Top3의 "리더 지속" 효과는 5~12번째 관측(1.25~3h 동안 Top3 유지)에만 있고 t < 2이다. 첫 진입은 음(−)이다.
- Emerging은 11~20위 + 20계단 조건에서만 1h 유의 근처에 있다. 범위를 넓히면 희석되고 2h에서 소멸한다.

### 5.4 거래량 × 순위 (전체 행)

| | vr<1 | 1~1.1 | 1.1~2 | 2~4 | ≥4 |
|---|---|---|---|---|---|
| Top10 1h / 2h | −0.007 / −0.016 | +0.043 / +0.174 | +0.112 / +0.151 | −0.135 / −0.130 | **−0.393 / −0.527** (t −1.88/−1.94) |
| 11~20 | −0.024 / +0.004 | −0.083 / −0.261 | −0.003 / −0.095 | +0.118 / +0.065 | +0.059 / −0.232 |
| 21~30 | +0.022 / +0.039 | +0.008 / +0.082 | +0.006 / +0.024 | +0.044 / +0.067 | +0.130 / +0.016 |

과열 거래량의 해악은 **Top10에 국한**된다. 11~30위에서는 1h 기준 중립~양(+)이고, 2h에서는 11~20위가 음(−)이다.

### 5.5 1분 후 진입으로 재계산 (F2 보정; `claude_k1` 225심볼, 2026-09-01~09-19, 18일, 최초 진입)

| 셀 | n | fwd60 (t) | fwd120 (t) |
|---|---|---|---|
| E 11~30 +20/60m | 1,159 | **+0.178% (1.72)** | +0.183% (1.30) |
| E 11~20 +20/60m | 793 | +0.251% (1.57) | +0.193% (1.08) |
| E 21~30 +20/60m | 877 | +0.076% (0.86) | +0.027% (−0.05) |
| Top3 첫 진입 | 278 | −0.107% (0.53) | +0.585% (1.56) |
| 4~10 첫 진입 | 718 | +0.002% | −0.048% |
| Top10 & vr≥4 | 472 | **−0.541% (−2.02)** | −0.563% (−1.27) |
| 31위+ (대조) | 2,343 | −0.005% | +0.080% |

- Emerging 11~20위에서 관측 후 1분→15분 구간이 평균 +0.10%(최초 +0.155%)이다. 즉 15분 지연 진입(패널)은 초기 움직임의 일부를 놓친다.
- 단 225심볼 부분집합(유동성·선택 편향 가능), 18일, t < 2이다. 비용 20~25bps를 빼면 0 근처다.

### 5.6 결론 (과거 데이터)

- **견고**: 4~10위 약세, Top10 과열 거래량 약세.
- **약함/가설**: Emerging 가속(1h +0.15~0.25%, 비용 차감 후 ≈0, 2h 소멸), Top3 지속.
- **기각**: "Top3 진입 자체의 edge", "Top10 vol 1~2x 우위"(최초 진입 기준 음수).

---

## 6. 실거래 409건과의 연결

`v11_long_regime_positions` CLOSED 409건, 누적 **−127.59 USDT** (2026-09-02~09-24, 현재 OPEN 0) — 재확인됨. 단, **서로 다른 6개 전략/사이징 버전의 합계**다.

| 그룹 | n | USDT | 비고 |
|---|---|---|---|
| 비 V17 (MICRO/V13) | 58 | −11.23 | 무관 |
| V17 즉시진입, 40 USDT | 277 | −68.62 | 09-08~16 |
| V17 눌림, 30 USDT | 20 | +3.62 | 09-18~19 |
| V17 눌림, 200 USDT, gate 없음 | 44 | +28.06 | 09-19~20 |
| V17 눌림 + B06133, 200 USDT | 9 | −71.18 | 09-20~22, 전부 native stop, 평균 −1.275% |
| V17 V30 + GPT(FD1), 200 USDT | 1 | −8.25 | 09-24 NILUSDT (rank 1, day +60.7%, CEC REJECT에서 BUY) |

- **Native stop 비중이 높은 이유**: `V17_NATIVE_STOP`은 거래소 상주 stop이며 trailing/R5/lock 레벨도 이 stop으로 체결된다. 눌림/무게이트 그룹 60건의 native stop 평균은 **+0.107%**이다. 즉 "native stop = 손절"이 아니다.
  즉시진입 그룹 164건은 평균 −0.338%였다.
- **V17 351건 (notional 정규화, 순손익)**:
  - 순위별: Top3 n=143 −0.294%(SE 0.217), 4~10 n=208 −0.128%(SE 0.159) → 실거래에서 Top3가 더 나음은 보이지 않는다.
  - 거래량별: 1.1~2x −0.086%(n147), 2~4x −0.271%(n106), 4x+ −0.279%(n98) → 방향은 일치하나 비유의.
  - 진입 day_return별: <8% +0.056%(n66), 8~15% −0.122%(93), 15~20% −0.422%(53), 20~40% −0.265%(94), 40%+ −0.308%(45).
    stop 청산 비중은 61% → 80%로 상승한다. **"이미 많이 오른 뒤 진입"이 나쁜 쪽**이라는 V29 결론(day≥20% 최악)과 일치하나, 셀당 SE 0.23~0.47로 개별 비유의다.
- **연결의 한계**: 패널은 1h/2h 고정 horizon, 무비용, 15분 지연이다. 실거래는 stop 2.5%, trail 3%/1.5%, stale 45m, 평균 보유 13~15분, 수수료 5bps/side, 눌림 진입가는 ref보다 +38bps 높다.
  **패널의 +0.1~0.2%는 실거래의 비용+stop 구조에서 쉽게 음수가 된다.**
- **최근 소표본**(B06133 9건, V30/GPT 1건)은 해석 불가 표본이다.

---

## 7. GPT 역할 설계

### 7.1 BUY/WAIT/SKIP/ABSTAIN은 타당한가

**타당하다. 단 두 가지를 고칠 때만.**

1. FD1처럼 "위험 카테고리 미발동 시 SKIP 선택지 제거"를 하면 WAIT/SKIP은 사실상 봉쇄된다(F8).
   대안 계약은 SKIP·WAIT를 항상 허용하되, **SKIP은 서버가 검증 가능한 카테고리 근거**, **WAIT는 열거형 trigger + 서버 검증 파라미터**를 요구한다.
   추가 SOFT 카테고리(모두 인용 가능, HARD 아님):
   - `VOLUME_OVERHEATED` (Top10 & vr15 ≥ 4)
   - `EXTENDED_LEADER` (day ≥ 20% & Top10 첫 진입 1h 이내)
   - `RANK_FADING` (15분 순위 하락 ≥ 5)
   - `COST_EXCEEDS_EDGE` (spread + 추정 슬리피지 + 수수료 ≥ 35bps)
   → 모두 in-sample 근거라 **SOFT(인용 가능)이지 차단(HARD)이 아니다.**
2. 프롬프트의 "이미 많이 올랐다는 사유가 아니다" 문장을 제거하고, "다음 60~120분 기대 움직임이 왕복비용(명시된 bps)을 넘는가"로 질문을 바꾼다.

### 7.2 WAIT 명세 (무한 WAIT 금지)

- **TTL**: 10분 고정(GPT가 연장 불가). 후보당 GPT 재질의 최대 1회 → 후보당 GPT 최대 2콜. WAIT → WAIT는 불가.
- **trigger** (GPT가 1개 선택, 파라미터는 서버가 범위 검증):

  | trigger | 조건 | 파라미터 범위 |
  |---|---|---|
  | `PULLBACK_HOLD` | 스냅샷 mid 대비 −X bps 터치 후 완료 1m 종가가 mid 위 복귀 | X ∈ [15, 60] |
  | `BREAKOUT_CONFIRM` | 완료 1m 종가 > max(60m 고점, mid × (1 + Y bps)) 이고 1m taker buy > 0.5 | Y ∈ [10, 50] |
  | `SPREAD_NORMALIZE` | spread ≤ min(10bps, 현재 / 2) | — |
  | `BOOK_IMPROVE` | ask_depth_to_order ≥ 5 이고 imbalance ≥ −0.2 | — |
  | `FLOW_TURN` | 최근 3×1m taker buy ≥ 0.55 | — |
  | `RANK_CONFIRM` | 다음 5분 스냅샷에서 순위 유지 또는 개선 | — |

- **무효화(즉시 종료, 진입 없음)**:
  - 가격 < mid × 0.99
  - 가격 > mid × 1.01 (production과 같은 1% 추격 상한)
  - 순위 10계단 이상 하락
  - TTL 만료
- **trigger 충족 시**:
  - (i) 결정론적 가상 진입(`WAIT_MECHANICAL`)을 그 시점 ask로 기록
  - (ii) GPT에 INITIAL/CURRENT/DELTA로 1회 재질의 → BUY/SKIP/ABSTAIN
  - 두 효과(trigger 자체 vs GPT)를 분리 측정한다.
- **평가**: WAIT의 가치는 "진입가 개선 bps"뿐 아니라 **만료·무효화된 WAIT의 기회비용**(동일 시점 BUY-now 반사실 결과)까지 포함한다.
  V29에서 눌림 재가속 타이밍(−1.44 USDT/거래)이 즉시진입(−1.20)보다 나빴다. WAIT 가치는 선험적으로 입증되지 않았다.

### 7.3 기존 모델의 역할 (Q4)

| 모델 | 코드상 실제 역할 | 근거 | SHADOW 권고 |
|---|---|---|---|
| V17 후보 | Top10 + 모멘텀 + vr15≥1.1 + 5m 확인 (생성기) | 4~10위 약세, 최초 진입 음수 | gate 아님. `v17_entryReason`을 계산해 "production이 봤을지"만 기록 |
| setup 타이밍 | 눌림/continuation, TTL 60s | V29: 모든 인과 타이밍 음(−) | 미적용 (WAIT이 대체). production setup 상태는 link로 기록 |
| B06133 | (absorption∧volumeTails∧fresh15over30∧btcAnyUp) ∨ (buyerShareRise∧¬fresh5over15∧¬recentHourLead). 현재 REFERENCE_ONLY | 통과군이 거절군보다 나쁨(16d −3.36 vs −1.21 USDT/거래). 핵심 요인 부호가 반대 | **allowed/branch는 GPT 입력에서 제외**, 7개 원시 요인만 1회 제공 |
| V30 | fresh5over15 ∧ ¬volumeTails, **production hard gate** | 09-08~24 in-sample 선택. volumeTails 다리는 독립 패널(Top10 vr≥4)이 지지 | **soft evidence**: `VOLUME_OVERHEATED` 카테고리와 V30 pass/fail 기록. gate 아님. Emerging에는 부호 미확정 |
| CEC0040 | 전략 전체 실현 EWMA (종목 무관), 현재 −4.07 REJECT 국면. advisory | replay: CEC hard gate 제거 시 16d +343 → −47 | **`v11_cec0040_state` 읽기만** (RPC 호출 금지). GPT에는 "production 전략의 최근 실현 성과, 이 후보와 무관"으로 라벨 |

- **중복**: V30은 B06133 7개 요인 중 2개를 반대 부호로 쓴 것이다. 둘 다 보여주면 같은 정보를 두 번 세게 된다 → 요인 벡터는 1회만 제공한다.
- fresh5over15(5m bar 기준)는 FD1의 `accel_5m_vs_15m > 0`(1m 기준)과 거의 같은 정보다.

---

## 8. 추천 SHADOW architecture

### 8.1 Q12: v30-front-shadow 재사용 vs 신규

**신규 `leader-emerging-shadow`.** v30-front-shadow는 `v11_long_regime_signals`에서 **production이 이미 trigger·B06133 스탬프한 신호만** 읽는다.
그래서 11~30위를 구조적으로 볼 수 없다. 또 production GPT 원장(`gpt_final_review_claim`)과 저널(`gpt_final_entry_reviews`)을 공유한다(현재 cron 정지).
재사용 가능한 것은 **순수 모듈의 import뿐**이다: `computeFacts`/`readSources`/`bookFacts`, `evaluateB06133`, `v30FrontDecision`, `replayP142Target`. 공유 파일 수정은 금지한다.

### 8.2 Q8: 스캐너 선택지

| 안 | blast radius | Binance weight | 비고 |
|---|---|---|---|
| A. production generator가 top30 저장 | **production 함수 재배포**. `SCAN_AUDIT_WRITE` 실패 시 신호 생성 중단 경로와 결합 | 0 | 15m 종가 순위만(5분마다 같은 값). 권장 안 함 |
| B. 독립 전체 스캐너(15m klines×525) | 없음 | **+~1,060/5분** → F10과 합쳐 2,100 guard 위험 | 금지 |
| C. `market_regime_observations.liquid_prices` 재사용 | 없음 (읽기) | **0** | 5분마다 528 BF 가격, 15:00:09Z 스냅샷 = KST 일시가 근사. 관찰자 의존 |
| **D (권장). C + shortlist만 정밀 조회** | 없음 | ≈45/5분 | universe 순위는 C, 후보 ≤3개만 15m klines(정확 V17 feature), B06133 입력, FD1 facts. 관찰자 지연(>6분) 시 `/fapi/v1/ticker/price`(weight 2) fallback |

### 8.3 함수 / cadence

- `leader-emerging-shadow` mode `scan`: cron `1-59/5 * * * *`.
  - generator(:00/:05), v16-broad(:04/:09), v16-shadow(:02/:07), mf-collector(:03/:08)를 피한 분이다.
  - 관찰자 스냅샷(:00~:09초) 수신 후 ≤70초에 순위를 계산한다.
- mode `wait`: 매분. 활성 WAIT가 있을 때만 동작(최대 5개).
- mode `outcome`: 15분마다. 성숙한 이벤트 ≤20개를 1m klines(limit 241, weight 2)로 라벨링한다. 대조군(CONTROL)은 관찰자 5분 가격으로 weight 0 라벨링한다.

### 8.4 scan 사이클 절차

1. 최신 관찰자 행(≤6분)에서 528 BF 가격을 읽는다. `exchangeInfo`(하루 1회, weight 1)로 COIN perpetual만 남긴다.
2. KST 일시가 = 15:00Z 이후 첫 관찰자 스냅샷을 `shadow_le.day_anchor`에 저장한다. 순위 = live day return.
3. 순위 이력(자체 이전 사이클 15/30/60분 전)을 계산한다. **lookback이 KST 00:00을 넘거나 자정 후 60분 이내면 `velocity_valid = false`.**
4. lane을 분류한다:
   - `LEADER`: rank ≤ 3
   - `EMERGING`: rank 4~30 & velocity_valid & (rank_60m − rank ≥ 20 ∨ rank_15m − rank ≥ 10)
   - 나머지 top30: `CONTROL`
   - (임계값은 §5 가설값 고정, 배포 전 사전등록)
5. shortlist(사이클당 ≤3): LEADER ≤1 (당일 Top3 첫 진입 또는 60분 이탈 후 재진입) + EMERGING ≤2 (velocity 내림차순, 동률이면 vr15 낮은 순). 심볼 cooldown 30분.
6. shortlist만 조회: 15m klines 110 (w2) → V17 feature·entryReason. B06133 입력(1m×3 + BTC 15m 캐시) → 요인·V30. FD1 `readSources`(≈w11) → `computeFacts`. 비용 facts.
7. 결정론적 HARD 차단(spread > 25bps, ask_depth_to_order < 1.5, slippage ≥ 25bps) → `SKIP_DETERMINISTIC` (GPT 호출 없음).
8. (2단계) GPT ALT1 호출. 응답 **후** depth(limit 5, w2)로 가상 진입 ask를 기록해 GPT 지연을 가격에 반영한다.
9. production link (읽기 전용): 같은 심볼 [관측 −15분, +30분]의 `v11_long_regime_signals`, `gpt_final_entry_reviews`(PRODUCTION), orders/positions.

### 8.5 DB (schema `shadow_le`, append-only)

모든 가상값 컬럼은 `hyp_` 접두어를 쓰고 `is_hypothetical boolean not null default true check (is_hypothetical)`를 둔다.
production 실값은 `prod_` 접두어로 link 테이블에만 둔다.

| 테이블 | 주요 컬럼 |
|---|---|
| `cycles` | cycle_id, observed_at, source(`REGIME_OBSERVER`/`TICKER`), observer_age_ms, n_universe, top50 jsonb, used_weight, errors |
| `candidates` | candidate_id, cycle_id, observed_at, symbol, lane, rank_now, rank_15m/30m/60m, rank_velocity_15m/60m, velocity_valid, first_top3_today, first_top10_today, minutes_in_top10_today, day_return_live, v17_rank_15m, v17_day_return, return_15m/30m/60m, vr15, qv24, v17_entry_reason, b06133_factors jsonb, v30 jsonb, cec_readonly jsonb(ewma, training_count, read_at), alt_score_v1 jsonb, alt_score_v2 jsonb, selected_for_gpt, selection_reason |
| `decisions` | decision_id, candidate_id, attempt(1 초기 / 2 WAIT 재질의), arm(`GPT_ALT1`/`RULE_BASELINE`/`TAKE_ALL`), packet jsonb, packet_hash, model, prompt_hash, schema_hash, decision(BUY/WAIT/SKIP/ABSTAIN/SKIP_DETERMINISTIC), valid, reasons, support, wait_trigger jsonb, wait_expires_at, snapshot_at, answered_at, latency_ms, tokens_in/out, cost_usd, request_id, hyp_entry_ask, hyp_entry_at, hyp_slip_bps_600, hyp_slip_bps_450, spread_bps |
| `wait_events` | decision_id, event(TRIGGERED/EXPIRED/INVALIDATED), at, price, detail |
| `outcomes` | decision_id 또는 candidate_id, outcome_version, entry_ref(`ASK_AFTER_ANSWER`/`SNAPSHOT_MID`/`OBSERVER_PRICE`), hyp_fwd_5/15/30/60/120/240m, hyp_mfe/mae_60/240, hyp_sim_exit_reason, hyp_sim_hold_min, hyp_net_bps_real, hyp_net_bps_stress44, hyp_net_usdt_600, data_complete |
| `production_link` | candidate_id, prod_signal_id, prod_status, prod_reject_reason, prod_setup_state, prod_v30_admitted, prod_gpt_decision, prod_order_id, prod_position_id, prod_entered, prod_realized_pnl_usdt, linked_at |
| `budget` | utc_day, calls, reserved_usd, settled_usd, cap_calls, cap_usd (보안 정의자 함수로만 증가) |
| `control` | singleton, enabled, gpt_enabled, set_by, reason |

- UPDATE/DELETE를 거부하는 트리거를 둔다(`budget`은 함수 경유만).
- 비교 view `v_compare`가 §9의 5개 그룹을 만든다.

### 8.6 가상 PnL 기준

- **notional 600 USDT 고정**(200×3, production과 동일). FD1 depth/slippage facts도 600 기준이라 일관된다.
- 150×3 = 450 슬리피지는 보조 컬럼으로만 둔다. 주 지표는 bps다.
- 청산 시뮬레이션: production 순수 커널 `replayP142Target`(retestAnchor, R5, stop 2.5%, trail, stale 45m, max 6h)을 3경로 평균으로 쓴다.
- 비용: 현실 = 수수료 5+5bps + **측정된** 진입 슬리피지 + 청산 5bps. 스트레스 = 44bps.
- 추가로 **1슬롯 용량 제약 포트폴리오 시뮬레이션**을 한다(equity 355 USDT에서 200 마진이면 동시 1포지션).

### 8.7 Q9: Binance weight (Binance 공개 문서 기준 weight)

| 항목 | weight |
|---|---|
| 한도 | 2,400/분/IP |
| production scanner | ≈1,060/5분 (burst 1초) |
| v16-broad | ≈2,400+/5분 |
| executor | 후보당 FD1 ≈11 + E1 aggTrades 등 |
| shadow scan | 0 (universe) + shortlist 3×(2 + 1 + 11) + BTC 1 + 가상진입 depth 3×2 ≈ **50/5분** |
| shadow WAIT | ≤5 × (1m klines 1 + depth20 2) = **15/분** |
| shadow outcome | ≤40/15분 |

- **피크 분당 ≈ 70 (한도의 ≈3%)**, generator 분에는 0이다.
- self-guard: 응답 헤더 `x-mbx-used-weight-1m ≥ 1,200`이면 즉시 사이클 중단(production 2,100보다 훨씬 낮게 → 항상 먼저 양보).
- 418/429 시 당일 정지. 호스트 순환(fapi1/2) 금지.

### 8.8 Q10: GPT 비용·지연

- **실측**: FD1 호출당 $0.0029(replay 1,114건 $3.18) ~ $0.0034(production 오늘, 입력 ≈3.83k tokens / 출력 ≈120). 지연 p50 1.4~1.8s, p95 2.2~3.6s.
- **예상 호출**: 패널 기준 Emerging 최초 이벤트 ≈111/일, Top3 최초 진입 ≈21/일, WAIT 재질의 ≈20~40.
  → **120~220콜/일, $0.4~0.8/일.**
- **hard cap**: 250콜/일, $1.00/일, 사이클당 ≤3, 동시 요청 ≤2.
- **production 원장 침범 0**: 별도 `shadow_le.budget` + 별도 키 `OPENAI_API_KEY_SHADOW`(별도 project, project 월 예산 한도)를 쓴다.
- **크레딧(조직 단위)은 공유**다. 다음 중 하나라도 해당하면 shadow GPT를 자동으로 멈춘다:
  - 최근 60분 production FD1에 HTTP 429 / `insufficient_quota`가 1건 이상
  - production API 오류율 > 20%
  - 당일 production 호출 수 ≥ 250
- production 소비는 오늘 18콜 $0.063, 어제 66콜 $0.246이다. shadow는 이의 3~10배가 되므로 **운영자 크레딧 확인이 선행 조건**이다.
- Rate limit(RPM/TPM)은 분당 수 건이라 무시 가능하다.

### 8.9 Q11: order-free 보장 (다층)

1. **코드**:
   - gateway/executor 모듈 import 금지. gateway 환경변수 이름(`*ORDER_GATEWAY*`, `*GATEWAY_SHARED_SECRET`)을 읽지 않는다.
   - fetch allowlist 래퍼: Binance는 `GET /fapi/v1/{klines,depth,exchangeInfo,ticker/price,premiumIndex,premiumIndexKlines}`와 `/futures/data/openInterestHist`만, OpenAI는 `POST /v1/responses`만 허용하고 그 외는 throw.
   - 정적 테스트가 번들에서 다음 문자열 부재를 검사한다: `/v1/command`, `create_order`, `v11_cec0040_decide`, `gpt_final_review_claim`, `verifyExecutionLease`, `v19_`, 그리고 `v11_long_regime_*`·`trading_settings`·`gpt_final_*`·`v17_operator_control`에 대한 `.update(`/`.insert(`/`.upsert(`/`.delete(`.
2. **DB**:
   - 전용 role `shadow_le_writer`: `shadow_le` INSERT만 허용. production 테이블은 필요한 것만 SELECT 권한(`market_regime_observations`, `v11_long_regime_signals/orders/positions`, `gpt_final_entry_reviews`, `v11_cec0040_state`, `v17_market_scan_runs`).
   - 그 외 권한 REVOKE. service role key를 쓰지 않고 이 role의 JWT를 쓴다.
   - production 테이블에는 트리거·컬럼을 추가하지 않는다.
3. **감사**: 배포 후 매시 확인 쿼리를 돈다 — shadow role이 쓴 production 행 0건. 위반 시 즉시 kill.
4. **운영**: `shadow_le.control.enabled`와 cron job을 각각 독립 정지할 수 있어야 한다.

---

## 9. 내일 오전에 봐야 할 KPI

**전제**: production GPT BUY는 하루 ≈5~10건이다. 그룹 1·2(CURRENT_BUY)는 **0~10건**이다. 모든 성과 KPI는 95% CI와 n을 함께 보고하고, **판정하지 않는다**.

### 운영/무결성 (내일 판정 대상)

- 사이클 실행률 ≥95%. 관찰자 지연 ≤6분 비율. velocity_valid 비율.
- production top10 ⊂ shadow top30 커버리지 ≈100%. production V17 신호 중 shadow가 본 비율.
- shadow role의 production 쓰기 0건. production scanner `SHARED_IP_WEIGHT_HIGH` 0건. production FD1 ABSTAIN(API 오류) 증가 없음.
- shadow 분당 최대 used-weight. GPT 콜 수 / 비용 / 지연 p50·p95 / invalid 비율.

### 비용 현실 (새 정보, 핵심)

- lane별 spread, 슬리피지@600, depth/600, `COST_EXCEEDS_EDGE` 비율: LEADER vs EMERGING vs production trigger.
- **11~30위 실행비용이 기대 edge(15~25bps)를 이미 잠식하는가.**

### 행태

- lane별 GPT 결정 분포(BUY/WAIT/SKIP/ABSTAIN).
- WAIT trigger/만료/무효화 비율. SKIP 사유 카테고리 분포.

### 5개 비교 그룹 (outcome은 60/120분 성숙분만)

1. CURRENT_BUY / ALT_BUY
2. CURRENT_BUY / ALT_SKIP·WAIT
3. CURRENT_SKIP_OR_NOT_SEEN / ALT_BUY
4. CURRENT_SKIP_OR_NOT_SEEN / ALT_WAIT
5. 둘 다 제외(대조)

각 그룹에서 n, 순 fwd 60/120m bps(현실 비용 / 44bps), 시뮬레이션 청산 순 bps, MAE/MFE, 승률, CI를 본다.

- **A**: 그룹 3의 순 fwd − 그룹 5 대조 차이
- **B**: 그룹 2의 production 실제 PnL(`prod_`)과 해당 후보의 가상 결과
- **C**: 그룹 3 중 관측 후 60분 내 production top10 진입 비율과, 진입 시점 대비 선행 수익(bps)
- **D**: WAIT_TRIGGERED 진입가 − BUY-now 반사실 진입가(bps) & 만료 WAIT의 반사실 결과(기회비용)
- **E**: 순 bps (현실 / 44bps)
- **F**: MAE 분포와 1슬롯 포트폴리오 MDD, production 동기간과 비교

### 판정에 필요한 최소 표본 (사전등록)

- ≥15 거래일, ≥300 Emerging-BUY (day-clustered t on 순 bps), 1슬롯 시뮬레이션 포함.
- **중단 규칙**: 7일 후 Emerging-BUY 순평균 < −10bps이고 CI 상한 < 0이면 종료.

---

## 10. 배포한다면 변경 파일 목록 (이번에 수정/배포하지 않음)

### 신규 (production 파일 변경 0)

- `supabase/functions/leader-emerging-shadow/index.ts`: HTTP, 내부 토큰, mode `scan`/`wait`/`outcome`/`diagnostic`
- `supabase/functions/leader-emerging-shadow/universe.mjs`: 관찰자 가격 순위, KST anchor, 순위 이력, velocity_valid
- `supabase/functions/leader-emerging-shadow/select.mjs`: lane, shortlist, cooldown, cap
- `supabase/functions/leader-emerging-shadow/score-v2.mjs`: V2 점수. 선택에 쓰지 않고 기록만. #182의 `alternative-score.mjs`는 `_shared`가 아닌 이 디렉터리로 옮겨 V1으로 기록
- `supabase/functions/leader-emerging-shadow/contract.mjs`, `prompt.mjs`: ALT1 BUY/WAIT/SKIP/ABSTAIN, WAIT 명세, 서버 검증
- `supabase/functions/leader-emerging-shadow/wait.mjs`, `outcome.mjs`: trigger, P142 커널 재사용, 비용 모델
- `supabase/functions/leader-emerging-shadow/guard.mjs`: fetch allowlist, used-weight guard, budget, 크레딧 stand-down
- `supabase/functions/leader-emerging-shadow/*.test.mjs`: order-free 정적 테스트, no-lookahead(bar 완료 시각 < asOf), 계약, WAIT TTL, 예산
- `supabase/migrations/<ts>_leader_emerging_shadow_schema.sql`: schema, append-only 트리거, role/grant, budget 함수, 내부 토큰
- `supabase/migrations/<ts>_schedule_leader_emerging_shadow.sql`: cron 3개 (별도 migration → 독립 정지)
- `research/leader-emerging-shadow-20260924/PREREGISTRATION.md`: 가설, 임계값, KPI, 중단 규칙. **첫 GPT 호출 전 커밋**
- `deployment-evidence/leader-emerging-shadow-<date>.md`

### 수정 (production 아님)

- `.github/workflows/gpt-final-review-release-20260923.yml`: target 선택지에 `leader-emerging-shadow` 추가. 또는 전용 workflow

### 변경 금지 (diff 0 확인)

- `v10-lane-executor/**`
- `v10-lane-signal-generator/**`
- `_shared/gpt-final-decision/**`
- `_shared/gpt-final-review/**`
- `_shared/leader-*.mjs`
- `v30-front-shadow/**`

---

## 11. GO / NO-GO 조건

### 1단계 (결정론적 shadow, GPT 없음) GO — 모두 충족

- **G1**: 변경 금지 목록 diff 0. executor/generator 번들 해시 불변.
- **G2**: order-free 정적 테스트 + fetch allowlist 테스트 통과.
- **G3**: `shadow_le` 전용 role 적용. production 테이블 DDL 0. append-only 트리거 동작 확인.
- **G4**: universe weight 0 (관찰자). 사이클 ≤100 weight. used-weight ≥1,200 self-abort. generator/v16-broad 분 회피.
- **G5**: `diagnostic` 모드(쓰기 없음)에서 15m 경계 기준 shadow top10과 production top10 겹침 ≥80%.
- **G6**: kill switch 2종(control 행, cron) 동작 확인.

### 2단계 (GPT 추가) GO — 1단계 12시간 무사고 + 추가 조건

- **G7**: 별도 OpenAI key/project(`OPENAI_API_KEY_SHADOW`), project 예산 한도 설정. 운영자가 조직 크레딧(자동충전 포함)을 확인.
- **G8**: shadow 원장 250콜 / $1.00/일, 사이클 ≤3. production 429/quota/오류율 기반 stand-down 테스트 통과.
- **G9**: ALT1 계약 테스트. WAIT는 열거 trigger와 TTL 10분, 재질의 ≤1. invalid → ABSTAIN. SKIP이 항상 선택지에 존재.
- **G10**: 사전등록 문서 커밋. 임계값·lane·KPI를 결과를 보기 전에 고정.

### NO-GO / 즉시 정지

- **N1**: shadow role의 production 테이블 쓰기 1건이라도 → 즉시 kill.
- **N2**: shadow 가동 후 production scanner `SHARED_IP_WEIGHT_HIGH` 또는 Binance 418/429 → shadow cron 정지.
- **N3**: production FD1 API 오류/ABSTAIN 증가, 또는 OpenAI quota 경고 → shadow GPT 정지.
- **N4**: executor `last_error` / 사이클 지연 회귀.
- **N5**: shadow micro_complete < 90% → 해당 구간 결과 무효.

---

## 12. 최종 결론

- **오늘 붙일 가치**: 있다. **데이터 수집 도구로서**다. 대안 전략이 낫다는 근거는 아직 없다.
  - 과거 패널에서 견고한 것은 "Top10 과열 거래량 약세"와 "4~10위 약세" 두 가지다. 이것은 **현행 production 후보군의 약점**을 말해 주지, 대안의 edge를 말하지 않는다.
  - Emerging 가속은 비용 차감 전 1h +0.15~0.25%, t ≈ 1.7~2.2, 2h 소멸이다. 연구 수치 자체가 horizon 오표기(F1), 15분 지연(F2), 일시가 off-by-one(F3), Top3 반복표본(F4)을 안고 있다.
- **SHADOW만이 답할 수 있는 질문**이 있다: 11~30위 실제 실행비용, WAIT 효과, BUY 편향을 제거한 GPT의 판별력.
  production 변경 없이, 추가 Binance weight ≈50/5분, GPT ≤$1/일로 수집할 수 있다.
- **권고 경로**:
  - (1) 오늘은 G1~G6 충족 시 1단계(결정론적 스캔 + lane + 규칙 기반 가상판단 + 대조군 outcome)만 붙인다.
  - (2) G7~G10 충족 시 GPT ALT1을 추가한다. 크레딧 확인이 오늘 안 되면 내일로 미룬다.
  - (3) 내일 오전 리뷰는 **운영·비용·행태 점검**으로 한정한다.
  - (4) production 반영 논의는 사전등록 표본(≥15일, ≥300 Emerging-BUY) 이후에 한다.
- **하지 말 것**: production scanner 수정(A), 두 번째 전체 kline 스캐너(B), v30-front-shadow 재사용, FD1 계약(SKIP 봉쇄) 그대로 재사용, `v11_cec0040_decide` 호출, production GPT 원장 공유, 150 USDT 사이징 변경을 이 작업에 섞는 것.
