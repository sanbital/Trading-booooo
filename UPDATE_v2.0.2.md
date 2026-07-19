# v2.0.2 GitHub 웹 업데이트

이 업데이트는 VS Code, PowerShell, Git, Supabase CLI를 사용하지 않습니다.

## 포함된 기능

- WAIT 후보의 조건부 대기 매수구간
- 최대 허용 매수가와 무효화 가격
- 가격 도달 후 재스캔 조건
- 후보 카드와 복사용 리포트 개선

## 업데이트 순서

1. `Trading-booooo-v2.0.2-GitHub-Update.zip`을 다운로드하고 Windows에서 모두 추출합니다.
2. GitHub의 `Trading-booooo` 저장소에서 `Code` → `Add file` → `Upload files`로 이동합니다.
3. 압축을 푼 업데이트 폴더 안의 모든 항목을 업로드 영역에 끌어놓습니다.
4. `docs`, `supabase`, `README.md`, `CHANGELOG_v2.0.md`, `UPDATE_v2.0.2.md`가 보이는지 확인합니다.
5. Commit message에 `Update conditional watch entry v2.0.2`를 입력합니다.
6. `Commit changes`를 누릅니다.
7. `Actions` → `Deploy Supabase Market Scanner`에서 새 실행이 초록색이 될 때까지 기다립니다.
8. GitHub Pages 배포가 끝난 뒤 개인 토큰 URL을 새로고침하고 다시 스캔합니다.

`index.html`에는 JavaScript·CSS 버전값이 포함되어 있어 이전 GitHub Pages 캐시를 사용하지 않습니다.

## 유지되는 설정

업데이트 ZIP에는 `docs/config.js`와 `.github`가 들어 있지 않습니다. 따라서 기존 Supabase URL·Publishable Key와 GitHub Secrets는 바뀌지 않습니다.

새 스캔에서 조건을 충족하는 WAIT 후보는 다음 항목을 표시합니다.

- 조건부 대기 매수구간
- 최대 허용 매수가
- 무효화 가격
- `가격 도달 시 자동매수 금지 · 15분봉 마감 후 재스캔`

안전 게이트를 통과하지 못한 후보에는 대기 가격이 표시되지 않는 것이 정상입니다.
