# Trading-booooo v6.8.1 — RESIDUAL LABEL INTEGRITY

Base: v6.8.0-VALIDATED-PARETO-LEARNING.

## 확인된 실전 버그

바이낸스 시장가 청산은 주문 수량을 `quantity_step`으로 내림한다. 이전 회계 RPC는
남은 코인의 평가액이 1 USDT 미만이면 포지션을 CLOSED로 만들면서
`remaining_quantity = 0`으로 저장하고, 매도 현금만으로 실현손익을 계산했다.

실제로는 계좌에 남아 있는 코인이므로 다음과 같은 가짜 손실이 발생했다.

- BNBUSDT: 약 0.001 BNB 잔량이 누락되어 -138~-144bp로 기록
- ETHUSDT: 약 0.0001 ETH 잔량이 누락되어 -65bp로 기록
- BTCUSDT: 약 0.00001 BTC 잔량이 누락되어 -61bp로 기록

이 잘못된 `net_bps`가 `lob_online_outcomes`와 코인·패턴 EWMA에 들어가 실제보다
큰 손실을 학습시키고 있었다.

## 수정 내용

- 청산 후 남은 실제 수량을 `residual_quantity`로 보존
- 잔량을 마지막 체결가로 평가해 `residual_value_quote`에 기록
- 매도 수수료가 기준자산으로 지급되면 잔량에서 정확히 차감
- 실현손익을 `현금 매도대금 + 잔량 평가액 - 진입원가 - 현금성 수수료`로 계산
- 기준자산 수수료를 quote 수수료로 다시 빼는 이중 차감 방지
- 진입 시 기준자산 수수료 차감 후 수량을 주문 step으로 다시 내림하지 않고
  계좌가 실제로 받은 정밀 수량을 장부에 기록
- 과거 CLOSED 거래 중 운영 dust 기준 안에서 재구성 가능한 건을 자동 보정
- 재구성할 수 없는 과거 거래는 `LEGACY_UNVERIFIED`로 분리해 학습에서 제외
- 오염된 `lob_market_profiles`와 `lob_online_outcomes`를 보정된 포지션 원장에서 재생성
- 성과 API가 CLOSED 포지션의 잔량 가치와 보정된 실현손익을 사용

## 변경하지 않은 것

- 3개 슬롯과 자금 배분
- 진입 임계값과 후보 수
- 목표가·손절가·최대 보유시간
- v6.8 Pareto CHAMPION/CHALLENGER 승격 규칙
- 일일·주간 손실 한도

따라서 이 릴리스는 거래 빈도를 낮추는 전략 변경이 아니라, 이미 발생한 거래의
경제적 결과를 정확하게 기록해 자기교정 라벨을 정상화하는 무결성 패치다.
