# Trading-booooo v6.5.1-GUARD

Base: v6.5.0-LATENCY.

## 거래 중지 오류

`only Upbit KRW spot markets are allowed`는 게이트웨이의 정상적인 거부였습니다.
문제는 `monitorCycle`이 모든 포지션의 quote를 하나의 `Promise.all`로 묶어, 한
포지션의 잘못된 market 또는 일시적인 quote 실패가 모든 포지션의 청산 판단을
중단시킨 구조였습니다.

- `_shared/spot-market.ts`: Upbit `KRW-BASE`, Binance `BASEUSDT`를 동일 규칙으로
  검증합니다.
- monitor quote를 `Promise.allSettled` 기반으로 격리했습니다. 실패 포지션은
  `MARKET_DATA_UNAVAILABLE`로 남고, 나머지는 정상적으로 감시·청산됩니다.
- 진입 전에 candidate route를 검증해 잘못된 market이 포지션/주문으로 진행되지
  않습니다.
- scanner persistence도 잘못된 route만 제외하고 정상 후보는 계속 저장합니다.
- 신규 migration의 `NOT VALID` check constraints가 신규·수정 행을 즉시
  보호하면서 과거 dirty row 때문에 배포 전체가 실패하지 않도록 했습니다.

## 미측정 지연비용

v6.5.0은 실측 표본이 0건이어도 1bp를 비용으로 부과했습니다. 이는
“표본이 쌓이기 전에는 계측만 한다”는 운영 원칙에 맞지 않습니다.

- 기본 prior를 1bp에서 0bp로 변경했습니다.
- 측정 전에는 0bp입니다.
- 측정 후에는 종목 noise band와 p95 지연으로 계산한 비용을 표본 수
  `n/(n+60)`으로 수축해 반영합니다.
- 운영자가 명시적으로 `scalp_latency_penalty_bps`를 올리면 그 값은 prior로
  사용할 수 있습니다.

## 모델 데이터 추출

`SQL_CHECK_v6.5.1.sql`을 추가했습니다. 기존 제안의
`scanner_signal_outcomes`는 LOB의 180초 보유와 달리 최소 1시간 버킷이므로
movement 상수 학습용으로 부적합합니다. 대신 실제 포지션의 2초 monitor
`peak_price`/`trough_price`에서 MFE·MAE를 계산합니다.

실제 CSV가 입력되기 전에는 movement 계수
`6 + confidence*62 + activity*26 + ...`를 변경하지 않습니다. 소표본에 계수를
맞추는 것은 개선이 아니라 과적합이기 때문입니다.
