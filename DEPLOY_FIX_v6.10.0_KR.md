# Trading-booooo v6.10.0 배포 복구 안내

## 오류 원인

### 1. TS2322

`adaptive-policy.ts`에서 타입이 지정된 배열 리터럴 뒤에 바로 `.sort()`를 연결하면서
Deno가 `family`를 `LobAdaptivePolicyFamily`가 아닌 일반 `string`으로 확장했습니다.

수정은 배열 생성과 정렬을 분리하는 것입니다.

### 2. 버전 불일치

GitHub 저장소에는 다음과 같이 일부 파일만 v6.10.0으로 올라간 상태였습니다.

- scanner: v6.9.1
- autotrader: v6.9.1
- gateway: v6.10.0
- dashboard: 이전 버전

전체 패키지 안의 파일은 모두 아래 버전으로 통일돼 있습니다.

`6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE`

## 가장 빠른 복구 방법

`Trading-booooo-v6.10.0-ACTIONS-HOTFIX-r2.zip`을 풀고, 그 안의 다음 경로를 저장소 루트에
그대로 덮어씁니다.

1. `supabase/functions/_shared/lob/adaptive-policy.ts`
2. `supabase/functions/market-scanner/engine.ts`
3. `supabase/functions/market-autotrader/index.ts`
4. `gateway/server.mjs`
5. `docs/index.html`

GitHub 웹 업로드 시 ZIP 자체나 최상위 폴더를 저장소 안에 올리지 말고, 압축을 푼 뒤
`supabase`, `gateway`, `docs` 폴더를 저장소 루트의 같은 폴더 위에 덮어씁니다.

커밋 후 새 Actions 실행을 기다립니다. 실패했던 기존 실행의 `Re-run`은 하지 않습니다.

## 기대 결과

- `deno task check` 통과
- `engine, autotrader and gateway report the same version` 통과
- `the dashboard fallback banner is not older than the engine` 통과
- 이후 migration 및 Edge Function 배포 단계 진행
