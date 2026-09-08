# V17 청산 신뢰성 패치 (V17-EXIT-RELIABILITY-REVIEW-2)

출처: `Trading_Boo_V17_Exit_Review_20260908.zip`. 패키지의 SHA256SUMS 77개 항목 전부 일치를 확인한 뒤 적용했습니다.

## 실제로 운영에 반영되는 변경

`supabase/functions/v10-lane-executor/index.ts`:

1. **호가 조회를 `quote` → `p10_quotes`로 교체하고 신선도 게이트를 추가**했습니다. `best_bid`/`best_ask` 유효성, `timing.received_at_ms` 존재, 3초 초과 지연과 1초 이상의 시계 역전을 검사해 위반 시 `V17_EXIT_QUOTE_INVALID_OR_STALE`로 중단합니다. 오래된 호가로 청산 주문을 내지 않습니다.
2. **청산 순서를 바꿨습니다.** 이미 감지된 손절이 peak DB 쓰기나 audit 왕복을 기다리지 않습니다. `CLOSE`가 결정되면 먼저 청산하고 audit은 뒤에서 실패해도 청산을 막지 않습니다(`.catch`).
3. **청산 시도 식별자를 결정적으로 만들었습니다.** `cid()` 대신 `exitAttemptId(positionId, attemptId)`가 SHA-256으로 `tb-v11x-<27hex>`(35자)를 만듭니다. 전송 타임아웃 시 같은 식별자로 조회하므로 재전송으로 인한 중복 청산이 생기지 않습니다. 게이트웨이 `validateIdentifier`(접두사 `tb-`, 36자 이하, `[A-Za-z0-9_-]`)를 통과하는 형식입니다.
4. **`v17_create_stop` / `v17_cancel_stop`에도 `engine_version`을 붙입니다.**

`gateway/server.mjs` + 신규 `gateway/v17-stop-commands.mjs`: 거래소 네이티브 보호 주문용 `v17_*` 명령 경로를 추가했습니다(선물 전용). 기존 경로는 건드리지 않습니다.

## 운영에 반영되지 **않는** 것

- **R3 / R4 청산 정책은 비활성입니다.** `leader-exit-r3*.mjs`, `leader-exit-r4*.mjs`, `leader-native-protection.mjs`, `leader-protection-adapter.mjs`는 파일로만 존재하며 executor가 import하지 않습니다.
- **청산 임계값은 그대로입니다.** `nextExitReviewed`는 유효 정책에 `breakEvenArmPct`/`profitLockArmPct`가 있을 때만 기준선에서 벗어납니다. `POLICY`에는 두 키가 없고, 포지션 `metadata.leaderExitPolicy`로만 개별 활성화됩니다. 따라서 이번 배포로 열려 있는 포지션의 청산 판단은 바뀌지 않습니다. 배포 워크플로가 이 조건을 매번 검사합니다.
- 패키지 문서 기준으로 R4는 같은 9거래 표본으로 만들고 평가한 후보이며 표본 밖 검증이 없습니다. 자동 활성화하지 않는 이유입니다.

## 검증

패키지 테스트 75개를 `test-support/v17-exit/`로 옮기고 import 경로를 **패키지 사본이 아니라 이 저장소의 실제 소스**로 바꿔 실행했습니다. 저장소의 `leader-momentum-v17.mjs`는 패키지 `source_after` 사본과 내용이 다르므로 이 재배선이 실제 통합 검사입니다.

- `node --test test-support/v17-exit/*.test.mjs` → 75/75 통과 (관측된 V17 결정 232건 재현 포함)
- `node --test gateway/server.test.mjs` → 기존 41/41 통과
- `node gateway/patch-trade-history.mjs` → 배포 시점 패치가 수정된 server.mjs에도 그대로 적용됨
- `actionlint` → 신규 워크플로 통과

## 배포 방법

executor는 push만으로 배포되지 않습니다. `main` 병합 후 **Deploy V17 Exit Reliability** 워크플로를 `workflow_dispatch`로 실행하거나, `research/v17-exit-reliability-deploy-trigger.txt`를 `main`에서 수정하십시오. 게이트웨이는 `gateway/**` 변경이 `main`에 들어가면 `deploy-binance-gateway.yml`이 자동으로 Fly에 배포합니다.
