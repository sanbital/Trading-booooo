# Trading-booooo v5.1.0 업데이트

## 자동매매 범위

- 업비트 KRW 현물
- 바이낸스 USDT 현물
- 5분 통합 스캔
- 15초 포지션 감시
- 지정가 IOC 진입
- 손절·분할익절·추적손절·시간청산

## 거래소 중립화

포지션·주문·체결·계좌 스냅샷을 `exchange`, `quote_currency` 기준으로 저장합니다. KRW와 USDT 손익을 임의 환산하지 않고 거래소별 기준통화로 독립 관리합니다.

## 안전성

- 고정 egress IP 주문 게이트웨이
- Upbit JWT HS512 / Binance HMAC SHA256
- Binance 불명확 응답은 clientOrderId 조회 후 조정
- API별 로컬 주문·일일매수 상한
- 동일 기초자산 양 거래소 중복노출 차단
- 수동 보유잔고 격리
- DB RPC exactly-once 회계
- 출금·이체·마진·선물 경로 미구현

## 자기교정

실제 종료 거래를 후보 학습 결과에 덮어쓰고 LIVE 성과에 가장 높은 가중치를 부여합니다. 주간 워크포워드 하한 아래에서만 포워드 challenger를 승격하며 악화 시 자동 롤백합니다.
