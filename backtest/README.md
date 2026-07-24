# v2.6.0 자동 백테스트·워크포워드 교정

운영 엔진의 분석 함수를 그대로 재사용해 과거 각 시점까지 마감된 캔들만으로 BUY, 조건부 WAIT, 거절 게이트를 평가합니다.

## 측정 항목

### 거래 성과

- 거래 수, 승률과 95% Wilson 구간
- 평균 이익·손실, 거래당 기대값, Profit Factor
- 계획/실현 손익비
- 누적 복리와 최대 낙폭
- 목표·손절·1차청산 후 본전·시간종료별 청산 수
- MFE와 MAE

### 실제 신호 일치율

- BUY 목표 선도달률
- WAIT 진입률과 발동 WAIT 적중률
- 목표/손절 선도달
- 거절 정확도와 놓친 기회율
- 실패 게이트별 차단 정확도
- 방향 일치율
- 예상 상승률의 MAE·RMSE·편향
- 목표 도달 확률 Brier Score

`NO_ENTRY`는 손실로 처리하지 않고 WAIT 진입 실패율로 분리합니다. 같은 봉에서 목표와 손절이 동시에 닿으면 보수적으로 손절 우선 처리하고 모호 건수를 별도 표시합니다.

## 미래참조 방지

- 결정시각까지 완전히 마감된 봉만 사용
- 5분 60봉, 15분 96봉, 4시간 120봉, 일봉 120봉 이상 확보 후 평가
- 신호 다음 15분봉 시가에 진입 슬리피지 반영
- 진입 이후 봉에서만 목표·손절 확인
- 평가구간 경계 뒤의 결과는 사용하지 않음
- TRAIN 60%에서만 파라미터 선택
- VALIDATION 20%에서만 승격 판정
- HOLDOUT 20%는 선택·승격에 사용하지 않음

## 자동 교정 승격 조건

후보 프로필은 다음 조건을 모두 통과해야 운영 파일로 기록됩니다.

- VALIDATION 거래 최소 15건
- 양의 거래당 기대값
- Profit Factor 1.08 이상
- 최대 낙폭 18% 이하
- 놓친 기회율 40% 이하
- 기존 프로필 대비 목적함수 개선
- 상승률 예측오차가 기존 대비 붕괴하지 않음

통과하지 못하면 `calibration-profile.ts`를 변경하지 않습니다.

## GitHub Actions

`Weekly Backtest Calibration`은 매주 월요일 05:00 KST에 실행됩니다.

- 기본 180일
- 고정 바스켓: BTC, ETH, XRP, SOL의 업비트·바이낸스 시장
- 테스트 → 데이터 수집 → TRAIN 선택 → VALIDATION 승격 → HOLDOUT 보고
- 결과는 Actions Artifact에 30일 보관
- 승격 성공 시 교정 프로필만 자동 커밋

수동 실행 시 `days`는 최소 125일이어야 합니다. 180일 이상을 권장합니다.

## 로컬 실행

```bash
deno task check
deno task test
deno run -A backtest/fetch-basket.ts 180
deno run -A backtest/run.ts backtest/data/*.json
deno run -A backtest/calibrate.ts --write-profile backtest/data/*.json
```

## 해석상 한계

과거 전체 호가창·체결 스트림은 공개 API로 복원할 수 없습니다. 백테스트에서는 미세구조를 중립으로 두므로 결과는 캔들·추세·가격구조 계층의 검증입니다. 현재 상장종목만 대상으로 하므로 생존편향이 남고, pooled 다종목 통계는 실제 동시 포트폴리오의 자본곡선과 다를 수 있습니다.
