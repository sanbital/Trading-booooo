# v6.8.1 검증 기록

검증일: 2026-07-27  
대상: `6.8.1-RESIDUAL-LABEL-INTEGRITY`

## 실데이터 재현

제공된 실거래에서 다음 패턴을 확인했다.

```text
BNBUSDT  initial 0.071 / sold 0.070 / step 0.001
기록 손실 -138.44bp / 누락 잔량 가치 140.85bp

ETHUSDT  initial 0.0209 / sold 0.0208 / step 0.0001
기록 손실 -65.41bp / 누락 잔량 가치 47.85bp
```

기존 RPC는 dust로 CLOSED 처리한 뒤 잔량 가치를 PnL에 더하지 않았다.

## 신규 회귀 테스트

`residual-accounting.test.ts`는 다음을 고정한다.

- BNB 매도 수수료가 BNB로 지급된 뒤 실제 잔량 계산
- ETH quote 수수료 거래의 한 step 잔량 평가
- 1 USDT보다 큰 잔량은 CLOSED로 처리하지 않음
- 기준자산 수수료가 남은 수량보다 크게 차감되지 않음

## 정적 검증

다음 명령을 실행한다.

```bash
node --check gateway/server.mjs
node --check docs/app.js
node --check docs/performance.js
node validation/v681-deploy-validation.mjs
node validation/v680-deploy-validation.mjs
node validation/lob-source-validation.mjs
```

Deno가 있는 CI에서는 추가로 실행한다.

```bash
deno task check
deno task test
```

## 보장 범위

- step 잔량이 가짜 손실로 학습되지 않는다.
- 기준자산 매도 수수료는 physical residual에서 차감된다.
- 재구성 불가능한 과거 라벨은 자동 학습에서 제외된다.
- 기존 Pareto 정책·슬롯·자금 설정은 바뀌지 않는다.

수익성 자체를 보장하는 변경은 아니다. 정확한 라벨로 이후 정책 비교를 가능하게
하는 무결성 수정이다.
