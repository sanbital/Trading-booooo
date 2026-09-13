# Trading-booooo E1/X1 거래 근거 연구 및 운영 검증

- 연구 고정일: 2026-09-13 UTC/KST
- 저장소: `sanbital/Trading-booooo`
- Supabase 프로젝트: `etaajwpernzrcdrifdnw`
- 고정 거래 표본: 2026-09-08~09-13 KST, 진입 시각 2026-09-13 21:15 KST 미만 210건
- 최종 판정: **E1 = DEFER, X1 = DEFER, E1+X1 = DEFER**

> 이 보고서는 연구 cutoff 당시의 승격 판정과 미배포 상태를 보존합니다. 이후 사용자의
> 명시적 우선 교체 지시에 따른 미검증 운영 override는 `OPERATOR_OVERRIDE.md`에 별도로
> 기록하며, 이 보고서의 `DEFER` 판정을 `SUPERIOR`로 소급 변경하지 않습니다. 실제 main,
> v43 배포 및 자연 발생 신호·체결·청산 증거는 이 문서의 13절과
> `generated/operator_override_live_evidence.json`에 후속 시각으로 보존합니다.

## 1. 결론

이번 조사에서 운영 기준선과 210건 원장은 재현했고, E1과 X1의 판단 로직 및 경계 회귀 테스트도 구현했습니다. 그러나 후보의 비용 후 계좌 성과는 검증하지 못했습니다. 고정 표본에는 E1 회복 대기 중 필요한 5초 블록·현재 호가·수량별 VWAP가 없고, X1에 필요한 1초 이하 best bid·수량별 매도 VWAP·stop 교체 ACK 순서가 없습니다. 따라서 정적 손실 제거를 전체 계좌 개선으로 바꾸어 계산하지 않았습니다.

현행 프로토콜의 재현 오차, 독립 검증, 기회 유지율, 비용·지연 stress, 자금·슬롯 재생, funding coverage 및 99% familywise bootstrap gate 중 어느 것도 후보 성능에 대해 통과했다고 표시할 수 없습니다. 회귀 테스트 통과는 성능 우월성과 별개입니다.

연구 판정만을 근거로 한 당시 결과로는 생산 코드, `main`, Edge Function 및 실거래 정책을 변경하지 않았습니다. 당시 새 정책 신호·체결·청산은 각각 0건입니다. 이후 사용자의 명시적 운영자 override로 변경된 상태는 13절과 분리해 해석해야 합니다.

| 단계 | 상태 | 근거 |
|---|---:|---|
| 실제 원장 재구성 | 완료 | 210건 합계 DB와 정확히 일치 |
| 기존 연구 재현 | 완료 | 패키지 SHA 검증, 분석 출력 파일별 일치 |
| E1/X1 판단 모듈 | 연구용 구현 완료 | 주문·네트워크·타이머 부작용 없음 |
| 회귀·정합성 테스트 | 완료 | 423/423 통과 |
| 성능 검증 | 미완료 / DEFER | 실행 가능 가격·계좌 재생·독립 표본 부족 |
| `main` 반영 | 미수행 | 승격 부적격 |
| 실제 배포 | 미수행 | 승격 부적격 |
| 신규 정책 신호/체결/청산 | 0/0/0 | 미배포 |

## 2. 새로 고정한 운영 기준선

| 항목 | 확인값 |
|---|---|
| 로컬 HEAD / `origin/main` | `adbcebd9dcc7614966f4a61ce53dd166f0f02f40` / 동일 |
| executor | `v10-lane-executor` v41, ACTIVE, 2026-09-13 10:36:17.315 UTC |
| executor bundle | `a9f5de783c0af38da40a407b5309ee997a25fec1c80297718e0255b7a872df3e` |
| signal generator | `v10-lane-signal-generator` v19, ACTIVE |
| signal generator bundle | `84e4ec2b5ece426ac6e4b68f86dc0947a045b54231e980b411dc8348d472c574` |
| patch | `V22-IMMEDIATE-ENTRY-PROTECTION-1` |
| entry | `V21_POST_FILL_DRIFT_GUARD_1` |
| exit | `V17_EXIT_R5_TAIL` |
| QV3 | `QV3_ENTRY_EXIT_TWO_1` |
| gateway | `8.0.3-P10-REGIME-ROUTER-V3-SAFE-EXIT`, ops `V18-OPS-ISOLATION-3` |
| 설정 | LIVE, 40 USDT 증거금 목표, 3배, 논리 cap 10, reserve 0 |

executor의 배포 파일 14개와 signal generator의 3개 파일은 현재 `main` 소스와 일치했습니다. 실제 호출 경로는 다음과 같습니다.

1. signal generator가 `leader-market-v17.mjs`와 `leader-momentum-v17.mjs`를 호출해 신호를 저장합니다.
2. executor가 기존 자격·소유권·자금·중복 제어 후 gateway 주문을 호출합니다.
3. entry settlement가 동일 주문을 재조회하고 position을 기록한 뒤 native stop을 설치합니다.
4. `manageLeader`가 Edge 호출당 한 번 top bid를 받아 R5를 평가하고, CAS 상태 저장과 native stop 동기화 후 새 완료 봉에만 QV3를 평가합니다.
5. idempotent exit settlement가 주문·체결·수수료를 정산합니다.

`pushShadowPositions`는 executor에 정의돼 있지만 호출 지점은 0개입니다. 따라서 gateway에 2초 position-monitor와 shadow 코드가 존재하는 사실만으로 X1이 운영 포지션을 관측한다고 볼 수 없습니다. 현재 gateway shadow 가격도 aggTrade/trade 가격이며 수량별 매도 VWAP가 아닙니다.

R5의 실제 가격 수익률 수식도 코드와 원장에서 다시 확인했습니다.

| 단계 | 조건 | stop 후보 |
|---|---|---|
| HARD | 최초 | 진입가 대비 -2.5% |
| RISK_CUT | 관측 MFE ≥ +1% 또는 보유 10분 | 진입가 대비 -1.2% |
| PROFIT_LOCK | 관측 MFE ≥ +2% | 관측 가격 이익의 50% 보호 |
| TRAILING | 관측 MFE ≥ +3% | 관측 고점 대비 -1.5% |

stop은 기존 값과 후보의 `max`로 단조 증가합니다. QV3는 완전 진입 뒤 형성된 완료 1분봉 중 진입가보다 0.2% 초과한 종가 증거가 있고, 최신 두 완료 봉이 연속 음봉이며 종가도 하락할 때만 성립합니다. 동일 봉 재평가 및 gap 방지 로직이 있습니다. `entryFeatures.bbPos=0`은 계산된 Bollinger 위치가 아니라 placeholder입니다.

## 3. 원장·시장 자료 재현

고정 210건은 여러 배포 patch가 섞인 실제 거래 원장입니다. 따라서 아래 값은 계좌 전체나 v41 단독 성능으로 해석하지 않았습니다.

| 지표 | 값 |
|---|---:|
| 거래 / 종목 | 210 / 78 |
| 수익 / 손실 | 84 / 126 |
| 승률 | 40.00% |
| 수익 합계 | +226.00696767 USDT |
| 손실 합계 | -236.28411106 USDT |
| 순손익 | -10.27714339 USDT |
| 거래당 순기대값 | -0.04893878 USDT |
| Profit factor | 0.956505 |
| 평균 수익 / 손실 | +2.690559 / -1.875271 USDT |
| 중앙 수익 / 손실 | +1.427242 / -1.586671 USDT |
| 최대 낙폭 | 25.27218885 USDT |
| 최악 거래 | DOGS -6.26446426 USDT |
| 최대 연속 손실 | 12건 |

원시 fill 시각은 기존 자료의 208/210에서 STEEM 체결을 `exchange_trade_fills`로 복원해 209/210으로 높였습니다. 1건은 여전히 대체 시각입니다. STEEM은 실제 fill 2026-09-13 18:15:09.244 KST, DB `entry_at` 18:16:05.298 KST로 56.054초 차이가 났습니다. 모든 거래별 원시 시각/DB 시각/대체 여부는 `generated/trade_truth.csv`에 보존했습니다.

고정 표본 중 169건에는 R5 exit policy stamp가 있고 41건은 해당 stamp가 없습니다. 누락 41건에 현재 정책을 사후 소급하지 않았으며, position별 patch/entry/exit/QV3 stamp를 원장 열로 그대로 남겼습니다.

자료 coverage는 다음과 같이 구분했습니다.

- 체결 표본 1분봉 논리 행 52,494개, 후보 표본 76,222개이며 중복되므로 합산하지 않았습니다.
- 후보 신호는 체결·미체결·거절 포함 621개입니다.
- 진입 직전 10초 체결은 109건 완전, decision-time 기준 1초 이내 reference는 103건입니다.
- OI·롱숏 계정 비율·premium·마지막 확정 funding은 210건에 있으나 과거 `receivedAt` 부재로 5분 지연 가정과 10분 민감도만 사용한 C등급 자료입니다.
- 실제 funding 현금흐름의 거래별 coverage는 0/210이므로 0으로 간주하지 않았습니다.
- 9월 13일 연속 L2는 없습니다. `v10_usdm_forward_snapshots` 최신은 9월 1일이므로 해당 테이블을 과거 호가 증거로 사용하지 않았습니다.
- 뉴스·온체인·실제 강제청산 stream은 자료가 없어 `UNKNOWN`입니다.

## 4. 거래별 손실 원인 판정

분류는 다음 의미로 사용했습니다.

- `CONFIRMED`: 코드, 주문/체결 원장, 시점이 일치하는 기계적 원인입니다.
- `SUPPORTED_HYPOTHESIS`: 자료와 정합적이지만 당시에 실행 가능한 가격으로 인과 검증되지 않은 후보입니다.
- `UNKNOWN`: 당시 L2, receive-time 또는 체결 가능 가격이 없어 판단할 수 없습니다.
- `REFUTED`: 확장 표본이나 승자 반례가 깨뜨린 설명입니다.

210건 각각의 판정은 `generated/cause_matrix.csv`에 한 행씩 기록했습니다. 모든 손실의 **청산 메커니즘**은 확인할 수 있었지만, 모든 가격 하락의 근본 원인을 사후 봉만으로 확정하지는 않았습니다.

| 거래(KST) | 순손익 | 확인된 메커니즘 | 회피·축소 판정 |
|---|---:|---|---|
| ILV 14:36 | -3.1775 | 약 14초 보유 후 native stop; 진입 전 fastWeak | E1 위험 표시는 지지되지만 반응 시간이 매우 짧고 회복/L2가 없어 실제 회피액 `UNKNOWN` |
| PUNDIX 15:16 | -1.4812 | QV3 두 음봉 청산, sampled MFE +0.556% | 더 이른 진입 거절·청산의 예측 근거 부족 |
| ARK 16:30 | -3.2099 | sampled MFE 0, native stop; fastWeak | 초기 진입 실패와 정합적이나 E1 exact replay 불가 |
| AVA 16:31 | +2.6557 | QV3 청산, sampled MFE +2.818% | 인접 시각의 승자; 시장 전체/단일 지표 금지의 반례로 보존 |
| ARK 17:46 | -1.8688 | sampled MFE 0, native stop; fastWeak 아님 | E1으로 설명되지 않는 손실, 원인 `UNKNOWN` |
| SAGA 18:06 | +0.1303 | QV3 청산, sampled MFE +1.252% | 낮은 단기 buyShare만으로 거절하면 승자 훼손 가능 |
| STEEM 18:15 | -3.1305 | actual fill 기준 초기 경로 뒤 native stop | DB `entry_at`만 쓰면 56초 경로 누락; 시각 오류가 손실 원인 자체는 아님 |
| POLYX 19:45 | -1.7633 | QV3 청산, sampled MFE +0.143%; 직전 완료 1분 buyShare 약 37.9% | 단기 약화와 정합적이나 후속 수익 POLYX 때문에 단독 금지 반박 |
| 龙虾 20:15 | -0.2428 | QV3 청산; fastWeak | small loss 축소 가능성은 있으나 회복 대기 체결가·비용 `UNKNOWN` |
| FLOCK 20:30 | -0.1125 | QV3; 가격 총손익 +0.00750083, 수수료 0.11999683 | 비용이 양의 가격손익을 음수로 바꾼 사실 `CONFIRMED`; +2.017% 봉 고가는 executable bid가 아님 |
| BTW 20:46 | -0.8752 | sampled MFE +1.979%, RISK_CUT 뒤 native stop; fastWeak | +2% 직전 불연속과 관측 누락 가설 지지, 하지만 봉 고가 +2.496%는 매도 가능 가격 증거 아님 |
| ARK 20:50 | -1.6594 | sampled MFE +1.435%, trigger 0.1928, 평균 exit 0.1926 | +1% 후 -1.2%까지 반납을 허용한 R5 설계 `CONFIRMED`; 조기 보호 우월성은 미검증 |
| CVC 21:10 | -1.6606 | 하락→반등→재하락, MFE +1.172%, trigger 0.0291, exit 약 0.0290669 | ‘진입 직후 계속 하락’은 `REFUTED`; 빠른 보호는 가설. JOIN 누락 fill은 raw 주문으로 복원 |

CVC는 `exchange_trade_fills` JOIN 행이 0개였지만, opening order `443218755`의 trade ID 4개와 수수료 0.06000895 USDT, native actual order `443307531`의 trade ID 3개와 수수료 0.05923829 USDT가 확인됐습니다. 이를 미체결·수수료 0으로 처리하지 않았습니다.

고정 연구 시점의 v41 종료 6건은 초기 native stop ACK가 fill 뒤 4.825~5.844초였고 모두 손실, 합계 -6.31382208 USDT였습니다. V22가 불완전한 최초 응답을 동일 주문 재조회로 마무리해 같은 주기에 보호를 설치한 사실과, 그 거래들이 돈을 잃은 사실은 동시에 참입니다. 보호 설치 개선을 진입 예측력으로 해석하지 않았습니다.

## 5. 수익 메커니즘과 보존 조건

### VTHO 13:31→13:35

Binance spot/perp/Upbit 환산 가격이 진입 전 5분에 각각 +6.5574%, +6.3965%, +7.0352%였고 15분도 약 +12%로 동행했습니다. RSI5는 84.29, 최근 3분 buyShare는 48.86%, 신호 나이는 72.7초였습니다. 최근 10초 가격은 -0.3319%였지만 buyShare는 57.70%였습니다. 따라서 `RSI≥70`, `3분 buyShare<50%`, `age>60초` 단독 금지는 이 +15.1481 USDT 승자를 제거합니다.

보유 중 완료 봉은 거래대금 199만→248만→336만 USDT, 저가 0.0008950→0.0009504→0.0009889, buyShare 약 51~54%로 가격 구조가 지속됐습니다. sampled best bid peak +14.5436%, 실제 exit 가격 상승 +12.7463%, sampled-peak capture 약 87.64%였습니다. 이 사례의 trailing은 큰 추세를 상당히 보존했습니다.

### SAGA 13:41→13:46

진입 전 spot/perp 5분 수익률은 +1.8334%/+1.9392%였습니다. sampled MFE +2.1832% 뒤 실제 가격 상승 +1.0983%, capture 약 50.31%였습니다. stop이 hard→risk cut→profit lock으로 올라간 경로가 확인됩니다. 마지막 완료 봉에서 buyShare가 약 47.45%로 낮아지고 음봉이 됐지만, 그 전의 상승 구간을 단일 flow 값으로 설명하지 않았습니다.

### POLYX 21:15→21:34 — 고정 210건 밖 사례

spot/perp/Upbit 환산 5분 상승은 +2.3148%/+1.7359%/+2.5424%였습니다. 동시에 직전 10초는 수익률 -0.4154%, buyShare 31.90%로 fastWeak였습니다. 진입 뒤 완료 봉 저가는 진입 대비 약 -1.57%까지 내려간 뒤 회복했습니다. sampled best bid peak 0.04417과 완료 봉 trade high 0.04488을 구분했습니다. 이 +1.4140 USDT 사례는 10초 약화 일괄 금지, 첫 음봉 종료, 무상승 시간 종료의 반례입니다.

### BTW 21:30→21:34 — 고정 210건 밖 사례

21:31 상승 뒤 21:32는 buyShare 56.47%인데 음봉, 21:33은 buyShare 38.77%와 거래대금 약 26.4만→50.7만 USDT 증가를 동반한 음봉이었습니다. 실제 청산은 `QV3_TWO_BEARISH_CLOSED`였고 sampled MFE는 +1.72%라 R5 +2% lock 전입니다. 따라서 이 +0.9046 USDT는 R5 절반 보호가 아니라 QV3의 가격/flow 소진 포착 사례입니다.

## 6. E1 검증

사전 고정한 fastWeak는 `last10sReturn < -0.002 AND takerBuyQuoteShare10s < 0.45`입니다. 109건 중 28건·19종목이 해당했고, decision 직전 1초 이내 마지막 체결가로 교정한 결과는 다음과 같습니다.

| 구간 | 상승 | 하락 | 중립 | 평균 변화 |
|---|---:|---:|---:|---:|
| 약 5분 | 11 | 16 | 1 | -0.8024% |
| 약 15분 | 9 | 18 | 1 | -1.0240% |

실제 정산은 10승/18패, 합계 -10.31259124 USDT였습니다. 이는 위험 연관성은 지지하지만 진입 금지 성능은 아닙니다. 28건을 정적으로 삭제하면 손실 35.9904를 빼는 대신 수익 25.6778도 놓칩니다. BEAT +8.9762 USDT와 고정 표본 밖 POLYX +1.4140 USDT가 반례입니다. 대기 중 새 가격·IOC 미체결·대체 진입·자금·슬롯을 반영하지 않은 +10.3126은 전략 개선액이 아닙니다.

연구 모듈 `e1-recovery.mjs`에는 다음 계약을 구현했습니다.

- 기존 자격 심사를 먼저 수행합니다.
- 결측·stale quote·book gap은 `UNKNOWN`으로 fail-closed합니다.
- fastWeak이면 최대 30초, 원래 신호 TTL보다 길지 않게 WATCH합니다.
- 완료된 비중첩 5초 블록, 블록당 최소 2체결, 두 블록 연속 return≥0 및 buyShare≥50%를 요구합니다.
- 현재 mid≥t0 mid, 기존 guard 및 수량별 유동성/비용을 재검사합니다.
- 회복 뒤 과거 t0 가격이 아니라 현재 ask/VWAP로 재평가합니다.
- 판단 함수에는 주문·네트워크·타이머 부작용이 없고 `executionEnabled=false`입니다.

하지만 과거 28건의 post-t0 5초 블록과 L2가 없어 실제 RECOVERY_CONFIRMED/EXPIRED 비율, 기회 유지율 및 계좌 순손익은 `UNKNOWN`입니다. 판정은 `DEFER`입니다.

## 7. X1 및 후속 청산 후보

`x1-fast-observer.mjs`는 R5/QV3 수식을 바꾸지 않고 다음만 분리했습니다.

- quote age≤1초 및 연속성 유효성 검사
- sampled best bid peak, 수량별 sell-VWAP peak, trade high의 별도 기록
- stop 단조성 및 tick 개선 시에만 갱신 후보 생성
- 동일 완료 봉 QV3 재평가 금지
- 현재 가격이 새 stop 이하이면 거부될 conditional 주문 대신 기존 idempotent close 계약으로 `CLOSE` 판단

FLOCK의 sampled bid MFE +0.765% 대 완료 봉 high +2.017%, 손실 BTW의 +1.979% 대 +2.496% 차이는 관측 개선을 시험할 근거입니다. 그러나 분봉 high가 해당 수량의 bid/VWAP도 아니고, threshold 위 유지 시간이나 stop 접촉 선후관계도 없습니다. VTHO를 더 일찍 잘라낼 winner damage 역시 계산할 수 없습니다. X1은 `DEFER`입니다.

X2의 `earlyArm=max(0.6%, 2×왕복 예상비용률, 0.4×ATR1m/entry)` 및 35% 보존 시작값은 X1과 섞지 않았습니다. 현 표본에서 +1.979% 주변으로 문턱을 맞추지 않았고, 소진 상태에 필요한 실제 sell-VWAP/OFI/bid 감소/ask 재보충이 없으므로 별도 프로토콜과 새 forward 구간 전에는 구현·주문 연결을 하지 않는 것이 맞습니다. 부분청산과 재진입도 잔량 stop, dust, 추가 비용 및 새 신호 계좌 재생이 없으므로 동일하게 `DEFER`입니다.

## 8. 더 오래 보유·부분익절 반례

실제 exit 뒤 같은 수량을 stop 없이 5/15/30분 더 보유한 완료 종가 기준 총액 차이는 다음과 같습니다. 비용·funding·호가 충격과 중간 stop이 빠진 연구용 가격 비교입니다.

| 거래 | +5분 | +15분 | +30분 |
|---|---:|---:|---:|
| VTHO | -8.88 | -7.75 | +3.95 USDT |
| SAGA | +0.81 | +0.19 | -0.74 USDT |
| POLYX | +1.72 | +4.28 | -9.66 USDT |
| BTW | +2.13 | -16.05 | -12.84 USDT |

VTHO의 +30분 가격을 얻으려면 중간 반납을 견뎌야 했고, BTW는 작은 수익 청산 15분 뒤 청산가보다 약 13.21% 낮았습니다. 사후 최적 보유시간은 정책이 아닙니다. VTHO에서 절반을 +2%에 팔고 나머지를 실제 exit에 판 단순 가정은 실제 전량 보유보다 가격 이익이 약 6.44 USDT 작았으며 추가 비용 전 값입니다.

꼬리 수익 의존도도 보존했습니다. 상위 5개 승자는 +59.7792 USDT로 전체 수익 풀의 26.45%입니다. 최대 승자 하나를 빼면 전체는 -25.4253 USDT, 상위 5개를 빼면 -70.0563 USDT입니다. 이는 큰 승자를 사전에 고를 수 있다는 뜻이 아니라, 작은 손실 감소와 큰 승자 훼손을 함께 보라는 민감도입니다.

## 9. 모델·단일 필터 결과

9/12와 9/13의 약 5분 상승 AUC는 각각 가격 구조 0.354/0.547, 가격+체결 0.420/0.605, 가격+시장 0.407/0.581, 가격+체결+시장 0.453/0.613, 여기에 운영·시간을 더하면 0.448/0.540이었습니다. 날짜 간 안정성이 없고 AUC는 비용 후 손익이 아닙니다. 단변량 86개 중 다중 비교 보정 뒤 유의한 특징은 없었습니다.

`RSI5≥70`, `3분 buyShare<50%`, `신호 age>60초`, `stop<ATR5 1배`, `EMA 이격>ATR5 3배` 집단의 실제 순손익은 각각 +10.1397, +17.3595, +17.5794, +2.4556, +10.8982 USDT였습니다. 이 사후 집단을 매수 조건으로 뒤집지도 않았고, 해당 조건을 일괄 금지하지도 않았습니다.

## 10. 테스트와 승격 판정

| suite | 통과 | 실패 |
|---|---:|---:|
| 신규 E1/X1·audit | 19 | 0 |
| gateway | 62 | 0 |
| 기존 QV3/V17/V18/V19/V21 비-SQL | 324 | 0 |
| PGlite SQL/CAS/정산 | 18 | 0 |
| 합계 | 423 | 0 |

테스트에는 stale/gapped quote, `m=true` 방향, 비중첩 5초 블록, 원래 TTL, 새 가격 재평가, VTHO/BEAT/POLYX 반례, FLOCK/BTW peak 종류 분리, 동일 QV3 봉 dedupe, monotone stop, 현재가가 새 stop 아래인 경우, order/network side-effect 부재가 포함됩니다. 기존 suite는 duplicate invocation, CAS/lease, IOC, timeout 후 동일 주문 조회, 보호 ACK 전 재시작, native stop race, fill 중복, 수동/다른 scope 보존 및 SQL 정산을 포함합니다.

그러나 다음 성능 gate는 값 자체가 없으므로 통과가 아닙니다.

- B0 행동 재현 오차 ≤0.25 USDT/거래
- 업데이트 후 종료 100건 및 시간순 검증 30건/3구간
- 후보의 양의 순기대값과 baseline 개선
- 최대 낙폭·최악 거래 비악화
- 기회 유지율 ≥70%
- 비용·지연 stress 후 양의 순손익
- 당시 자금·증거금·슬롯·소유권·funding 계좌 재생
- 각 24시간 및 최신 배포 cohort delta 비음수
- 다중 선택 반영 99% bootstrap confidence

따라서 B0 행동 재생, E1, X1, E1+X1 모두 `SUPERIOR`가 아니며 `DEFER`입니다.

## 11. 최종 운영 상태

2026-09-13 14:28:52.184 UTC의 gateway 직접 거래소 proof는 complete였고 다음을 확인했습니다.

- Binance futures 포지션 0
- 일반 주문 0
- 조건부 주문 0
- USDT balance/equity/available 92.80699616
- locked/initial margin/unrealized PnL 0

DB runtime은 live, circuit false, pause/kill/emergency/manual flag 모두 false였습니다. 논리 slot cap 10은 400 USDT 보유를 뜻하지 않으며, 실제 가용자금 92.80699616이 별도로 제약합니다. 14:20:03 UTC DB account snapshot은 `positionsComplete=false`, equity 3.76359, available 0.03028이어서 더 늦은 complete 거래소 proof보다 신뢰할 수 없습니다.

DB 전체 원장에는 9월 3일 V13의 SEI/UNI close 4행이 여전히 `SUBMITTED`로 남아 있지만, 각 행의 저장된 raw exchange status는 이미 `CANCELED`이고 최종 거래소 proof의 실제 주문은 0입니다. 즉 실거래 미확정 주문이 아니라 오래된 DB 상태 불일치입니다. 이를 삭제하거나 정상으로 덮어쓰지 않았습니다.

조사 중 기존 정책으로 자연 발생한 두 거래도 원장에 추가 확인했습니다.

| 거래 | 정책 | 순손익 | 최초 보호 ACK | 결과 |
|---|---|---:|---:|---|
| SOLV `a0c1f14b-2043-41fb-8a91-41c97f295b8e` | V22/V21/R5/QV3 | -3.19841045 | fill+5.165초 | native stop, 수수료 정산 확인 |
| PUNDIX `5f79558f-b6be-460d-8f0a-bef58ef9ecd8` | V22/V21/R5/QV3 | -2.95761967 | fill+6.043초 | native stop, 수수료 정산 확인 |

두 거래 합계 -6.15603012 USDT입니다. 이들은 새 후보 정책 거래가 아닙니다. executor v41 이후 확인 시점까지 신호 38개(종료 10, 거절 28), position 10개였고 모두 기존 stamp였습니다.

`KNOWN_ORDER_PENDING_RECONCILIATION` account incident가 09:15:10 UTC부터 OPEN인 반면 runtime circuit은 false이고 거래소는 flat입니다. 이를 자동 삭제하거나 circuit을 조작하지 않았습니다. control-plane metadata 이상으로 별도 운영 조사가 필요합니다. gateway proof의 `gatewaySourceHashVerified`와 `positionModeVerified`도 false여서 확인됐다고 주장하지 않습니다.

Supabase security advisor에는 기존 7개 rule family, 360 findings가 남아 있습니다. 그중 ERROR는 `security_definer_view` 29건과 `rls_disabled_in_public` 65건입니다. 전략 후보와 무관한 광범위 권한 변경은 이번 승인 범위에서 임의 적용하지 않았고, 이번 작업이 새 finding을 만들지도 않았습니다.

## 12. 다음 승격에 필요한 실제 작업

1. gateway의 지속 실행 position monitor에 실제 운영 position feed를 연결하되 처음에는 판단/quote/VWAP/sequence/ACK를 shadow 저장만 해야 합니다.
2. U/u/pu 연속성, 절대 수량 update, gap 재동기화를 지키는 local book과 수량별 sell-VWAP를 1초 품질 gate로 기록해야 합니다.
3. E1은 원래 signal TTL 안에서 5초 블록, 현재 mid, 새 IOC 가격/체결, 예약 TTL 및 대체 기회를 기록해야 합니다.
4. 최소 100 종료 거래, 시간순 30건/3구간을 확보한 뒤 B0/E1/X1/E1+X1을 같은 자금·슬롯·우선순위로 재생해야 합니다.
5. 현행 `research/qv3/protocol.json`의 모든 비용·위험·99% 신뢰 gate를 그대로 통과할 때만 production import, commit/PR, `main`, deploy, 신규 signal/fill/exit 확인 순으로 진행해야 합니다.

연구 cutoff 당시에는 배포를 진행하려면 데이터가 없는 부분을 유리하게 가정해야 했으므로 성능 승격을 허용할 수 없었습니다. 13절의 후속 배포는 이 성능 판정을 통과한 승격이 아니라 별도 운영자 override입니다.

## 산출물

- `generated/trade_truth.csv`: 210건 실제 원장과 시각/비용 coverage
- `generated/timeline.csv`: 거래별 시간 순서
- `generated/cause_matrix.csv`: 210건 거래별 원인 분류
- `generated/baseline_metrics.json`: 기준선 지표와 날짜/청산별 분해
- `generated/candidate_comparison.json`: B0/E1/X1/E1+X1 판정
- `generated/winner_damage.json`: 놓친 승자·꼬리 의존·보유 연장/부분익절
- `generated/feature_coverage.csv`: 자료 등급·결측 사유
- `generated/core_cases.json`: 지정 손실·수익 사례 원자료
- `generated/preregistration.json`: 사전 고정 임계값·gate
- `generated/validation_results.json`: 코드 테스트와 성능 gate 분리
- `generated/operational_evidence.json`: main/deploy/runtime/account 최종 증거
- `generated/operator_override_live_evidence.json`: override 배포와 자연 신호·체결·청산 증거

## 13. 연구 판정 이후 운영자 override와 실제 적용 증거

이 절은 위 연구 cutoff 이후 사건입니다. 성능 gate가 `DEFER`인 상태에서 사용자가
미검증 교체를 명시적으로 지시했으므로, 성능 우월성 승격과 분리한
`OPERATOR_OVERRIDE_UNVALIDATED`로 E1/X1을 활성화했습니다. 따라서 1절·10절의 연구 판정은
그대로 유효하고, 당시의 “미배포” 기록만 후속 운영 사건으로 갱신됩니다.

| 단계 | 후속 상태 | 증거 |
|---|---:|---|
| main 반영 | 완료 | feature `9700b28e...`, health fix `81930cb0...` |
| 실제 배포 | 완료 | executor v43, bundle `c64d7965...` |
| 자연 신규 신호 평가 | 완료 | BRUSDT `b906f118...`, E1 `E1_NOT_FAST_WEAK` |
| 새 stamp 체결 | 1건 | position `d8b779bb...`, 401 BR |
| native 보호 | 완료 | 0.29214 설치 후 0.29603으로 단조 상승, 새 ACK 뒤 기존 stop 취소 |
| X1 관측 | 완료 | bid peak 0.30509, 전량 sell-VWAP peak 0.3034 |
| 새 stamp 청산·정산 | 1건 | native stop, 비용 후 -1.07524050 USDT |
| 종료 후 계좌 | flat | signed account REST position 0, 일반 주문 0, runtime `FLAT` |

이 거래는 E1이 `WATCH_FAST_WEAK`로 분기하지 않았고, X1 관측 전에 기존 분 단위 R5가
이미 risk-cut stop을 올렸습니다. X1의 추가 stop update도 없었습니다. 따라서 이 한 건은
새 정책 연결·stamp·보호·정산은 입증하지만 B0 대비 손익 delta는 입증하지 않습니다.
후보의 성능 판정은 여전히 `DEFER`이며, 이 손실 한 건만으로 `INFERIOR`라고 판정할 수도
없습니다.

최종 거래소 fill은 250개@0.29725와 151개@0.29722, 진입 fill은
334개@0.29962와 67개@0.29963이었습니다. 가격 손익 -0.95556999 USDT에 진입·청산
수수료 0.11967050 USDT를 더한 DB 정산은 -1.07524050 USDT로 일치합니다.
`exchange_trade_fills`의 position 연결과 exit row는 확인 cutoff에 늦었지만, signed account
user trades, native stop의 `actualOrderId`, 두 trade ID 및 executor reconciliation이 수량·비용을
완전히 복원했습니다. 이를 미체결이나 미정산으로 해석하지 않습니다.

v43 자연 주기는 열린 동안 `PROTECTED`를 반환해 같은 주기의 잘못된 `FLAT` 표시 수정도
확인했습니다. X1은 cron 1분 전체를 연속 감시하는 프로세스가 아니라 각 Edge invocation
안의 제한된 1초 관측입니다. 첫 운영 loop는 전량 실행 가능 관측 1회와 얕은 top-bid 관측
30회를 기록했으므로, 지속 1초 L2 커버리지로 과장하지 않습니다.

상세 원시 식별자·시각·fill·stop 세대·최종 account proof는
`generated/operator_override_live_evidence.json`에 있습니다. 테스트 주문은 만들지 않았습니다.
