# Trading-booooo Market Scanner v2.0.1

업비트 원화마켓(KRW) 전체를 자동 점검하고, 기간 추세와 최신 호가·체결을 함께 통과한 종목만 현재 매수 후보로 제시하는 개인용 읽기 전용 분석 도구입니다.

자동 주문, 업비트 계정 조회, 잔고 조회, 거래소 API Key 사용은 포함하지 않습니다.

## v2.0 핵심 동작

1. 업비트 KRW 상장 종목 전체의 현재가·24시간 거래대금·시장경보·체결 최신성을 1차 점검합니다.
2. 유의·주의·저유동·장기 미체결 종목을 제외합니다.
3. 안전필터를 통과한 **모든 종목**의 15분봉 96개(약 24시간)를 먼저 조회해 기간 추세를 점검합니다.
4. 15분 기간추세·유동성·모멘텀·당일 위치를 합산해 정밀분석 30개 후보를 구성하고 다음 시간축을 추가 조회합니다.
   - 5분봉 72개: 최근 약 6시간
   - 4시간봉 90개: 최근 약 15일
   - 일봉 60개: 최근 약 60일
5. 기간점수 상위 8개는 호가 4회와 최근 체결 최대 500건으로 정밀검증합니다.
6. 모든 강제 게이트를 통과한 최대 3개만 `현재 매수 후보`로 표시합니다. 통과 종목이 없으면 `현재 매수 추천 없음`이 정상 결과입니다.

## 추천 결과

- 현재 매수 후보와 종합점수·신뢰도
- 매수 검토 구간
- 단기 목표가와 중기 목표가
- 손절가격과 비용 반영 예상 손실률
- 위험예산 기반 추천 투입금
- 단기·중기·중장기 보유 분류와 조건부 추세 유지기간
- 추세 무효화 조건
- 5분·15분·4시간·일봉 지표
- 최신 호가 불균형·스프레드·체결 압력
- GPT/Claude에 그대로 붙여넣을 수 있는 Markdown 심층분석 리포트

## 보안 방식

로그인 화면은 없습니다. GitHub Pages 주소 뒤의 URL fragment에 개인 토큰을 넣습니다.

```text
https://YOURNAME.github.io/Trading-booooo/#access=YOUR_PRIVATE_TOKEN
```

fragment는 GitHub 서버 요청에 포함되지 않으며, 브라우저 앱이 Supabase Edge Function 호출 헤더로 전달합니다. Edge Function은 Supabase Secret의 `SCAN_ACCESS_TOKEN`과 일치할 때만 스캔합니다.

> GitHub Pages 주소 자체는 공개적으로 발견될 수 있습니다. 개인 토큰이 없으면 분석 함수는 실행되지 않지만, 토큰이 포함된 전체 URL을 공유하거나 캡처하지 마세요.

## 설치 방식

VS Code, PowerShell, Git, npm, Supabase CLI가 필요 없습니다. GitHub 저장소 비밀값 3개를 등록하고 파일을 웹으로 업로드하면 `.github/workflows/deploy-supabase.yml`이 Edge Function 비밀값 설정과 배포를 자동으로 처리합니다. 프론트엔드 설정도 GitHub의 파일 편집 화면에서 두 값만 바꿉니다.

## 파일 구조

```text
Trading-booooo/
├─ .github/
│  └─ workflows/deploy-supabase.yml
├─ docs/
│  ├─ index.html
│  ├─ app.js
│  ├─ styles.css
│  ├─ config.js
│  └─ .nojekyll
├─ supabase/
│  ├─ config.toml
│  ├─ .env.example
│  └─ functions/market-scanner/
│     ├─ index.ts
│     ├─ engine.ts
│     └─ engine.test.ts
├─ .gitignore
├─ DEPLOYMENT.md
├─ CHANGELOG_v2.0.md
└─ README.md
```

GitHub 웹 전용 배포는 [DEPLOYMENT.md](./DEPLOYMENT.md)를 위에서부터 순서대로 진행하세요.

## 투자 유의사항

본 도구는 공개 시세 기반 조건부 분석만 제공합니다. 목표가·손절가·보유기간은 미래를 확정하는 값이 아니며, 뉴스·공시·상장폐지·급격한 유동성 공백과 실제 체결 슬리피지를 완전히 반영할 수 없습니다. 수익을 보장하지 않으며 최종 판단과 책임은 사용자에게 있습니다.
