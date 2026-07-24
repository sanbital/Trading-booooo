# Trading-booooo Market Scanner v4.0.0

하루 2~3회만 확인하는 사용자를 위한 저빈도 현물 추천·포워드 자기학습 엔진입니다. 추천 시점의 가격·호가·체결·이벤트를 저장하고, 24시간·72시간·7일·20일 실제 경로를 평가해 주간 워크포워드 안전선 안에서 로직을 자동 교정합니다.

## v4.0.0 핵심

- 추천 유효시간 15분과 다음 확인 시점 명시
- 초단타 대신 6시간~20일 보유계획 분류
- 진입 즉시 손절·1차·2차 목표를 확정하는 저빈도 운용 게이트
- 주간 백테스트 상위, 포워드 학습 하위의 보수적 위계
- BUY 실전 표본만 학습하고 WAIT·AVOID는 진단 데이터로만 보존
- 고정익절·분할익절·추적청산을 반사실적으로 동시 평가
- 실패원인 자동분류, 자동 승격, 자동 롤백
- 스캔과 학습을 분리해 Edge Function 타임아웃 방지

자세한 내용은 `UPDATE_v4.0.0.md`를 참고하세요.

## 설치·배포

`DEPLOYMENT.md`를 따라 Supabase migration, `market-scanner`, `market-learning` 함수를 배포합니다. GitHub Secret에는 기존 값 외에 `LEARNING_ACCESS_TOKEN`이 필요합니다.

---

## 이전 버전 기록

# Trading-booooo Market Scanner v3.3.0

업비트 KRW 현물과 바이낸스 USDT 현물을 전수 점검해 기간 추세, 가격구조, 최신 호가·체결, 비용 포함 손익비를 함께 통과한 후보만 제시하는 개인용 읽기 전용 분석 도구입니다. 자동 주문, 거래소 계정 조회, 거래소 API Key는 사용하지 않습니다.

## v3.3.0에서 달라진 점

- 매 실행 시작 시 18~36시간 전 미평가 후보의 이후 5분봉을 자동 조회해 결과 채점
- 진입 여부, 목표·손절 선도달, 비용 차감 순수익, MFE, MAE, Peak Capture Ratio 영구 저장
- BUY뿐 아니라 WAIT·AVOID를 포함한 거래소별 finalist 전체를 Supabase에 누적
- 누적 포워드 표본 60건 이상부터 70/30 시간순 검증으로 challenger 자동 생성
- 기대수익·Profit Factor·낙폭 목적함수가 기존 champion보다 개선될 때만 런타임 프로필 자동 승격
- 승격된 score threshold, 최소 순 R:R, 목표 ATR 배수, 손절 ATR 배수를 같은 실행의 당일 추천부터 적용
- 코드 재배포 없이 DB의 active runtime profile을 읽어 매일 로직을 자동 교정
- 과거 백테스트 바스켓을 48개 시장으로 확대하고 기본 수집기간을 450일로 상향
- Supabase 테이블·RLS·인덱스를 생성하는 migration과 자동 적용 workflow 추가

자세한 내용은 `UPDATE_v3.3.0.md`를 참고하세요.

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
- `SUPABASE_SERVICE_ROLE_KEY` — 포워드 로그 저장용
- `SUPABASE_DB_PASSWORD` — migration 자동 적용용

`main` 브랜치에서 스캐너 코드나 DB migration이 바뀌면 `.github/workflows/main.deploy-supabase.yml`이 타입검증·테스트 후 Edge Function을 배포합니다.

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
├─ UPDATE_v3.1.0.md
├─ backtest/calibration-history.jsonl (첫 실행부터 생성)
└─ README.md
```

자세한 설치 과정은 [DEPLOYMENT.md](./DEPLOYMENT.md), 백테스트 해석은 [backtest/README.md](./backtest/README.md)를 참고하십시오.

## 투자 유의사항

이 도구는 공개 시세 기반 조건부 분석입니다. 목표가, 예상 상승률, 목표 선도달 추정, 보유기간은 미래를 확정하지 않으며 뉴스·공시·상장폐지·급격한 유동성 공백·실제 체결 오차를 완전히 반영할 수 없습니다. 최종 판단과 책임은 사용자에게 있습니다.
