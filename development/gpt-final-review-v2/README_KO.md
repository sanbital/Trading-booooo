# Trading-booooo · GPT 최종 판단 재검증자 V2

기존 모델을 교체하지 않습니다. 기존 모델이 내린 신규 매수 판단과 그 근거를 실제 OpenAI Responses API에 보내고 GPT가 그 판단을 재검증하는 코드를 추가했습니다.

## 동작

기존 후보 생성 → 눌림·재가속 확인 → B06133 → CEC0040 → GPT 최종 재검증 → 기존 계좌·호가·가격 이탈·유효시간·중복 검사 → 기존 주문 경로.

GPT에는 “기존 모델이 매수를 승인했다”는 제안, 적용한 조건, 실제 지표와 심사 당시의 완성 봉 기반 최신 지표를 함께 보냅니다. 기존 답을 숨긴 독립 필터 실험과 다릅니다. 원래 계산과 논리가 성립하는지, 지금도 근거가 유지되는지를 평가합니다.

- PASS: 근거가 뒷받침됨. 원래 실행 검사로 넘깁니다. 주문 명령이 아닙니다.
- VETO: 기존 판단과 직접 충돌하는 근거가 있음. 적용 모드에서는 해당 후보만 제외합니다.
- ABSTAIN: 근거 부족·응답 오류·만료. 적용 모드에서는 해당 후보만 보류합니다.

“맞다/틀리다”는 제공된 근거의 타당성 평가입니다. 미래 수익의 정답 판정이나 수익 보장이 아닙니다. 매도·청산 판단은 이번 범위에 포함하지 않습니다.

## 실제 API 코드

`supabase/functions/_shared/gpt-final-review/openai.mjs`가 서버 secret `OPENAI_API_KEY`를 사용해 `https://api.openai.com/v1/responses`에 실제 POST 요청을 전송합니다. fetch를 주입하지 않으면 런타임의 실제 네트워크 fetch가 사용됩니다. 테스트에서만 가짜 응답을 주입합니다.

모델은 공식 문서에서 확인한 `gpt-5.4-mini-2026-03-17`로 고정했습니다. `text.format`에 strict JSON Schema를 적용합니다. 서버 도구·거래소 키·계좌 정보·주문 함수는 GPT에 제공하지 않습니다. 원본 응답, 요청 ID, 토큰 사용량과 USD 비용 추정을 심사 저널에 저장합니다. API 비용과 USDT 거래손익은 합치지 않습니다.

## 현재 소스와 연결

확인한 GitHub main 커밋: `fea185c089932386d057a8abea14997007713b6d`.

대상: `supabase/functions/v10-lane-executor/index.ts`.

원본 Git blob: `b3cb11693036b8761bbe2618508f33ba1738e5d1`.

`development/gpt-final-review/apply-current.mjs`는 위 원본 해시와 정확한 다섯 연결 지점을 확인하고 로컬 체크아웃에 새 모듈을 복사합니다. 기존 원본 전체를 바꾸거나 미확인 버전에 억지로 적용하지 않습니다.

연결 지점은 import, CLAIMED 처리 전 심사, 진입 시작 시 재확인, 주문 intent 생성 직전 순수 재확인, lease 해제 후 재진입 순서입니다. 코드의 200 USDT·3배·계좌 10슬롯·하위 정책 4슬롯 상수와 매도·보호·정산 함수에는 수정 패치가 없습니다.

로컬 원본 확인만 수행:

```bash
node development/gpt-final-review/apply-current.mjs /path/to/Trading-booooo
```

로컬 파일에 적용하고 원본 백업 생성:

```bash
node development/gpt-final-review/apply-current.mjs /path/to/Trading-booooo --write
```

두 명령 모두 GitHub push, Supabase 설치·배포, secret 변경, 주문 실행을 하지 않습니다. 원본 파일은 해당 Git blob과 동일한 LF 인코딩이어야 합니다. 해시가 다르면 중단합니다.

## 대기와 안전장치

GPT 호출은 원래 거래 루프가 기다리는 동기 호출이 아닙니다. 별도 promise로 진행하고 보호·청산·X1 루프를 그대로 진행시킵니다. SHADOW에서는 심사 저널 조회도 원래 주문 경로가 기다리지 않습니다.

ENFORCE에서는 미완료 후보를 실행 큐에서 빼고 나머지 기존 루프를 마칩니다. 원래 `runWithLease`가 종료해 lease를 반환한 다음에만 응답을 기다릴 수 있습니다. 유효한 PASS가 있으면 기존 `runWithLease` 전체를 한 번 다시 호출해 일반 검사를 다시 거칩니다. 별도 주문 경로를 만들지 않습니다. busy·계좌 차단·원래 조건 탈락을 무시하지 않습니다.

최종 확인은 네트워크 없는 순수 함수입니다. 응답이 왔다고 이미 읽은 호가를 그대로 사용하지 않고 기존 코드의 최신 호가·자금·중복·가격 이탈 검사로 돌아갑니다. 원래 trigger 만료를 늘리지 않습니다. GPT 검토 스냅샷도 별도의 짧은 유효시간을 갖습니다.

같은 원래 판단·모델·프롬프트·설정은 원자적으로 한 번만 심사 요청합니다. RUNNING이 남으면 자동 재과금하지 않습니다. 이 보수적 처리로 해당 후보가 만료될 수 있지만 PASS를 얻기 위한 반복 호출은 하지 않습니다.

## 설치되지 않은 심사 저장소

`development/gpt-final-review/create_review_store.UNAPPLIED.sql`에 별도 심사 저널과 일일 API 예약 예산 테이블, 중복 요청 방지 함수를 넣었습니다. 원래 거래 테이블을 변경하지 않습니다. RLS를 켜고 PUBLIC·anon·authenticated 권한을 제거합니다. 함수는 SECURITY INVOKER입니다.

이 SQL은 실행하지 않았습니다. 실제 연결에는 별도 승인 후 심사 저장소 설치가 필요합니다. 저장소가 없거나 오류가 나면 ENFORCE 후보는 통과하지 않고 SHADOW는 원래 주문 허용 여부를 바꾸지 않습니다.

`.env.example`은 OFF입니다. API 호출에는 서버 키, API 승인 참조, USD 일일 예산, 호출 상한이 필요합니다. ENFORCE에는 별도의 명시적 승인 설정도 필요합니다. API 승인과 실거래 적용 승인을 혼동하지 않습니다.

후보별 0.10 USD는 실제 비용이 아니라 보수적인 예약액입니다. 예약액은 자동 환급하지 않습니다. 실제 비용 추정은 응답의 토큰 사용량으로 따로 남기며 사용량을 모르면 null로 기록합니다.

## 테스트와 주문 없는 실행

Node.js 22.16 이상. 외부 npm 패키지 설치 없이 실행합니다.

```bash
npm test
npm run demo
```

`demo`는 합성 입력과 모의 API 응답만 씁니다. PASS/VETO/ABSTAIN 각각의 연결을 보여주며 실제 API·주문 호출은 0건입니다.

실제 API를 한 후보에 호출하는 별도 실행기:

```bash
node --env-file=/secure/server.env development/gpt-final-review/review-once.mjs \
  --candidate /secure/live-candidate.json \
  --journal /secure/private-gpt-journal \
  --call-api --approve-cost-usd 0.10 --approval-ref YOUR_APPROVAL_REFERENCE
```

`live-candidate.json`은 현재 executor의 승인된 실제 signal row 형식입니다. id·symbol·status·features.v17Setup·features.b06133·features.cec0040·features.exitPolicy가 필요합니다. 원래 유효시간 안에 실행해야 합니다. 테스트 fixture의 종목이나 과거 거래 시각을 현재 시각으로 바꿔 실제 사례처럼 실행하지 마십시오. 이 실행기는 DB·주문 클라이언트를 불러오지 않습니다.

동일 저널 디렉터리를 재사용하면 같은 판단의 중복 호출과 하루 초과 호출을 막습니다. 키는 출력하지 않습니다. 실사용 저널과 API 원문은 저장소에 커밋하지 않습니다.

## 검증 범위와 남은 제한

신규 모듈 테스트, 모의 HTTP 요청 형태·응답 검증, 중복 심사, SHADOW 비동기 격리, 후보별 보류, lease 밖 대기, 로컬 패치 앵커 검증을 수행했습니다. 결과는 `development/gpt-final-review/evidence/tests.tap`에 있습니다.

실제 GPT API 호출, 실제 DB에서의 새 SQL 실행, 전체 executor에 패치를 적용한 Deno 통합 빌드, 운영 거래 루프 회귀와 비용·지연·수익성 검증은 수행하지 않았습니다. 새 코드가 현재 운영 서버에 적용됐다는 의미가 아닙니다.

특히 기존 X1 루프가 한 사이클 시간을 길게 사용하는 상황에서는 PASS가 도착해도 기존 사이클 종료·재평가 전에 만료될 수 있습니다. 이때는 후보를 보류하며 유효시간을 늘리거나 기존 보호 루프를 단축하지 않습니다. 따라서 실거래 적용 전 실제 심사 완료→재평가→주문 가능 시간의 통합 검증이 필요합니다. 이 패키지를 바로 활성화해도 충분한 진입률이 나온다고 보장하지 않습니다.

## 확인한 공식 문서

- OpenAI 모델·snapshot·파라미터·단가: https://developers.openai.com/api/docs/models/gpt-5.4-mini
- OpenAI strict Structured Outputs: https://developers.openai.com/api/docs/guides/structured-outputs
- Supabase EdgeRuntime.waitUntil: https://supabase.com/docs/guides/functions/background-tasks

문서 확인일: 2026-09-23. 신규 기능의 실제 운영 설치나 모델 호출 성공을 뜻하지 않습니다.
