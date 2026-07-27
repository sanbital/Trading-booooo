# Trading-booooo v6.9.0 — EVIDENCE-SIZED LIVE VALIDATION

Base: `6.8.1-RESIDUAL-LABEL-INTEGRITY`

## 변경

1. 설정 슬롯 수를 주문 크기의 고정 분모로 사용한다. 후보 수가 적어도 한 종목이 빈 슬롯 자본을 흡수하지 않는다.
2. 소스코드 자가수정 대신 bounded `policy_definition` 정책군을 버전·감사 가능하게 저장한다.
3. LOB 데이터 불충분 거래는 유지하되 evidence에 따라 0.35~1.0 슬롯으로 크기를 조절한다.
4. 지연 미측정 상태에서도 noiseBand×가정 p95 또는 최소 1bp를 비용으로 반영한다.
5. 회계 검증 실거래의 `realized - predicted EV-LCB`로 낙관 편향을 추정해 진입 EV에서 차감한다.
6. backtest, shadow, PAPER, `LEGACY_UNVERIFIED`는 정책 승격 투표에서 제외한다.
7. 챌린저를 15% canary로 시작해 비유해성 확인 후 50%로 확대하고, Pareto non-inferiority를 통과해야 승격한다.

## 변경하지 않음

- 3개 슬롯 설정 자체
- 일일·주간·거래당 손실 한도
- 180초 기본·300초 절대 보유 한도
- 현물 전용·출금/레버리지 금지
- v6.8.1 잔량 회계

## 신규 파일

- `_shared/lob/adaptive-policy.ts`
- `_shared/lob/evidence-sizing.ts`
- `_shared/lob/ev-bias.ts`
- `202607270022_evidence_sized_live_validation_v690.sql`
- `SQL_VERIFY_v690.sql`
- `MODEL_REVIEW_v6.9.0.md`
- `validation/v690-deploy-validation.mjs`
