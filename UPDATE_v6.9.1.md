# v6.9.1 적용

1. ZIP 내부 `Trading-booooo-main`의 전체 내용을 GitHub 저장소 루트에 덮어씁니다.
2. `.github` 폴더와 신규 migration이 포함됐는지 확인합니다.
3. 새 커밋으로 업로드합니다. 과거 실패 작업을 Re-run하지 않습니다.
4. GitHub Actions에서 전체 테스트와 `v691-deploy-validation`이 통과해야 합니다.
5. Supabase 배포 후 `SQL_VERIFY_v691_FEE_LEDGER.sql`을 실행합니다.
6. 세 검사 모두 `PASS`인지 확인합니다.

신규 migration은 과거 Upbit 수수료와 순손익을 교정하고 LOB 학습 원장을 재생성합니다.
