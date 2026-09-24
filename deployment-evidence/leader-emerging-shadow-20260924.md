# LE-SHADOW-1 배포 증거 — Top30 Leader/Emerging order-free SHADOW 1단계 (2026-09-24)

근거: `research/leader-emerging-shadow-20260924/README.md`(조건부 권장), 사전등록 `PREREGISTRATION.md`(첫 배포 전 커밋 `4c5ef90`).
브랜치 `claude/leader-emerging-shadow-deploy-y4wlsb` (감사 브랜치 `claude/top30-leader-emerging-shadow-pldnz4` 876d024 위에 fast-forward).

## 1. 결론

- **1단계만 배포.** 결정론적 스캔·lane·shortlist·`RULE_BASELINE`/`TAKE_ALL`·outcome·production 연결.
- **GPT ALT1 은 코드·테스트만 포함하고 `shadow_le.control.gpt_enabled=false` 로 배포.**
  - 운영자 입력 §0 두 항목이 비어 있어(`[YES / NO]`) NO 로 처리했다.
  - 함수 비밀 `OPENAI_API_KEY_SHADOW` 는 등록되지 않았다. 코드는 이 키만 읽으며, 없으면 GPT 를 호출하지 않는다(`SHADOW_KEY_MISSING`).
  - 2단계 GO 에는 G7(운영자 YES + 별도 키/프로젝트 예산), 1단계 12시간 무사고가 추가로 필요하다.
- production 진입·주문·포지션·GPT 판단·control·trading_settings·사이징(200 × 3)은 바꾸지 않았다.

## 2. 변경 목록

| 구분 | 내용 |
|---|---|
| 신규 함수 | `supabase/functions/leader-emerging-shadow/` — `index.ts`, `shadow.mjs`(scan/wait/outcome/diagnostic), `universe.mjs`, `select.mjs`, `features.mjs`, `guard.mjs`, `store.mjs`, `dbtarget.mjs`, `contract.mjs`, `prompt.mjs`, `gpt.mjs`, `wait.mjs`, `outcome.mjs`, `score-v2.mjs`, `alternative-score.mjs`(#182 V1 복사, 기록 전용) |
| import 한 production 순수 모듈 (수정 0) | `leader-momentum-v17.mjs`(+`leader-slot-sizing.mjs`), `leader-b06133-entry.mjs`, `gpt-final-review/contract.mjs`(v30FrontDecision), `gpt-final-decision/{market,facts}.mjs`(readSources/computeFacts/bookFacts), `leader-cec0040.mjs`(+`leader-exit-review.mjs`, replayP142Target) |
| migration (스키마) | `20260924094136_leader_emerging_shadow_schema.sql` — schema `shadow_le` 10 표, append-only 트리거 21, 전용 role `shadow_le_writer`, budget definer 함수, 관찰자 라벨·production 연결 함수, `v_arm_final`/`v_compare`, `portfolio_1slot` |
| migration (cron, 분리) | `20260924094844_leader_emerging_shadow_schedule.sql` — job 90 scan `1-59/5`, 91 wait(열린 WAIT 가 있을 때만, 분 mod 5 ∈ {1,2,3}), 92 outcome `12,27,42,57` |
| 테스트 | `tests/leader-emerging-shadow-{orderfree,db,logic}.test.mjs` + helpers (27개) |
| 문서 | `PREREGISTRATION.md`(+수정 1), `morning-check.sql`, 이 문서 |
| workflow | `gpt-final-review-release-20260923.yml` target 에 `leader-emerging-shadow` 추가(그 외 불변) |
| migration (shadow 전용 성능) | `20260924095434_leader_emerging_shadow_compare_index.sql` — v_compare/portfolio_1slot 의 outcome 조회를 색인 2회 조회로(출력 불변) |
| 함수 버전 | `leader-emerging-shadow` v1(09:43Z, release run 35982912902, source 00d08ec, bundle 23파일 digest `60a11bad…`, 22023 버그) → **v2**(09:47Z, run 35983308981, source 63d7623, digest `8ae24a30…`, 현재) |
| migration 적용 확인 | 세 migration 모두 `supabase_migrations.schema_migrations.statements` md5 = 파일 md5 (`5ce2e120…`, `5916d751…`, `cc9e743f…`) |

## 3. GO 조건 증거 (1단계)

| | 조건 | 증거 | 판정 |
|---|---|---|---|
| G1 | 변경 금지 목록 diff 0, executor/generator 번들 불변 | `git diff 3f3a839 HEAD -- v10-lane-executor v10-lane-signal-generator _shared/gpt-final-decision _shared/gpt-final-review _shared/leader-*.mjs v30-front-shadow` = 0줄. 배포 전후 `v10-lane-executor` v82 ezbr `74b8f2c0…9527`, `v10-lane-signal-generator` v26 `86c42357…59be`, `v30-front-shadow` v1 `3a29ca0e…43e0` 동일. release workflow 의 frozen-policy 단계 통과 | 통과 |
| G2 | order-free 정적 + allowlist | 번들(실제 배포 23파일과 동일한 import 그래프) 문자열 검사: `/v1/command`, `create_order`, `v11_cec0040_decide`, `gpt_final_review_claim`, `verifyExecutionLease`, `v19_`, `*ORDER_GATEWAY*`, `*GATEWAY_SHARED_SECRET`, service-role, `OPENAI_API_KEY`(≠`_SHADOW`) 부재; production 표 쓰기(supabase-js·SQL) 부재; store 의 모든 SQL 은 shadow_le 에만 쓰고 public 은 허용 8표 SELECT 만; allowlist 밖 18개 URL(주문·계정·listenKey·fapi1/2·서명·OpenAI chat 등) 전부 차단. 전체 스위트 296/296 | 통과 |
| G3 | 전용 role, production DDL 0, append-only | role: login, 비superuser, bypassrls(읽기용, production 정책 추가 없이), createrole/createdb 없음, noinherit, 멤버십 없음. production SELECT = 정확히 8표, production INSERT/UPDATE/DELETE/TRUNCATE 권한 0, shadow INSERT 7표, UPDATE/DELETE 0, `v11_cec0040_decide`/`gpt_final_review_claim` EXECUTE 없음, anon/authenticated/service_role 의 shadow_le 접근 0, production 표 트리거/정책 추가 0. 운영 DB 에서 owner 로 UPDATE/DELETE/TRUNCATE/control DELETE 시도 → 전부 `SHADOW_LE_APPEND_ONLY`(롤백된 DO 블록) | 통과 |
| G4 | universe weight 0, 사이클 ≤ 100, self-abort, 분 회피 | universe 는 관찰자 가격(weight 0). 가드: 사이클 cap 100, `x-mbx-used-weight-1m ≥ 1200` 즉시 중단, 418/429 당일 정지, 단일 호스트(테스트). 실측 사이클 weight 18 (아래 §4). cron 분: scan :x1/:x6, outcome :12/27/42/57, wait mod 5 ∈ {1,2,3} → :x0/:x4/:x5/:x9 없음 | 통과 (주: §6-2) |
| G5 | diagnostic(쓰기 0) top10 겹침 ≥ 80% | 09:44Z diagnostic: 15분 경계 13개(06:30~09:30Z), shadow top10 vs `v17_market_scan_runs` top10 **평균 97.7%, 최소 90%**, writes 0, weight 1, 연결 role `shadow_le_writer`(DIRECT) | 통과 |
| G6 | kill switch 2종 | (1) 09:45Z `control.enabled=false` → scan 응답 `DISABLED`, `written:false`, Binance 0, 복구 후 control_log 에 두 변경 기록. (2) 09:56:51Z `cron.alter_job(90, active:=false)` → 10:01 슬롯에 job 90 실행 기록 없음·SCAN 사이클 없음(같은 창의 job 91/92 는 정상 실행) → 10:01:55Z 재활성 → 10:06 사이클 정상 | 통과 |

2단계(G7~G10): G8 원장/stand-down 테스트, G9 ALT1 계약 테스트, G10 사전등록 커밋은 충족. **G7 미충족**(운영자 입력 없음·별도 키 없음) → GPT 비활성 유지.

## 4. 첫 사이클 (v2, 10:27Z 까지)

| cycle | 시각(관찰자) | source / age | universe | LEADER / EMERGING / CONTROL | shortlist | weight / 공유 IP used | 오류 |
|---|---|---|---|---|---|---|---|
| 2 (수동 검증) | 09:45:03 | observer / 148 s | 520 | 3 / 0 / 27 | NOMUSDT (LEADER, 배포일 이력 공백으로 "첫 진입") | 18 / 17 | 0 |
| 3 (cron) | 09:50:07 | observer / 54 s | 520 | 3 / 0 / 27 | 0 (Top3 모두 이미 본 종목) | 0 / – | 0 |
| 4 (cron) | 09:55:04 | observer / 56 s | 520 | 3 / 0 / 27 | 0 | 0 / – | 0 |
| (10:01 슬롯) | – | – | – | – | – | – | G6 cron 정지 시험 |
| 6 (cron) | 10:05:00 | observer / 63 s | 520 | 3 / **1** / 26 | COLLECTUSDT (EMERGING, 39 → 29위, 15분 +10) | 17 / 16 | 0 |
| 7, 9 | 10:10, 10:15 | observer / 62~64 s | 520 | 3 / 0 / 27 | 0 | 0 | 0 |
| 10 | 10:20:03 | observer / 105 s | 520 | 3 / 1 / 26 | AGTUSDT (EMERGING) | 17 / 16 | 0 |
| 11 | 10:25:48 | observer / 12 s | 520 | 3 / 1 / 26 | TUTUSDT (LEADER) | 17 / 16 | 0 |

- 첫 사이클 top30: NOMUSDT, NILUSDT, LSKUSDT, CYSUSDT, ARXUSDT, CVCUSDT, STARUSDT, B2USDT, LTCUSDT, PLUMEUSDT, TUTUSDT, CHRUSDT, TSTUSDT, BROCCOLI714USDT, VTHOUSDT, FOLKSUSDT, FFUSDT, ESPORTSUSDT, BTWUSDT, ALCHUSDT, ARKUSDT, STEEMUSDT, HANAUSDT, VELVETUSDT, CELRUSDT, EDENUSDT, BLESSUSDT, ETCUSDT, GIGGLEUSDT, COMPUSDT.
- 선정 4건 모두 micro_complete, HARD 차단 0. 측정 비용(600 USDT, bps): NOMUSDT spread 3.87 / 슬리피지 5.23 / 왕복 20.2, COLLECTUSDT 5.26 / 6.81 / 21.8,
  AGTUSDT 9.95 / 15.65 / 30.7 (`COST_EXCEEDS_EDGE`), TUTUSDT 3.39 / 7.73 / 22.7 (`VOLUME_OVERHEATED` → RULE_BASELINE SKIP).
- 결정: RULE_BASELINE BUY 3 / SKIP 1, TAKE_ALL BUY 4. GPT 0콜(`GPT_DISABLED`), shadow 원장 0.
- 10:15 사이클 velocity_valid=false 는 10:00 참조 사이클이 G6 시험으로 비어서다(설계대로).
- OUTCOME 사이클 3회(09:57, 10:12, 10:27) 정상. 첫 production 연결은 관측 후 45분(10:42~), 첫 정밀·관찰자 라벨은 4시간 후(13:50Z~)부터 생긴다.
- 최대 사이클 weight 18, 최대 공유 IP used-weight 17 (중단 기준 1,200).

## 5. production 영향 (10:27Z)

- production scanner `v17_market_scan_runs` 09:40~10:25Z 10회 전부 정상(525/525, 차단 0, `SHARED_IP_WEIGHT_HIGH` 0).
- executor: circuit 닫힘, `last_error` null, 매분 사이클 정상. 배포 후 정상 거래 1건(PLUMEUSDT 10:12Z, V17 → FD1 BUY → executor). shadow 는 같은 종목을 rank 6 CONTROL 로 관찰만 했다.
- FD1 PRODUCTION 배포 후 4콜, 오류 0, 429 0. `gpt_final_review_control` ENFORCE $3/300 불변(updated 09-23 14:02Z). 사이징 200 × 3 불변.
- **N1 감사**(`pg_stat_statements`, userid = shadow_le_writer): 22 문장 / 142 호출, shadow_le 밖 쓰기 0, public 함수 호출 0, DDL 0. 권한상 production 쓰기 0.
- N2 (418/429, SHARED_IP) 0, N3 (FD1 오류/quota 증가) 0, N4 (executor last_error) 0, N5 (micro_complete) 4/4 = 100%.

## 6. 배포 중 발견·수정

1. **v1 첫 scan 실패(09:45Z, 쓰기 0).** postgres.js 는 `$N::jsonb` 파라미터를 jsonb 로 describe 한 뒤 다시 `JSON.stringify` 한다.
   미리 직렬화한 문자열이 JSON 문자열 스칼라로 도착해 `jsonb_populate_record` 가 22023 으로 거부했다. PGlite 는 문자열을 그대로 넘겨 테스트가 못 잡았다.
   수정: 모든 JSON 파라미터를 `$N::text::jsonb` 로, 정적 테스트로 재발 방지, 오류 응답에 SQL 메시지 포함. v2 로 재배포(bundle parity 통과).
2. **수동 검증 호출 1회가 generator 분(09:45:04Z)에 나갔다.** 운영 실수다. 그 호출(v1)은 코드 순서상 첫 JSON 파라미터인 `day_anchor` 삽입에서 실패했으므로 Binance 요청은 그 직전의 `exchangeInfo` 1건(weight 1)뿐이다.
   production scanner 09:45 사이클은 09:45:04.188Z 에 이미 정상 종료(차단 없음, 525/525)해 영향이 없었다. 이후 수동 호출은 허용 분만 쓰도록 SQL 에서 분을 검사했다.
3. **배포일 이력 공백.** 당일 첫 Top3/Top10 판정은 shadow 자신의 이전 사이클에 의존하므로 배포일에는 부정확하다(NOMUSDT 가 "첫 진입"으로 선정).
   결과를 보기 전(성숙 outcome 0건)에 사전등록 수정 1 로 **판정 표본 시작 = 2026-09-25 KST 일**을 고정했다. 임계값은 바꾸지 않았다.

## 7. 롤백 / 정지

- 즉시(함수 수준): `update shadow_le.control set enabled=false, set_by='…', reason='…' where singleton;`
- cron: `select cron.unschedule('leader-emerging-shadow-scan'); select cron.unschedule('leader-emerging-shadow-wait'); select cron.unschedule('leader-emerging-shadow-outcome');`
- 권한: `alter role shadow_le_writer nologin;` (연결 자체 차단). 스키마·데이터는 append-only 로 남긴다.

## 8. 남은 위험과 다음 단계

- **공유 IP**: 관측된 `x-mbx-used-weight-1m` 은 16~17 로, edge 함수의 egress IP 가 production scanner 와 다를 수 있다. 가드는 IP 와 무관하게 1,200 에서 멈춘다.
- **관찰자 의존**: 관찰자가 6분 넘게 늦으면 ticker fallback(weight 2). 관찰자 자체가 멈추면 순위 이력이 끊겨 velocity 가 무효가 된다(cycles.source / observer_age_ms 로 감시).
- **라벨 적체 확인 필요**: 관찰자 라벨(8 사이클/15분)과 정밀 라벨(20건/15분)의 첫 실행은 13:50Z 이후다. 내일 오전 `morning-check.sql` V4 로 적체와 `data_complete` 를 확인한다.
- **production 연결**: 첫 FINAL 링크는 10:42Z 이후. PLUMEUSDT(10:12Z 진입)가 2군(CURRENT_BUY / 미선정) 첫 사례가 된다.
- **2단계**: G7(운영자 YES, `OPENAI_API_KEY_SHADOW` 를 별도 OpenAI project 와 월 한도로 등록, 조직 크레딧/자동충전 확인) + 1단계 12시간 무사고(가장 빠르면 2026-09-24 21:50Z 이후) 후
  `update shadow_le.control set gpt_enabled=true, set_by='…', reason='…' where singleton;` 한 줄로 켠다. 코드 재배포는 필요 없다.
- **표본**: 판정은 사전등록대로 ≥15 거래일 AND ≥300 EMERGING-BUY 이후. 첫 3시간 EMERGING 선정은 3건이었다(속도 ≈ 24건/일 수준이면 300건까지 수 주가 걸릴 수 있다 — 판정 일정에 반영, 임계값은 바꾸지 않는다).
