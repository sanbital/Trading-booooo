Trading-booooo v6.10.0 CI HOTFIX r3

원인:
- LobAdaptivePolicyDefinition.schemaVersion이 literal 2로 고정됨
- normalizeLobAdaptivePolicy 입력도 shallow Partial이어서 legacy schemaVersion 1과 일부 evidenceSizing 객체를 타입상 거부함
- adaptive-policy.test.ts는 legacy/partial 입력 정규화를 검증하는 올바른 테스트였음

수정:
- LobAdaptivePolicyInput deep-partial 입력 타입 추가
- schemaVersion 1을 포함한 기존 정책 row를 입력으로 허용
- normalize 결과는 계속 schemaVersion 2로 강제
- 정책 수치, 승격 로직, 자금 배분, 수수료, 청산 로직 변경 없음

적용:
1. 압축을 풉니다.
2. supabase 폴더를 GitHub 저장소 루트에 덮어씁니다.
3. 새 커밋을 생성합니다.
4. Actions에서 새 커밋으로 실행되는 Deploy Supabase Trading Engine을 확인합니다.
