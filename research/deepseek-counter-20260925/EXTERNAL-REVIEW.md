# 외부 리뷰 검증 — 2026-09-25

리뷰 기준 c2fd61e, 수정 기준 main c66c339. 실행기 소스와 운영 v89 배포는 이번 수정에서 변경하지 않는다. OOS 이전 counter authority=[] 원칙과 사후 튜닝 금지를 유지한다.

| 항목 | 판단 | 직접 확인한 근거와 조치 |
|---|---|---|
| 1a 공동 완료 시각이 GPT 결정 무효화 | 동의 | 실제 시계 200ms 재현에서 202ms 후 BUY→ABSTAIN/COUNTER_STALE. GPT의 관측 완료·보고 완료 시각으로만 신선도를 판단하도록 수정했다. |
| 1b counter 대기가 GPT 반환 지연 | 동의 | parallelReview는 GPT 완료 시 반환한다. startParallelReview는 baseline/counter promise를 분리하며, collectParallelReview만 오프라인 진단용으로 둘을 기다린다. |
| 1c 고정 시계 테스트의 사각지대 | 동의 | 실제 시계 ENTRY/HOLD/RECHECK 회귀, 진행 mock 시계, 늦은·미래·실패·미응답 GPT 테스트를 추가했다. |
| 1d 4s/8s와 실행 예약 | 확인·보완 | HOLD/ENTRY 8s, RECHECK 4s. 호출 상한·스냅샷 만료·기존 deadline·trigger 만료−3000ms 중 가장 이른 시각을 적용한다. 기존 실행기/RECHECK 구현은 수정하지 않았다. |
| 2 Pro 실시간 부적합 | 부분동의 | 원자료에서 122/122 timeout, 별도 진단 27/27 timeout 확인. 122건 모두 8초였다는 표현은 부정확하다: RECHECK 27건은 4초, ENTRY 76+HOLD 19건은 8초다. 현 제한에서 부적합하며 무제한 지연이나 전체 용도는 평가할 수 없다. 연구 후보로 명시하고 실시간 후보 목록에서 제외했다. |
| 3 RECHECK 효과 미입증 | 동의 | 결과가 있는 25건 중 GPT BUY 4건, Flash SUPPORT 조건 통과 1건 ONDO −11.7 proxy. XAI +90.8938, SAGA +34.7954 proxy는 OPPOSE였다. 실현 손익·OOS 자료가 아니다. |
| 3 Temporal 효과와 노이즈 | 부분동의 | +0.933739는 이력 없는 PENGU 한 건. invalid 2→6, 유효 쌍 불일치 1/36 대 15/75를 재집계했다. A와 이력 없는 B도 프롬프트 구조가 다르므로 이것만으로 노이즈가 주원인이라고 단정할 수 없다. |
| 3 결정성 설정 | 부분동의 | 연구용 A/A·B/B에서 temperature=0을 명시한다. 결정성을 보장하지 않으며 새 조건은 과거 실험과 별도 버전이다. 공식 Chat Completions 문서에는 seed가 없어 임의로 전송하지 않는다. 기본 callCounter 호출의 샘플링은 바꾸지 않는다. |
| 4 main 직접 커밋·CI 누락 | 동의 | 지목된 4개 커밋의 [skip ci]를 GitHub에서 확인했다. 기존 관련 workflow는 main의 이 경로를 자동 테스트하지 않았다. 배포·비밀키·주문 권한이 없는 main/PR 연구 CI를 추가하고 skip 지시 없이 실행한다. |

## 데이터와 검증

`node research/deepseek-counter-20260925/review-evidence.mjs`는 원본 replay·diagnostic·outcome·temporal 결과와 label 파일을 읽어 재집계한다. [review-evidence.json](review-evidence.json)에 입력 SHA-256과 결과를 기록했다. 기존 raw 데이터·라벨·분할·수익 정책·historical prompt는 변경하지 않았다. Temporal raw 자료는 기존 로컬/비공개 연구 저장소에 있으므로 공개 체크아웃만으로 그 부분을 재계산할 수는 없다.

로컬 통합 검증: 129 tests passed, 0 failed. HOLD/최종 RECHECK 기존 회귀도 포함했다. 수정 SHA acf540d의 [연구 CI](https://github.com/sanbital/Trading-booooo/actions/runs/36129279625)와 [Workflow Lint](https://github.com/sanbital/Trading-booooo/actions/runs/36129279634)가 모두 success였다. 후속 트리거 수정 커밋에서도 같은 두 검사를 실행한다.

### 자동 배포 부작용 및 재발 방지

main push의 기존 `deploy-market-autotrader-v707.yml`은 `_shared/**` 전체를 대상으로 했다. 사전 점검에서 이 경로를 놓쳐 acf540d가 [기존 배포 workflow](https://github.com/sanbital/Trading-booooo/actions/runs/36129279584)를 함께 실행했다. 중단 시도 전에 11:26 UTC에 완료되었다. 이는 요청한 연구-only 범위를 벗어난 부작용이며 의도한 배포로 취급하지 않는다.

market-autotrader v448, market-regime-observer v90, market-v2-signal v81, market-scanner v418이 재배포되었다. 해당 함수 소스는 이번 커밋에서 수정하지 않았지만, 재배포 전 네 함수의 번들을 보관하지 않았으므로 이전 운영 번들과 byte-identical했다고 주장하지 않는다. 임의로 추정한 버전으로 되돌리지 않았다.

v10-lane-executor는 v89, SHA-256 ae8742095256da88ceef4f0e337f2df9c4954229a760ae66b76bb2b7ea5dd152 그대로이며 해당 소스도 바뀌지 않았다. 재발 방지를 위해 기존 배포 workflow의 push/PR 경로에서 `gpt-final-decision/**`을 제외했다. 이 모듈들은 별도 FD1 릴리스 경로의 대상이다. 후속 커밋은 비밀키 없는 연구 CI와 lint로 검증한다.

## A/A·B/B 계획 — 구현 완료, API 실험 미실행

`noise-control.mjs`는 고정 4회 A1/B1/B2/A2 호출로 입력을 동일하게 유지한 A/A 및 B/B 재현성 대조군을 만든다. `temperature=0`, Flash/non-thinking, 8초 제한, 결과를 입력으로 넣지 않는 조건을 고정했다. 사용자가 요청한 것은 평가·수정이며 이번 작업에서 새 유료 표본을 수집하지 않았다.

다음 실험은 기존 119개 개발 패킷 전체를 사용하고 결과에 따라 선별하지 않는다. 사전 기록 후 위치별로 묶어 AA/BB 불일치, invalid 비율, AB 차이, 비용·지연을 함께 보고한다. 종목/시점 묶음과 이력 유무가 교란될 수 있으므로 과거 1/36 대 15/75를 인과 효과로 해석하지 않는다. 통계적 이득이 보여도 개발 진단이며 OOS 승격 근거로 재사용하지 않는다.

## 남은 실매매 권한 연결 선행조건

1. 새 입력 버전과 샘플링 설정, 표본·평가 규칙·예산을 사전 고정하고 A/A·B/B로 노이즈와 프롬프트 구조 차이를 구분한다.
2. 이미 본 표본을 제외한 시간순 TRAIN/VALIDATION/미접촉 TEST를 확보하고 OOS에서 손실 억제와 승자 보존을 함께 검증한다.
3. 실제 손절·이익 보호 갱신, 부분 체결, 수수료·슬리피지, AI 비용, 지연·슬롯 경쟁을 포함한 실행 재현을 완성한다.
4. task별 정책과 불일치·기권·실패 처리 규칙을 사전 고정한다. 임의 confidence 임계값이나 본 표본의 수익에 맞춘 규칙은 금지한다.
5. 사용할 때 다시 만료·현재 호가·3000ms 예약분·최종 실행 가드를 확인한다. baseline promise와 background counter 수명·취소·예산·저장 실패를 검증한 후 별도 통합 리뷰를 한다.
6. 배포·권한 부여는 그때 별도 검토한다. 현재 v89의 관찰 기록 기능은 거래 권한을 뜻하지 않으며, 이번 패치를 운영에 배포하지 않는다.

공식 API 확인: https://api-docs.deepseek.com/api/create-chat-completion/ — temperature는 non-thinking에서 사용 가능하고 thinking에는 효과가 없다. seed는 문서화된 요청 필드가 아니다.
