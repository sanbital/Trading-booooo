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

- Node 회귀·통합: 420/420 통과
- 격리 Postgres/PGlite: 18/18 통과
- TypeScript 모듈 구문, ESM 모듈 구문, whitespace diff 검사: 통과
- Supabase 배포 bundling/compile: 배포 시 별도 확인
- 성능 검증: 미통과(`DEFER` 유지)

## 운영 안전과 rollback

- `V23_E1_ENTRY_OVERRIDE=false`: E1만 즉시 비활성화합니다.
- `V23_X1_FAST_OBSERVATION=false`: X1 빠른 관측만 즉시 비활성화합니다.
- 환경값이 없으면 사용자의 교체 지시에 따라 두 정책이 활성화됩니다.
- rollback 대상은 위에 기록한 이전 main/executor bundle입니다.
- rollback은 기존 position stamp, 이미 상승한 stop, native stop 및 정산 증거를 낮추거나
  삭제하지 않습니다. 기존 포지션은 원래 정책 stamp를 계속 따릅니다.
- test 주문은 만들지 않습니다. 실제 신규 신호·체결·청산은 자연 발생 건만 증거로
  확인합니다.
