# v6.9.1 검증 기록

## 구현 검증

- Upbit aggregate paid_fee fallback
- 다중 체결 fee 비례 배분 및 합계 보존
- 실제 KRW-EUL 손익 `+2.03789731원` → `-19.963121625235원` 회귀검사
- Binance quote/BNB/base fee 분기 유지
- 과거 주문·체결·포지션·학습 라벨 backfill
- migration 멱등성 및 DB trigger 방어
- runtime 버전 정렬

## 로컬 검사

- Node deployment validations
- Gateway tests
- 소스 정적 검증
- ZIP 무결성

Deno 전체 typecheck/test는 GitHub Actions가 최종 출고 게이트입니다.
