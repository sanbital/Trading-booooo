# E1/X1 운영자 우선 교체 기록

- 결정 시각: 2026-09-13
- 이전 운영 기준선: main `adbcebd9dcc7614966f4a61ce53dd166f0f02f40`, executor v41,
  bundle `a9f5de783c0af38da40a407b5309ee997a25fec1c80297718e0255b7a872df3e`
- 변경 patch: `V23-E1-X1-OPERATOR-OVERRIDE-1`
- E1: `E1_FAST_WEAK_RECOVERY_OVERRIDE_1`
- X1: `X1_FAST_OBSERVATION_OVERRIDE_1`
- 활성화 근거: `OPERATOR_OVERRIDE_UNVALIDATED`
- 직전 성능 판정: `DEFER`

## 결정의 의미

`REPORT.md`의 연구 결과는 변경하지 않습니다. E1/X1은 비용 후 전체 계좌 성과,
독립 검증 표본, 수량별 과거 체결 가능 가격 및 99% familywise bootstrap 승격 기준을
통과하지 못했습니다. 운영 반영은 성능 우월성 판정이 아니라 사용자의 명시적 우선
교체 지시입니다. 따라서 주문·신호·포지션·청산 기록에는
`parametersValidatedByBacktest=false`, `priorPerformanceVerdict=DEFER`와 위 활성화 근거를
영구 저장합니다.

## 실제 연결 범위

- E1은 기존 자격·QV3·소유권·자금 제어 뒤 실제 `OPEN_LONG` 주문 경로에 연결됩니다.
- fastWeak가 아니면 기존 후보를 유지합니다. fastWeak이면 원래 신호 TTL 안에서만
  최대 30초 기다리고, 두 개의 완료된 비중첩 5초 블록과 새 L2·자금·슬롯·소유권을
  통과해야 현재 가격의 IOC 주문으로 진행합니다.
- 누락, 오래된 호가, 잘린 체결, 전량 depth 부족은 통과로 바꾸지 않습니다.
- X1은 이 patch 이후 생성되어 X1 stamp가 있는 포지션만 최대 1초 간격으로 관측합니다.
  기존 R5/QV3 수식, hard stop, stop 단조성, native 보호 교체, 동일 주문 조회 및 CAS
  경로는 그대로 사용합니다.
- X1은 전체 보호 수량이 최우선 bid에서 실행 가능한 관측만 peak로 인정하며, stop은
  최소 한 tick 개선되고 rate budget을 만족할 때만 동기화합니다. QV3는 기존 분 단위
  완료 봉 경로에서만 평가합니다.
- 기존 포지션에는 새 entry/exit stamp를 소급하지 않습니다.

## 코드·정합성 검증

- Node 회귀·통합: 421/421 통과
- 격리 Postgres/PGlite: 18/18 통과
- TypeScript 모듈 구문, ESM 모듈 구문, whitespace diff 검사: 통과
- Supabase 배포 bundling/compile: 통과
- 성능 검증: 미통과(`DEFER` 유지)

## main·배포·자연 거래 확인

- main feature commit: `9700b28e5ede28a1ff42b32cfd02609c11103ccc`
- same-cycle health fix commit: `81930cb098162d6f16eeb9fb3d17f86c8a2e82c8`
- 최종 executor: v43, ACTIVE, bundle
  `c64d7965c00faac88ac99e890866f136f1c60727958ca0a6e1226168d607fa14`
- 배포 파일 15개는 해당 main의 executor import 집합과 문자열 단위로 일치했습니다.
- 자연 발생 BRUSDT 신호 `b906f118-88f6-4ba2-a8f2-2a9bd5ebabfa`가 E1으로 평가되고,
  position `d8b779bb-b218-41a9-8b37-c96c9c764b13`에 E1/X1/override stamp가 저장됐습니다.
- 401개 fill 뒤 native stop이 설치됐고, 기존 R5 risk-cut으로 0.29214에서 0.29603으로
  상승했습니다. 새 stop ACK는 기존 stop 취소 요청보다 110ms 빨라 보호 공백이 없었습니다.
- X1은 bid peak 0.30509와 전량 실행 가능 sell-VWAP peak 0.3034를 저장했지만 추가 stop
  변경은 만들지 않았습니다.
- position은 2026-09-13 15:21:10.247 UTC에 native stop으로 종료됐습니다. 원시 account
  fill·수수료와 DB 정산 순손익은 -1.07524050 USDT로 일치했습니다.
- 종료 후 signed account proof는 포지션 0, 일반 주문 0, algo/조건부 주문 0이었고 executor의
  reconciliation은 수량 401, attribution/accounting complete, runtime `FLAT`을 확인했습니다.
- 이후 3초 freshness 창을 넘긴 account 관측으로 generation 55 circuit이 fail-closed 됐지만,
  기존 V19 복구기가 완전 account/open-order 독립 관측 3회를 모아 같은 세대를 CAS로
  `RESOLVED`했습니다. circuit을 수동으로 변경하지 않았고 최종 entry block은
  `NO_FRESH_BULL_SIGNAL`입니다.
- 이 거래는 E1 fast-weak 분기와 X1 추가 행동이 모두 없으므로 baseline 대비 성능 차이의
  증거가 아닙니다. `DEFER` 판정은 유지합니다.

세부 증거는 `generated/operator_override_live_evidence.json`에 보존합니다.

## 운영 안전과 rollback

- `V23_E1_ENTRY_OVERRIDE=false`: E1만 즉시 비활성화합니다.
- `V23_X1_FAST_OBSERVATION=false`: X1 빠른 관측만 즉시 비활성화합니다.
- 환경값이 없으면 사용자의 교체 지시에 따라 두 정책이 활성화됩니다.
- rollback 대상은 위에 기록한 이전 main/executor bundle입니다.
- rollback은 기존 position stamp, 이미 상승한 stop, native stop 및 정산 증거를 낮추거나
  삭제하지 않습니다. 기존 포지션은 원래 정책 stamp를 계속 따릅니다.
- test 주문은 만들지 않습니다. 실제 신규 신호·체결·청산은 자연 발생 건만 증거로
  확인합니다.
