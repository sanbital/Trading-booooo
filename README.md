# Trading-booooo Market Scanner v2.6.0

업비트 KRW 현물과 바이낸스 USDT 현물을 전수 점검해 기간 추세, 가격구조, 최신 호가·체결, 비용 포함 손익비를 함께 통과한 후보만 제시하는 개인용 읽기 전용 분석 도구입니다. 자동 주문, 거래소 계정 조회, 거래소 API Key는 사용하지 않습니다.

## v2.6.0에서 달라진 점

### 1. 단기 목표와 중기 추세를 분리

가까운 저항 하나만으로 모든 후보의 손익비를 평가하던 한계를 수정했습니다.

- `SHORT_ONLY`: 가까운 단기 목표에서 일괄 청산
- `SCALE_OUT`: 1차 목표 60% 청산 후 2차 목표 40% 추세 추종
- 강한 4시간·일봉 추세라도 단기 목표의 최소 손익비가 부족하면 분할청산으로 억지 승격하지 않음
- 손절 완충폭은 `ATR15 × 0.35`, 현재 스프레드 3배, 최소 2틱 중 가장 큰 값 사용

### 2. 추천 상승률을 별도 예측

목표가를 그대로 “예상 상승률”로 표시하지 않습니다.

- 원시 목표수익률
- 백테스트 점수구간별 실제 MFE(진입 후 최대 유리 변동)
- 목표 선도달률
- 추세·모멘텀·과열·동적 호가 데이터 품질

을 합쳐 보수·중심·낙관 상승률과 예상 가격 범위를 계산합니다. 충분한 워크포워드 표본이 없을 때는 측정값인 것처럼 표시하지 않고 `보수적 사전값`으로 명시합니다.

### 3. 실제 신호 일치율 백테스트

단순 승률뿐 아니라 다음을 별도로 집계합니다.

- BUY 목표 선도달률
- WAIT 조건 발동률과 발동 후 적중률
- 목표/손절 선도달
- 시간종료 이익·손실
- 거절 게이트 정확도
- 놓친 기회율
- 방향 일치율
- 예상 상승률 대비 실제 MFE의 MAE·RMSE·편향
- 목표 도달 확률의 Brier Score
- 같은 봉에서 목표·손절이 함께 닿은 모호 신호 수

같은 15분봉에서 목표와 손절이 모두 닿으면 미래 경로를 추정하지 않고 손절 우선으로 처리합니다.

### 4. 자동 워크포워드 교정

`.github/workflows/backtest-calibration.yml`이 매주 월요일 오전 5시 KST에 실행됩니다.

1. 고정된 업비트·바이낸스 주요 8종목의 최근 180일 데이터를 수집
2. 테스트와 타입 검증 실행
3. 공통 기간을 TRAIN 60% / VALIDATION 20% / HOLDOUT 20%로 분리
4. TRAIN에서만 파라미터 선택
5. VALIDATION에서 기대값·Profit Factor·MDD·놓친 기회율·예측오차를 검사
6. 모든 승격 조건을 통과한 경우에만 `calibration-profile.ts` 갱신
7. HOLDOUT은 최종 모니터링에만 사용하고 선택이나 승격에 사용하지 않음
8. 승격된 프로필 커밋이 Supabase 자동 재배포를 시작

검증에 실패하면 기존 운영 프로필을 그대로 유지합니다. 자동 교정은 매주 반드시 값을 바꾸는 기능이 아니라, 나쁜 변경을 차단하는 자동 검증 장치입니다.

## 스캐너 처리 흐름

1. 유의·주의·저유동·장기 미체결 종목 제외
2. 안전필터 통과 전 종목 15분봉 192개 기간 점검
3. 상위 30개에 5분 144봉·4시간 180봉·일봉 200봉 추가 분석
4. 거래소별 상위 8개를 WebSocket으로 기본 60초, 저유동 경계 시 90초 관찰
5. 비체결성 대형벽 취소, 매도벽 재보충·흡수, 지지 붕괴, 돌파 후 지지 전환 검증
6. 지지·저항·수수료·슬리피지·호가 깊이·위험예산을 반영해 계획 계산
7. 동일 기초자산을 하나로 합치고 교차거래소 위험이 있으면 BUY를 WAIT로 강등
8. 안전한 서로 다른 코인만 최대 4개 표시

## 백테스트의 범위와 한계

과거 캔들로 당시 시점의 추세·가격구조를 재현하되, 공개 API로 복원할 수 없는 과거 호가·체결 스트림은 중립값으로 분리합니다. 따라서 백테스트 일치율은 **캔들·가격구조 계층의 실제 과거 일치율**이며, 스푸핑·흡수 같은 실시간 미세구조 계층의 완전한 라이브 성과로 과장하지 않습니다.

현재 상장종목만 과거 데이터를 받을 수 있어 상장폐지 종목에 대한 생존편향이 남고, 다종목 합계는 동시 포트폴리오 자본배분을 완전히 재현하지 않습니다.

## 화면에서 확인할 수 있는 값

- 현재 BUY·WAIT·AVOID 판정
- 단기/분할청산 전략과 1·2차 목표
- 구조적 지지·저항과 ATR·스프레드 기반 손절
- 비용 포함 손익비와 위험예산 기반 투입금
- 교정 예상 상승률과 보수·낙관 가격 범위
- 목표 선도달 추정과 교정 표본 수
- 5분·15분·4시간·일봉 상태
- 정적·동적 호가와 체결 품질
- 교차거래소 충돌 여부
- GPT/Claude용 상세 리포트

## 보안

GitHub Pages URL의 fragment에 개인 토큰을 넣고 Supabase Edge Function의 `SCAN_ACCESS_TOKEN`과 비교합니다.

```text
https://YOURNAME.github.io/Trading-booooo/#access=YOUR_PRIVATE_TOKEN
```

fragment는 GitHub 서버 요청에 포함되지 않지만 토큰이 들어간 전체 URL을 공유하거나 캡처하지 마십시오.

## 자동 배포

필요한 GitHub Repository Secrets:

- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_PROJECT_REF`
- `SCAN_ACCESS_TOKEN` — 32자 이상

`main` 브랜치에서 스캐너 코드나 승격된 교정 프로필이 바뀌면 `.github/workflows/main.deploy-supabase.yml`이 타입검증·테스트 후 Edge Function을 배포합니다.

## 파일 구조

```text
Trading-booooo/
├─ .github/workflows/
│  ├─ main.deploy-supabase.yml
│  └─ backtest-calibration.yml
├─ backtest/
│  ├─ fetch-history.ts
│  ├─ fetch-basket.ts
│  ├─ simulate.ts
│  ├─ metrics.ts
│  ├─ calibration.ts
│  ├─ calibrate.ts
│  ├─ run.ts
│  ├─ markets.json
│  └─ *.test.ts
├─ docs/
│  ├─ index.html
│  ├─ app.js
│  ├─ styles.css
│  └─ config.js
├─ supabase/functions/market-scanner/
│  ├─ index.ts
│  ├─ engine.ts
│  ├─ calibration-profile.ts
│  ├─ combined.ts
│  └─ *.test.ts
├─ deno.json
├─ DEPLOYMENT.md
├─ UPDATE_v2.6.0.md
└─ README.md
```

자세한 설치 과정은 [DEPLOYMENT.md](./DEPLOYMENT.md), 백테스트 해석은 [backtest/README.md](./backtest/README.md)를 참고하십시오.

## 투자 유의사항

이 도구는 공개 시세 기반 조건부 분석입니다. 목표가, 예상 상승률, 목표 선도달 추정, 보유기간은 미래를 확정하지 않으며 뉴스·공시·상장폐지·급격한 유동성 공백·실제 체결 오차를 완전히 반영할 수 없습니다. 최종 판단과 책임은 사용자에게 있습니다.
