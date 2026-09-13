# 2026-09-13 최신 손실 및 실제 체결가 이탈 분석

분석 경계는 `2026-09-13T06:30:22.434605Z`로 고정했다. 이 문서의 후보
손익은 실제 체결 성과가 아니라 동일 진입을 고정한 반사실적 결과다.

## 운영 기준점

- production source commit: `716a7dc61154637da539a85931476d9c685f65c6`
- `v10-lane-executor`: v39, `V20-QV3-EVIDENCE-1`
- bundle SHA-256: `f4c9691c91fe89a8737a2c656923741422e658880dfca8e6028e8835075a66a5`
- 전략/청산: `QV3_ENTRY_EXIT_TWO_1` / `V17_EXIT_R5_TAIL`
- v39는 QV3 판단 입력을 남긴 관측 패치이며 QV3 매매 조건 변경이 아니다.
- 분석 시점 OPEN 포지션 0건, circuit `false`, entry control `true`,
  active incident 0건이었다.

## 최신 네 거래의 원장 재구성

| 종목·position | 실제 진입→종료 UTC | 순손익 | 관측 MFE | QV3 | 실제 종료 | 핵심 원인 |
|---|---|---:|---:|---|---|---|
| VTHO `4543d76c…` | 05:05:19→05:06:52 | -3.108354 | 0.3896% | 미무장 | own-lifecycle initial native stop | 계획가가 아닌 실제 fill이 reference보다 -1.0167%에서 체결되어 모멘텀 전제가 이미 깨진 진입 |
| AVA `84a796de…` | 05:16:14→05:23:02 | -3.340261 | 0.0488% | 미무장 | own-lifecycle initial native stop | 고점 추격 후 유리한 진행 없이 초기 stop까지 하락 |
| ILV `6646f8dd…` | 05:36:14→05:36:28 | -3.177513 | 0.3201% | 미무장 | own-lifecycle initial native stop | 급가속 진입 직후 14초 만에 반락; QV3 무장 조건 전에 stop |
| PUNDIX `91c496d2…` | 06:16:15→06:21:08 | -1.481215 | 0.5559% | 무장 | `QV3_TWO_BEARISH_CLOSED` | 첫 음봉에서는 기다리고 두 번째 완성 음봉 후 정상 청산한 정책상 giveback |

네 거래 실제 합계는 `-11.107343 USDT`다. VTHO/AVA/ILV의 native stop은
각 포지션 ID와 정확히 연결된 generation 1 주문이었고 이전 거래 stop 개입이나
중복 청산은 없었다. PUNDIX는 두 번째 음봉 마감 뒤 약 8.3초 안에 체결되어
주 손실 원인은 API 지연이 아니라 두 음봉을 기다리는 정책이었다.

실제 거래 식별자는 다음과 같다.

| 종목 | signal ID | entry order / trade IDs | exit order / trade IDs | 실제 수수료 |
|---|---|---|---|---:|
| VTHO | `94ebde35-a320-4ca4-ad0d-898af93ef43d` | `786722346` / `61797816,61797817,61797818` | `786891164` / `61819092` | 0.11729718 |
| AVA | `8f6030ab-2cee-4334-9945-8de29ee7ff32` | `952465189` / `58438851,58438852` | `952494640` / `58441484–58441487` | 0.11836088 |
| ILV | `c1eed39d-4423-45df-9030-838e4a38c81f` | `2500477464` / `103958033–103958036` | `2500485529` / `103958582,103958583` | 0.11831299 |
| PUNDIX | `fb5a89e6-5ab2-454a-a9de-907411c95319` | `493711355` / `33205990–33205993` | `493797191` / `33214537,33214538` | 0.11945506 |

각 position의 순손익은 `Σ 실제 realized_pnl_quote - Σ 실제 fee_quote_amount`와
반올림 오차 안에서 일치하고, entry/exit accounting pending flag는 모두 false다.
다만 원시 `exchange_trade_fills.accounting_status`는 네 거래 모두 `PENDING` 라벨을
유지한다. 금액은 재검산되었지만 이 상태 라벨 부채는 성과 우월성 근거로 숨기지 않는다.

VTHO의 실행 결함은 특히 분명하다. 완성 5분봉 reference `0.0010459`, 최종 IOC
계획가 `0.001046833876`(+0.0893%)는 기존 1% freshness 검사를 통과했다. 그러나
BUY LIMIT은 가격 상한만 보장하므로 급락 중 평균 `0.0010352668`(-1.0167%)에
체결되었다. 운영 코드는 계획가만 재검사하고 실제 fill을 검사하지 않았다.

## 구간별 실제 성과

폐쇄 거래 누적곡선의 낙폭이며 미실현손익 포함 계좌 MDD가 아니다.

| 구간 | 거래 | 승/패 | 순손익 | 기대값 | PF | 최악 거래 | 폐쇄곡선 DD |
|---|---:|---:|---:|---:|---:|---:|---:|
| A. 09-09 08:44:06 KST 이후 | 176 | 73/103 | +14.189696 | +0.080623 | 1.0804 | -3.869225 | 25.272189 |
| B/C. 실제 QV3 stamp | 96 | 39/57 | +11.184161 | +0.116502 | 1.1206 | -3.869225 | 23.157443 |
| D. V19 운영 구조 이후 | 53 | 21/32 | -1.007602 | -0.019011 | 0.9801 | -3.869225 | 20.191008 |
| E. 직전 48시간 | 56 | 26/30 | +14.231238 | +0.254129 | 1.2471 | -3.440044 | 15.722836 |
| F. 고정 최근 48시간 | 112 | 42/70 | -5.344783 | -0.047721 | 0.9542 | -3.869225 | 23.157443 |
| v39 관측 패치 이후 | 48 | 18/30 | -2.086577 | -0.043470 | 0.9556 | -3.869225 | 20.191008 |

QV3 96건의 배타적 원인 분류는 다음과 같다.

| 원인군 | 거래 | 순손익 | 평균 손실 | initial hard-loss | profit→loss |
|---|---:|---:|---:|---:|---:|
| 의미 있는 MFE 없는 초기 손실 | 25 | -60.319513 | -2.412781 | 15 / -45.877075 | 14 / -28.560758 |
| 유리한 진행 후 정책상 giveback | 31 | -29.860820 | -0.963252 | 3 / -9.422687 | 31 / -29.860820 |
| 과거 잘못된 주문 생애 개입(CHZ, 복구 재수행 안 함) | 1 | -2.542622 | -2.542622 | 0 | 0 |
| 수익 거래 | 39 | +103.907115 | — | 0 | 0 |

실제 FULL_CLOSE 판단과 첫 fill을 연결한 software/QV3 청산 48건의 지연은
중앙 4.183초, p90 5.039초, 최대 6.717초였다. 10초 초과의 확인된 실행 지연군은
0건이다. native stop 46건 중 최초 2.5% stop임을 가격·무장 상태로 확인한 것은
18건(-55.299763), 다른 단계의 native stop 28건, 증거 결손은 0건이다.

## MFE와 giveback 재해석

QV3 96건 모두 bot-observed `peak_price`가 있으나 이는 저장된 bid 최대이며 전체
시장 경로의 tick high나 최고가 전량 체결 가능성을 뜻하지 않는다.

- 전체 동일 집합 `Σr/Σm`: 23.7243%
- 실제 winner만: 67.8606%
- MFE 0.2% 이상: 39.7351%
- 명목가치 가중 금액 효율: 25.0096%
- MFE 0.2% 미만 손실: 26건
- 양의 MFE에서 최종 손실: 45건, 합계 -58.421578
- 거래별 giveback: 평균 1.3869%p, 중앙 1.2916%p, p90 2.7075%p

따라서 “모든 winner가 고점의 96%를 반납했다”는 해석은 틀리다. 실제로는
유리한 움직임이 거의 없던 손실군과, 무장 후 반납군이 동시에 존재한다.

## 후보 비교와 판정

후보 A의 정상 반사실적은 동일 실제 entry/quantity에서 즉시 청산을 가정하고
25bp adverse move와 양방향 각 5bp 수수료를 차감한다. stress는 50bp와 각
10bp를 차감한다. 후속 슬롯·대체 거래는 만들어 넣지 않았다.

| 후보 | QV3 거래 | 반사실적 순손익 | 기준 대비 | winner→loss | 판정 |
|---|---:|---:|---:|---:|---|
| 기준 QV3/R5 | 96 | +11.184161 | — | — | 기준 |
| A. 실제 fill 절대 이탈 >1% 즉시 보호·청산 | 96 | +16.233975 | +5.049814 | 0 | 실행 무결성 수정 채택 |
| B. day≥20%, r5≥1.2×r15 진입 차단 | 90 | +11.763906 | +0.579745 | 해당 없음 | winner 2건 +10.641063 제거로 탈락 |
| C. QV3 무장 후 첫 near-entry 음봉 청산 | 96 | +13.108226 | +1.924065 | 9 | 기존 winner +10.426412를 -5.255017로 바꿔 탈락 |

A는 POWR `4684b788…`(-2.774039, fill drift -1.5202%)와 최신 VTHO
`4543d76c…`(-3.108354, -1.0167%) 두 손실만 포착했다. 정상 비용 가정에서 각각
`-0.416804`, `-0.415775`로 제한되며, stress에서도 합산 개선은 +4.217236이다.
leave-one-trade/symbol에서도 각 단독 개선이 양수다. v39 48건은
`-2.086577 → +2.963238`, latest 4건은 `-11.107343 → -8.414763`이다.
hard-loss는 QV3 18→16건이며 거래 수·승수는 바뀌지 않는다.

임계값은 결과에서 새로 고른 값이 아니라 기존 production
`POLICY.maxEntryDriftPct=1%`다. 0.75%로 낮추면 +15.148114 VTHO winner를 포함해
성과가 -7.803297 악화된다. 실제 QV3 winner의 최대 절대 fill 이탈은 0.8453%였고,
1%에서는 winner 포착이 0건이다. 1.25%와 1.5%에서도 개선 방향은 유지되지만
최신 VTHO는 놓친다.

B는 최신 AVA/ILV를 막지만 `龙虾USDT` +10.507629와 SAGA +0.133434도
막는다. C는 PUNDIX를 약 +0.281로 보존하는 반사실적이지만 RIVER +3.917198를
약 -0.240으로 바꾸며 총 9개 winner를 손실로 전환한다. 눈앞의 최신 손실만
맞추기 위해 두 규칙을 승격하지 않았다. 앞선 `V21_DECAY_RECLAIM_1`도 holdout
수와 account replay fidelity gate를 통과하지 못해 연구 상태로 유지한다.

## 구현과 안전 경계

- 운영 patch는 `V21-POST-FILL-DRIFT-2`, 전략/진입 실행 정책은 별도 버전
  `V21_POST_FILL_DRIFT_GUARD_1`이다.
- 새 entry order intent에만 `V21_POST_FILL_DRIFT_GUARD_1`을 stamp한다.
- 정산된 실제 평균 fill과 entry 당시 immutable `referenceClose`로 한 번 판정하고
  position metadata에 영속화한다.
- 해당 생애의 native stop을 먼저 만든 뒤 기존 lease/fencing + idempotent
  reduce-only `closePos`로 청산한다.
- 부분 체결이면 exchange-confirmed 실제 잔량으로 stop 수량을 다시 맞추고 다음
  cycle에 그 잔량만 재시도한다.
- 동일 생애 stop만 정리하며 기존 OPEN position, QV3, R5, V19 scope-aware entry,
  DB-only reconciliation, circuit, 40 USDT margin/3x/10-slot 설정은 바꾸지 않는다.
- migration, 원장 수정, 신호 조작, 확인용 주문은 없다.

## 배포 전 운영 정산 상태 결함과 분리 수정

배포 직전 runtime은 매분 cycle을 끝내고 `NO_FRESH_BULL_SIGNAL`, `FLAT`,
pending order 0을 기록했지만 `last_success_at`은 `2026-09-12T04:59:09.341Z`,
`last_error`는 과거 `V18_CONTROLS_UNAVAILABLE`에 고정돼 있었다. 원인은 entry/QV3
판단이 아니라 닫힌 포지션 두 건의 native-stop journal이었다.

| position | 실제 상태 | 잔류 journal | 판정 근거 |
|---|---|---|---|
| STEEM `9ecaef3f…` | CLOSED, 정산 완료 | `CANCEL_PENDING` | stop 제출 전 `V18_STOP_OWNERSHIP_CHANGED`; algo/order ID 없음 |
| 牛来 `c525b7e2…` | CLOSED, 정산 완료 | `CANCEL_PENDING` | Binance create가 `Order would immediately trigger`로 동기 거절; algo/order ID 없음 |

두 row 모두 이후 정확한 client ID 조회가 `Order does not exist`를 반환했지만,
기존 코드는 timeout 같은 불확실한 제출과 확정적인 pre-send/API 거절을 구분하지
않아 영구 `NATIVE_RECONCILIATION_PENDING`으로 두었다. 수정은 다음 두 경우만
`REJECTED/terminal`로 승격한다.

1. 거래소 호출 전에 소유권 재검증이 실패한 `V18_STOP_OWNERSHIP_CHANGED`.
2. Binance create endpoint가 동기 400 `Order would immediately trigger`를 반환했고
   ACK/algo ID/actual order ID가 전혀 없는 경우.

timeout, connection loss, 일반적인 조회 실패는 계속 미확정으로 남긴다. 기존
ACTIVE stop이 있는 replacement 거절은 그 stop을 취소하지 않으며 보호 상태도
유지한다. 이 수정은 원장 PnL이나 체결을 쓰지 않고 journal 상태만 CAS로 정리한다.

최종 통합 회귀는 CI와 동일한 명령으로 `412/412 PASS`였다. 이 중 native stop
격리 테스트는 16건이며, 확정 거절 종결, 불확실 timeout 보존, 기존 stop 보존을
각각 포함한다.

배포 SHA, workflow run, production v40 hash와 세 cycle 증거는 배포 완료 후 이
문서에 추가한다.
