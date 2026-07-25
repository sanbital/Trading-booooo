# Trading-booooo v5.1.0 GitHub Repository Secrets

GitHub 저장소 `Settings → Secrets and variables → Actions`에 등록합니다.

## 기존 Supabase/Scanner

```text
SUPABASE_ACCESS_TOKEN
SUPABASE_PROJECT_REF
SUPABASE_DB_PASSWORD
SCAN_ACCESS_TOKEN
LEARNING_ACCESS_TOKEN
```

`SCAN_ACCESS_TOKEN`, `LEARNING_ACCESS_TOKEN`은 각각 32자 이상이어야 합니다.

## 고정 IP 게이트웨이

```text
FLY_API_TOKEN
FLY_ORG
FLY_APP_NAME
```

## 업비트 KRW 현물

```text
UPBIT_ACCESS_KEY
UPBIT_SECRET_KEY
```

권한은 자산조회·주문조회·주문하기만 허용하며 입출금 권한은 부여하지 않습니다.

## 바이낸스 USDT 현물

```text
BINANCE_API_KEY
BINANCE_SECRET_KEY
```

Read/USER_DATA와 Spot TRADE만 허용하며 Withdrawals·Transfer·Margin·Futures는 비활성화합니다.

## 선택 위험한도

```text
UPBIT_MAX_ORDER_KRW=100000
UPBIT_MAX_DAILY_BUY_KRW=300000
BINANCE_MAX_ORDER_USDT=100
BINANCE_MAX_DAILY_BUY_USDT=300
```

미등록 시 우측 기본값이 적용됩니다. DB 한도와 고정 IP 게이트웨이의 로컬 한도가 동시에 적용되며 더 작은 값이 우선합니다.

API Secret 값은 문서·이슈·채팅·소스코드에 넣지 말고 GitHub Repository Secret에만 저장합니다.
