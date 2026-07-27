# Trading-booooo v6.9.0 외부 AI 검토 요청서

버전: `6.9.0-EVIDENCE-SIZED-LIVE-VALIDATION`  
기준 버전: `6.8.1-RESIDUAL-LABEL-INTEGRITY`  
검토 목적: 아래 7개 한계에 대한 구현 적합성, 누락 위험, 통계·회계·실행 논리 검증

> 이 문서는 구현 코드와 설계 의도를 함께 제공하는 검토용 명세다. 수익을 보장하지 않는다. 검토자는 문서 주장보다 소스·마이그레이션·테스트를 우선하여 반박해 달라.

---

## 1. 변경 목적

v6.8.1은 Binance 청산 잔량을 가짜 손실로 학습하던 라벨 오류를 수정했다. v6.9.0은 그 위에서 다음 문제를 보완한다.

1. 후보 수가 적을 때 한 종목이 관리 시드의 1/3을 초과할 수 있음
2. 자기개선이 고정된 일부 계수 보정에 머무르고 개선 범위가 불명확함
3. LOB 데이터가 불충분한 탐색 거래도 풀사이즈로 진입함
4. 실측 지연 표본이 없으면 지연비용이 0으로 처리될 수 있음
5. 진입 시 예측 EV가 실현 순손익보다 지속적으로 낙관적일 수 있음
6. 캔들 백테스트·shadow 결과가 실전 LOB 승격 근거와 혼재될 위험
7. 기존 Pareto 승격이 안전하지만 지나치게 엄격하고 느려 유효한 개선도 정체될 수 있음

이번 버전은 진입을 무조건 줄이는 하드 게이트가 아니다. **거래 기회를 유지하되 자금 집중과 불확실성 비용을 제한하고, 정책 승격은 회계 검증된 실거래만으로 단계적으로 수행**한다.

---

## 2. 변경하지 않는 안전 불변식

아래 항목은 자동 정책이 수정할 수 없다.

- 현물만 허용
- 출금·이체·마진·선물·레버리지 기능 없음
- 일일·주간 손실 한도
- 거래당 최대 손실 한도
- 비상청산·신규 진입 중지·수동 개입 보호
- 거래소별 관리 자본과 보호금
- 사용자가 설정한 `scalp_position_slots`
- 180초 기본, 300초 절대 보유시간 상한
- 잔량 회계와 `LEGACY_UNVERIFIED` 학습 제외
- 후보가 적다는 이유로 슬롯 분모를 줄이지 않음
- backtest·shadow 자료는 실전 정책 승격 표로 사용하지 않음
- AI가 소스코드를 생성·수정해 자동 배포하지 않음

---

# 3. 7개 개선의 정의와 구현

## 개선 1. 슬롯 수를 고정 자본 분모로 사용

### 기존 문제

기존 코드는 후보 수와 열린 포지션 수에 따라 유효 슬롯을 줄였다.

```ts
const slots = effectiveSlots(
  configuredSlots,
  candidatePoolSize,
  openPositions,
);
```

설정 슬롯이 3개라도 후보가 하나면 분모가 1이 되어 한 거래가 관리 자본 대부분을 사용할 수 있었다.

### v6.9 정의

```text
슬롯당 최대 노출 = 전체 전략 노출 상한 / 설정 슬롯 수
```

후보가 하나여도 남은 두 슬롯의 자본은 현금으로 유지한다. 후보 부족은 위험 집중의 근거가 아니다.

### 구현

파일: `supabase/functions/market-autotrader/index.ts`

```ts
const configuredSlots = allocationOnly
  ? clamp(finite(settings.scalp_position_slots, 6), 1, 20)
  : 1;
const slots = configuredSlots;
```

`effectiveSlots()`는 autotrader 진입 크기 계산에서 제거했다.

### 기대 효과

- 3슬롯 설정이면 종목당 최대 약 1/3
- 후보 1개일 때도 전체 시드 몰빵 방지
- 후보가 부족한 구간에서 현금 비중 자연 증가

### 검토 요청

- 현재 exposure 계산이 열린 포지션과 예약 주문까지 일관되게 포함하는가
- `quoteStep` 반올림 때문에 1/3을 실질적으로 초과할 경로가 있는가
- 양 거래소를 각각 독립 3분할하는 기존 의도가 유지되는가

---

## 개선 2. 자기개선 범위를 ‘검토된 정책 정의’로 확장

### 기존 문제

기존 자기교정은 코인·패턴 확률, 순위, 손절 하한, 소프트 청산 등 정해진 일부 값만 조정했다. 반대로 무제한 코드 자가수정은 안전하지 않다.

### v6.9 정의

자가개선 단위는 소스코드가 아니라 **불변·버전 관리되는 `policy_definition`**이다. 정책은 사전에 검토한 범위 안에서만 진화한다.

정책군:

```text
BALANCED
QUALITY_WEIGHTED
LATENCY_GUARDED
EV_DEBIASED
```

정책이 변경할 수 있는 항목:

- 탐색 주문의 최소 크기와 데이터 불충분 크기 상한
- 풀사이즈에 필요한 데이터 품질·표본 수
- 미측정 지연 p95 가정값과 최소 지연비용
- 실측 EV 낙관 편향 페널티의 배수와 상한

정책이 변경할 수 없는 항목:

- 슬롯 수와 전체 관리 자본
- 손실 한도
- 출금·레버리지·마켓 범위
- 회계 규칙
- 임의 지표·임의 코드

### 구현

파일: `supabase/functions/_shared/lob/adaptive-policy.ts`

```ts
export interface LobAdaptivePolicyDefinition {
  schemaVersion: 1;
  family: "BALANCED" | "QUALITY_WEIGHTED" | "LATENCY_GUARDED" | "EV_DEBIASED";
  evidenceSizing: { ... };
  latency: { ... };
  evBias: { ... };
}
```

모든 수치는 `normalizeLobAdaptivePolicy()`에서 하한·상한을 강제한다.

정책 제안 순서:

```text
지연 미측정 또는 SLO 위반
→ LATENCY_GUARDED

지연 정상 + 확인된 EV 낙관 편향
→ EV_DEBIASED

지연 정상 + EV 편향 없음 + 데이터 불충분 거래 비중 높음
→ QUALITY_WEIGHTED

모두 정상
→ BALANCED
```

DB에는 각 챌린저의 정책 정의가 불변 JSON으로 저장된다.

### 검토 요청

- 정책군 우선순위가 과도하게 단순한가
- 한 번에 하나의 정책군만 바꾸는 것이 원인 분리에 충분한가
- 정책 정의 JSON에 스키마 버전·해시·서명 등 추가가 필요한가

---

## 개선 3. 데이터 불충분 거래는 허용하되 크기를 축소

### 기존 문제

`dynamicStatus = INSUFFICIENT`, 낮은 `dataQuality`, 적은 시장 표본이어도 LOB 전략은 `sizeFraction = 1`을 사용했다. 거래를 완전 차단하지 않는 방향은 맞지만 학습 비용이 풀사이즈였다.

### v6.9 정의

```text
진입 허용 여부 ≠ 주문 크기
```

데이터가 불충분해도 탐색 거래는 가능하다. 단, 아래 증거가 성숙하기 전에는 풀 슬롯을 쓰지 않는다.

- 실시간 관찰 데이터 품질
- 현재 관찰창의 feature 표본
- 해당 코인·패턴 실거래 표본
- 거래소 전체 패턴 표본

### 산식

```text
qualityScore = dataQuality / fullSizeQuality
featureScore = featureSamples / fullSizeFeatureSamples
marketScore  = marketSamples / fullSizeMarketSamples
patternScore = patternSamples / fullSizePatternSamples
onlineScore  = max(marketScore, 0.75 × patternScore)

evidence = cubic_root(qualityScore × featureScore × onlineScore)
sizeFraction = floor + (1 - floor) × evidence
```

기본값:

```text
탐색 최소 크기             0.35 슬롯
INSUFFICIENT 상태 상한      0.55 슬롯
dataQuality < 0.25 상한     0.40 슬롯
풀사이즈 품질 기준          0.75
풀사이즈 feature 표본       60
풀사이즈 시장 표본          40
풀사이즈 패턴 표본          100
```

### 구현

파일: `supabase/functions/_shared/lob/evidence-sizing.ts`

Autotrader에서는 계산된 값을 risk allocator에 직접 전달한다.

```ts
sizeFraction: evidenceSize
```

### 의도

- 거래가 사라져 학습이 멈추는 문제 방지
- 저품질 탐색 손실을 제한
- 코인 신규 상장·국면 변화에서도 완전 영구 차단 방지
- 충분한 데이터가 쌓이면 자동으로 정상 슬롯 크기 복귀

### 검토 요청

- 기하평균 결합이 적절한가
- 0.35 최소 탐색 비중이 너무 큰가 또는 너무 작은가
- 시장 표본과 패턴 표본의 계층적 결합 방식이 합리적인가
- 주문 최소금액 때문에 소형 계좌에서 축소 거래가 사라지는 경우 처리 필요 여부

---

## 개선 4. 지연 미측정 상태에서도 비용을 0으로 두지 않음

### 기존 문제

`scalp_latency_source = UNMEASURED`, 표본 0건이면 `latency_penalty_bps = 0`이 될 수 있었다. 가장 짧은 전략이 실행 경로를 모를 때 순간 체결을 가정하는 오류다.

### v6.9 정의

우선순위:

```text
1. 실측 p95 + 현재 책의 noiseBand → 수축된 실측 비용
2. 실측 없음 + noiseBand 있음 → 가정 p95로 추정
3. noiseBand도 없음 → 보수적 최소 비용
```

기본값:

```text
미측정 가정 p95           1,500ms
미측정 최소 비용          1bp
정책별 배수 범위          0.75~1.75
총 지연 페널티 상한       15bp
```

noiseBand 기반 계산:

```text
latencyCostBps = noiseBandBps × sqrt(latencyMs / observationWindowMs)
```

### 구현

파일: `supabase/functions/_shared/scalp/latency.ts`

```ts
resolveLatencyPenaltyBps(...)
```

출처는 감사 로그에 다음 중 하나로 저장된다.

```text
NOISE_BAND_X_MEASURED_P95_SHRUNK
NOISE_BAND_X_ASSUMED_P95
CONSERVATIVE_UNMEASURED_FLOOR
```

### 검토 요청

- noiseBand를 지연 역선택 비용으로 사용하는 근사가 보수적인가
- Binance와 Upbit에 서로 다른 가정 p95가 필요한가
- 실측 p95 수축 prior가 exchange/market별이어야 하는가

---

## 개선 5. 실현 손익으로 EV 낙관 편향을 자동 보정

### 기존 문제

예측 `ev_lower_bound_bps`가 양수인데 회계 교정 후 실제 순손익이 계속 음수라면 모델이 비용·목표 도달률·청산 결과를 낙관적으로 본 것이다. 단순 표본 평균을 즉시 차감하면 작은 표본과 이상치에 흔들린다.

### v6.9 정의

회계 검증된 호환 엔진의 종료 거래만 사용한다.

```text
residual = realizedNetBps - predictedEvLowerBoundBps
```

- 양수: 예측보다 실제가 좋음
- 음수: 예측이 낙관적

처리:

1. 양 끝 5% 절사
2. 최소 40표본
3. 잔차 평균의 one-sided 90% 상한이 0보다 낮을 때만 낙관 편향 확정
4. 표본 수로 prior 80에 수축
5. 최대 30bp 기본 상한

```text
weight = n / (n + 80)
penalty = min(maxPenalty, -meanResidual × weight)
```

### 구현

파일: `supabase/functions/_shared/lob/ev-bias.ts`

진입 EV:

```ts
evNetBps -= forecastBiasPenaltyBps;
evLowerBoundBps -= forecastBiasPenaltyBps;
```

중요: 이 값은 가짜 수수료가 아니라 **예측모델 교정값**으로 별도 감사 필드에 남긴다.

### 사용 데이터 범위

- `accounting_quality`가 검증된 거래만
- 호환 엔진:
  - `6.8.1-RESIDUAL-LABEL-INTEGRITY`
  - `6.9.0-EVIDENCE-SIZED-LIVE-VALIDATION`
- 과거 오염 라벨과 다른 예측 구조는 제외

### 검토 요청

- 실현손익과 EV-LCB 차이를 직접 빼는 방식이 이중 보수화되는가
- 코인·패턴·거래소별 segment가 필요할 최소 표본은 얼마인가
- 국면 변화 대응을 위해 시간 감쇠가 필요한가
- target/stop/timeout/fill 예측을 별도로 교정해야 하는가

---

## 개선 6. 정책 승격은 회계 검증된 실거래만 사용

### 기존 문제

캔들 백테스트는 과거 주문 대기열, 취소, 스푸핑, 부분체결, 순간 지연을 복원하지 못한다. shadow 데이터도 실제 체결비용과 자본 점유를 완전히 대표하지 못한다.

### v6.9 정의

정책 승격 투표 자격:

```text
실제 LIVE 종료 거래
AND policy_version 존재
AND accounting_quality IN (
  NO_RESIDUAL,
  RESIDUAL_MARKED_TO_EXIT
)
```

아래 데이터는 연구·진단에는 사용하지만 승격 투표권이 없다.

```text
PAPER
shadow outcome
candle backtest
LEGACY_UNVERIFIED
정책 버전이 없는 과거 거래
```

추가 생존 조건:

- 각 arm의 검증 실거래 비율 100%
- 최소 2개 시장
- 최소 2개 독립 시간 블록
- 거래소×패턴 공통 구성 커버리지

### 구현

- `governance.ts`: `liveVerified`, `accountingQuality`, market/time breadth gate
- `202607270022_evidence_sized_live_validation_v690.sql`: 평가 dataset 단계에서 필터링

### 개발 방향

백테스트의 역할:

```text
후보 생성, 코드 회귀, 극단 시나리오, 사전 탈락
```

실거래 canary의 역할:

```text
최종 승격·확대·롤백
```

### 검토 요청

- live-only 승격이 너무 느릴 때 사용할 수 있는 안전한 사전 정보 결합 방식
- 시장 2개·시간 블록 2개가 충분한지
- 동일 시각 상관 거래를 독립 표본으로 보는 문제
- 거래소×패턴 구성 보정 방식의 통계적 적절성

---

## 개선 7. 15% canary → 50% 확대 → 승격 → 재확인

### 기존 문제

기존 구조는 처음부터 50:50 cohort를 만들고, 순익·승률·회전율이 모두 엄격하게 개선되어야 했다. 안전하지만 다음 문제가 있었다.

- 검증 전 챌린저에 절반 자본 배정
- 작은 표본에서 엄격한 동시 우월성 확보 어려움
- 일부 지표가 통계적으로 동일해도 승격 정체
- 좋은 정책도 영구 HOLD 가능

### v6.9 상태 흐름

```text
CHAMPION
  ↓ 새 정책 정의 생성
CHALLENGER 15% CANARY
  ↓ 회계 검증 실거래에서 비유해성 확인
CHALLENGER 50% EXPANDED
  ↓ 충분한 동시대 표본 + Pareto 계약
PROVISIONAL CHAMPION
  ↓ 기존 챔피언을 CONTROL 50%로 재비교
CONFIRMED CHAMPION 또는 AUTO ROLLBACK
```

### canary 확대 기준

기본 최소:

```text
baseline 20건
candidate 10건
회계 검증 실거래 100%
2개 이상 시장
2개 이상 독립 시간 블록
candidate 평균 순손익 > 0
profit factor >= 0.90
순익·승률 신뢰상한이 허용 손실폭보다 나쁘지 않음
거래 완료율·자본 회전율이 baseline의 75% 이상
낙폭 실질 악화 없음
```

확대는 승격이 아니다. `EXPAND`는 traffic만 15%에서 50%로 바꾸고 평가 cohort를 새 시각부터 다시 시작한다.

### full promotion 계약

필수:

- 양 arm 최소 40 종료 거래
- 양 arm 최소 20 assigned scan
- candidate 순손익·가중 순손익·기하평균 모두 양수
- profit factor > 1
- 평균 순손익 개선
- 평균 순손익 90% 하한이 baseline 대비 -2bp보다 나쁘지 않음
- 승률 90% 하한이 baseline 대비 -3%p보다 나쁘지 않음
- 거래 완료율·slot 회전율·자본 회전율 90% 이상 유지
- 거래소별 정상 주문금액 98% 이상 유지
- 공통 거래소×패턴 구성에서 평균 순손익 악화 없음
- 낙폭 5% 상대 허용치 이내
- 순익·승률·회전율 중 하나는 의미 있게 개선

### 설계 철학

`non-inferiority`는 악화를 숨기기 위한 가중합이 아니다.

```text
candidate는 비용 후 양의 기대값이어야 하고,
주요 보조지표는 정해진 작은 허용범위 안에서 유지되며,
최소 하나는 의미 있게 좋아져야 한다.
```

### 검토 요청

- 15% canary에서 표본 편향이 심해지는가
- 확대 시 cohort를 리셋하는 것이 맞는가, 누적하는 것이 맞는가
- -2bp, -3%p, 90% turnover 비열등 마진의 근거
- multiple testing과 repeated peeking 보정 필요 여부
- 순차검정 또는 Bayesian decision rule이 더 적합한가

---

# 4. 데이터 흐름

```text
실시간 LOB·체결
  ↓
market-scanner 후보 생성
  ↓
scan_id 기반 고정 policy lane 배정
  ↓
market-autotrader
  ├─ 설정 슬롯 수를 고정 분모로 사용
  ├─ 현재 LOB + 시장/패턴 실거래 표본으로 sizeFraction 계산
  ├─ 실측 또는 보수적 지연비용 반영
  ├─ 확인된 EV 낙관 편향 반영
  └─ 비용 후 EV 재검증
  ↓
실제 주문·체결·청산
  ↓
v6.8.1 residual accounting
  ↓
lob_online_outcomes
  ├─ accounting verified
  ├─ entry-time policy definition
  ├─ evidence sizing audit
  ├─ latency source/cost
  └─ EV bias penalty
  ↓
lob-calibration
  ├─ 실현-vs-예측 EV 진단
  ├─ bounded policy proposal
  └─ canary/expand/promote/confirm/rollback
```

---

# 5. 주요 파일

| 파일 | 역할 |
|---|---|
| `market-autotrader/index.ts` | 고정 슬롯 분모, evidence sizing, latency/EV 비용 실주문 반영 |
| `_shared/lob/adaptive-policy.ts` | 검토된 정책 스키마·정규화·챌린저 제안 |
| `_shared/lob/evidence-sizing.ts` | 불충분 데이터 주문 크기 계산 |
| `_shared/lob/ev-bias.ts` | 실현-vs-예측 EV 낙관 편향 추정 |
| `_shared/scalp/latency.ts` | 실측/미측정 지연비용 해석 |
| `_shared/lob/entry.ts` | EV와 EV-LCB에서 편향 페널티 차감 |
| `_shared/lob/governance.ts` | live-only, breadth, canary EXPAND, non-inferiority Pareto |
| `lob-calibration/index.ts` | 진단값 저장, bounded policy proposal, governance 실행 |
| `202607270022_evidence_sized_live_validation_v690.sql` | 설정·정책 정의·live-only dataset·EXPAND RPC |
| `SQL_VERIFY_v690.sql` | 배포 후 슬롯·정책·증거크기·지연·EV 확인 |

---

# 6. 새 DB 필드

`trading_settings`:

```text
scalp_unmeasured_latency_ms
scalp_unmeasured_latency_penalty_bps
scalp_ev_bias_penalty_bps
scalp_ev_bias_samples
scalp_ev_bias_source
scalp_ev_bias_measured_at
```

`lob_policy_versions`:

```text
policy_definition jsonb
```

기존 자본·손실 한도 필드는 변경하지 않는다.

---

# 7. 감사 가능한 진입 스냅숏

v6.9 신규 또는 강화 필드:

```json
{
  "slots": 3,
  "risk_sizing": {
    "slotCap": 100,
    "sizeFraction": 0.4,
    "notionalQuote": 40,
    "totalExposureCap": 300
  },
  "evidence_sizing": {
    "fraction": 0.4,
    "cappedBy": "LOW_DATA_QUALITY",
    "qualityScore": 0.2,
    "featureScore": 0.15,
    "onlineScore": 0.1
  },
  "latency_penalty_bps": 1.5,
  "latency_penalty_source": "NOISE_BAND_X_ASSUMED_P95",
  "forecast_bias_penalty_bps": 4.2,
  "forecast_bias_samples": 120,
  "forecast_bias_source": "MEASURED",
  "policy": {
    "version": 12,
    "lane": "CHALLENGER",
    "definition": {
      "family": "LATENCY_GUARDED"
    }
  }
}
```

---

# 8. 테스트와 검증

추가 테스트:

- bounded policy 모든 파라미터 범위 강제
- 진단에 따른 policy family 선택
- 고품질 성숙 증거 풀사이즈
- INSUFFICIENT 거래 크기 상한
- 저품질 데이터 탐색 크기 상한
- 작은 표본 EV 편향 무반응
- 충분한 낙관 편향 수축 페널티
- EV/EV-LCB 직접 차감
- 미측정 지연 non-zero fallback
- canary EXPAND
- unverified/shadow 표본 승격 금지
- 고정 슬롯 분모 source invariant
- v6.9 migration 안전 불변식
- 버전 일치

현재 작업 환경에서 수행한 검증:

```text
전체 Deno 테스트 파일 Node 호환 실행 360 passed
수정 순수 모듈 및 정책 테스트       32 passed
지연 모듈 집중 실행                 17 passed
Gateway Node 테스트                 11 passed
v6.9 배포 정적 불변식               12 passed
TypeScript syntax transpile          passed
Git diff whitespace check            passed
```

제약:

- 현재 작업 컨테이너에는 Deno 실행기가 없어서 공식 `deno task check/test` 전체 실행은 하지 못했다.
- GitHub Actions의 Deno CI가 최종 출고 게이트다.
- SQL은 실제 Supabase 트랜잭션에 적용하지 않았으며 배포 전 DB 백업과 staging 적용이 필요하다.

---

# 9. 배포 순서

1. 현재 DB와 저장소 백업
2. 전체 ZIP을 저장소 루트에 덮어쓰기
3. GitHub Actions에서 `deno task check`와 전체 테스트 통과 확인
4. Supabase migration `202607270022_evidence_sized_live_validation_v690.sql` 적용
5. Edge Functions와 Gateway 배포
6. `SQL_VERIFY_v690.sql` 실행
7. 신규 거래 스냅숏에서 확인
   - `slots = 3`
   - `order_quote <= exposure_cap / 3`
   - 데이터 불충분 시 `size_fraction < 1`
   - latency penalty가 0이 아님
   - policy definition이 저장됨
8. 40개 이상 회계 검증 종료 거래 후 EV 편향 상태 확인
9. 챌린저가 15%에서 시작하고 `EXPAND` 전 50%로 올라가지 않는지 확인

---

# 10. 롤백

코드 롤백:

- v6.8.1 커밋으로 되돌린다.

DB 롤백 원칙:

- 신규 컬럼은 즉시 삭제하지 않는다. 이전 코드가 무시할 수 있으므로 보존이 안전하다.
- 활성 CHALLENGER가 문제를 일으키면 `REJECT` 또는 traffic 0이 아니라 governance RPC로 종료한다.
- 잘못 승격된 provisional champion은 기존 CONTROL로 `ROLLBACK`한다.
- v6.8.1 residual accounting migration은 되돌리지 않는다.

---

# 11. 알려진 잔여 한계

- 주문 대기열 우선순위와 역선택을 완전 모델링하지 못함
- EV 편향은 초기에는 전체 호환 엔진 pooled 값이며 segment별 교정이 아님
- 정책군은 네 종류로 제한되며 새로운 전략 패턴을 발명하지 않음
- canary repeated evaluation의 통계적 alpha spending을 명시적으로 구현하지 않음
- 시장 국면별 champion 분리는 아직 없음
- latency fallback의 1,500ms/1bp는 보수적 운영 prior이지 실측 사실이 아님
- 데이터 품질 크기 산식의 기본값은 실거래 검증 전 가설
- 수익성은 보장되지 않으며, 개선 효과는 v6.9 회계 검증 실거래로 확인해야 함

---

# 12. 다른 AI에게 요청하는 반대심문 질문

1. 고정 3분할이 주문 예약·부분체결·교차 거래소에서 깨지는 경로가 있는가
2. evidence sizing이 동일 위험을 중복 감점하거나 반대로 과소 감점하는가
3. `INSUFFICIENT` 거래를 0.35~0.55 슬롯으로 허용하는 것이 합리적인가
4. 지연비용의 noiseBand 제곱근 스케일이 시장 미세구조에서 타당한가
5. EV 편향 페널티가 수수료·슬리피지·uncertainty haircut과 이중 차감되는가
6. 40표본, prior 80, 90% one-sided 신뢰기준의 통계적 근거가 충분한가
7. 호환 엔진 6.8.1/6.9.0을 함께 pooling해도 되는가
8. accounting-verified live-only 승격이 데이터 누락 편향을 만들 수 있는가
9. 15% canary와 50% 확장 cohort를 리셋하는 설계가 올바른가
10. Pareto non-inferiority margin(-2bp, -3%p, turnover 90%)이 너무 느슨하거나 엄격한가
11. repeated peeking과 multiple challenger에 따른 오류율을 어떻게 통제할 것인가
12. 정책군 선택 로직이 원인 분리를 훼손하거나 특정 family를 영구 우선할 가능성이 있는가
13. `policy_definition` 변조·스키마 오류·롤링 배포에서 fail-closed가 충분한가
14. migration RPC의 동시성·partial unique index·EXPAND 전환에 트랜잭션 결함이 있는가
15. 현재 코드에서 실제 손익이나 자본회전율을 왜곡할 수 있는 다른 회계 라벨이 남았는가

검토 결과는 다음 형식으로 요청한다.

```text
[확정 버그]
파일/함수/라인, 재현 조건, 영향, 수정안

[설계 위험]
가정, 반례, 발생 가능성, 방어안

[통계 문제]
표본·검정·편향·다중비교 문제, 대체 방법

[통과]
근거와 검증 범위

[추가 데이터 필요]
필드, SQL, 최소 표본, 판정식
```
