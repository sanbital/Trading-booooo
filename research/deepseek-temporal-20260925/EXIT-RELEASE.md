# 청산 개선 운영 배포 결과 — 2026-09-25

## 완료 상태
- 구현 커밋: a83e4ac526ea08c8491f6cdca411f6ec185659c6.
- 운영 저장 키 제약 수정 커밋: 8cbd1dcb87b3d6f08291656c6cc17b977768cfcd.
- Supabase etaajwpernzrcdrifdnw / v10-lane-executor **v89 ACTIVE**.
- 배포 SHA-256: ae8742095256da88ceef4f0e337f2df9c4954229a760ae66b76bb2b7ea5dd152.
- 배포 파일 56개를 다시 내려받아 업로드 내용과 전부 일치함을 확인했다. 변경 파일 Git blob SHA도 로컬 검증 파일과 일치한다.
- 실행기 표시 holdRelease: FD1-EXIT-HARDENING-DS-SHADOW-1. 기존 PATCH 필드는 과거 호환성을 위해 그대로이며, 운영 릴리스 식별은 holdRelease와 함수 버전을 사용한다.

## 검증 결과
- 로컬 회귀 테스트 **66/66 통과**, Deno 실행기 검사 통과.
- 최초 v88 검증에서 DB의 64자리 hex job_key 제약 위반을 발견했다. 신규 probe와 DeepSeek 키를 해시로 수정하고 v89로 재배포했다. 최초 실패 요청 57830은 API 검토를 시작하기 전 claim에서 거부됐다.
- 인증 없는 요청 57831: HTTP 401.
- v89 실제 API 검증 요청 57913: HTTP 200, ok=true, orderCalls=0.
- GPT: 유효 HOLD, 1340 ms. DeepSeek Flash: 유효 HOLD, 942 ms. 호출 시작 간격 80 ms로 겹쳐 실행됐다.
- 두 모델 저널의 원본 snapshot_hash 동일: 27272ff4a7b800286a957713859f577613156304c94c7c8aa5a780dfc21c004e.
- 현재 bid 입력은 스냅샷보다 18 ms 전의 거래소 호가이며 가격 기준 EXECUTABLE_BID가 확인됐다.
- GPT/DeepSeek 저널 모두 DONE, valid=true, error=null. 정산 값 각각 0.003438 USD와 0.0006837 USD(DeepSeek는 최고 요금 기준 예산 상한).
- 같은 runId의 재요청 57923: duplicate=true, 추가 주문 0. 기존 완료 키를 반환하여 제공자 중복 호출을 차단했다.
- 재검증 요청 57922, 관측 2026-09-25 11:09:51 UTC / 20:09:51 KST: DB와 거래소 포지션 2개 일치, 조건부 주문 2개, 미해결 주문 0. protection_health=PROTECTED, circuit_open=false, last_error=null. 운영 주기 완료 시각 11:09:49 UTC로 배포 후 갱신됐다.
- incident_kind의 기존 INCOMPLETE_OR_STALE_SNAPSHOT 문자열은 남아 있었지만 회로 차단 사유는 null이고 보호 상태는 PROTECTED였다. 이 문자열을 지우거나 재해석하지 않았다.
- DeepSeek shadow enabled=true, keyPresent=true, authority=[] 확인. 하루 한도 3 USD/300회 유지. 점검 중 누계 90회, 예산 반영 0.3976197 USD.

## 검증의 범위
실제 API 검증은 BTCUSDT 가상 보유 포지션의 주문 없는 probe였다. 이 점검 시점까지 v89 이후 자연 발생한 실제 보유 포지션의 신규 HOLD 검토는 관찰되지 않았다. 배포 및 API·저널·운영 보호 상태의 정상 작동을 확인한 것이며, 실거래 수익 개선을 입증한 것은 아니다. DeepSeek는 관찰 결과만 저장하고 주문 결정 권한을 갖지 않는다.

## 복구
DeepSeek만 중지하려면 DEEPSEEK_HOLD_SHADOW_ENABLED=false를 설정한다. 전체 코드 복구 기준은 배포 전 main c2fd61e97f359ccb71d8f0b6ad02ef077372bda3 및 executor v87, SHA-256 753aae6b3e65b6b064085b95d287b8c18ba500b4be1c642eb7d3527800643ace다. 다른 함수와 전략·사이징 설정은 이번 배포에서 변경하지 않았다.
