# v2.1.0 동적 호가구조 GitHub 웹 업데이트

이 업데이트는 VS Code, PowerShell, Git, Supabase CLI를 사용하지 않습니다.

## 새 기능

- 최종 후보 8개를 기본 18초간 Upbit 공개 WebSocket으로 실시간 관찰
- 호가 잔량 변화와 같은 가격·시간의 실제 체결량 교차검증
- 가짜 매수벽 취소 의심, 매도벽 재보충·흡수, 매수 지지 붕괴 감지
- 매도벽 실체결 돌파 후 저항→지지 전환 확인
- 동적 표본 부족 또는 위험 패턴 발견 시 BUY와 조건부 대기 매수가 차단
- 반복 유지된 인접 매도벽을 단기 목표가 상한에 보수적으로 반영
- 후보 카드와 복사 리포트에 관찰시간·호가수·동시간대 체결수·판정 표시

## 업데이트 순서

1. `Trading-booooo-v2.1.0-GitHub-Update.zip`을 다운로드합니다.
2. Windows 파일 탐색기에서 ZIP을 마우스 오른쪽 버튼으로 눌러 `모두 추출`합니다.
3. GitHub의 `Trading-booooo` 저장소에서 `Code` → `Add file` → `Upload files`로 이동합니다.
4. 압축을 푼 업데이트 폴더 안의 모든 항목을 업로드 영역에 끌어놓습니다.
5. 화면에 `docs`, `supabase`, `README.md`, `CHANGELOG_v2.0.md`, `UPDATE_v2.1.0.md`가 보이는지 확인합니다.
6. Commit message에 `Update dynamic orderflow v2.1.0`을 입력합니다.
7. `Commit changes`를 누릅니다.
8. `Actions` → `Deploy Supabase Market Scanner`에서 새 실행이 초록색이 될 때까지 기다립니다.
9. `pages build and deployment`도 초록색이 된 것을 확인합니다.
10. 개인 토큰 URL을 열고 `Ctrl + F5`로 새로고침한 뒤 다시 스캔합니다.

## 기존 설정은 유지됩니다

업데이트 ZIP에는 다음 파일이 들어 있지 않습니다.

- `docs/config.js`
- `.github/`

따라서 기존 Supabase URL, Publishable Key, GitHub Secrets, 배포 Workflow는 바뀌지 않습니다.

## 정상 화면 확인

후보 카드마다 `동적 호가` 줄이 새로 표시됩니다.

- `동적 특이 위험 없음`
- `돌파 후 지지 전환 확인`
- `가짜 매수벽 취소 의심`
- `매도 흡수·재보충 위험`
- `매수 지지 붕괴 위험`
- `동적 표본 부족`

`동적 표본 부족`은 오류가 아닐 수 있습니다. 관찰시간 중 서로 다른 호가 8회 또는 동시간대 체결 8건을 확보하지 못한 종목은 안전을 위해 매수 후보에서 제외됩니다.

스푸핑·아이스버그는 공개 호가 데이터만으로 법적·기술적으로 확정할 수 없으므로 화면은 `의심` 또는 `재보충 위험`으로 표시합니다.

