# Self-Evolution production receipt — 2026-09-27 KST

**PRODUCTION FUNCTIONAL, PROFITABILITY UNKNOWN.** 연구·검증·정책 적용 경로를 배포했다. 최초 challenger는 검증 조건을 통과하지 못했으며 실거래 승격은 0건이다. 21일 forward 검증, 실제 승격 이후 수익성 및 rollback의 실거래 효과는 아직 관찰되지 않았다.

## 기준선과 배포

최초 감사 main은 `bcdc3b2e2911817aad9dc1888b006f9dbdd454c1`, executor v101이었다. 작업 중 PR192–197 및 production v104/v105 변경을 다시 읽고 계승했다. 배포 직전 v105의 전체 소스와 비교해 runtime에서 바뀐 기존 파일은 `gpt-final-decision/dual.mjs`, `advisory.mjs` 두 개다. 새 policy/runtime 의존성을 추가했다. production-only emergency validation 및 native-stop ratchet 수정도 main에 보존했다.

| 항목 | 확인값 |
|---|---|
| 직전 executor | v105 / `f55a69d782600c41bd75b07b5af277baea896a397d9ad0b1a032bed3ef26adce` |
| 배포 executor | v106 / `b91fa4076e9a286918dd4521f7c4138b10e3872e3f992e346e86652f3baaea48` |
| executor 배포 시각 | 2026-09-26 17:32:55 UTC |
| 연구 worker | self-evolution-worker v6 / `96dffb22a4a54286a0a5284da349965d077cd4ae70b781afeaf8eb6f8ad08ea3` |
| worker 배포 시각 | 2026-09-26 18:02:00 UTC |
| 핵심 merge | PR198 / `8203036ce018c1bf6aede5fe21bfc21321b8d1fa` |
| 후속 보정 | PR200: 정확한 근거 ID, SQL 범위 검사, 원자적 후보 등록·복구 |
| active champion | `POLICY_BASELINE_V105` |
| policy SHA256 | `13edf14e2243fb492a5e6321746136095d8cb361674a24a5187acfbf9ec59ff9` |
| replay 보호 코드 SHA256 | `b8307e6b59be9154d8b798dde23390f643690959d49a379850cc557bdd9b4ef8` |
| 정기 실행 | `self-evolution-research-minute`, 매분, ACTIVE |

승인된 v104 보호 예외를 유지한다. 거래소 상주 profit protection 및 GPT 장애 시 검증된 DeepSeek 긴급 보호 경로는 고정 코드이며 자가개선 대상이 아니다. 일반 전략 판단은 GPT FIRST·DeepSeek 독립 병렬 판단 후 최신 데이터로 GPT FINAL이 결재한다.

## 요청 항목별 결과

| # | 항목 | 결과와 한계 |
|---|---|---|
| 1 | 작업 전 production | 매 배포 전 source bundle·main·migration·포지션·config 재조회. v105를 최종 기준으로 사용. |
| 2 | 계승 기능 | continuous capture, 120s trajectory, BTC sensor, FINAL RECHECK, HOLD/PROTECT/EXIT, IOC, partial reconciliation, CEC0040/B06133/V30, native protection 유지. |
| 3 | 구조 | 별도 research worker → 복기 → 패턴 → 가설 → immutable candidate → replay → quantitative/scope gate → atomic pointer → monitor/rollback. |
| 4 | GPT realtime | FIRST 독립 판단 및 FINAL 전략 결재. 기존 모델 `gpt-5.4-mini-2026-03-17`. |
| 5 | DeepSeek realtime | `deepseek-flash` 독립 의견. 승인된 긴급 보호 예외 외 일반 주문 권한 없음. |
| 6 | 병렬성 | 동일 frozen input으로 Promise.all; 상대 모델의 첫 답변은 최초 입력에 포함하지 않음. |
| 7 | synthesis | GPT FINAL에 두 의견, 최신 refresh, policy 해석과 causal calibration 전달. |
| 8 | journal | 실제 production journal을 비동기 복사. policy/hash/model/input/first/advisory/final 및 position generation을 추적. |
| 9 | trajectory | 기존 60s 호환 유지. v3 24×5초를 보존하고 연구용 causal archive 추가. |
| 10 | post-trade review | 실제 체결·가격 경로·비용·결측 counterfactual을 입력으로 GPT/DeepSeek 각각 복기. |
| 11 | cross critique | 독립 복기 이후 양방향 비평을 병렬 실행. 최초 3건 모두 두 모델 및 비평 2개 저장. |
| 12 | 성공 패턴 | +30.85729065 USDT 거래 포함. winner continuation과 premature exit를 복기. 소표본 패턴은 검증된 규칙이 아님. |
| 13 | 실패 패턴 | -5.76626060, -5.58766617 USDT 거래 포함. 구조화 taxonomy 및 반대 사례 참조. |
| 14 | calibration | regime·stage·provider별 표본 수와 Wilson 구간. 정확한 이후 관측이 없으면 null; 20건 미만은 realtime에서 제외. 최초 유효 calibration은 아직 없음. |
| 15 | 가설 | `HYP_20260926_ac7c83b200a8`: 추세 지속 근거와 flow 약화 근거의 비대칭 해석을 검증하는 RECHECK 가설. |
| 16 | Binance universe | 실제 scanner를 통해 525/525 USDT perpetual 평가·roster/관측 저장. 거래했던 symbol만 사용하지 않음. 전체 수익성 replay가 완료됐다는 뜻은 아님. |
| 17 | walk-forward | 후보 고정 이후 14일 validation. discovery와 겹치지 않는 데이터 및 기존 scanner 기회 사용. |
| 18 | holdout | 이후 7일 별도 holdout, 만료 전 성과 공개/승격 불가. 최초 검증은 아직 미성숙. |
| 19 | baseline | V104 원본은 immutable history에 남김. V105 보호 코드와 빈 해석 rubric을 operator baseline으로 동결. |
| 20 | challenger | `POLICY_20260926_f6be6ff8f8b50d7d` 실제 생성·동결·등록. |
| 21 | 시험 결과 | 첫 EPICUSDT 비교: champion SKIP, challenger SKIP, 양쪽 오류 없음. 닫힌 portfolio lifecycle 결과는 아직 0건. |
| 22 | active champion | 계속 `POLICY_BASELINE_V105`. 새 후보는 VALIDATING. |
| 23 | promotion | JS+SQL gate 및 CAS pointer. qualification false인 후보는 전환 불가. 실제 신규 champion 승격은 0건. |
| 24 | rollback | policy 무결성/오류율/손실 꼬리·drawdown 악화/health deadline으로 previous champion 복귀. DB 통합 테스트 통과. 실거래에서 신규 champion rollback은 아직 발생하지 않음. |
| 25 | scope | exact object schema·stage/model/feature allowlist·금지 권한 검사. SQL 독립 재검사. AI 생성 코드 실행 없음. |
| 26 | immutable config | 실조회 margin 150 USDT, leverage 3, MAX_SLOTS 10, dynamic cash capacity 유지. 실제 잔고 332.01243023 USDT는 연구 비교 입력으로만 사용. |
| 27 | production deploy | executor v106, worker v6 ACTIVE. 실제 번들 source 검증. |
| 28 | migrations | 아래 5개 additive migration 적용. trading history 삭제/수정 없음. |
| 29 | main | PR198 merge; PR200 후속 보정. |
| 30 | artifact | 위 버전/hash. Bundler가 사용하지 않는 연구 모듈은 executor 결과물에서 제외하며, 반환된 모든 소스는 배포 입력과 일치. |
| 31 | DB evidence | 17:46 UTC 기준 journal 375, micro archive 12,762, review 3, outcome 16, pattern 33, hypothesis 1, paired simulation 1. |
| 32 | log evidence | function_logs의 TRADE_REVIEW DONE, MARKET_SCAN 525/525 DONE, MONITOR ACTIVE_CHAMPION 및 SIMULATE DONE을 확인. |
| 33 | 현재 연구 | light backfill, 6시간 패턴·24시간 full review, hourly replay, daily validation, 5분 monitor가 durable queue로 작동. 실패는 bounded retry. |
| 34 | 다음 자동 연구 | 동일 후보의 추가 미관측 데이터 비교와 holdout 검증. gate 미달 시 유지/기각, rollback 시 실패 복기 큐 자동 생성. |

## 실제 production 증거

주문 없는 QUSDT probe(`SELF_EVOLUTION_V106_AUTHORITY_PROBE`, HTTP request 4618): `ok=true`, `orderCalls=0`, `identicalPacket=true`, GPT FINAL `HOLD`, `authority=GPT_FINAL_ONLY`, `policy_source=ACTIVE_POINTER`, `refresh_error=null`.

- initial capture hash: `bcab4261d94a608243b4903b2d5574a655b116292731431717fced99de5affcd`
- refreshed capture hash: `8b2b9f72aa68c8968c4d668649905d9b14f932f3f88dd197300303e91fb4975f`
- 실제 PRODUCTION MARSCOINUSDT ENTRY journal `340bed5391d1f249015fb0ee4f4f7267b4f408c37fd7e210fb9cf271eb56402a`: V105 policy hash, valid GPT FINAL BUY, DeepSeek valid. 이는 주문 체결 증명과 별개다.
- QUSDT/SPELLUSDT/JELLYJELLYUSDT/WLDUSDT: `CAPTURE-CONTEXT-3-TRAJECTORY-120S`, AVAILABLE, 24 buckets, trajectory length 24. 기존 v2 RPC도 12 buckets AVAILABLE.
- preflight HTTP request 4793: sizing 150 USDT × 3, MAX_SLOTS 10, available-capital capacity 2, OPEN 0, external positions 0, circuit false, protection FLAT, last_error null.
- capture worker `DOA-CAPTURE-6-MARKET-SENSOR`, enabled/production_enabled/gpt_context_enabled=true. 17:47 UTC watched 34. OPEN priority 구조 유지; 검증 시 OPEN 포지션은 없었음.
- 실거래 복기 ID: `3c430b0c-4f26-4179-b116-63597eafaa64`, `889a8c9c-c349-424a-b2d4-ef3555ba0648`, `a8898cb7-298a-4fa5-b011-6244f77b7802`.
- 평가 `EVAL_POLICY_20260926_f6be6ff8f8b50d7d_20722`: qualified=false. HOLDOUT_NOT_MATURE, SAMPLE, ACTUAL_TRADE_REPLAY, EXECUTION_PARITY, LIFECYCLE_COVERAGE 등 미충족을 기록. 결과를 맞추기 위한 강제 승격 없음.

## Migration 및 테스트

실제 적용 버전으로 저장소 파일명을 맞췄다. 재실행으로 같은 schema가 중복 생성되는 것을 피한다.

| Production migration | 용도 |
|---|---|
| 20260926171719_autonomous_decision_evolution | 연구 tables/RLS, queue, scope, causal archive, promotion/rollback |
| 20260926171806_autonomous_evolution_activation | 기준 정책, worker token, scheduler |
| 20260926173042_evolution_v105_baseline | 승인된 v105 보호 코드 기준선 동결, 자금 설정 변경 없음 |
| 20260926174101_evolution_scope_and_recovery | 단어 경계 scope 검사, 후보 원자적 등록·복구 |
| 20260926180102_evolution_replay_receipt_cutoff | historical cutoff 기준 freshness, 수신 완료 frame만 선택 |

최종 관련 회귀 574/574 및 Deno check 통과. 연구 전용 테스트는 37/37. GitHub CI도 실행했다. 권한 위반, provider timeout, 최초 판단 독립성, 미래 데이터/결측, hard/soft exit, fill 지연 중 자금 사용 금지, SQL null 우회, immutable history, queue fencing, atomic switch, rollback을 검증했다.

## 남은 관측 한계

신규 후보의 완성된 14+7일 out-of-sample portfolio, holdout, live promotion/rollback, forward PnL·tail loss·winner retention 개선은 아직 증명되지 않았다. 과거 1분봉에서 없는 초 단위 호가를 재구성하지 않는다. 결측·partial-fill·execution estimate는 gate에서 불리하게 반영한다. API withdrawal permission 자체는 변경하거나 검증하지 않았으며 연구 코드에는 해당 호출 경로가 없다. 모델 weight를 재학습하는 시스템이 아니라 검증된 prompt·해석·calibration policy를 자동 교체하는 시스템이다.

운영 조회: service-only `select public.evolution_report();`. 실제 자금·계좌·안전 설정은 자가진화 범위 밖이며, 후보 policy가 runtime source를 수정하거나 배포할 수 없다.

## 최종 causal replay 확인 — 18:05 UTC

연구 archive RPC의 freshness 비교가 현재 시계에 묶여 과거 packet을 거부하던 문제를 수정했다. 수신 시각이 cutoff 이하인 frame만 먼저 선택한 뒤 최근 25개에서 24개 trajectory를 만든다. 미래 event sentinel, 누락·gap·stale 검증은 유지했다. 실시간 capture RPC는 변경하지 않았다. PostgreSQL microsecond 수신 시각은 millisecond로 올림하고, 재시작 cursor는 1ms 겹쳐 조회한 뒤 event ID로 중복 제거한다.

- QUSDT/SPELLUSDT/JELLYJELLYUSDT/WLDUSDT: 2분 전 cutoff에서 AVAILABLE, 24 points, 실제 coverage 120,065ms, 모든 수신 시각이 cutoff 이하. BTC market sensor도 후속 동일 방식 조회에서 AVAILABLE. 유효하지 않은 bucket이 들어간 구간은 그대로 UNAVAILABLE 처리한다.
- 연구 job 24724 DONE: champion/challenger 각각 709개 관측, missing 0, open 0, 완료 거래 0. paired API 비교는 총 3개. 거래 없음은 성과 개선으로 인정하지 않는다.
- Worker v6의 반환 source 36개가 배포 입력과 모두 일치했다. Executor는 v106 및 기존 hash 그대로다.
- 동시 merge PR201의 보호 강화 코드는 그대로 계승하며 이번 변경은 연구 worker·archive·테스트에만 한정한다.
