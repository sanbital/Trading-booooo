# V18-OPS-ISOLATION-3 배포·복구 절차

상태: 검토용. 이 절차는 실행되지 않았다. 운영 변경은 사용자 요청 2항의 별도 명시적 승인이 필요하다.

## 승인 범위

다음을 구분해서 승인받는다.

1. 정확한 검토 commit의 gateway / migration / executor 선택 배포.
2. 해당 TAC incident의 증거 기반 복구 대상 재분류. 이는 이후 자동 circuit 해제를 허용하는 운영 변경이다.
3. 필요하다면 배포 중 신규 진입 pause 및 CAS 복원. pause/kill/withdrawal/manual intervention을 임의 해제하지 않는다.

main push, workflow dispatch, DB migration, Fly 배포를 코드 리뷰와 혼동하지 않는다.
이번 패치에 포함된 workflow 변경은 없다. 로컬 commit만으로 배포하지 않는다.

## 1. 배포 경로와 부작용

| 기존 workflow | 이 변경과의 관계 | 사용 제한 |
|---|---|---|
| `deploy-binance-gateway.yml` | main의 `gateway/**` 변경으로 Binance Fly 배포; secret 설정·인프라 작업도 포함 | main push 금지. 기존 전체 bootstrap 절차를 그대로 실행하지 않는다 |
| `deploy-order-gateway.yml` | 같은 `gateway/**` 변경으로 Upbit Fly 배포도 발생 | 이번 Binance 수정의 선택 배포에서 제외 |
| `deploy-market-autotrader-v707.yml` | main의 `_shared/**` 변경으로 autotrader 관련 배포 | 이번 선택 배포에서 제외 |
| `main.deploy-supabase.yml` | main의 `supabase/migrations/**` 변경으로 다른 서비스·DB 배포 | 전체 migration push를 선택 migration으로 오인하지 않는다 |
| `deploy-v17-exit-reliability-20260908.yml` | trigger 파일 main push 또는 dispatch. 이전 함수명/소스 문자열 gate와 trigger PATCH 사용 | 새 코드의 함수 추출 gate와 맞지 않으므로 그대로 dispatch하지 않는다 |

승인된 release runner에서 검토 SHA를 detached checkout하여 아래 선택 명령만 실행한다.
새 workflow가 필요하다면 별도 파일 diff와 권한·trigger 검토 후 등록한다. 기존 secret을 사용하며 secret 값을 로그에 출력하지 않는다.

## 2. 승인 전 완료된 검증 및 배포 전 추가 gate

`test-support/v18-ops/README.md`의 회귀 명령을 정확한 release SHA에서 다시 실행한다.
Supabase staging에서 기존 실제 trigger/RLS/권한을 포함한 migration 적용과 PostgREST 경유 lease header fencing을 검증한다.
로컬 PGlite 검증은 전체 production schema 복제나 실제 다중 연결 부하 검증을 대신하지 않는다.
실주문을 검증 방법으로 쓰지 않는다.

원래의 원격 ESM 의존성 경로로 `deno check supabase/functions/v10-lane-executor/index.ts` 및 배포 bundle 검사를 수행한다.
개발 환경에서는 Deno 2.5.6과 같은 버전의 npm `@supabase/supabase-js@2.57.4`를 사용한 오프라인 검사가 통과했다.
원격 ESM 다운로드는 개발 환경에서 완료되지 않았다.

gateway `stage-engine.mjs` 실행 후 Docker 이미지 build 및 시작 검증을 한다.
개발 검증은 Dockerfile의 실제 COPY 파일 집합을 임시 디렉터리로 옮겨 import한 단계까지다.

## 3. 변경 직전 snapshot과 대상

트랜잭션 읽기 전용 snapshot을 파일로 보존하고 SHA-256, UTC 시각, release SHA를 기록한다.
토큰·인증 테이블·secret 값은 포함하지 않는다.

```sql
begin transaction isolation level repeatable read read only;
select now(), current_database();
select * from public.v11_long_regime_runtime where singleton;
select * from public.v17_operator_control where singleton;
select owner,expires_at from public.v17_execution_lease where singleton;
select mode,pause_new_entries,scalp_kill_switch,withdrawal_mode,
       manual_intervention_required,emergency_liquidation,pause_lock_reason,
       binance_futures_allocation_usdt,binance_futures_leverage,updated_at
from public.trading_settings where id=1;
select * from public.v11_long_regime_positions where state='OPEN';
select * from public.v11_long_regime_orders
where state in ('PLANNED','DISPATCHED','RECONCILIATION_FAILED','RECONCILIATION_PENDING');
select captured_at,positions_complete,positions,available_quote,locked_quote
from public.trading_account_snapshots where exchange='binance_futures'
order by captured_at desc limit 3;
select id,symbol,state,remaining_quantity,realized_pnl_usdt,metadata,updated_at
from public.v11_long_regime_positions
where id in ('9d21a501-0b4a-4230-826b-6ca2d37d66e8','794da229-cdce-4d41-800d-578f92d03f56');
commit;
```

대상 테이블의 schema-only dump와 변경 대상 함수·trigger·grants도 보존한다.
데이터 backup은 필요한 행을 암호화된 운영 보관 위치에 저장한다.

| 작업 | 기존 행에 대한 기대 영향 |
|---|---|
| migration | 과거 position/order/fill DML 0건. runtime 1행에 새 열 기본값. 새 incident 표 0행 |
| slot trigger 정합성 | V17 상한 10, LEGACY 상한 3. 이후 insert/update에서 적용 |
| 현재 incident 재분류 | runtime singleton 1행, 새 incident 1행. lease 1행 획득·해제 |
| 자동 복구 | 검증한 incident 1행과 동일 runtime incident/generation만 갱신 |
| 지연 fill 재귀속 | 새 identity와 일치하는 미귀속 fill만 갱신. PnL/수량 추가 반영 0건 |

재귀속 예상 건수는 동일 exchange/account_scope/market/order ID 조건의 SELECT로 먼저 계산한다.
계좌 전체 과거 fill backfill은 이 migration에 포함하지 않는다.

## 4. 순서가 있는 선택 배포 — 승인 후에만 실행

승인된 runner에서 기존 secret을 환경변수로 공급한다. `REVIEWED_SHA`는 검토 문서의 완전한 40자리 SHA다.
main push 없이 해당 commit을 detached checkout한다.

```sh
git checkout --detach "$REVIEWED_SHA"
test "$(git rev-parse HEAD)" = "$REVIEWED_SHA"
git diff --exit-code
node gateway/patch-trade-history.mjs
node gateway/stage-engine.mjs
node --test gateway/*.test.mjs
```

`patch-trade-history.mjs`는 기존 Binance 배포와 동일한 읽기 전용 history route staging이다.
변환 후 gateway hash와 원래 commit을 함께 기록한다. 실행 중 새 incident가 발생하면 기존 복구 절차를 중단한다.
현재 계좌가 flat이 아니면 소유권·실잔량·기존 native stop을 다시 확인한다. 필요한 entry pause는 별도 승인 대상이다.

1. 기존 Fly 앱·region·설정을 읽고 배포 대상을 확인한다. 앱 생성, IP 재할당, secret 재설정 단계는 실행하지 않는다.
2. 기존 파일 `gateway/fly.binance.toml`을 사용하는 Binance gateway만 배포한다. 아래 명령은 기존 workflow의 deploy 단계와 같다.

```sh
(cd gateway && flyctl deploy . --remote-only -a "$FLY_BINANCE_APP_NAME" --config ./fly.binance.toml --ha=false)
```

3. gateway health의 `ops_patch=V18-OPS-ISOLATION-3`을 확인한다. 서명된 읽기 전용 `p10_portfolio`, `v18_open_orders`로 올바른 계좌, 완전성·신선도, 일반 주문과 algo 주문을 확인한다.
4. 기존 `SUPABASE_DB_URL`로 다음 migration 한 파일만 적용한다. 파일 자체에 BEGIN/COMMIT이 있다.

```sh
psql "$SUPABASE_DB_URL" --no-psqlrc --set=ON_ERROR_STOP=1 \
  --file=supabase/migrations/20260911000759_v18_ops_isolation.sql
```

`supabase db push`로 미적용 전체 이력을 실행하지 않는다. migration 이력 등록이 필요하면 실행한 SQL과 기존 이력을 대조한 뒤 해당 version 등록만 별도 검토한다.
5. RLS/grants, lease fence, slot cap, nullable 회계 열, incident RPC, 귀속 trigger 정의를 다시 읽어 hash를 확인한다.
6. v10-lane-executor만 배포한다.

```sh
supabase functions deploy v10-lane-executor --project-ref etaajwpernzrcdrifdnw
```

기존 JWT/내부 token 설정을 보존한다. 인증을 비활성화하는 추가 flag를 사용하지 않는다.
7. production 함수 version/status와 모든 import 파일을 다시 받아 검토한 소스 hash와 비교한다. version 증가만으로 일치 판정하지 않는다.
8. `exchange-trade-sync`는 배포하지 않는다. 실제 운영 v61에는 repo에 없는 `futures-sync.ts`와 변경이 있다. repo 버전의 단순 재배포는 이를 제거한다.
9. generator, LEGACY autotrader, Upbit gateway, 다른 전략, 자금 설정, native-stop 활성화 flag는 변경하지 않는다.

## 5. 현재 구형 incident의 복구

기존 runtime에는 incident ID/generation이 없으므로 migration만으로 자동 해제하지 않는다.
현재 reason 문자열만 보고 `circuit_open=false`를 실행하지 않는다.

재분류의 evidence predicate는 다음과 같다.

- 정확한 기존 reason, `last_error=EXTERNAL_POSITION`, circuit=true, incident_id IS NULL, generation=0.
- 동시에 다시 읽은 완전하고 신선한 DB·gateway 상태 일치. flat을 전제하지 않는다.
- 알려진 native algo/actualOrderId/fills로 TAC 64,310과 SAGA 7,067.3의 청산이 설명됨. 과거 행을 OPEN으로 되돌리지 않는다.
- 위험을 바꿀 수 있는 미확정 주문 없음. 일치한 ACTIVE native stop만 허용한다.
- 계좌·종목·방향·소유권·잔량·보호가 확인됨. 수동 혼합, 외부 주문, 인증 실패이면 수동 검토한다.
- operator flag를 보존하고, 조회 이후 DB version이나 incident 변경이 없음.

승인된 runner가 새 UUID로 기존 `v17_acquire_execution_lease`를 획득한다.
동일 transaction에서 runtime을 FOR UPDATE로 읽고, 관측한 `updated_at`, 기존 reason, incident ID/generation을 CAS 조건으로 검증한다.
조건 불일치이면 영향 0건으로 중단한다. 새 증거 없이 조건을 제거해 재시도하지 않는다.
검증을 포함한 실행 SQL은 `docs/operations/v18-approve-flat-legacy-incident.sql`이다. 이 파일은 현재 flat인 경우에만 실행 가능하며 재실행은 CAS miss로 중단해 새 incident를 중복 생성하지 않는다. 검증 후 사용하는 변경 RPC는 다음이다. 파라미터는 그 시점의 검증 결과이며 예전 snapshot을 넣지 않는다.

```sql
select public.v18_record_incident(
  :'owner_uuid'::uuid,
  'KNOWN_EXIT_PENDING_RECONCILIATION',
  'APPROVED_TAC_NATIVE_CLOSE_RECONCILED',
  :'verified_evidence_json'::jsonb
);
```

RPC는 circuit=true를 유지하면서 새 incident를 만든다. 기대 영향은 runtime 1행, incident 1행이다.
획득한 owner만 lease를 해제하고, 이후 일반 scheduler의 독립 검증에 맡긴다.
동일 승인을 재전송할 때는 이미 생성한 incident ID를 확인한다. 새 세대를 계속 만들어 clean count를 초기화하지 않는다.
새 incident가 생기면 과거 승인에 의한 재시도를 중단한다.

새 V18 incident의 자동 복구는 50초 이상 간격의 서로 다른 account observation 3회, 전체 110초 이상, 인접 관측 90초 이내를 요구한다.
1분 scheduler를 기준으로 최소 약 2분의 연속 확인이다. 같은 캐시 응답은 세지 않는다.
새 불일치나 operator halt는 clean count를 초기화한다. 시간 경과만으로 circuit을 해제하지 않는다.
과거 fee-only pending 150건이나 일치한 ACTIVE 보호주문은 위험 미확정 주문으로 세지 않는다.

## 6. 복구 후 최소 3 cycle 확인

각 cycle마다 다음 증거를 따로 보존한다.

- 호출 시각·HTTP status·본문 patch/entry/managed/reconciliation/recovery.
- last_cycle_started_at, last_cycle_completed_at 전진. HTTP 200만으로 정상 판정하지 않는다.
- 각 OPEN position의 last_evaluated_at, peak/stop, native ack/query 시각, 잔량과 보호 수량.
- last_management_success_at, protection_health, last_reconciliation_success_at, pending age.
- entry_block_reason, incident ID/generation, 복구 확인 횟수, operator flags.
- DB·거래소 재대조와 미확인 주문 부재.

flat이면 보호 관리를 “운영 검증 완료”라고 하지 않고 “대상 포지션 없음”으로 기록한다.
정상 신호가 없으면 “진입 가능·실체결 없음”으로 보고한다. 강제 시험 주문을 보내지 않는다.

## 7. rollback / 보상 조치

- migration transaction 실패: rollback한다. gateway 추가 계약은 이전 executor와 병존 가능하다.
- executor 문제: 승인 범위에서 신규 진입을 차단하고 기존 native stop을 유지한다. 미확정 주문은 기존 ID로 조회한다.
- 소스 rollback: backup한 정확한 version으로 선택 배포한다. 이전 executor는 nullable 회계와 새 journal을 이해하지 못하므로 OPEN/pending 행이 있는 상태에서 곧바로 되돌리지 않는다.
- 데이터 복구: snapshot으로 전체 fill/PnL/position을 덮어쓰지 않는다. 그 사이 실제 체결을 없애게 된다. 해당 row version/incident ID를 조건으로 보상 변경을 별도 검토한다.
- 새로운 operator halt, 외부 포지션, 소유권 혼합, 인증·거래소 전체 장애, 주문 결과 불명은 자동 복구하지 않는다.
- lease는 기존 10분 TTL과 잔여 60초 확인을 유지한다. process crash 시 다음 획득까지 기다릴 위험은 남는다. 현재 TAC 장애의 직접 원인은 lease 점유가 아니다.

## 8. 읽기 전용 SQL fallback

이번 조사에서는 Supabase 직접 SQL이 작동했으므로 fallback workflow를 실행하지 않았다.
기존 `automation-performance-readonly-20260904.yml`은 `SUPABASE_DB_URL` 및
`PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=60000'`을 사용한다.
다만 특정 과거 기간을 조회하는 main-push-only workflow다. 임의 SQL을 dispatch하는 도구가 아니다.
새 확인 SQL을 넣으려면 저장소/workflow 쓰기 검토가 필요하다. write-capable repair workflow를 읽기 전용 경로로 실행하지 않는다.
