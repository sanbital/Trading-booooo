# Trading-booooo v5.2.0 자동매매 배포·운영 가이드

이 문서는 업비트 KRW 현물과 바이낸스 USDT 현물 자동매매, GitHub Pages 운영 대시보드, 수동 매도·출금 안전장치, 자기교정까지 포함한 전체 절차입니다.

## 1. 저장소 업로드

ZIP 압축을 풀고 안쪽 `Trading-booooo` 폴더를 연 뒤, 내부 항목 전체를 GitHub 저장소 루트에 덮어씁니다.

```text
.github/
backtest/
docs/
gateway/
supabase/
README.md
...
```

바깥 폴더 자체를 올려 아래처럼 중첩되면 안 됩니다.

```text
Trading-booooo/Trading-booooo/...
```

권장 커밋 메시지:

```text
Deploy Trading-booooo v5.2.0 dashboard and capital controls
```

## 2. GitHub Repository Secrets

GitHub 저장소에서 `Settings → Secrets and variables → Actions`로 이동합니다.

### 필수

```text
SCAN_ACCESS_TOKEN
SUPABASE_ACCESS_TOKEN
SUPABASE_PROJECT_REF
SUPABASE_DB_URL
LEARNING_ACCESS_TOKEN
FLY_API_TOKEN
FLY_ORG
FLY_APP_NAME
UPBIT_ACCESS_KEY
UPBIT_SECRET_KEY
BINANCE_API_KEY
BINANCE_SECRET_KEY
```

`SCAN_ACCESS_TOKEN`과 `LEARNING_ACCESS_TOKEN`은 각각 32자 이상이어야 합니다.

`SUPABASE_DB_URL`은 Supabase `Connect → Direct → Shared pooler`에서 복사한 **Session pooler 5432** 주소여야 합니다.

```text
postgresql://postgres.<PROJECT_REF>:<URL_ENCODED_DB_PASSWORD>@...pooler.supabase.com:5432/postgres
```

### 대시보드 권장

```text
DASHBOARD_ACCESS_TOKEN
```

32자 이상의 별도 임의 문자열을 권장합니다. 미등록 시 배포 Workflow가 `LEARNING_ACCESS_TOKEN`을 대시보드 토큰으로 사용합니다.

### 선택 주문 상한

| Secret | 기본값 |
|---|---:|
| `UPBIT_MAX_ORDER_KRW` | 100000 |
| `UPBIT_MAX_DAILY_BUY_KRW` | 300000 |
| `BINANCE_MAX_ORDER_USDT` | 100 |
| `BINANCE_MAX_DAILY_BUY_USDT` | 300 |

DB 위험한도와 Fly 게이트웨이 상한을 모두 적용하며 더 엄격한 값이 우선합니다.

## 3. 거래소 API 권한

### 업비트

허용:

```text
자산조회
주문조회
주문하기
```

금지:

```text
출금조회
출금하기
```

### 바이낸스

허용:

```text
Enable Reading
Enable Spot & Margin Trading
```

프로그램은 Spot 주문 경로만 구현하며 Margin·Futures·Transfer·Withdrawal 경로는 없습니다.

금지:

```text
Withdrawals
Internal Transfer
Futures
```

두 거래소 모두 Fly의 **egress IPv4**만 허용 IP로 등록합니다. 앱 접속용 ingress/Anycast IP를 등록하면 안 됩니다.

## 4. 자동 배포 확인

업로드 후 다음 Workflow가 실행됩니다.

```text
Deploy Supabase Trading Engine
Deploy Multi-Exchange Static-IP Gateway
pages build and deployment
```

### Supabase Workflow

1. Deno·Node 정적 검사 및 테스트
2. v5.2 DB migration 적용
3. Edge Function Secret 설정
4. `market-scanner`, `market-learning`, `market-autotrader` 배포
5. 최초 PAPER 설정 확인

### Fly Workflow

1. 게이트웨이 테스트
2. 기존 고정 egress IP 유지
3. 업비트·바이낸스 키를 Fly Secret에 반영
4. Always-on Machine 1대 배포
5. `/health` 및 거래소 계좌 읽기 smoke test
6. 5분 스캔·15초 모니터 스케줄러 활성화

## 5. 최초 상태와 PAPER 검증

API 키가 등록되어도 최초 모드는 `PAPER`입니다. 키 등록만으로 실주문이 발생하지 않습니다.

대시보드 또는 GitHub Actions에서 다음을 확인합니다.

```text
settings.mode = PAPER
gateway.ok = true
keys_configured.upbit = true
keys_configured.binance = true
scheduler_enabled = true
scan_seconds = 300
monitor_seconds = 15
```

PAPER에서 추천, 가상 진입, 손절·익절·시간청산, 학습 기록이 정상 생성되는지 먼저 확인합니다.

## 6. 운영 대시보드 접속

GitHub Pages에서 `자동매매 대시보드` 탭을 누르고 `DASHBOARD_ACCESS_TOKEN`을 입력합니다.

- 토큰은 GitHub Pages 코드에 포함되지 않습니다.
- 토큰은 페이지 메모리에만 유지되며 새로고침·탭 종료 시 다시 입력해야 합니다.
- 대시보드는 15초마다 상태를 갱신합니다.

대시보드에서 확인할 수 있는 항목:

- PAPER / LIVE_LIMITED / PAUSED 상태
- 신규 매수 가능 여부
- Fly 게이트웨이 상태
- 업비트 KRW·바이낸스 USDT 자산
- 봇 운용 한도와 신규 투자 가능 금액
- 열린 포지션과 손절·목표·최대 보유시간
- 최근 주문·운용 이벤트·외부 현금 흐름
- 활성 자기교정 프로필

## 7. 거래소별 운용 사이즈

### 업비트

단위는 **KRW**입니다.

```text
전액
선택 금액
보호 원화
```

### 바이낸스

단위는 **USDT**입니다.

```text
전액
선택 금액
보호 USDT
```

### 전액의 의미

`전액`은 한 종목에 잔액을 모두 주문하는 뜻이 아닙니다.

```text
업비트: KRW 현금·잠김 KRW + 봇 포지션 가치
바이낸스: USDT 현금·잠김 USDT + 봇 포지션 가치
- 보호 원화/USDT
= 포트폴리오 운용 한도
```

사용자가 별도로 보유한 코인 평가액은 운용 한도에서 제외됩니다.

그 안에서 다시 다음 제한을 적용합니다.

- 손절거리 기반 거래당 위험예산
- 종목당 최대 비중
- 1회 주문 상한
- 일일 매수 상한
- 동시 보유 상한
- 실제 주문 가능 현금

### 선택 금액의 의미

예를 들어 업비트 선택 운용금이 2,000,000 KRW라면, 봇이 관리하는 열린 포지션 원가와 신규 주문 가능액의 합이 2,000,000 KRW를 넘지 않도록 합니다.

바이낸스 선택 운용금은 동일하게 USDT 기준입니다.

## 8. 수동 매도·입출금 감지

15초 계좌 대조에서 다음을 감지합니다.

- 봇 포지션 수량의 수동 감소
- 봇 주문으로 설명되지 않는 KRW·USDT 감소
- 봇 주문으로 설명되지 않는 KRW·USDT 증가

증가도 중지 사유로 처리합니다. 사용자가 코인을 직접 매도해 원화·USDT가 늘어난 경우, 다음 5분 스캔에서 그 돈을 즉시 재투자하지 못하게 하기 위함입니다.

감지 시:

```text
신규 매수 즉시 중지
→ 실제 잔고 기준 장부 조정
→ 관련 이벤트·현금 흐름 기록
→ 수동 개입 거래를 학습 표본에서 제외
→ 열린 봇 포지션의 자동 손절·청산 감시는 계속 유지
```

## 9. 출금 절차

권장 절차:

1. 대시보드에서 `출금 모드 시작`
2. 신규 매수 중지 확인
3. 필요한 코인을 직접 매도
4. 원화 또는 자산을 직접 출금
5. 대시보드에서 `계좌 즉시 대조`
6. 운용금·보호금을 필요에 맞게 수정
7. `즉시 재개 + 지금 스캔`

출금 권한은 API에 없으므로 봇은 출금을 실행할 수 없습니다.

출금·수동 매도액은 자동매매 손실로 학습하지 않습니다.

## 10. 즉시 재개

대시보드의 `즉시 재개 + 지금 스캔` 버튼은 다음을 수행합니다.

```text
실제 계좌 재대조
→ 성공한 경우에만 수동개입·출금 플래그 해제
→ 신규 매수 즉시 재개
→ 대기시간 없이 통합 스캔 즉시 실행
```

6시간 또는 다음 정기 스캔까지 기다리지 않습니다. 계좌 대조 lease가 사용 중이면 최대 약 10초 재시도하며, 끝내 대조할 수 없으면 재개하지 않고 오류를 표시합니다.

GitHub Actions에서도:

```text
Auto Trading Control
→ command = resume_now
```

를 사용하면 같은 방식으로 즉시 재개 후 스캔합니다.

## 11. 제한 실거래 시작

대시보드에서 `LIVE_LIMITED 전환`을 누르고 다음 문구를 정확히 입력합니다.

```text
ENABLE_LIVE
```

서버에서도 확인 문구를 검증합니다. 화면만 우회해 직접 API를 호출해도 확인값 없이는 LIVE_LIMITED 전환이 거부됩니다.

GitHub Actions:

```text
Auto Trading Control
→ command = start_live_limited
→ confirmation = ENABLE_LIVE
```

## 12. 실제 진입 절차

1. 업비트 KRW·바이낸스 USDT 전 종목 통합 스캔
2. 모든 강제조건을 통과한 BUY만 수신
3. 추천 유효기간·이벤트 상태·현재 진입상한 재검증
4. 실시간 스프레드와 진입상한 이하 호가 깊이 재검증
5. 거래당 위험과 운용 가능 자금으로 주문 크기 계산
6. 거래소 tick·step·최소주문금액 적용
7. 기존 수동잔고 및 양 거래소 동일 기초자산 노출 차단
8. test-order 호출
9. 고유 `tb-` identifier로 지정가 IOC 매수
10. 실제 체결수량만 포지션 등록, 미체결분 추격 금지

## 13. 자동 청산

15초마다 다음 순서로 평가합니다.

```text
비상청산
→ 손절/추적손절
→ 2차 목표
→ 1차 분할매도
→ 최대 보유시간 종료
```

진입은 시장가 매수를 사용하지 않습니다. 청산 목적의 시장가 매도만 사용합니다.

## 14. 중복 주문 방지

- Upbit `identifier`, Binance `newClientOrderId`에 동일 `tb-` 규칙
- 타임아웃·5xx를 즉시 미체결로 단정하지 않음
- 동일 identifier로 거래소 주문 상태부터 조회
- `ENTRY_PENDING`, `EXITING`, DB lease, 활성 포지션 unique index
- 주문 경제효과는 PostgreSQL RPC로 한 번만 반영
- 이미 `APPLIED`인 주문은 거래소 재조회가 되돌리지 못함

## 15. 자기교정

학습 우선순위:

```text
실제 LIVE 체결 결과
> PAPER 체결 결과
> 미체결 후보 시뮬레이션
```

수동 매도·출금·장부 조정이 들어간 포지션은 `exclude_from_learning`으로 표시해 전략 성과에서 제외합니다.

자동 승격에는 충분한 성숙 BUY 표본, 양의 기대수익, Profit Factor, 낙폭, 집중도, 롤링 검증이 필요합니다. 포워드 학습은 주간 워크포워드 안전선보다 위험 기준을 느슨하게 만들 수 없습니다.

## 16. 운영 제어

| command | 동작 |
|---|---|
| `status` | 설정·게이트웨이·계좌·포지션·최근 주문 확인 |
| `start_paper` | PAPER 모드 전환 |
| `start_live_limited` | `ENABLE_LIVE` 확인 후 제한 실거래 |
| `pause_new_entries` | 신규 매수만 중지, 청산 감시는 유지 |
| `resume_now` | 계좌 대조 후 즉시 재개하고 즉시 스캔 |
| `emergency_liquidate` | `LIQUIDATE_NOW` 확인 후 봇 포지션 전량 시장가 청산 |

## 17. 주요 오류

| 오류/이벤트 | 의미 | 조치 |
|---|---|---|
| `no_authorization_ip` | 업비트 허용 IP 불일치 | Fly egress IPv4 확인 |
| Binance `-2015` | 키·권한·IP 제한 오류 | Spot 권한과 고정 IP 확인 |
| Binance `-1021` | 서버시간 오차 | 게이트웨이 재배포/시간동기 확인 |
| `ENTRY_RESULT_UNKNOWN` | 주문 실행 여부 불확실 | identifier 조회 완료 전 재주문 금지 |
| `ACCOUNT_POSITION_MISMATCH` | 실제 코인 수량이 봇 장부와 다름 | 장부 조정 후 대시보드에서 즉시 재개 |
| `EXTERNAL_INCREASE/DECREASE` | 봇 주문 외 KRW·USDT 변동 | 출금·입금·수동매도 확인 후 즉시 재개 |
| `ENTRY_CIRCUIT_BLOCK` | 손실·보유·진입횟수 한도 | 상태·최근 손익 확인 |
| `monitor lease busy` | 이전 모니터 실행 중 | 다음 주기 또는 재개 버튼 재시도 |

## 18. 주의

자동교정은 검증된 범위에서 정책을 개선하지만 미래 수익을 보장하지 않습니다. 급격한 가격 갭, 유동성 고갈, 거래소/API 장애, Fly/Supabase 장애, 정책 변경에서는 계획보다 불리하게 체결되거나 청산이 지연될 수 있습니다. 실거래 전 PAPER 결과와 대시보드 계좌 대조를 충분히 확인하십시오.
