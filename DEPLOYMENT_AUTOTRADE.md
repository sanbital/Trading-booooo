# Trading-booooo v5.1.0 자동매매 배포 가이드

## 1. 저장소 업로드

ZIP의 바깥 폴더가 아니라 압축을 푼 `Trading-booooo` 내부 항목을 저장소 루트에 덮어씁니다.

```text
.github/
gateway/
supabase/
docs/
backtest/
README.md
```

## 2. 기존 Supabase Secrets

GitHub `Settings → Secrets and variables → Actions`에 다음 값이 있어야 합니다.

```text
SUPABASE_ACCESS_TOKEN
SUPABASE_PROJECT_REF
SUPABASE_DB_PASSWORD
SCAN_ACCESS_TOKEN
LEARNING_ACCESS_TOKEN
```

`SCAN_ACCESS_TOKEN`, `LEARNING_ACCESS_TOKEN`은 각각 32자 이상으로 설정합니다. 자동매매 호출 토큰과 게이트웨이 서명키는 `LEARNING_ACCESS_TOKEN`에서 용도별 SHA-256으로 자동 파생됩니다.

## 3. Fly.io 인프라 Secrets

```text
FLY_API_TOKEN
FLY_ORG
FLY_APP_NAME
```

`FLY_APP_NAME`은 전 세계에서 고유한 소문자 이름이어야 합니다.

## 4. 고정 egress IPv4 먼저 생성

```text
Actions
→ Deploy Multi-Exchange Static-IP Gateway
→ Run workflow
→ setup_only = true
```

로그에 표시되는 `egress` IPv4를 복사합니다. 앱 접속용 Anycast 주소가 아니라 **egress IPv4**여야 합니다.

## 5. 업비트 API 키

업비트 Open API 관리에서 Fly egress IPv4를 허용 IP로 등록합니다.

허용 권한:

```text
자산조회
주문조회
주문하기
```

금지 권한:

```text
입금조회
출금조회
출금하기
```

GitHub Secrets에 등록:

```text
UPBIT_ACCESS_KEY
UPBIT_SECRET_KEY
```

## 6. 바이낸스 Spot API 키

바이낸스 API 관리에서 같은 Fly egress IPv4로 IP 접근 제한을 설정합니다.

허용 범위:

```text
Read / USER_DATA
Spot Trading / TRADE
```

비활성 유지:

```text
Withdrawals
Internal Transfer
Margin
Futures
Universal Transfer
```

GitHub Secrets에 등록:

```text
BINANCE_API_KEY
BINANCE_SECRET_KEY
```

## 7. 선택 위험한도 Secrets

미등록 시 아래 기본값을 사용합니다.

| Secret | 기본값 |
|---|---:|
| `UPBIT_MAX_ORDER_KRW` | 100000 |
| `UPBIT_MAX_DAILY_BUY_KRW` | 300000 |
| `BINANCE_MAX_ORDER_USDT` | 100 |
| `BINANCE_MAX_DAILY_BUY_USDT` | 300 |

DB 설정과 게이트웨이 로컬 상한을 모두 적용하며, 둘 중 더 엄격한 제한이 우선합니다.

## 8. Supabase 배포

```text
Actions
→ Deploy Supabase Trading Engine
→ Run workflow
```

자동 수행:

1. Deno·Node 검사와 테스트
2. 거래소 중립 자동매매 migration 적용
3. Edge Function secrets 설정
4. `market-scanner`, `market-learning`, `market-autotrader` 배포
5. 최초 `PAPER` 설정 생성

## 9. 게이트웨이 실배포 및 스케줄러 가동

```text
Actions
→ Deploy Multi-Exchange Static-IP Gateway
→ Run workflow
→ setup_only = false
```

성공 조건:

- `/health`에서 `ok: true`
- `keys_configured.upbit: true`
- `keys_configured.binance: true`
- `scheduler_enabled: true`
- `scan_seconds: 300`
- `monitor_seconds: 15`
- 두 거래소 portfolio smoke test 성공

이후 브라우저와 무관하게 게이트웨이가 자동 스캔과 포지션 감시를 계속 호출합니다.

## 10. PAPER 검증

```text
Actions
→ Auto Trading Control
→ command = start_paper
```

상태 확인:

```text
Actions
→ Auto Trading Control
→ command = status
```

확인할 값:

- `settings.mode: PAPER`
- 게이트웨이 `ok: true`
- 최근 `SCAN`, `MONITOR` 성공
- `trading_positions`, `trading_orders`, `trading_fills`에 PAPER 기록 생성
- `trading_account_snapshots`에 업비트 KRW·바이낸스 USDT 스냅샷 생성

## 11. 제한 실거래 시작

PAPER 체결·청산·학습 기록을 확인한 뒤 실행합니다.

```text
Actions
→ Auto Trading Control
→ command = start_live_limited
→ confirmation = ENABLE_LIVE
```

API 키를 등록하는 것만으로 실거래 모드가 켜지지는 않습니다.

## 12. 실제 진입 절차

1. 양 거래소 전 종목을 통합 스캔
2. 모든 강제 게이트를 통과한 `BUY`만 수신
3. 추천 유효기간·이벤트 상태·현재 진입상한 재검증
4. 실시간 스프레드와 진입상한 이하 호가 깊이 재검증
5. 손절거리 기반 위험예산으로 수량 계산
6. 거래소 최소수량·tick size·step size·최소주문금액 적용
7. 기존 수동잔고와 동일 기초자산의 다른 거래소 노출 차단
8. test-order 호출
9. 고유 `tb-` client identifier를 사용한 지정가 IOC 주문
10. 실제 체결수량만 포지션으로 등록하고 미체결분은 추격하지 않음

## 13. 자동 청산 순서

15초마다 다음 우선순위로 확인합니다.

```text
비상청산
→ 손절 또는 추적손절
→ 2차 목표
→ 1차 분할매도
→ 최대 보유시간 종료
```

청산은 시장가 매도로 실행합니다. 급격한 갭에서는 계획 손절가보다 불리하게 체결될 수 있습니다.

## 14. 중복 주문과 계좌 보호

- Upbit `identifier`, Binance `newClientOrderId`에 동일한 `tb-` 규칙 사용
- 네트워크 오류나 5xx 응답을 실패로 단정해 재주문하지 않음
- 동일 client identifier로 먼저 주문 상태 조회
- `ENTRY_PENDING`, `EXITING`, DB lease, 활성 포지션 unique index로 중복 차단
- 주문 경제효과는 PostgreSQL RPC에서 정확히 한 번만 반영
- DB의 `APPLIED` 상태는 거래소 재조회가 되돌리지 못함
- 실제 잔고가 봇 추적수량보다 작으면 신규 진입 정지
- 기존 수동 보유 종목 자동진입 금지
- 동일 BTC·ETH 등 기초자산을 양 거래소에서 동시에 신규 진입하지 않음
- 출금·이체·마진·선물 관련 API 경로 자체가 없음

## 15. 자기교정

매시간 실제 거래와 PAPER 결과를 후보별로 연결합니다.

- 실제 체결 순손익을 후보 가상성과보다 우선
- LIVE 결과 가중치 > PAPER 결과 가중치 > 미체결 시뮬레이션
- 24시간·72시간·7일·20일 결과 체크포인트
- 진입 점수, 손익비, 구조적 여유, 수급, 깊이, 스프레드, 슬리피지, 손절 ATR, 목표·분할·추적 정책 challenger 평가
- 최소 120개 성숙 BUY, 검증 40개, 선택표본 30개, PF 1.15, 양의 기대수익, 3개 롤링 fold 중 2개 통과 전 자동 승격 금지
- 최근 기대수익 음수와 PF 0.9 미만이 함께 발생하면 자동 롤백
- 포워드 학습은 주간 워크포워드 안전선보다 위험 기준을 완화할 수 없음

## 16. 운영 제어

| command | 동작 |
|---|---|
| `status` | 설정·게이트웨이·계좌·포지션·최근 주문 확인 |
| `start_paper` | PAPER 자동매매 |
| `start_live_limited` | 제한 실거래. `ENABLE_LIVE` 필요 |
| `pause_new_entries` | 신규 매수만 정지. 청산 감시는 유지 |
| `resume_new_entries` | 신규 매수 재개 |
| `emergency_liquidate` | 봇 포지션 전량 시장가 청산. `LIQUIDATE_NOW` 필요 |

## 17. 주요 오류

| 오류/이벤트 | 의미 | 조치 |
|---|---|---|
| `no_authorization_ip` | 업비트 IP 허용 목록 불일치 | Fly egress IPv4 확인 |
| Binance `-2015` | 키·권한·IP 제한 오류 | Spot 권한과 고정 IP 확인 |
| Binance `-1021` | 서버시간 오차 | 게이트웨이 재배포/시간동기 확인 |
| `ENTRY_RESULT_UNKNOWN` | 주문 응답은 불확실하나 주문 도달 가능성 존재 | 자동 조회 완료 전 재주문 금지 |
| `ACCOUNT_POSITION_MISMATCH` | 실제 잔고가 봇 장부보다 작음 | 신규 진입 정지 후 수동거래 여부 확인 |
| `ENTRY_CIRCUIT_BLOCK` | 손실·보유·진입횟수 한도 | 상태와 최근 손익 확인 |
| `monitor lease busy` | 이전 감시 주기 실행 중 | 정상 중복방지, 다음 주기 재시도 |

## 18. 주의

Fly Machine, 고정 egress IP, Supabase 사용량에는 비용이 발생할 수 있습니다. 서비스 결제 중단이나 거래소 장애가 발생하면 자동 감시와 청산도 중단될 수 있습니다. 자동교정은 검증된 범위 안에서 정책을 개선하는 기능이며 미래 수익을 보장하지 않습니다.
