# v6.9.0 적용 안내

## 목적

v6.8.1의 정확한 손익 라벨을 기반으로, 후보 부족 시 자금 집중을 막고 저표본 거래의 크기를 줄이며 지연·EV 낙관 편향을 비용에 반영한다. 정책은 회계 검증 실거래 canary를 거쳐서만 승격한다.

## 배포

1. DB와 저장소 백업
2. 전체 파일 덮어쓰기 후 커밋
3. GitHub Actions 전체 통과 확인
4. `202607270022_evidence_sized_live_validation_v690.sql` 적용
5. Edge Functions/Gateway 배포
6. `SQL_VERIFY_v690.sql` 실행

## 즉시 확인

- engine/autotrader/gateway/dashboard 버전이 모두 `6.9.0-EVIDENCE-SIZED-LIVE-VALIDATION`
- 설정 슬롯 3개일 때 신규 주문의 `slots=3`
- 후보 1개여도 `notionalQuote <= totalExposureCap/3`
- `dynamicStatus=INSUFFICIENT`이면 `sizeFraction <= 0.55`
- 지연 미측정이어도 `latency_penalty_bps > 0`
- 챌린저 traffic은 0.15에서 시작

## 주의

신규 설정·정책 컬럼을 읽는 코드이므로 migration과 함수 배포를 같은 릴리스에서 수행한다. 수익성은 신규 회계 검증 실거래가 쌓인 뒤 판정한다.
