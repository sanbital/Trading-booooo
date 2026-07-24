# Trading-booooo v4.0.1

## 배포 비밀값 정정

- GitHub Repository Secret은 총 5개만 사용합니다.
- 기존: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SCAN_ACCESS_TOKEN`
- 추가: `SUPABASE_DB_PASSWORD`, `LEARNING_ACCESS_TOKEN`
- `SUPABASE_SERVICE_ROLE_KEY`는 Supabase Edge Function에 기본 제공되므로 GitHub Secret 검증 및 `supabase secrets set` 단계에서 제거했습니다.
- v4.0.0의 오래된 배포 문서를 v4.0.1 기준으로 정리했습니다.
