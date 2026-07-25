# Trading-booooo v5.1.0 검증 결과

검증일: 2026-07-25 KST

## 통과 항목

- Gateway Node.js 문법 검사: PASS
- Gateway 단위 테스트: 7/7 PASS
- Scanner·Autotrader·Learning·Backtest TypeScript 전체 그래프 정적 검사: PASS
- Scanner·Learning·Autotrader·Backtest 회귀 테스트: 66/66 PASS
- GitHub Actions YAML 5개 구문 검사: PASS
- `deno.json` JSON 구문 검사: PASS
- 프론트엔드 JavaScript 문법 검사: PASS
- 업비트 KRW·바이낸스 USDT 거래소 중립 DB 필드 정합성 검사: PASS
- 과거 KRW 전용 자동매매 회계 필드 잔존 여부 검사: 없음

## 검증된 핵심 시나리오

- 동일 봉 목표·손절 동시 충족 시 손절 우선
- 지정 목표·분할매도·T1 이후 추적손절 비교
- 실제 호가 기준 진입가와 슬리피지·깊이 게이트
- 주문 식별자 중복 방지와 거래소 상태 정규화
- 업비트 JWT HS512·query hash 생성
- 바이낸스 HMAC 서명·LOT_SIZE 수량 절삭
- 업비트·바이낸스 동일 기초자산 중복 노출 차단
- 글로벌·거래소별 동시 보유·일일 진입·손실 회로차단
- 주간 안전선보다 포워드 프로필이 위험 기준을 완화하지 못하도록 제한
- 검증 표본·Profit Factor·챔피언 개선이 부족한 challenger 승격 거부

## 이 환경에서 수행하지 않은 검증

- 사용자의 실제 업비트·바이낸스 계정 API 호출
- 실주문 제출 및 실제 체결
- 사용자의 Supabase migration 적용
- Fly.io 고정 egress IPv4 실제 배포
- 장시간 장애·거래소 점검·극단적 갭 상황의 실환경 복구 시험

배포 후 반드시 PAPER 모드에서 주문 가능 정보, 호가, 가상 체결, 청산, 학습 기록을 먼저 확인해야 합니다. `ENABLE_LIVE` 확인 없이는 제한 실거래로 전환되지 않습니다.
