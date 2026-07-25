# Trading-booooo v5.1.0 자동매매 설치

전체 절차는 [`DEPLOYMENT_AUTOTRADE.md`](./DEPLOYMENT_AUTOTRADE.md)에 통합되어 있습니다.

```text
Upbit KRW + Binance USDT 통합 스캔: 5분
열린 포지션 감시: 15초
실전 포워드 학습: 매시간
장기 워크포워드 교정: 매주
```

고정 egress IPv4를 먼저 발급해 두 거래소 API 키에 IP 제한을 적용한 뒤, API 키를 GitHub Repository Secrets에 등록합니다. 최초 운용 모드는 PAPER이며 `ENABLE_LIVE` 확인 전에는 실주문이 실행되지 않습니다.
