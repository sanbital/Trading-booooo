# V18-OPS-RACE-2 — 배포 및 운영 복구 절차

2026-09-10 작성. **이 문서의 배포·DB 수정·차단 해제·거래 재개는 모두 운영자가 직접 실행한다.**
작성 과정에서 수행한 것은 코드 수정과 로컬 검사, 그리고 읽기 전용 조회뿐이다.

- 대상 저장소: `sanbital/Trading-booooo`
- 기준 커밋: `588524c7fe73d6ac7359df7127676a79598dd58a` (조회 시점 `origin/main` HEAD와 동일)
- 작업 브랜치: `claude/trading-booooo-ops-recovery-sqok8n`
- Supabase 프로젝트: `etaajwpernzrcdrifdnw`
- 대상 함수: `v10-lane-executor` (조회 시점 운영 version **32**, PATCH `V17-EXIT-SETTLE-1`)
- 배포할 PATCH: **`V18-OPS-RACE-2`**
- 전략/청산 정책: `LEADER_MOMENTUM_V17` / `V17_EXIT_R5_TAIL` — **변경 없음**
- 증거금 40 USDT, 레버리지 3배, 최대 10슬롯 — **변경 없음**

---

## 0. 배포를 유발하는 동작 (먼저 확인)

직접 확인한 결과, 아래 두 경로가 **main push만으로 실제 운영 배포를 실행**한다.

| 워크플로 | 트리거 | 결과 |
|---|---|---|
| `deploy-v17-exit-reliability-20260908.yml` | `push: branches:[main]`, `paths: research/v17-exit-reliability-deploy-trigger.txt` | `v10-lane-executor`를 운영에 배포 |
| `main.deploy-supabase.yml` | `push: branches:[main]`, `paths: supabase/migrations/**` 외 | migration 적용 + 다른 함수 배포 |

이번 변경은 `research/v17-exit-reliability-deploy-trigger.txt`를 수정하므로
**main에 병합하는 순간 executor 배포가 시작된다.**

그래서 이 작업에서는:

- 작업 브랜치(`claude/trading-booooo-ops-recovery-sqok8n`)에만 push했다. 이 브랜치는 어떤 배포 워크플로도 트리거하지 않는다.
- 원장 보정 SQL을 `supabase/migrations/`가 아니라 `ops/db-patches/`에 두었다. migrations에 두면 main 병합만으로 운영 DB에 적용된다.
- main push, workflow 실행, 함수 배포, 주문 제출, 차단 해제는 **하나도 수행하지 않았다.**

---

## 1. 배포 대상

### 변경 파일

| 파일 | 변경 |
|---|---|
| `supabase/functions/v10-lane-executor/index.ts` | PATCH 문자열, 진입 직후 보호, closePos 앞 native 청산 복구, 차단 중 동기화 전용 경로, 복구 후보 한정, 실패 보고 |
| `supabase/functions/_shared/leader-protection-adapter.mjs` | 이미 CLOSED인 포지션의 exit_reason 덮어쓰기 방지 |
| `supabase/functions/_shared/leader-entry-protection.mjs` | 신규(진입 체결·DB 저장 직후 보호 처리) |
| `research/v17-exit-reliability-deploy-trigger.txt` | `2026-09-10 V18-OPS-RACE-2` 추가 — **배포 트리거** |
| `.github/workflows/deploy-v17-exit-reliability-20260908.yml` | 테스트 단계에 `research/v18/*.test.mjs` 추가 |
| `test-support/v17-exit/native-close-race.test.mjs` | 신규 회귀 검사 |
| `test-support/v17-exit/native-fill-reconcile.test.mjs` | 차단 중 동기화 검사 확장 |
| `test-support/v17-exit/exit-settle.test.mjs` | settle 함수 추출 범위 수정 |
| `research/v18/*` | 연구 전용. **매매 경로에 연결되지 않음** |
| `ops/db-patches/20260910_native_stop_fill_attribution_repair.sql` | 신규. 원장 보정. **자동 적용 안 됨** |

### 변경 함수 (executor)

- `reconcileNativeCloseBeforeDispatch()` — 신규
- `reconcileCandidates()` — 신규
- `reconcileNativeFills()` — 실패 보고 추가
- `run()` — 차단 중 동기화 전용 분기
- `closePos()` — 포지션 부재 시 native 체결 확인 후에만 매도 생략
- `manageLeader()` — native 복구 시 청산 사유를 `V17_NATIVE_STOP`으로 기록
- `openBull()` — 진입 직후 보호 처리 호출

migration 없음. DB 스키마 변경 없음.

---

## 2. 배포

### 2-1. 코드 검토 후 main 반영

```bash
git fetch origin claude/trading-booooo-ops-recovery-sqok8n
git log --oneline origin/main..origin/claude/trading-booooo-ops-recovery-sqok8n
git diff origin/main..origin/claude/trading-booooo-ops-recovery-sqok8n
```

검토 후 main에 병합한다. **병합 즉시 배포가 시작된다.**

브랜치에서 `workflow_dispatch`로 먼저 배포할 수도 있으나, 그 경우 다음 main 배포가
코드를 되돌리므로 결국 main과 운영 소스를 일치시켜야 한다.

### 2-2. 워크플로 확인

<https://github.com/sanbital/Trading-booooo/actions/workflows/deploy-v17-exit-reliability-20260908.yml>

wiring gate → 테스트(`node --test test-support/v17-exit/*.test.mjs research/v18/*.test.mjs`,
`node --check gateway/server.mjs`, `node --test gateway/server.test.mjs`) → CLI 2.109.1 배포 순으로 진행된다.

### 2-3. 직접 CLI로 배포할 경우

```bash
supabase --version
supabase functions deploy --help
supabase functions deploy v10-lane-executor --project-ref etaajwpernzrcdrifdnw --no-verify-jwt --use-api
```

`--no-verify-jwt`는 기존 배포 설정이다. 함수는 `x-v10-executor-token` 검증을 그대로 유지하므로
내부 인증 코드를 제거하면 안 된다.

### 2-4. 배포 후 버전 확인

```sql
-- 함수 버전이 32에서 올라갔는지
select id, slug, version, status, to_timestamp(updated_at/1000) as updated_at
from  -- Supabase 대시보드 Edge Functions 화면 또는 Management API로 확인
```

대시보드에서 `v10-lane-executor`의 version이 **33 이상**인지 확인한다. 그리고 실행 응답의 PATCH를 확인한다:

```sql
select revision, live_enabled, circuit_open, circuit_reason, last_error,
       last_success_at, updated_at
from public.v11_long_regime_runtime;
```

배포 직후 executor가 남기는 감사 로그로 PATCH를 직접 확인할 수 있다:

```sql
select created_at, action, reason, details->>'executorPatch' as patch
from public.v11_long_regime_decisions
order by created_at desc limit 5;
```

`executorPatch`가 `V18-OPS-RACE-2`여야 한다.

---

## 3. 배포 후 자동으로 일어나는 일 / 일어나지 않는 일

cron `v11-long-regime-executor`(매분, active)가 실행되면:

**일어나는 일**
- `circuit_open=true`이므로 **동기화 전용 경로**로 진입한다.
- 거래소 포지션을 읽기 전용으로 1회 조회하고, 거래소가 더 이상 전량 보유하지 않은 포지션만 대상으로
  기억된 native 주문을 조회한다(`v17_query_stop`, `v17_stop_fill` — 둘 다 읽기 전용).
- 정확한 체결이 확인되면 CKB 포지션이 `CLOSED`, `remaining_quantity=0`,
  `exit_reason='V17_NATIVE_STOP'`으로 기록되고 실현손익이 거래소 체결값(funds/fee)으로 반영된다.
- 응답에 `reconciliationOnly:true`, `reconciledClosed`, `reconciliationPending`,
  `reconciliationFailures`가 포함된다.

**일어나지 않는 일**
- 신규 진입 없음
- software 매도 없음
- native 주문 신규 제출·취소 없음 (동기화 경로는 `v17_create_stop`/`v17_cancel_stop`를 호출하지 않는다)
- **차단 자동 해제 없음** — 차단 해제는 운영자만 한다

조회가 실패하면 성공으로 표시하지 않고 `reconciliationFailures`에 남기며 CKB는 계속 대기 상태다.

---

## 4. 복구 확인 (읽기 전용)

### 4-1. CKB — native 체결과 DB 대조

```sql
select id, symbol, state, original_quantity, remaining_quantity,
       exit_price, exit_reason, closed_at, realized_pnl_usdt,
       jsonb_pretty(metadata->'exitProtection') as journal
from public.v11_long_regime_positions
where id = 'ecf3660c-74c4-499b-992c-85496abaf81b';
```

충족해야 할 조건:

- `state='CLOSED'`, `remaining_quantity=0`, `exit_reason='V17_NATIVE_STOP'`
- journal의 두 번째 주문(`clientId` `tb-v17s-1d17ecb122039f46f0959d0cdaa`, algoId `2000001424023086`)에
  `actualOrderId='4191734774'`, `fillStatus='FILLED'`, `appliedQuantity=101139`,
  `appliedFunds`, `appliedFee`가 기록되어 있을 것
- `closed_at`이 실제 체결 시각 `2026-09-10 07:41:03.160+00`(16:41:03.160 KST)과 일치할 것

거래소 체결 원장과 대조:

```sql
select exchange_trade_id, exchange_order_id, executed_at, side, quantity, price,
       fee_quote_amount, accounting_status, v17_position_id
from public.exchange_trade_fills
where market='CKBUSDT' and exchange_order_id='4191734774'
order by exchange_trade_id;
```

수량 합계 82,539 + 8,520 + 10,080 = **101,139**가 포지션 수량과 일치해야 한다.

### 4-2. EGLD 및 나머지 포지션 — 소유 수량·보호 주문

```sql
select id, symbol, state, remaining_quantity, hard_stop_price, last_evaluated_at,
       metadata->'exitProtection'->>'health' as protection_health,
       jsonb_pretty(metadata->'exitProtection'->'orders') as orders
from public.v11_long_regime_positions
where state='OPEN' order by entry_at;
```

```sql
select captured_at, positions_complete, jsonb_pretty(positions::jsonb)
from public.trading_account_snapshots
where exchange='binance_futures'
order by captured_at desc limit 1;
```

조회 시점 기준값: EGLD 23.3개, `positions_complete=true`, 보호 주문
algoId `2000001423922721` / clientAlgoId `tb-v17s-eb6c312725e1c258d3be1981694`,
triggerPrice 5.104, status `ACTIVE`.

**주의: 위 journal의 `status`와 `lastQueryAt`은 마지막 조회 시점의 값이지 현재 거래소 상태가 아니다.**
CKB가 그 증거다 — journal은 `ACTIVE`인데 실제로는 이미 체결돼 있었다.
차단 해제 전에 반드시 Binance에서 **현재 포지션과 현재 미체결 일반·조건부 주문을 직접 조회**해
DB 소유 수량과 일치하는지 확인하라. 오래된 `ACTIVE` 메타데이터를 현재 주문 상태로 간주하면 안 된다.

- 포지션: `GET /fapi/v2/positionRisk`
- 일반 미체결: `GET /fapi/v1/openOrders`
- 조건부(algo) 미체결: `GET /fapi/v1/openAlgoOrders`

EGLD에 유효한 보호 주문이 없으면, 차단 해제 전에 보호부터 복구해야 한다.

### 4-3. 원장 attribution 보완 — **필요함**

`ops/db-patches/20260910_native_stop_fill_attribution_repair.sql` 참조.

직접 확인한 사실:

- native 청산의 매도 주문은 `v11_long_regime_orders`에 행이 없다(주문 `4191734774` 조회 결과 0행).
  포지션의 `exitProtection` journal이 유일한 연결 근거이며, 트리거는 이를 **행이 기록되는 순간에만** 조회한다.
- 그 결과 아래 두 건이 `UNMATCHED_INVENTORY` / `source=UNCLASSIFIED`로 남아 있다.

| 종목 | 주문 | 수량 | 체결 시각(UTC) | 상태 |
|---|---|---|---|---|
| EDGEUSDT | 900418698 | 93 | 2026-09-10 00:32:11.044 | 근거 이미 존재 → **지금 보정 가능** |
| CKBUSDT | 4191734774 | 101,139 (3건) | 2026-09-10 07:41:03.160 | journal에 `actualOrderId` 없음 → **배포·동기화 후 보정** |

EDGE는 청산 자체가 정상이었다(포지션 `69b72bbc…` CLOSED, `V17_NATIVE_STOP`, 실현손익 -0.75419745 반영).
문제는 원장 라벨뿐이다. 원인은 경합이다: 체결 00:32:11.044 → journal에 `actualOrderId` 기록 00:33:02.976,
**52초 차이**. 그 사이에 `exchange-trade-sync`가 행을 먼저 넣어 트리거가 근거를 찾지 못했다.

보정 SQL은 exchange·종목·주문·체결 ID로 한정되고, journal의 `FILLED` 영수증이 있을 때만 적용되며,
attribution 4개 컬럼이 모두 null인 행만 건드리므로 **중복 적용이 불가능**하다.
포지션 수량·상태·실현손익은 건드리지 않는다(실현손익은 이미 protection reconciler가 거래소 체결값으로 반영했고,
원장의 `realized_pnl_quote`는 별개의 평균원가 재고 원장이다 — 이중 계상 없음).

MAGMAUSDT(주문 1444776244 BUY / 1472439514 SELL, 각 1,029)는 native 청산이 아니라 근거 규칙 밖이므로
이 보정에서 **제외**했다. 별도 분류가 필요하다.

**남은 결함(이번에 고치지 못함):** 위 경합은 여전히 열려 있다. 앞으로도 sync가 executor tick보다 빠르면
native 청산의 매도 체결이 다시 미연결로 남는다. 근본 해결은 "삽입 시점 1회"가 아니라 재귀 보정 패스가 필요하고,
그것은 DB 함수 → `supabase/migrations/` → main push 시 자동 적용이므로 운영자가 별도로 결정할 사안이다.
그때까지는 native 청산이 발생할 때마다 위 SQL을 재실행하면 된다.

---

## 5. 차단 해제와 거래 재개

**아래는 운영자가 직접 실행한다. 이번 작업에서는 수행하지 않았다.**

해제 전 모두 충족해야 하는 조건:

1. 함수 version이 33 이상이고 `executorPatch`가 `V18-OPS-RACE-2`
2. CKB가 체결 근거와 함께 `CLOSED` / `remaining_quantity=0` / `exit_reason='V17_NATIVE_STOP'`
3. `reconciliationFailures`가 비어 있음 (최근 실행 응답 또는 함수 로그)
4. **Binance 직접 조회** 결과 현재 포지션이 DB의 OPEN 포지션과 정확히 일치
5. 열려 있는 모든 포지션에 현재 유효한 보호 주문이 존재
6. 원장 보정(4-3) 완료, leak check에 native 청산 미연결 건이 남아 있지 않음

모두 충족한 뒤:

```sql
-- 운영자 직접 실행. 위 1~6을 확인하기 전에는 실행하지 말 것.
update public.v11_long_regime_runtime
set circuit_open = false,
    circuit_reason = null,
    last_error = null,
    updated_at = now()
where singleton = true
  and circuit_open = true
  and circuit_reason = 'V17_POSITION_MANAGEMENT_FAILED:CKBUSDT';
```

`circuit_reason` 조건을 넣은 이유는, 그 사이에 **다른** 사유로 차단이 다시 열렸다면 이 UPDATE가
0행을 반환하고 아무것도 하지 않게 하기 위해서다. 그 경우 새 사유부터 조사해야 한다.

해제 후 1~2분 내 확인:

```sql
select circuit_open, circuit_reason, last_error, last_success_at, last_entry_at, updated_at
from public.v11_long_regime_runtime;
```

`last_success_at`이 갱신되고 `circuit_open`이 false를 유지하면 재개된 것이다.
다시 열리면 `circuit_reason`을 근거로 조사하고, 해제를 반복하지 말 것.

`entry_enabled`는 조회 시점 이미 `true`이므로 별도 조작이 필요 없다.

### 하지 말 것

- 체결 근거 없이 DB 잔량을 0으로 바꾸는 것
- 미연결 원장 행을 삭제하는 것
- 위 조건을 확인하지 않고 circuit만 강제로 해제하는 것
- native 보호 주문을 임의 취소하거나 손절선을 낮추는 것

---

## 6. 롤백

코드 롤백 대상은 기준 커밋 `588524c7fe73d6ac7359df7127676a79598dd58a`다.

```bash
# main에서 되돌린 뒤 트리거 파일을 다시 건드려야 배포가 실행된다.
git revert <merge-commit>
# research/v17-exit-reliability-deploy-trigger.txt가 되돌려지면 배포 워크플로가 다시 동작한다.
```

또는 워크플로를 기준 커밋에서 `workflow_dispatch`로 실행한다.

롤백 시 주의:

- 되돌리면 **차단 중 동기화 경로가 사라지므로** CKB는 다시 미연결 상태로 돌아가고,
  경합이 재발하면 같은 방식으로 다시 멈춘다.
- **실제 체결·native 주문 ID·포지션 회계 기록은 과거로 되돌리지 말 것.** 코드만 되돌린다.
  이미 반영된 `CLOSED`/실현손익/원장 attribution은 거래소 체결에 근거한 사실이다.
- 원장 보정 SQL은 코드 롤백과 무관하며 되돌릴 필요가 없다.
- 급히 매매를 멈춰야 하면 롤백보다 `circuit_open=true` 또는 `live_enabled=false`가 빠르고 안전하다.

---

## 7. 검사 결과 (로컬, 실계좌 아님)

```
node --test test-support/v17-exit/*.test.mjs research/v18/*.test.mjs   → 186/186 통과
node --check gateway/server.mjs                                        → 통과
node --test gateway/server.test.mjs                                    → 41/41 통과
배포 워크플로 wiring gate (로컬 재현)                                   → 전 항목 통과
```

186건은 첨부 패키지의 181건 + 이번에 추가한 회귀 검사 5건이다.

**이는 로컬 모의 실행이다.** 실계좌 주문, 배포 후 함수 실행, native ACK 실측,
E2E 검증은 수행하지 않았다.
