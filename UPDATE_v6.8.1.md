# v6.8.1 업데이트 절차

## 핵심

이 버전은 청산 수량 step 때문에 남은 코인을 손실로 기록하던 회계·학습 라벨을
수정한다. 신규 마이그레이션은 과거 재구성 가능한 dust 거래를 보정하고 온라인
학습 프로필을 corrected ledger에서 다시 만든다.

## 배포 순서

1. Supabase DB 백업
2. ZIP의 `Trading-booooo-main` 전체를 저장소 루트에 덮어쓰기
3. 커밋 후 기존 `Deploy Supabase` GitHub Actions 실행
4. 마이그레이션이 Edge Function보다 먼저 적용되는지 확인

신규 핵심 파일:

```text
supabase/migrations/202607270021_residual_label_integrity_v681.sql
supabase/functions/market-autotrader/residual-accounting.test.ts
AI_FEEDBACK_REVIEW_v6.8.1.md
SQL_VERIFY_v681.sql
```

마이그레이션은 슬롯·배분·진입 기준을 변경하지 않는다.

## 배포 직후 확인

Supabase SQL Editor에서 `SQL_VERIFY_v681.sql`을 실행한다.

정상 기준:

- 최근 CLOSED 포지션 `accounting_version = 6.8.1`
- step 잔량이 있었던 거래는 `residual_value_quote > 0`
- `realized_pnl_quote`가 잔량 가치를 포함
- `lob_online_outcomes.accounting_quality`에 `LEGACY_UNVERIFIED`가 남아 있으면 해당
  거래는 프로필 표본에 포함되지 않음
- 신규 BNB/ETH/BTC 종료 거래에서 `abs(net_bps) - mae_bps`가 한 step 가치만큼
  비정상 확대되지 않음

## 주의

마이그레이션은 `lob_online_outcomes`와 `lob_market_profiles`를 삭제 후 보정된
`trading_positions`에서 재생성한다. 원본 포지션·주문·체결은 삭제하지 않는다.
정책 테이블과 자금 설정도 변경하지 않는다.
