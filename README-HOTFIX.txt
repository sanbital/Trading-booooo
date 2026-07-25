Trading-booooo v5.2.1 Upbit 404 hotfix

1) 압축을 풉니다.
2) 안의 gateway 폴더와 UPDATE_v5.2.1.md를 GitHub 저장소 최상위에 업로드해 기존 파일을 덮어씁니다.
3) 커밋 후 자동 실행되는 Deploy Multi-Exchange Static-IP Gateway가 성공하는지 확인합니다.
4) 자동 실행되지 않으면 Actions > Deploy Multi-Exchange Static-IP Gateway > Run workflow에서 setup_only=false로 실행합니다.
5) 대시보드를 강력 새로고침한 뒤 계좌 즉시 대조를 누릅니다.

이 핫픽스는 Supabase, 거래소 API 키, 고정 EGRESS IP를 변경하지 않습니다.
