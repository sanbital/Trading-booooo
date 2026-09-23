# 실거래 재개 기록 (2026-09-23, 사용자 지시)

- GPT 제어: `ENFORCE`, 일일 $3 / 300회, approval_ref `USER-APPROVED-2026-09-23-ENFORCE-3USD-300` (13:59 UTC 전 적용, circuit 해제 이전).
- 대사(14:02 UTC): Binance 포지션 0 / 일반 주문 0 / 조건부 주문 0, DB 포지션 0 / 미해결 주문 0.
- incident gen 123 `MANUAL_REVIEW_REQUIRED` → 사용자 승인 재분류: lease 획득, incident CAS, DB flat 확인 후 `v19_record_incident`로
  gen 124 `INCOMPLETE_OR_STALE_SNAPSHOT`(`OPERATOR_APPROVED_FLAT_RECONCILED_GEN123`). `circuit_open`은 직접 쓰지 않음.
- executor 자체 복구가 Binance 독립 관측 3회(14:03:08, 14:04:08, 14:05:09)로 circuit 해제: 14:05:10 UTC, gen 124 RESOLVED.
- 해제 직후 진입 평가 정상(`NO_FRESH_BULL_SIGNAL`). 08:50 이후 시장 국면 NEUTRAL이라 기존 모델 신호 없음 → 실제 후보의 ENFORCE 경로는 다음 BULL 신호에서 관찰 필요.
- 미해결: 실행자 자신의 주기 오류가 open circuit에서 MANUAL_REVIEW로 승격되는 trigger 동작 수정은 도구 보안 판정으로 거부됨(운영자 결정 필요).
  v70은 이 경로의 실제 원인(복구 lock timeout)만 재시도로 처리함.

## 후속 (사용자 승인)
- `v18_external_incident_epoch` 수정 적용(migration `20260923141626`): 현재 유효한 lease 소유자(실행자)가 circuit·사유를 바꾸지 않고
  `last_error`만 갱신하면 오류는 그대로 기록하되 MANUAL_REVIEW로 승격하지 않음. 헤더 없는 writer, 다른 소유자·만료 lease,
  circuit 개방, circuit_reason 변경은 기존대로 승격. SQL: `sql/v18_external_incident_epoch_executor_owner.sql`, 테스트: `tests/incident-epoch-sql.test.mjs`.
- 임시 검증 함수 삭제: release workflow의 `delete-gpt-final-review-verify` 대상으로 수행.

## 호가·펀딩·미결제약정 스냅샷 입력 추가 (executor v71, ezbr `2500de76…`, main `2b96c6a`)
- 심사 시점에 공개 Binance USD-M 4개 엔드포인트(호가 100단계, premiumIndex, openInterest, 5분 OI 이력)를 캔들과 병렬 조회.
- GPT 사실 항목 추가: 스프레드(bp), ±25bp 매수·매도 호가 금액, 호가 불균형, 슬롯 주문금액(600 USDT) 대비 매도 호가 배수,
  펀딩비, mark/index 프리미엄, 미결제약정 금액, OI 5분·60분 변화율. 스냅샷 시점 5초 초과 자료는 제외, 실패 소스는 해당 항목만 비움.
- 실제 API 라이브 프로브 8건(BTC·ETH·SOL·ACE·XRP·DOGE·BNB): 8/8 검증 통과, 마이크로구조 수집 8/8 완전,
  스냅샷 시점 신선도 0~9ms(요청 5~15ms). GPT가 7/8건에서 마이크로구조 사실을 근거로 인용.
  지연 2.6~4.3초(두 번째 측정 2.6~3.6초), 출력 370~482 토큰, 건당 약 $0.004.
- 프로브 후보는 fixture이며 선택기가 거절한 종목이라 전부 VETO가 정상 결과. 라이브 PASS 경로는 실제 후보에서 확인 필요.
