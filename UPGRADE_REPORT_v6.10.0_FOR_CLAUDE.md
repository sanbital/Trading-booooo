# Trading-booooo v6.10.0 업그레이드 보고서

## 0. 버전 식별

- 버전: `6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE`
- 기반: `v6.9.1-FEE-LEDGER-INTEGRITY`
- 목적: 수수료·슬리피지·지연·미체결·부분체결·잔량을 모두 반영한 실제 순자산의 장기 복리 성장
- 검토 대상: 업비트 KRW 현물 + 바이낸스 USDT 현물 LOB 초단기 스캘핑

## 1. 절대 운영 원칙

v6.10.0은 다음 세 가지를 동시에 달성해야 한다.

1. **자본회전율 극대화**: 관리 자본이 지나치게 유휴 상태에 머물지 않고, 검증된 양의 순기대값 거래로 빠르게 회전해야 한다.
2. **수익률과 승률 극대화**: 비용 차감 순수익과 수익 거래 비율을 함께 개선해야 한다.
3. **상호 대체 금지**: 회전율을 높이기 위해 손실 거래를 늘리거나, 승률을 높이기 위해 거래를 없애는 정책은 승격하지 않는다.

위 목표를 추구하는 과정에서 다음은 절대 허용하지 않는다.

- 수수료, 슬리피지, 지연비용, 부분체결, 잔량을 누락한 가짜 손익
- 예약 자본을 무시한 중복 노출
- 백테스트·PAPER·Shadow 표본의 LIVE 정책 투표 참여
- 회계 품질이 불명확한 거래의 온라인 학습 참여
- 자동 학습에 의한 출금·이체·레버리지·손실한도·거래소 활성화 변경
- 하나의 합산 점수로 수익률·승률·회전율 중 하나의 악화를 숨기는 정책 승격

## 2. 핵심 구조 변경

### 2.1 공동 목적함수: 성장률·승률·회전율을 분리 평가

신규 파일:

- `supabase/functions/_shared/lob/joint-objective.ts`
- `supabase/functions/_shared/lob/joint-objective.test.ts`

신규 지표:

- `accountLogGrowthPerHour`: 전체 관리 계좌의 시간당 로그 성장률
- `activeCapitalLogEfficiency`: 실제 투입 자본의 시간당 로그수익 효율
- `capitalUtilization`: 관리 자본 중 실제 거래에 사용된 자본시간 비율
- `capitalTurnsPerHour`: 시간당 자본 회전 횟수
- `winRate`: 비용 차감 순손익이 양수인 종료 거래 비율
- `geometricMeanReturn`: 거래당 기하평균 순수익률

승격은 단일 가중합이 아니라 Pareto 계약으로 평가한다.

- 계좌 성장률이 비열등이어야 한다.
- 승률이 비열등이어야 한다.
- 자본회전율이 비열등이어야 한다.
- 세 항목 중 최소 하나는 의미 있게 개선되어야 한다.
- 비용 차감 기대값은 양수여야 한다.

따라서 거래를 거의 없애 승률만 올리는 정책과, 무분별한 거래로 회전율만 올리는 정책은 승격할 수 없다.

### 2.2 수수료 원장 무결성 완성

관련 파일:

- `supabase/functions/market-autotrader/fee-accounting.ts`
- `supabase/functions/market-autotrader/fee-accounting.test.ts`
- `gateway/server.mjs`
- `supabase/functions/market-autotrader/index.ts`
- `supabase/migrations/202607280001_fee_ledger_integrity_v691.sql`
- `supabase/migrations/202607280002_joint_compound_growth_v610.sql`

수정 내용:

- 업비트 개별 `trades`에 `fee`가 없더라도 주문 전체 `paid_fee`를 권위값으로 사용한다.
- 업비트 주문 전체 수수료를 개별 체결대금 비율로 배분하되 합계는 주문 수수료와 정확히 일치한다.
- 바이낸스 USDT 수수료는 정확한 체결 수수료로 기록한다.
- 기준자산 수수료는 수량·잔량 회계에서 처리하여 quote 비용으로 이중 차감하지 않는다.
- BNB 등 제3자산 수수료는 체결 자료가 있으면 quote 가치로 표시하며, 정확 환산이 불가능하면 `ESTIMATED`로 명시한다.
- `0`과 `MISSING`을 구분한다. 자료가 없다는 이유로 무료 거래로 간주하지 않는다.

수수료 품질은 잔량 회계 품질과 별도 축으로 저장한다.

`fee_accounting_quality` 허용값:

- `EXACT`
- `AGGREGATE_EXACT`
- `THIRD_ASSET_MARKED`
- `BASE_ASSET_ACCOUNTED`
- `ESTIMATED`
- `MISSING`
- `LEGACY_UNVERIFIED`
- `NOT_APPLICABLE`

정책 투표와 EV 교정에는 정확하거나 물리적으로 검증된 품질만 참여한다. `ESTIMATED`, `MISSING`, `LEGACY_UNVERIFIED`는 성과 화면에는 표시할 수 있지만 정책 승격에는 투표하지 않는다.

### 2.3 예약 자본과 총노출 원장

신규 파일:

- `supabase/functions/market-autotrader/exposure-ledger.ts`
- `supabase/functions/market-autotrader/exposure-ledger.test.ts`

신규 필드:

- `trading_positions.reserved_quote`
- `trading_positions.reserved_quantity`
- `trading_positions.reservation_expires_at`
- `trading_positions.marked_pnl_quote`

노출 계산은 다음을 모두 포함한다.

- 체결된 포지션의 원가 또는 현재 평가액 중 큰 값
- `ENTRY_PENDING` 주문의 예약 quote
- 요청 수량의 현재 평가액
- 부분체결 후 남은 예약분
- 잔량 원장의 평가액

주문이 체결·취소·실패·만료되면 예약금은 원자적으로 반환된다. 하나의 후보만 존재해도 설정 슬롯 분모는 3으로 유지되고, 예약 주문 때문에 같은 자금이 이중 사용되지 않는다.

운영자 설정 `scalp_max_strategy_exposure_pct`를 추가했다. 기본값은 `100`으로 기존 동작을 유지하지만, 급락·거래소 장애·회계 이상 시 배포 없이 노출 상한을 줄일 수 있다. 이 값은 자동 학습 정책이 수정할 수 없다.

### 2.4 미실현 손익을 포함한 손실 방어

기존 종료 거래의 실현손익만 보던 안전 레일을 경제 손익 기준으로 확장했다.

포함 항목:

- 당일 실현 순손익
- 열린 포지션의 현재 평가손익
- 이미 지급한 진입·부분청산 수수료
- 남은 수량의 예상 청산비용
- residual 평가액
- 예약 자본과 열린 주문 노출

정상 손절 레일, 비상 backstop, 계좌 전체 kill switch를 구분한다. 거래당 5%, 일일 30% 값은 최종 비상 상한으로 유지하며, 정상 운용은 더 촘촘한 가격·LOB·marked-PnL 레일이 먼저 작동한다.

### 2.5 자산 잠금 원장과 안전한 자동 해제

신규 파일:

- `supabase/functions/market-autotrader/asset-locks.ts`
- `supabase/functions/market-autotrader/asset-locks.test.ts`

신규 테이블:

- `trading_asset_locks`

문자열 JSON 배열만 사용하던 구조를 감사 가능한 별도 원장으로 승격했다.

필드:

- 거래소, 자산, 잠금 상태, 사유
- `clean_checks`
- 마지막 점검 상태와 시각
- 잠금·해제 시각
- 메타데이터

해제 규칙:

- 실제 잔고가 허용 오차 이내
- 활성 포지션 없음
- `ENTRY_PENDING` 없음
- 미체결 BUY/SELL 주문 없음
- residual이 허용 범위 이하이거나 원장에 정확히 귀속됨
- 필요한 연속 정상 대사 횟수 충족

상태 전이:

- `CLEAN`: `clean_checks + 1`
- `MISMATCH`: `clean_checks = 0`, 잠금 유지
- `QUERY_FAILED`: 카운터를 리셋하지 않고 증가만 보류

기존 `manual_asset_locks`는 호환성 미러로 남지만 권위 원장은 `trading_asset_locks`다.

### 2.6 residual 자산 원장과 조건부 sweep

신규 파일:

- `supabase/functions/market-autotrader/residual-ledger.ts`
- `supabase/functions/market-autotrader/residual-ledger.test.ts`

신규 테이블:

- `trading_residual_inventory`

잔량은 손실이 아니라 실제 계좌 자산으로 보존한다. 상태:

- `AVAILABLE`
- `RESERVED_FOR_REENTRY`
- `SWEEP_PENDING`
- `SWEPT`
- `CONSUMED`

sweep은 다음을 모두 만족할 때만 허용한다.

- 활성 포지션 없음
- 진입 예정 또는 열린 주문 없음
- 같은 자산 재진입 예약 없음
- 잔량 가치가 거래소 최소 주문금액 × 설정 buffer 이상
- 수량 step과 최소 명목가 충족

동일 자산에 재진입하면 잔량을 신규 보유량과 경제적으로 합산할 수 있다. 즉 작은 잔량을 매번 시장가로 팔아 회전율과 수수료를 악화시키지 않는다.

### 2.7 저표본 탐색의 별도 손실예산

신규 테이블:

- `lob_exploration_budget_daily`
- `lob_exploration_budget_claims`

데이터가 부족한 거래는 학습을 위해 허용하되 다음을 적용한다.

- evidence 기반 축소 주문
- 거래소별 일일 탐색 손실예산
- 주문 생성 시 예상 최대손실 예약
- 주문 취소·미체결 시 예약 해제
- 종료 시 실제 손실로 정산
- 예산 소진 시 저표본 신규 진입만 차단

학습을 위해 풀사이즈로 손실을 반복하는 경로를 차단하면서 거래 자체가 완전히 멈추는 것도 방지한다.

### 2.8 계층형·노후화 반영 evidence sizing

수정 파일:

- `supabase/functions/_shared/lob/evidence-sizing.ts`
- `supabase/functions/_shared/lob/evidence-sizing.test.ts`

개별 코인×패턴 표본만 보지 않고 다음 계층을 결합한다.

1. 전체 거래소
2. 거래소×패턴
3. 전체 패턴
4. 개별 시장
5. 시장×패턴

표본이 적을 때 상위 집단으로 shrinkage하고, 표본이 충분해질수록 개별 시장·패턴의 비중을 높인다. 오래된 표본은 age decay로 유효 표본 수를 줄인다. 기준 표본 수를 임의로 40에서 12로 낮추지 않았다.

### 2.9 EV 편향의 조건면 정렬

예측과 실현의 비교 기준을 `FILL_CONDITIONAL`로 통일했다.

- 진입 당시 체결조건부 EV를 immutable snapshot에 저장한다.
- 체결된 거래의 비용 차감 실현 순bps와 비교한다.
- 미체결은 실행 품질·fill probability 모델에서 별도 평가한다.
- 수수료 수정 이전 엔진 표본은 현재 EV 교정에 pooling하지 않는다.
- `lob-calibration`의 호환 엔진은 `6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE`로 제한한다.
- residual·fee 품질이 모두 검증된 LIVE 거래만 사용한다.

이로써 pFill이 포함된 주문 시도 EV와 체결 거래 손익을 비교하던 수학적 조건면 오류를 제거했다.

### 2.10 정책 거버넌스: 15% → 25% → 50% → 승격

기존 15% → 50% 확대를 다음으로 변경했다.

1. 15% canary
2. 25% 제한 확대
3. 50% 최종 검증
4. provisional promotion
5. control 비교 후 확정 또는 rollback

각 단계는 최소 표본, 최소 관찰시간, 독립 시간 블록, 손실예산, 회계 품질, 자본 노출 비율을 함께 검사한다. 거래 수 비율이 아니라 실제 자본 노출도 함께 기록한다.

정책 배정은 scan ID 기반으로 결정론적이며, 포지션 진입 시 정책 버전을 고정한다. 청산과 학습은 진입 당시 버전을 사용한다.

### 2.11 immutable bounded policy

수정 파일:

- `supabase/functions/_shared/lob/adaptive-policy.ts`
- `supabase/functions/_shared/lob/adaptive-policy.test.ts`
- `supabase/functions/_shared/lob/governance.ts`

정책 스키마 버전을 2로 올리고 허용 가능한 파라미터와 범위를 명시했다. 활성 정책 정의는 수정하지 않고 새 버전으로만 생성한다.

자동 학습이 변경할 수 없는 항목:

- 거래소 활성화
- 현물 전용
- 출금·이체 금지
- 레버리지·선물 금지
- 비상청산 권한
- 거래당·일일 손실 상한
- 슬롯 수와 운영자 총노출 상한
- 수수료·잔량 회계 규칙
- 수동 잠금

자동 학습은 정의된 정책 family 안에서 진입·청산·사이징의 제한된 파라미터만 제안한다. 소스코드를 작성하거나 직접 배포하지 않는다.

### 2.12 계좌 성장 텔레메트리와 대시보드

신규 테이블:

- `trading_joint_objective_snapshots`

기록 항목:

- 전체 자기자본
- 관리 자본
- 가용 자본
- 체결 노출
- 예약 노출
- residual 가치
- 열린 포지션 marked PnL
- 당일 실현손익
- 외부 입출금 효과
- 엔진 버전

성과 API와 대시보드는 다음을 분리 표시한다.

- 계좌 성장률
- 활성 자본 효율
- 자본 활용률
- 시간당 회전율
- 승률
- 정확 수수료 / 추정 수수료 / 누락 수수료 건수
- 예약 자본
- residual 자산
- 활성 자산 잠금과 사유

외부 입금이나 출금은 거래 전략 수익으로 계산하지 않는다.

## 3. 추가로 선제 보완한 v6.10 예상 한계

### 3.1 네트워크 실패를 정상 데이터로 해석하는 문제

조회 실패는 잔고 0, 수수료 0, 잠금 정상으로 해석하지 않는다. `QUERY_FAILED`와 `MISSING`을 명시하고, 안전 카운터와 학습 표본을 유지·보류한다.

### 3.2 늦게 도착한 수수료와 부분체결

수수료 재조회가 늦게 완료되면 `recompute_position_economic_accounting_v610()`이 주문 원장에서 포지션 손익을 멱등적으로 다시 계산한다. 이미 생성된 온라인 결과는 검증 품질을 다시 확인하고 파생 프로필을 재구축할 수 있다.

### 3.3 거래소별 통화 단위 혼합

업비트 KRW와 바이낸스 USDT는 거래소별 원장과 목적함수를 유지한다. 환율 없이 금액을 직접 합산하지 않는다. 정책 비교는 bps·비율·동일 거래소 동시대 cohort를 사용한다.

### 3.4 동시 실행과 중복 주문

- deterministic client order ID
- position/claim primary key
- DB row lock
- advisory lock 기반 정책 전이
- 예약 자본 원자적 정산
- 멱등 RPC

를 유지한다. 네트워크 타임아웃 후 동일 경제 주문을 재제출하지 않고 주문 ID로 조회한다.

### 3.5 자본회전율 과최적화

회전율은 승격의 독립 축이지만 비용 차감 순성장과 승률을 악화시키면 승격하지 못한다. 최소 회전율만 강제해 음의 EV 거래를 만드는 구조도 사용하지 않는다.

### 3.6 승률 과최적화

거래를 없애 승률을 높이는 정책은 자본회전율과 계좌 성장률에서 열등해진다. 최소 거래량·관찰시간·자본 활용률 조건을 함께 둔다.

### 3.7 정책 반복 평가의 false promotion

단계별 cohort를 고정하고, 최소 관찰시간과 독립 블록을 사용하며, 같은 표본으로 매 시간 승격 결정을 반복하지 않는다. 손실예산 위반은 통계적 유의성과 무관하게 즉시 중단한다.

## 4. 주요 신규·수정 파일

### 신규

- `supabase/functions/_shared/lob/joint-objective.ts`
- `supabase/functions/_shared/lob/joint-objective.test.ts`
- `supabase/functions/market-autotrader/exposure-ledger.ts`
- `supabase/functions/market-autotrader/exposure-ledger.test.ts`
- `supabase/functions/market-autotrader/asset-locks.ts`
- `supabase/functions/market-autotrader/asset-locks.test.ts`
- `supabase/functions/market-autotrader/residual-ledger.ts`
- `supabase/functions/market-autotrader/residual-ledger.test.ts`
- `supabase/functions/_shared/scalp/v6100-invariants.test.ts`
- `supabase/migrations/202607280002_joint_compound_growth_v610.sql`
- `validation/v6100-deploy-validation.mjs`
- `SQL_VERIFY_v6100.sql`

### 핵심 수정

- `supabase/functions/market-autotrader/index.ts`
- `supabase/functions/market-autotrader/core.ts`
- `supabase/functions/_shared/lob/governance.ts`
- `supabase/functions/_shared/lob/adaptive-policy.ts`
- `supabase/functions/_shared/lob/evidence-sizing.ts`
- `supabase/functions/_shared/lob/entry.ts`
- `supabase/functions/lob-calibration/index.ts`
- `supabase/functions/market-performance/index.ts`
- `supabase/functions/market-scanner/engine.ts`
- `gateway/server.mjs`
- `docs/index.html`
- `docs/app.js`
- `docs/performance.js`
- `.github/workflows/main.deploy-supabase.yml`
- `validation/v690-deploy-validation.mjs`
- `validation/v691-deploy-validation.mjs`

## 5. 배포 순서

1. 현재 DB 백업
2. GitHub 저장소 전체 파일 교체
3. 신규 migration 존재 확인
   - `202607280001_fee_ledger_integrity_v691.sql`
   - `202607280002_joint_compound_growth_v610.sql`
4. 새 커밋 push
5. GitHub Actions 전체 통과 확인
6. migration 적용
7. Edge Functions 배포
8. Upbit/Binance Gateway 배포
9. `SQL_VERIFY_v6100.sql` 실행
10. 첫 30건은 회계·주문·잔량·수수료 무결성 중심 관찰
11. 30~100건은 EV·지연·청산·회전율 검증
12. 100건 이후 정책 canary 시작

과거 workflow를 재실행하지 않고 v6.10 커밋에서 새 workflow를 실행한다.

## 6. 성공 기준

- 실행된 모든 주문의 수수료 품질이 `MISSING`이 아님
- 수수료 원장 합계와 포지션 `paid_fees_quote` 일치
- 종료 포지션 순손익이 주문대금·수수료·잔량과 일치
- 중복 주문 0건
- 0수량 활성 포지션 0건
- 만료된 예약 자본 0건
- 장기 미해제 잠금이 사유 없이 남지 않음
- residual 누락 0건
- 정책 승격 데이터가 검증 LIVE + `FILL_CONDITIONAL`로만 구성
- challenger가 계좌 성장률·승률·회전율 중 어느 하나도 허용 범위 밖으로 악화시키지 않음

## 7. 중단 기준

다음 중 하나라도 발생하면 신규 진입을 중단하고 청산·대사만 허용한다.

- 중복 경제 주문
- 실제 잔고와 원장 불일치
- 수수료 `MISSING` 거래 발생 후 재조회 실패
- 미실현 포함 일일 손실 레일 도달
- 예약 노출이 설정 총노출 상한 초과
- 잔량이 포지션·residual 원장 어디에도 귀속되지 않음
- gateway 시세·주문 데이터 stale
- challenger 탐색 손실예산 소진
- 정책 버전이 포지션 진입·청산 사이 변경됨

## 8. 남는 한계

v6.10.0은 수학적·회계적 오류를 구조적으로 차단하고 학습·승격 경로를 제한하지만, 미래 수익을 보장하지 않는다. 실제 시장의 구조 변화, 거래소 장애, 극단적 갭, API 제한, 유동성 소멸은 코드만으로 제거할 수 없다.

따라서 완성도 판정은 신규 회계 검증 LIVE 거래로 수행한다. 코드 기능을 더 추가하는 것보다 다음이 중요하다.

- 수수료·잔량·노출 무결성 30건
- 비용·EV·지연 검증 100건
- 시장·패턴 계층 검증 200건
- 정책 canary와 Pareto 비교 400건 이상

v6.10의 궁극 목적은 거래 횟수나 승률을 장식하는 것이 아니라 **비용 차감 후 실제 계좌 자기자본을 지속적으로 복리 성장시키는 것**이다.
