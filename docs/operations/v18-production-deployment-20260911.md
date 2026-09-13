# Trading-booooo 운영 배포·TAC circuit 복구 결과

확인 기준: **2026-09-11T09:20:20.776+09:00 KST** (2026-09-11T00:20:20.776186+00:00 UTC).

사용자 지시 “운영배포와 서킷해제 해”에 따라 선택 배포와 해당 incident 복구를 실행했다.
현재 circuit_open=false, entry_block_reason=NO_FRESH_BULL_SIGNAL, protection_health=FLAT.
실제 보유 포지션이 없어 기존 포지션의 production stop ratchet/청산을 검증한 상태는 아니다. 정상 신호를 기다리는 상태이며, 시험 실주문은 보내지 않았다.

## 1. 실제 배포 대상과 검증

| 대상 | 실제 결과 |
|---|---|
| Binance gateway | Fly `trading-booooo`, Paris cdg, release 184, machine `1850353b930168` |
| Gateway image | `sha256:4497c5775cba866cfc5af2d3e5b042ed73f3f35e22ec0ae2d821844ae569b82c` |
| Gateway 원본 commit | `fbc2647bf5d9b0e56c4f2d4cd112d307144711b1` |
| Gateway patch | `V18-OPS-ISOLATION-3`; 실제 health와 서명된 portfolio/openOrders 읽기 통과 |
| DB migration | `20260911000759_v18_ops_isolation.sql`; SQL SHA256 `3395e88d46ed7208913924bf93282cb8b9e5daef6976f243e9ca4983527d2d6e` |
| Executor | `v10-lane-executor`, **version 34 ACTIVE**, `V18-OPS-ISOLATION-3` |
| Executor bundle | `6a8d507c9709c718e927279473a915d5ba67f360c997842039077d000b512c38` |
| 소스 재검증 | production에서 다시 받은 9개 파일 모두 검토 소스와 일치. 배포 도구의 끝 개행만 정규화 |
| 인증 | 기존 verify_jwt=false 및 함수 내부 token 인증 유지; 인증 설정 변경 없음 |
| 복구 runner commit | `565eee0219fd3cfda27807f6f2fa97825ff7755f` |

로컬 검토 commit `cdad4a1aee30b5d3a009269ebe430954cc17023e`와 gateway release commit 사이의 차이는 선택 배포 workflow와 서명된 읽기 검증 script뿐이다. 후속 commit은 검증·복구 도구와 migration 파일명 정합성을 추가했고 trading 소스는 동일하다.
Supabase가 migration을 실제 적용 시각 `20260911000759`로 기록하므로 저장소 파일명을 이에 맞췄다. 기존 검토 SQL의 내용은 byte 단위로 동일하다.

기존 자금/전략은 LEADER_MOMENTUM_V17, 증거금 40 USDT, 레버리지 3x, V17 최대 슬롯 10이다. V17에 잘못 적용되던 기존 DB cap 3을 선언된 10과 맞췄고 LEGACY cap 3은 유지했다. 기존 position별 exit policy와 부분체결 관리 규칙은 유지했다.

main에는 push하지 않았다. Upbit gateway, signal generator, 다른 전략, exchange-trade-sync v61, scheduler 설정과 secret은 배포·변경하지 않았다.

## 2. 백업·DB 변경 범위

변경 직전 runtime, lease, operator, 제한된 settings, OPEN/pending 주문, TAC/SAGA CLOSED 원본 행, 함수·trigger·RLS/grants, gateway 이전 image 정보를 보존했다.
Migration 전후 positions 133 / orders 283 / exchange_trade_fills 4,771건으로 동일했고 과거 포지션·PnL을 고쳐 쓰지 않았다. Migration 직후 incident 0건, runtime 기존 circuit=true/기존 reason 유지, fence trigger 5개, incident RLS=true, anon RPC 실행 권한=false를 다시 확인했다.
새 incident는 승인된 CAS transaction으로 1건 생성됐다. 해제는 정상 executor가 같은 ID/generation에 대해 수행했다. operator flag, pause/kill/withdrawal/manual intervention은 변경하지 않았다.

## 3. 해당 incident의 증거 기반 복구

- Incident: `912bd951-0774-4d9c-86da-0bb631b54788`, generation `1`.
- 등록: 2026-09-11T09:12:55.300+09:00 KST.
- 등록 직전 새 gateway 관측: DB/거래소 flat, 일반 주문 0, algo 주문 0, account_scope=futures, positions_complete=true.
- TAC position `9d21a501-0b4a-4230-826b-6ca2d37d66e8` 및 SAGA position `794da229-cdce-4d41-800d-578f92d03f56`가 CLOSED/잔량 0임을 transaction 안에서 검증.
- TAC order `1179849258`, trades `116576836/116576837/116576838` SELL 합계 64,310; SAGA order `4882990988`, trade `311493537` SELL 7,067.3을 계좌·종목 범위로 검증.
- 정확한 기존 reason `BULL_EXTERNAL_EXPOSURE:COUNT:1:2:SAGAUSDT`, last_error, observed updated_at, incident_id=null/generation=0를 CAS로 확인.
- 등록 transaction은 circuit=true를 유지했다. 이후 서로 다른 live observation 3회, 간격 ≥50초/총 ≥110초 조건을 정상 cycle에서 충족했다.
- **실제 해제: 2026-09-11T09:17:05.069+09:00 KST** (2026-09-11T00:17:05.069957+00:00 UTC).
- 원래 runtime incident ID/generation을 유지한 해제이며 새 incident를 지우지 않았다. 신규 주문을 시험 발주하지 않았다.

첫 복구 runner는 DB URI를 PGDATABASE에 전달한 방식의 오류로 DB 접속 전에 실패했다. URI를 libpq 환경변수로 분리하는 방식으로 수정했고, 이후 새 증거로 성공했다. 실패 기록도 보존했다.
09:14 cycle은 recovery CAS lock timeout으로 HTTP 500을 반환했다. heartbeat는 갱신됐고 circuit은 유지됐다. 다음 cycle에서 조회·검증을 다시 수행했으며, 관측 간격이 90초를 넘었으므로 연속 확인 수를 1부터 다시 셌다. 이후 09:15/09:16/09:17의 3회 확인으로 해제됐다. 사후 lock 조회 시 blocker는 남아 있지 않아 해당 lock 보유 주체는 확정하지 않았다.

## 4. 실제 운영 cycle 결과

아래 시각은 net._http_response의 created 값이다. HTTP 200 외에 실제 response body의 entry/recovery/protection 상태를 함께 확인했다.

| HTTP row ID | KST 시각 | HTTP | clean checks | resolved | entry/오류 | protection |
|---|---|---|---|---|---|---|
| 26725 | 2026-09-11T09:13:00.051+09:00 | 200 | 1 | False | CIRCUIT_OPEN_MANAGEMENT_ACTIVE | FLAT |
| 26726 | 2026-09-11T09:14:00.174+09:00 | 500 | — | — | RECOVERY_CAS:canceling statement due to lock timeout | — |
| 26729 | 2026-09-11T09:15:00.102+09:00 | 200 | 1 | False | CIRCUIT_OPEN_MANAGEMENT_ACTIVE | FLAT |
| 26733 | 2026-09-11T09:16:00.053+09:00 | 200 | 2 | False | CIRCUIT_OPEN_MANAGEMENT_ACTIVE | FLAT |
| 26734 | 2026-09-11T09:17:00.070+09:00 | 200 | 3 | True | NO_FRESH_BULL_SIGNAL | FLAT |
| 26737 | 2026-09-11T09:18:00.069+09:00 | 200 | — | False | NO_FRESH_BULL_SIGNAL | FLAT |
| 26739 | 2026-09-11T09:19:02.094+09:00 | 200 | — | False | NO_FRESH_BULL_SIGNAL | FLAT |
| 26740 | 2026-09-11T09:20:00.106+09:00 | 200 | — | False | NO_FRESH_BULL_SIGNAL | FLAT |

최종 last_cycle_started_at: 2026-09-11T09:20:00.540+09:00; last_cycle_completed_at: 2026-09-11T09:20:03.860+09:00.
최종 OPEN positions: 0; 이번 배포 이후 생성 orders: 0.
관리·정산 대상이 없으므로 last_management_success_at/last_reconciliation_success_at을 허위 성공 시각으로 채우지 않았다. 기존 last_success_at은 오래된 호환 필드로 남아 있으므로 운영 판단에는 새 cycle/management/reconciliation 지표를 사용해야 한다.

## 5. 실제 검증 명령과 범위

GitHub Node **22.23.2**, PostgreSQL 17 및 PostgREST v14.18 runner에서 다음을 실행했다.

```sh
npm ci --prefix test-support/v18-ops --ignore-scripts
PGLITE_MODULE="$PWD/test-support/v18-ops/node_modules/@electric-sql/pglite/dist/index.js" \
node --test --test-reporter=tap test-support/v17-exit/*.test.mjs research/v18/*.test.mjs \
  test-support/v18-ops/*.test.mjs gateway/*.test.mjs
npm exec --yes --package=deno@2.5.6 -- deno check supabase/functions/v10-lane-executor/index.ts
docker build -t v18-verified-gateway gateway
node test-support/v18-ops/postgrest-gate.mjs setup
node test-support/v18-ops/postgrest-gate.mjs
```

- 배포 gate: **272 pass / 0 fail**. 실제 run → manage → refresh → openBull의 TAC COUNT:1:2 재현 및 수정 경로 포함.
- 원래 원격 Deno 의존성 검사 통과. 실제 Docker image 기동, health patch, shadow engine loading 통과.
- 실제 PostgreSQL에서 migration 2회 적용, 캡처한 production RLS/grants와 대상 trigger 정의 적용.
- 실제 PostgREST 인증 요청에서 lease 소유자 쓰기 허용, 만료/경쟁 패자 쓰기 거부, 동시 HTTP 요청 중 lease 1개만 획득, anon/authenticated incident mutation 거부 통과.
- 추가 관측 오류 회귀: `node --test --test-name-pattern='production recovery lock timeout' test-support/v18-ops/run-race.test.mjs` → **1 pass / 0 fail**. 합성 SAGA 가격에서 peak/stop 관리가 recovery lock timeout 전에 완료·보존되고 다음 cycle 복구가 이어짐을 확인했다. 이 추가 테스트를 배포 gate의 272개에 포함됐다고 보고하지 않는다.

격리 DB 검사는 대상 테이블 형태·RLS/grants·trigger 정의와 PostgREST fencing을 검증했다. 전체 production DB 복제, 모든 LEGACY 트리거 의존 경로 또는 실제 거래소 주문 경합의 실주문 테스트는 아니다.

실행 기록: [Gateway 배포](https://github.com/sanbital/Trading-booooo/actions/runs/34544767191), [PostgreSQL/PostgREST gate](https://github.com/sanbital/Trading-booooo/actions/runs/34545077062), [DB 접속 전 실패](https://github.com/sanbital/Trading-booooo/actions/runs/34545405919), [승인된 incident 등록 성공](https://github.com/sanbital/Trading-booooo/actions/runs/34545511406).

## 6. 현재 완료 범위와 남은 제한

코드 개발·회귀 테스트·선택 production 배포·production 소스 재확인·해당 circuit 복구는 완료했다. 해제 후 실제 cycle 결과는 위 표와 원본 증거에 남겼다.
현재 flat이므로 **진입 가능/신호 대기**, **실제 신규 체결 없음**, **실포지션 보호 갱신은 대상 없음**을 구분한다. TAC가 청산되는 순간의 SAGA 보호 지속은 실제 실행 경로를 쓰는 회귀 테스트로 확인했고, 해당 순간을 production 실주문으로 재연하지 않았다.
외부 포지션, 같은 종목의 수동 혼합, 불명확한 주문 결과, 인증 실패나 operator halt는 자동 해제 대상이 아니다. 새 문제가 생기면 현재 incident ID/generation과 원장을 다시 대조해야 한다.

**후속 배포 주의:** production은 `release/v18-ops-isolation-3`의 검토 소스를 사용하고 main은 `bce9e952...`에 남아 있다. 이후 main에서 기존 자동 배포를 실행하기 전에 이번 release를 반영하고 workflow 범위를 검토해야 한다. 그렇지 않으면 구형 소스로 되돌아갈 수 있다. 이번 작업에서 광범위한 main 자동 배포를 실행하지 않았다.
Rollback 시 gateway 이전 image는 backup에 보존돼 있다. Executor 구버전은 nullable 회계/journal을 이해하지 못하므로 OPEN/pending 주문이 생긴 뒤에는 단순 소스 rollback하지 않는다. 주문 원장·PnL을 snapshot으로 덮어쓰거나 정상 native stop을 일괄 취소하지 않는다.
