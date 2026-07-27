# v6.9.0 검증 기록

대상: `6.9.0-EVIDENCE-SIZED-LIVE-VALIDATION`

## 수행 결과

- 전체 Deno 테스트 파일 Node 호환 실행: 360 passed
- 변경 모듈·정책 집중 테스트: 32 passed
- latency 모듈 집중 실행: 17 passed
- Gateway Node 테스트: 11 passed
- v6.9 정적 배포 불변식: 12 passed
- TypeScript syntax transpile: passed
- `git diff --check`: passed

## 최종 CI 필수

```bash
deno task check
deno task test
node --test gateway/server.test.mjs
node validation/v690-deploy-validation.mjs
node validation/v681-deploy-validation.mjs
node validation/v680-deploy-validation.mjs
```

현재 생성 환경에는 Deno가 없어 Node 22의 TypeScript strip + Deno assert/read shim으로 전체 테스트 파일을 실행했다. 공식 Deno 전체 테스트는 실행하지 못했다. GitHub Actions가 최종 출고 게이트다.

## 운영 검증

배포 후 `SQL_VERIFY_v690.sql`로 다음을 확인한다.

- 고정 3슬롯 분모
- evidence size fraction
- non-zero latency penalty
- EV bias sample/penalty
- accounting-verified live outcome만 governance 대상
- canary 15% → EXPAND 50%
- policy definition immutable 기록
