# FD1 opportunity-loss refinement (2026-09-25)

새 전략이 아니라 FD1(GPT 최종판단) 경로의 기회손실 3개(GPT_ABSTAIN, V17_CHASE_EXPIRED, IOC_NO_FILL)와
"GPT BUY인데 주문 시도 없이 사라진 후보"(TRBUSDT형 orphan)를 고친 변경이다. 보호장치(3x, 슬롯당 150 USDT,
MAX 10 slots, SETUP_MAX_CONCURRENT 4, native stop -2.5%, volumeTails, V17_SETUP_EXPIRED, GPT FINAL RECHECK,
ENTRY_DRIFT-as-evidence, partial fill safety, emergency controls)는 바꾸지 않았다.

- Baseline(동결): production `FD1-BOUNDED-RETRY-AUTHORITY-2` = 이 브랜치의 `dba40b4`(PR #184 v85 포함).
- Candidate: 이 브랜치의 다음 커밋, executor `PATCH="FD1-OPPORTUNITY-REFINEMENT-1"`.
- 데이터 컷오프: 2026-09-24 18:57 UTC. "FD1 구간" = 04:20 UTC(FD1 투입) 이후, "업그레이드 후" = 11:21 UTC
  (150 USDT/재시도 릴리스) 이후, "전체" = 09-17/18 이후 journal·replay.
- 금액 단위: 별도 표기 없으면 450 USDT 명목(150×3) 기준 USDT. 60분 모델 = 트리거(또는 chase 봉) 종가 진입,
  -2.5% native stop 도달 시 손절, 아니면 60분 종가 청산, 수수료 0.1%.

## 1. 원인 요약

| 경로 | 원인 (production 증거) |
|---|---|
| BUY orphan | (a) GPT 답의 유효시간 15 s < 파이프라인 지연(스냅샷→주문 11–14 s + X1 관측 루프): ONDO 14:23(2차 사이클 14:23:27, 유효 14:23:26), PLUME 14:32(14:32:27 vs 14:32:26), BROCCOLI 14:26·LINK 18:48(E1 통과 후 1 s 차이로 `GPT_REVIEW_EXPIRED`). (b) run당 1진입 규칙: 같은 사이클에 USELESS/QNT가 먼저 진입 → CHIP 16:16, TRB 17:17 미시도. (c) 트리거 창이 닫힌 후보는 재무장하지 않지만 15분 setup TTL까지 NEW로 남다가 `V17_SETUP_EXPIRED`로 잘못 표기. (d) `V11_SLOT_FULL`/`DUPLICATE_SYMBOL_OPEN`은 claim을 반환하지 않아 CLAIMED로 영구 잔류, look-back(20분) 밖으로 밀린 NEW 29건이 사유 없이 잔류. |
| GPT_ABSTAIN | ENTRY ABSTAIN 5건 중 4건이 risk flag 없는 "확신 부족" ABSTAIN. 스키마에 "위험 카테고리 없는 SKIP" 경로가 없어 불확실하면 ABSTAIN으로 몰림. journal은 HOLD/EXIT 리뷰를 ENTRY 판단으로 오기(LTC: 실제 BUY, journal ABSTAIN). |
| V17_CHASE_EXPIRED | 1% 추격 한도를 넘은 봉이 나오면 시장 상태와 무관하게 종료. journal의 +missed PnL은 "신호 기준가/5분봉 시각" 앵커 착시(chase 진입가 기준으로 재계산하면 음수). |
| IOC_NO_FILL | 1차 IOC 체결률 69.7%(83/119, 09-18 이후). 미체결 36건 모두 한도(ask+3–5 bps) 위로 가격이 0.4–0.6 s 내 이동. 2차 재시도(v85)는 top-of-book 한도라 같은 경쟁에서 다시 질 수 있고, 한도가 1틱만 올라가도 150 USDT 상한 초과로 `IOC_RETRY_MARGIN_BOUND` 실패. production에서 2차 IOC는 아직 한 번도 발송된 적 없음. |

## 2. GPT_ABSTAIN

- FD1 구간 ENTRY 리뷰 35건: BUY 28, SKIP 3(+FINAL RECHECK SKIP 6), ABSTAIN 5.
- ABSTAIN 케이스(60분 모델): LSK 08:06 HARD PREMIUM_EXTREME -11.70(정당), BROCCOLI 12:43 +7.01, CFG 15:38 -0.74,
  RIVER 15:45 +10.37, RIVER 16:10 +9.36. 업그레이드 후 ABSTAIN 합계 +26.0(4건, 평균 +1.54%/60분).
- 수익 ABSTAIN의 공통점: 가격 흐름(return_15m/60m)은 위, 체결 우위(taker_buy_ratio_5m 0.44–0.48)나 volume_ratio<1이
  약함 → "상승 근거 vs 약한 체결" 비교 없이 판단 보류.
- 전체(replay 16일, 09-17 이후): no-flag ABSTAIN 46건 평균 -1.00%/60분, BUY no-flag 227건 -0.25%.
  → ABSTAIN을 BUY로 일괄 전환하면 손실(46×-4.5 USDT ≈ -207). 강제 BUY가 아니라 근거·기대값 비교로 BUY/SKIP을 가르게 했다.
- 변경: ENTRY 출력 순서 = support → bearish → invalidation → upside/downside → ev → confidence → d → abstain_reason.
  ABSTAIN은 DATA_INSUFFICIENT / EVIDENCE_CONFLICT_SEVERE / EV_UNDETERMINABLE / EXECUTION_UNSAFE 중 하나를
  명시해야 유효. 위험 카테고리가 없어도 SKIP 가능한 `EV_UNFAVORABLE`(서버 검증 bearish 사실 ≥2, 그중 가격/체결 1개 이상,
  ev NEGATIVE, downside>upside). confidence·ev는 기록/flag만 하며 차단하지 않는다(BUY 조건은 기존과 동일).

## 3. V17_CHASE_EXPIRED

chase 봉 종가 진입 기준 반사실(5m 지표 proxy 분류; live 분류기는 1m klines):

| 분류 | 전체 n | 60분 합계 | 평균/건 | FD1 구간 |
|---|---:|---:|---:|---|
| DEAD (거래량 감소·매도 우위·돌파 실패·저점 하락·60분 하락·>5%) | 159 | -414.4 | -2.61 | 9건 -93.9 (승 0) |
| LIVE (거래량≥1, 매수≥0.5, 5봉 위치≥0.7, 고저점 유지, 60분 상승) | 129 | +101.3 | +0.79 | 8건 +40.4 |
| UNCERTAIN (DEAD 조건 없음, 위치 0.5–0.7) | 32 | -149.3 | -4.66 | 0건 |
| NO_DATA (분류 불가 → DEAD 처리) | 62 | -128.0 | -2.06 | 1건 -11.7 |

journal(기존 앵커)은 같은 382건을 +1,945.6으로 보고했다(착시). 변경: 동결된 setup 상태기계는 그대로 두고, CHASE_EXPIRED
직후 chase 봉을 분류해 LIVE/UNCERTAIN은 같은 60 s 창의 트리거(`LIVE_MOMENTUM_CHASE`)로 V30 front(volumeTails
포함)→CEC→GPT를 그대로 통과하게 하고, GPT에 late-entry context(현재가, 돌파가/거리, 최근 고점/거리, 4h 고점까지 여지,
손절거리, 예상 슬리피지, chase 봉 지표)와 `CHASE_EXTENDED` SKIP 카테고리(chase 후보에만)를 준다. DEAD·데이터 없음·창 경과는
기존대로 거절하되 사유에 증거를 붙인다(`V17_CHASE_EXPIRED:DEAD:VOLUME_FADING+...`). `FD1_LIVE_CHASE_TO_GPT=false`로 즉시 원복.

## 4. IOC_NO_FILL

- 1차 IOC: 전체 119건 중 83 체결(69.7%), FD1 13건 중 10(76.9%), v85 이후 6/6. 2차 IOC 발송 0건.
- 미체결 36건의 60분 모델 합계 +69.9(30분 +5.7, 5분 -32.9), FD1 구간 3건 +52.8(NOM 05:48 +36.44, FF 05:28 +6.04,
  BROCCOLI 13:01 +10.28).
- 변경(시도 수 2회 유지: 2차 체결 데이터가 0건이라 3회 근거 없음): 2차 한도 = max(필요 호가 깊이, ask+8 bps), 상한 12 bps
  (틱 반올림이 상한을 넘으면 상한 안으로). 한도에서 150 USDT를 1 lot 넘으면 수량을 상한에 맞춰 줄이고(거래소 최소 미만이면 거절),
  한도·잔량·예상 VWAP·슬리피지는 기존 경계 그대로. 시도별 증거(best bid/ask, spread, 도달 가능 수량, 요청 수량/가격,
  offset bps, 호가 나이, 지연, 거래소 응답, 체결 수량, 1차 대비 경과·가격 변화, 재시도 계획)를 order intent에 저장.

## 5. BUY-but-no-attempt

FD1 구간 GPT BUY 28건 중 체결 9, FINAL RECHECK SKIP 6, IOC 미체결 3, 주문 전 소멸 10
(ENTRY_DRIFT 하드 거절 3건은 07:30 릴리스에서 이미 evidence로 전환). 07:30 이후 orphan 7건:
BROCCOLI 10:17(2차 사이클 없음, +60.45), ARX 10:32(마진 부족), ONDO 14:23, BROCCOLI 14:26, PLUME 14:32(유효시간 경과),
CHIP 16:16, TRB 17:17(run당 1진입), LINK 18:48(유효시간 경과, 현재 NEW 잔류).

변경:
1. 종결 사유 보장(`entry-lifecycle.mjs`): FILLED / PARTIAL_FILLED / GPT_REJECTED / EXECUTION_REJECTED / IOC_NO_FILL /
   SLOT_UNAVAILABLE / STALE / ERROR(+ pre-GPT STRATEGY_REJECTED). GPT SKIP/ABSTAIN/실패 응답은 즉시 종결
   (`GPT_SKIP:<카테고리>`, `GPT_ABSTAIN:<사유>`, `GPT_TIMEOUT`), 창이 닫힌 트리거·look-back 밖 NEW는 sweep이
   마지막 기록 사유로 종결(`STALE:GPT_BUY_NOT_EXECUTED:GPT_REVIEW_EXPIRED` 등), 슬롯 가득 = claim 반환 후 run 종료,
   중복 심볼 = `SLOT_UNAVAILABLE:DUPLICATE_SYMBOL_OPEN` 종결.
2. aged BUY 재확인: 유효시간이 지났지만 트리거 실행 예비시간 8 s 이상 남은 BUY는 주문 경로 진입만 허용되고, 강제
   GPT FINAL RECHECK(`INITIAL_ANSWER_AGED`, 시간 자체는 SKIP 사유 아님)가 신선한 데이터로 다시 판단한다. aged 답으로는
   절대 주문하지 않는다. 주문 직전 2.5 s 내 만료 예정인 BUY도 같은 방식.
3. follow-up 사이클: run당 1진입 규칙은 유지. 진입한 run이 도달하지 못한 GPT BUY가 창 안에 있으면 X1 관측을 한 번
   조기 종료하고 일반 사이클 1회 추가(보호관리부터 다시 수행, 호출 시작 30 s 이내만).
4. 스위치: `FD1_AGED_BUY_RECHECK=false`, `FD1_ENTRY_FOLLOW_UP=false`로 각각 기존 동작 복원. 복구된 진입은
   `entry_final_recheck.recheck_reasons`(INITIAL_ANSWER_AGED) / `entry_lifecycle_prior`(ENTRY_PER_RUN_LIMIT)로 코호트 식별.

## 6. 체결 거래 lifecycle (FD1 구간)

| 거래 | 진입→청산 | 보유 | PnL | MFE | 청산 | MFE capture / giveback | 판단 |
|---|---|---:|---:|---:|---:|---|---|
| LTC 13:20 | 68.73→73.51 | 78.8m | +30.86 | +8.63% | +6.95% (native trailing) | 80.5% / 1.68%p | GPT HOLD 4회 + trailing이 추세를 끝까지 보유 |
| USELESS 16:16 | 0.29742→0.30069 | 16.4m | +4.51 | +2.25% | +1.10% (native) | 49% / 1.15%p | 보유 판단은 맞았고 trailing 간격만큼 반납 |
| PYTH 16:02 | 0.07061→0.06965 | 6.7m | -6.63 | +0.18% | -1.37% (GPT EXIT) | - | 손절(-2.5%) 전 GPT EXIT로 약 -5 USDT 절감 |
| CHIP 16:36 | 0.04627→0.04550 | 10.1m | -7.98 | 0.00% | -1.67% (risk cut) | - | 진입 직후 한 번도 유리하게 가지 않음: 진입 선별 문제 |
| LAB 16:51 | 0.06259→0.06183 | 13.9m | -5.95 | +0.52% | -1.22% (native) | - | 동일 |
| QNT 17:17 | 85.85→84.73 | 13.9m | -6.27 | +0.15% | -1.31% (native) | - | 동일 |

승자(LTC, USELESS)는 MFE ≥2.25%, 패자는 MFE ≤0.52%: 손실은 청산이 아니라 진입 선별에서 났다. 표본 6건으로는
새 hard gate 근거가 없어, 진입 판단에 bearish 근거·기대값을 쓰게 하는 쪽(GPT evidence 개선)을 택했다.

## 7. 바꾸지 않은 것

3x, 150 USDT/슬롯(SLOT_SIZING_CONTRACT), MAX_SLOTS 10, SETUP_MAX_CONCURRENT 4, 자금 구조, risk limit, stop(체결가
-2.5% native stop), emergency/kill switch, volumeTails(V30 front), V17_SETUP_EXPIRED(setup TTL·상태기계
`leader-pullback-reaccel.mjs` 무수정), GPT FINAL RECHECK 구조·카테고리·최대 2회, GPT_FINAL_RECHECK_SKIP, ENTRY_DRIFT
= evidence, partial fill 보호(보호된 잔량만 top-up, 3차 IOC 없음), run당 1진입, BOO/E1/entry-control/lease/fencing.

## 8. 테스트

- node(개발·계약·executor·journal SQL on PGlite): 375/375 (baseline 342/342 + 신규 33).
- test-support(v17-entry/exit, v18/v19/v23, research/qv3): 405/409. 실패 4건은 baseline과 동일한 기존 실패
  (오래된 PATCH/기대값 고정: qv3 integration 23, 33, 34, 36).
- deno task test: 1055/1055.
- 필수 회귀 목록: GPT ABSTAIN/BUY, FINAL RECHECK BUY/SKIP, CHASE DEAD/LIVE, ENTRY_DRIFT, volumeTails, IOC 1차 체결/
  재시도 체결/부분 체결/전부 실패, BUY+슬롯 없음, BUY+stale, BUY orphan 방지, 중복 진입, 포지션 예산 초과 모두 포함.

## 9. Replay: baseline vs candidate (FD1 구간 04:20–18:00, 동일 후보)

GPT는 오프라인 재호출이 불가하므로 GPT 의존 부분은 가정을 명시한다. "개선안(all-in)" = 추가되는 모든 후보가 체결된다고
볼 때(복구 BUY는 재확인도 BUY, IOC 재시도 체결, LIVE chase·no-flag ABSTAIN 전부 BUY; 같은 심볼 중복은 제외).

| 지표 | 현재(실현) | 현재(60분 모델) | 개선안(60분 모델, all-in) |
|---|---:|---:|---:|
| 거래 수 | 9 | 9 | 27 |
| Net PnL | -18.40 | -48.81 | -1.80 |
| Profit Factor | 0.658 | 0.379 | 0.989 |
| Win Rate | 22.2% | 11.1% | 33.3% |
| Avg Winner | +17.68 | +29.83 | +18.05 |
| Avg Loser | -7.68 | -9.83 | -9.12 |
| Max Loss | -11.22 | -11.70 | -11.70 |

구성요소: orphan 복구 5건 -46.85(4건 손절), IOC 재시도 3건 +52.76, LIVE chase 7건 +24.46, ABSTAIN→BUY 3건 +16.64.
GPT 선별률 가정(IOC 체결 70%, chase/ABSTAIN BUY 80%, 선별력 0): orphan 제외 +21.0 / 포함 -25.9.
전체 데이터 기준 all-in: ABSTAIN -207, chase(LIVE+UNCERTAIN) -48.0, IOC +69.9, orphan -46.9 → 약 -232.
→ 추적성·정합성 개선은 확실하지만, 추가 거래의 PnL 개선은 GPT 선별이 좋아질 때만 성립한다(오프라인 미측정).

## 10–12

`replay.sql`에 위 수치를 재현하는 읽기 전용 쿼리, `summary.json`에 수치를 둔다. 운영 판단·잔여 위험은 최종 보고 참고.
