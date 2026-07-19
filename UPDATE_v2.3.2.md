# v2.3.2 업데이트 — 백테스트 정확성 보정

기존 v2.3.0 설치본을 GitHub 웹에서 덮어쓰는 업데이트입니다. VS Code와
터미널은 필요하지 않습니다.

## 운영 화면 변경

- 상단 버전이 `v2.3.2`로 표시됩니다.
- 돌파 후 지지 전환은 소량의 매도체결만으로 승인하지 않고, 원 매도벽 대비 실제
  방어·흡수량에 비례해 판정합니다.
- 기존 목표·손절·점수 기본값은 유지됩니다. 백테스트 연구 결과가 운영값을 자동으로
  바꾸지 않습니다.

## 새 GitHub 기능

- `Actions`에 `Backtest Market Scanner`가 추가됩니다.
- 업비트 또는 바이낸스 종목을 쉼표로 입력해 마감 캔들 백테스트를 실행합니다.
- 즉시 BUY와 조건부 WAIT 진입 결과가 분리됩니다.
- 수수료·슬리피지·위험예산 투입비중과 동일기간 단순보유를 비교합니다.
- 선택적으로 60/20/20 연구 모드를 실행할 수 있습니다.

## 업로드 순서

1. `Trading-booooo-v2.3.2-GitHub-Update.zip`을 다운로드하고 압축을 풉니다.
2. GitHub `Trading-booooo` → `Code` → `Add file` → `Upload files`로 이동합니다.
3. 압축을 푼 폴더 안의 모든 항목을 업로드합니다.
4. Commit message에 `Add measured backtest v2.3.2`를 입력합니다.
5. `Commit changes`를 누릅니다.
6. `Actions`에서 `Deploy Supabase Market Scanner`가 초록색인지 확인합니다.
7. Pages 배포가 끝난 뒤 개인 URL에서 `Ctrl + F5`로 새로고침합니다.

업데이트 ZIP에는 `docs/config.js`가 없습니다. 기존 Supabase URL과 Publishable Key는
유지됩니다. `.github/workflows/backtest.yml`은 새 파일이므로 숨김 폴더까지 포함해
업로드해야 합니다.

## 백테스트 실행

1. `Actions` → `Backtest Market Scanner`를 선택합니다.
2. `Run workflow`를 누릅니다.
3. 거래소와 종목을 입력합니다.
   - 업비트: `KRW-BTC,KRW-ETH`
   - 바이낸스: `BTCUSDT,ETHUSDT`
4. 조회기간은 `180`일 이상을 권장합니다.
5. 처음에는 `sweep=false`로 실행합니다.
6. 결과는 실행 요약과 Artifacts에서 확인합니다.

과거 공개 캔들에는 호가창 전체가 없으므로 이 결과는 스푸핑·아이스버그·흡수 판정의
정확도를 증명하지 않습니다. 동적 호가 로직은 전진 페이퍼 로그가 쌓이기 전까지
현재 안전 게이트를 유지합니다.
