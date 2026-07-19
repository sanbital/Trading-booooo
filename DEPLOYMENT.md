# Trading-booooo v2.1.0 — GitHub 웹 전용 배포 가이드

이 가이드는 **VS Code, PowerShell, Git, Supabase CLI를 전혀 사용하지 않습니다.** Windows 파일 탐색기, GitHub 웹사이트, Supabase 대시보드만 사용합니다.

이미 만든 항목:

- GitHub 저장소: `Trading-booooo`
- Supabase 프로젝트 표시 이름: `Trading-booootrading boooo`

Supabase 프로젝트의 **표시 이름은 배포에 사용되지 않습니다.** 아래에서 복사하는 `Project Ref`가 실제 연결값입니다.

## 전체 순서

1. ZIP 압축 풀기
2. Supabase 값 3개 확인
3. 개인 스캔 토큰 정하기
4. GitHub 비밀값 3개 등록
5. GitHub에 파일 업로드
6. 자동 함수 배포 성공 확인
7. GitHub에서 `docs/config.js` 수정
8. GitHub Pages 켜기
9. 개인 URL로 접속해 스캔 확인

## 1. ZIP 압축 풀기

1. 받은 ZIP을 다운로드합니다.
2. Windows 파일 탐색기에서 ZIP을 마우스 오른쪽 버튼으로 누릅니다.
3. `압축 풀기` 또는 `모두 추출`을 누릅니다.
4. 압축을 푼 `Trading-booooo` 폴더를 엽니다.

중요: ZIP 파일 자체를 GitHub에 올리면 안 됩니다. GitHub는 ZIP 내부를 자동으로 배치하지 않습니다.

압축을 푼 폴더에는 다음 항목이 있습니다.

```text
Trading-booooo/
├─ .github/workflows/deploy-supabase.yml
├─ docs/
├─ supabase/
├─ .gitignore
├─ README.md
├─ DEPLOYMENT.md
└─ CHANGELOG_v2.0.md
```

## 2. Supabase 값 확인

Supabase 대시보드에서 프로젝트 `Trading-booootrading boooo`를 엽니다.

### 2-1. Project Ref

브라우저 주소가 아래와 같다면:

```text
https://supabase.com/dashboard/project/abcdefghijklmnop
```

마지막의 `abcdefghijklmnop`가 `Project Ref`입니다. 따로 복사해 둡니다.

### 2-2. Project URL과 Publishable Key

1. Supabase 프로젝트 왼쪽 아래 `Project Settings`를 엽니다.
2. `API` 또는 `API Keys`를 엽니다.
3. 다음 두 값을 복사해 둡니다.
   - Project URL: `https://PROJECT_REF.supabase.co`
   - Publishable Key: `sb_publishable_...` 형식 또는 기존 `anon` 키

`service_role`, Secret Key, 데이터베이스 비밀번호는 프론트엔드에 사용하지 않습니다.

### 2-3. Supabase Access Token

1. Supabase 화면 오른쪽 위 사용자 메뉴를 누릅니다.
2. `Account Settings` → `Access Tokens`로 이동합니다.
3. 새 토큰 이름을 `Trading-booooo GitHub`로 입력하고 생성합니다.
4. 생성 직후 보이는 토큰을 복사해 둡니다.

이 토큰은 GitHub Actions가 Supabase에 함수를 배포할 때만 사용합니다. 권한이 큰 관리 토큰이므로 파일, `config.js`, README, 메모 공개글에 절대 넣지 않습니다.

## 3. 개인 스캔 토큰 정하기

로그인 대신 사용할 본인만의 문자열을 하나 정합니다.

- 최소 32자
- 영문 대·소문자, 숫자, `_`, `-`만 사용 권장
- 다른 사이트에서 쓰는 비밀번호 재사용 금지
- 비밀번호 관리자의 임의 문자열 생성 기능 사용 권장

예시 형식만 참고하고, 아래 값을 그대로 사용하지 마세요.

```text
Boo_Replace_With_Your_Own_Random_32Plus_Chars
```

실제 값은 안전한 곳에 보관합니다. 아래에서는 `MY_SCAN_TOKEN`이라고 부릅니다.

## 4. GitHub 비밀값 3개 등록

GitHub의 `Trading-booooo` 저장소에서 다음 순서로 이동합니다.

1. `Settings`
2. 왼쪽 `Secrets and variables`
3. `Actions`
4. `New repository secret`

다음 3개를 정확한 이름으로 하나씩 만듭니다.

| Name | Secret에 넣을 값 |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | 2-3에서 만든 Supabase Access Token |
| `SUPABASE_PROJECT_REF` | 2-1에서 복사한 Project Ref |
| `SCAN_ACCESS_TOKEN` | 3에서 정한 개인 스캔 토큰 |

저장 후 값이 다시 보이지 않는 것은 정상입니다. 이름 철자를 정확히 확인합니다.

## 5. GitHub에 파일 업로드

1. GitHub `Trading-booooo` 저장소의 `Code` 탭으로 이동합니다.
2. `Add file` → `Upload files`를 누릅니다.
3. Windows에서 압축을 푼 `Trading-booooo` 폴더를 엽니다.
4. **바깥쪽 `Trading-booooo` 폴더가 아니라 그 안의 모든 항목**을 업로드 영역으로 끌어놓습니다.
5. 목록에 `.github`, `docs`, `supabase`, `README.md`가 보이는지 확인합니다.
6. Commit message에 `Deploy Trading-booooo v2.1.0`를 입력합니다.
7. `Commit changes`를 누릅니다.

정상 저장소 루트는 다음과 같아야 합니다.

```text
.github/
docs/
supabase/
README.md
DEPLOYMENT.md
```

`Trading-booooo/docs/...`처럼 폴더가 한 겹 더 생기면 잘못 올린 것입니다.

## 6. 자동 함수 배포 확인

파일을 올리면 GitHub Actions가 Supabase 비밀값 설정과 Edge Function 배포를 자동으로 실행합니다.

1. 저장소 위쪽 `Actions`를 누릅니다.
2. 왼쪽 `Deploy Supabase Market Scanner`를 선택합니다.
3. 가장 최근 실행을 엽니다.
4. `Deploy market-scanner`가 초록색 체크가 되는지 확인합니다.

자동 실행이 보이지 않으면:

1. `Actions` → `Deploy Supabase Market Scanner`
2. `Run workflow`
3. Branch가 `main`인지 확인
4. 초록색 `Run workflow` 버튼 클릭

실패하면 빨간 단계명을 눌러 메시지를 확인합니다. `... is missing`이면 4단계의 GitHub 비밀값 이름 또는 값이 빠진 것입니다.

## 7. GitHub에서 프론트엔드 설정

로컬 편집기 없이 GitHub에서 직접 수정합니다.

1. 저장소 `Code` → `docs` → `config.js`를 엽니다.
2. 오른쪽 위 연필 모양 `Edit this file`을 누릅니다.
3. 아래 두 줄의 따옴표 안만 2-2에서 복사한 실제 값으로 바꿉니다.

```js
supabaseUrl: "https://실제_PROJECT_REF.supabase.co",
supabasePublishableKey: "실제_PUBLISHABLE_KEY",
```

4. `Commit changes...`를 누릅니다.
5. Commit message에 `Configure Supabase frontend`를 입력합니다.
6. `Commit directly to the main branch`를 선택하고 저장합니다.

Publishable/Anon Key는 브라우저용 공개 키입니다. `SUPABASE_ACCESS_TOKEN`, `SCAN_ACCESS_TOKEN`, `service_role` 키는 이 파일에 넣지 않습니다.

## 8. GitHub Pages 켜기

1. 저장소 `Settings`를 누릅니다.
2. 왼쪽 `Pages`를 누릅니다.
3. `Build and deployment`의 Source를 `Deploy from a branch`로 선택합니다.
4. Branch를 `main`, 폴더를 `/docs`로 선택합니다.
5. `Save`를 누릅니다.
6. 페이지 위쪽에 공개 주소가 나타날 때까지 기다립니다.

기본 주소 형식:

```text
https://GITHUB_USERNAME.github.io/Trading-booooo/
```

## 9. 개인 URL 만들기

기본 주소 끝에 3단계에서 정한 토큰을 붙입니다.

```text
https://GITHUB_USERNAME.github.io/Trading-booooo/#access=MY_SCAN_TOKEN
```

이 전체 주소를 본인 브라우저에 북마크합니다. `#access=...`가 포함된 전체 주소를 다른 사람에게 보내거나 화면 캡처에 노출하지 않습니다.

## 10. 최종 확인

1. 개인 URL로 접속합니다.
2. `원화마켓 전체 스캔`을 누릅니다.
3. 최대 140초 기다립니다.
4. 다음을 확인합니다.
   - 업비트 KRW 상장 종목 전체 개수
   - 안전필터를 통과한 전 종목의 15분 기간점검 결과
   - 5분·4시간·일봉 정밀분석 결과
   - 현재 매수 후보 또는 `현재 매수 추천 없음`
   - 단기·중기 목표가, 손절가, 예상 보유기간
   - `심층분석용 리포트 복사` 버튼

추천 없음은 오류가 아닙니다. 강제 조건을 통과한 종목이 없으면 매수를 억지로 추천하지 않도록 설계되어 있습니다.

## 이후 업데이트 방법

새 버전 ZIP을 받으면 압축을 풀고, 같은 방식으로 저장소 루트에 새 파일들을 업로드해 덮어씁니다. `supabase/functions/market-scanner` 또는 자동배포 파일이 바뀌면 GitHub Actions가 함수를 다시 배포합니다. `docs`만 바뀌면 GitHub Pages만 자동 갱신됩니다.

비밀값은 보통 다시 등록할 필요가 없습니다.

## 문제 해결

| 화면 또는 오류 | 원인 | 해결 |
|---|---|---|
| Actions에 `secret ... is missing` | GitHub 비밀값 누락 또는 이름 오타 | 4단계의 세 이름을 그대로 다시 확인 |
| Actions 배포 단계 401/403 | Supabase Access Token 또는 Project Ref 오류 | 토큰을 새로 만들고 비밀값 갱신 |
| `config.js 설정 오류` | Project URL/Publishable Key 미입력 | 7단계 두 값 수정 |
| `개인 접속 토큰 없음` | 주소의 `#access=` 누락 | 9단계 개인 URL로 접속 |
| `401 개인 접속 URL 오류` | URL 토큰과 GitHub Secret 불일치 | 같은 토큰으로 `SCAN_ACCESS_TOKEN` 갱신 후 Actions 수동 실행 |
| `403 허용되지 않은 주소` | Pages 소유자 주소 또는 커스텀 도메인 불일치 | 기본 `github.io` 주소 사용 후 재확인 |
| `404 Function not found` | Actions 함수 배포 미완료 | 6단계 초록 체크 확인 |
| `현재 매수 추천 없음` | 모든 강제 조건을 통과한 종목 없음 | 정상 결과이며 나중에 다시 스캔 |

## 사용하지 않는 항목

- Supabase Authentication 사용자 생성
- SQL Editor와 테이블 생성
- 업비트 API Key
- 로컬 프로그램, VS Code, PowerShell, Git, npm
- 자동 주문과 계좌 접근

## 공식 참고자료

- GitHub Actions용 Supabase 함수 배포: <https://supabase.com/docs/guides/functions/examples/github-actions>
- Supabase Edge Function 배포: <https://supabase.com/docs/guides/functions/deploy>
- GitHub Actions 비밀값: <https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions>
- GitHub Pages 설정: <https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site>
