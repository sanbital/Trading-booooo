# v6.8.0 검증 기록

검증일: 2026-07-27  
대상: `6.8.0-VALIDATED-PARETO-LEARNING`

## 제공 실거래 진단

제공된 SQL 추출 자료에서 종료 LIVE LOB 거래 67건과 메이커 진입 시도 171건을
분석했다.

- 순이익 거래 16건, 23.9%
- 목표 도달 8건, 11.9%
- 평균 순손익 -14.88bp
- 중앙 보유 77.75초
- 예측 목표확률 평균 51.5% 대 실제 목표 도달 11.9%
- 예측 체결확률 평균 78.0% 대 실현 메이커 체결 39.2%

이 결과는 이전 모델의 예측 교정과 실행비용 추정이 낙관적이었음을 보여준다.
새 모델의 미래 수익을 증명하는 자료로 재사용하지 않았으며, 최초 v6.8 승격
cohort에서 제외한다.

## 타입·회귀 테스트

실행:

```bash
deno task check
deno task test
```

결과:

- scanner, learning, autotrader, LOB calibration, backtest 진입점 타입 검사 통과
- Deno 단위·회귀 테스트 **341 passed / 0 failed**
- 신규 거버넌스 테스트 **11 passed / 0 failed**

신규 테스트가 차단하는 사례:

- 주문금액 축소 또는 거래 분할로 지표 개선
- 승률·순익은 좋아졌지만 거래 수 감소
- 손실 모델이 덜 나쁘다는 이유만으로 승격
- 첫 cohort 우연 승격 후 두 번째 cohort 악화
- 거래소·패턴 구성 차이로 생긴 가짜 개선
- KRW·USDT 명목금액 직접 합산에 따른 가짜 자본회전·주문금액 개선
- 원시 학습 프로필의 자동 실전 활성화
- 슬롯·배분 설정의 마이그레이션 변경

## Gateway·브라우저 소스

```bash
node --check gateway/server.mjs
node --check docs/app.js
node --check docs/performance.js
node --test gateway/server.test.mjs
```

결과:

- JavaScript 구문 검사 모두 통과
- Gateway **11 passed / 0 failed**
- 엔진·autotrader·gateway·대시보드 버전 일치 테스트 통과
- 거래별 성과 기본 10건, 확장 50건, 페이지 이동, 전체 필터 CSV 소스
  불변조건 통과

## 배포 소스 불변조건

```bash
node validation/lob-source-validation.mjs
node validation/v610-deploy-validation.mjs
node validation/v620-deploy-validation.mjs
node validation/v680-deploy-validation.mjs
```

결과:

- LOB 핵심 소스 불변조건 20개 통과
- v6.1 누적 배포 불변조건 14개 통과
- v6.2 누적 배포 불변조건 13개 통과
- v6.8 정책·자본·UI 불변조건 16개 통과

## 전체 SQL 마이그레이션·상태 전이

PGlite PostgreSQL 호환 런타임에 빈 데이터베이스를 만들고 31개 마이그레이션을
파일명 순서대로 모두 적용했다. PGlite가 제공하지 않는 `pgcrypto` extension
선언만 검증 환경에서 제외했으며, 실제 Supabase에는 해당 extension이 존재한다.

검증한 상태 전이:

```text
CHAMPION + CHALLENGER
  → HOLD
  → PROMOTE
  → CHAMPION + CONTROL
  → ROLLBACK
  → 기존 CHAMPION 복구

기존 CHAMPION + 새 CHALLENGER
  → PROMOTE
  → CONFIRM
  → 새 CHAMPION 확정 + 이전 CONTROL 퇴역
```

결과:

- 31개 마이그레이션 적용 통과
- HOLD / PROMOTE / ROLLBACK / PROMOTE / CONFIRM 통과
- 최종 CHAMPION 정확히 1개, ALTERNATE 0개
- 전이 전후 `trading_settings` 전체 JSON 동일
- 최초 발견된 부분 고유 인덱스 상태교환 충돌을 수정한 뒤 재검증 통과

## 검증하지 못한 것

제공 자료에는 미체결 후보의 이후 tick/호가 경로와 실제 queue position이 없다.
따라서 v6.8 challenger를 과거 동일 시점에 재주문한 것처럼 재생해 미래 승률이나
수익률을 확정할 수 없다. 검증 결과는 다음을 의미한다.

- 코드가 컴파일되고 기존 회귀를 깨지 않는다.
- 승격 편법과 상태 경쟁을 지정한 범위에서 차단한다.
- 나쁜 challenger를 거절하고 잠정 모델을 자동 롤백할 수 있다.
- 자본 관련 사용자 설정을 이 릴리스가 바꾸지 않는다.

실제 잔고 개선은 배포 후 동시 CHAMPION/CHALLENGER 실거래 cohort가 공동 승격
조건을 통과하는지로 판단해야 한다. 테스트 통과는 수익 보장이 아니다.
