# Top 10 batch entry audit — 2026-09-28

> 이 문서는 최초 감사 당시의 기록이다. 이후 실환경 배포 상태·추가 실측·정합성 결과는 [10분 production 후속 보고서](RELEASE_20260928_10M.md)를 기준으로 한다.

**판정: 실거래 전환 금지.** 5분 묶음의 비용 기준과 판단 근거 품질 기준이 실패했다. 신규 전략·예산 migration·scheduler 변경은 production에 적용하지 않았다. 주문 없는 측정만 3회 수행했고 진단 Edge v2는 종료 상태(HTTP 410)다. 수동 주문은 0건이다.

**후속 요청 반영 — 기본 주기 10분:** 사용자의 10분 상시 Top 10 조회 지시에 따라 후보 코드와 DB 예약 간격을 600초로 변경했다. 한 주기에 10개 종목 전체를 한 요청으로 처리하며, 슬롯이 가득 차면 신규 진입 유료 리뷰를 멈추고 기본 캡처는 계속한다. 슬롯 해제·강한 증거 변화에 따른 즉시 재검토 예외는 유지한다. 아래 5분 측정·미통과 기록은 역사적 감사 증거로 보존한다. 10분 환산은 4,464요청/31일, DS 평균 $79.70, 최대 표본/cache 0 기준 $80.50이며 추가 보호·즉시 검토 여유는 $19.50–20.30이다. 의미적 근거 혼입과 새 경로 recall 미검증은 그대로이므로 실거래 활성화는 아직 하지 않았다.

## 1. 운영 기준과 후보 변경

- 최초 main `091edc5caee09eaf67e62f4ff2a17d9807a08e70`에서 시작했다. 작업 중 추가된 QNT 복구 관측 수정 `e104c14896d1fc5a5e2d1e8498e1e7f39e4e2066`를 fast-forward로 계승했다. QNT collector, gateway, ingest와 release request는 수정하지 않았다.
- 진행 중 작업과 열린 PR을 읽었다. PR #225는 이미 적용된 월 AI $95 + 저장 $5를 기록하는 변경이다. 이를 되돌리거나 별도 승인 예산으로 오인하지 않았다. 오래된 shadow·emergency PR은 배포에 사용하지 않았다.
- 적용 migration 548개, 마지막은 `20260927232129_leader20_monthly_100_ai_95_budget`. 배포 executor v136의 77개 파일을 main과 대조했으며 줄바꿈 정규화 후 일치했다. 운영 generator v35, ingest v5, evolution v16도 확인했다. [배포 해시와 원장 대조](evidence/20260928-production.json).
- Universe는 전체 적격 Binance perpetual 중 rolling 24h 상승률 Top 20을 6시간마다 갱신하고, 현재 watch_limit=10으로 Top 10을 관찰한다. 5분마다 순위를 재선정하는 구조가 아니다. 측정 당시 Top 10은 QNT, SOON, INX, W, BULLA, GRT, BTW, PUMP, NEAR, ONE USDT였다.
- 24개 연속 5초 버킷, 약 120초 경로를 요구한다. bucket_ms 간격 5000ms, 구간 길이 4000–6500ms, 시작/종료 연결, exchange/book/flow/received 시각의 인과성, 실제 book·flow·trade count, 모델 호출 시 10초 미만의 마지막 버킷을 검사한다. 장애를 0이나 가짜 버킷으로 채우지 않는다. QNT는 3회 측정 모두 24개가 유효했다.
- 기존 `leader20_schedule()`은 전역 30분 제한과 종목별 30분 변화 재검토/6시간 공정 재검토를 함께 적용한다. cron observer는 매분 호출되지만 이 제한을 우회하지 않는다. 기존 일정에는 실제 계정 잔여 슬롯에 따른 신규 AI 중단이 없다.
- 실제 ENTRY·RECHECK·HOLD 호출은 GPT FIRST와 DeepSeek advisory가 병렬로 시작한 뒤 GPT FINAL로 끝난다. HOLD의 PROTECT/EXIT가 청산 판단 경로다. 동적 경로에서 DeepSeek는 advisory이고 거래 최종 권한은 GPT다. hard stop·native protection·위험 제한은 AI 승인이나 예산에 의존하지 않는다.
- 계정 설정 상한 10슬롯, 한 슬롯 margin 150 USDT, sizing ceiling 151.25, leverage 3, 보수적 소요액 152.021375 + 계정 buffer 0.10이다. exchange 수동 포지션, DB OPEN, 미확정 OPEN_LONG, 당회차 fills의 symbol 합집합과 낮은 가용 증거금이 실제 용량을 결정한다. 미확정 주문은 PLANNED/DISPATCHED/RECONCILIATION_PENDING/RECONCILIATION_FAILED이고 v18ExposureFinal=true는 제외한다. 00:27:10 UTC snapshot은 잔액 331.34419204, 포지션 0으로 2슬롯에 해당한다. 00:31:54 UTC DB exposure와 unresolved orders도 각각 0이었다. 실주문 시에는 기존 executor가 live 계정을 다시 검사한다.
- 기존 ENFORCE 설정은 일 $3, 월 $95, 일 100 review jobs다. 무포지션 시 신규 진입 $2.50/83 jobs, 보호 $0.50; 노출이 있으면 보호 예산은 기존 함수에 따라 증가한다. 2026-09-27 일일 offset은 $14.0111288와 208 calls이며 월 누적액을 지우는 값이 아니다.
- 기존 parent journal의 api_cost_usd에는 GPT FIRST + DeepSeek + GPT FINAL 비용이 합산되지만 top-level usage는 FINAL 토큰이다. daily.reserved_usd는 정산액과 미정산 예약을 모두 포함한다. `ai_monthly_spend_used()`에는 evolution·shadow·FD1 관련 장부도 포함된다.

후보 구현은 [migration](../../supabase/migrations/20260928012054_leader20_batch_provider_ledger.sql), [batch](../../supabase/functions/_shared/leader20/batch.mjs), [runtime](../../supabase/functions/_shared/leader20/batch-runtime.mjs), [paid transport](../../supabase/functions/_shared/leader20/paid-transport.mjs), [GPT FINAL](../../supabase/functions/_shared/leader20/final.mjs)에 있다.

- 한 요청/공통 지침 1회/10개 ID. 각 종목의 원본 24개 버킷 34개 열을 행렬로 보존하고 시간은 정확한 offset으로 직렬화한다. 평균 대체나 숫자 반올림은 없다. 중복 ID, 누락, 버전 불일치, JSON 실패, 시각 역전, stale은 종목별 BLOCKED로 기록한다. 전체 JSON이 깨지면 전부 차단한다.
- 데이터 버전에서 요청 시각을 제외해 동일 capture 재과금을 막는다. SKIP은 영구 제외가 아니다. 최신 evidence의 가격·flow·imbalance 변화는 재검토 요청만 만들고 판단 통과율을 조작하지 않는다.
- batch PASS는 GPT FIRST를 거치지 않고 DeepSeek 근거와 최신 원본 24개 경로를 넣은 독립 GPT FINAL 한 번으로 간다. batch 신규 진입의 FINAL RECHECK는 이전 capture end보다 더 최신인 경로를 요구한다.
- DB 예약·owner CAS·단일 진행 batch·late-result fence·full-slot 중단·slot release wake를 추가했다. pg_net wake는 거래 변경 커밋 후 기존 observer를 호출하며 실패가 거래/보호 기록을 rollback하지 않는다. 일반 강한 변화는 현재 매분 observer에서 탐지하므로 최대 약 60초의 감지 지연이 남는다. QNT capture 경로에 새 trigger를 설치하지 않았다.
- 보유 종목은 entry batch에서 데이터 행렬을 제외하며 기존 보유 관리가 담당한다. Top 10 기본 캡처 및 native protection은 계속된다.
- provider limit은 DeepSeek 월 $100, GPT 월 $95로 **후보 테이블에만** 분리했다. 저장 $5 설정은 건드리지 않았다. 목적 ENTRY/RECHECK/HOLD/EXIT/VERIFICATION, model, 실제 usage/cache/latency와 보수적 비용 예약을 별도 기록한다. RECHECK도 신규 진입 지출로 계산해 보호 몫을 침범하지 않게 했다.
- dispatch 전 취소만 환급한다. 결과 불명은 UNKNOWN으로 예약을 유지하고 확정 usage를 받아 한 번만 정산한다. 새 parent는 reserved_usd=NULL로 legacy daily 중복 정산을 막고, 이전 진행 중 parent는 기존 정산 경로를 유지한다. 호출 거부에는 API_BUDGET_EXHAUSTED와 추가 필요액을 남긴다.
- 기존 비용을 복사하거나 reset하지 않고 읽기 시 제공자를 배분한다. 확인 불가능한 legacy 비용은 OpenAI/unknown 쪽에 보수적으로 유지한다. 00:31:54 UTC 대조: 기존 $40.225351716 = 식별된 DS $1.575929936 + OpenAI/unknown $38.649421780. 합계 차이 0. 과거 미정산 예약을 지우지 않았다.
- rolling 24h 기반 `ai_provider_budget_status()`가 월 누적, 잔액, 31일 환산, 소진까지 일수, 미정산액을 산출한다. 다른 legacy 장부는 월 합계에는 포함되며 24h review rate에는 포함되지 않는다는 한계를 출력한다.
- 기본 enabled=false이며 budget/recall/concurrency/protection 검증 영수증이 없으면 batch 활성화 CHECK를 통과하지 못한다. 이 PR에는 활성화 영수증이 없다.

## 2. 재생·검증 결과

[재생 결과와 표본별 job key](evidence/20260928-replay.json), [최근 production 리뷰 통계](evidence/20260928-review-statistics.json).

- 운영 측정 3요청 × 10종목 = 30평가. 응답 ID/버전/시각 30/30 대응, HTTP 및 JSON 3/3 완료. 720개 버킷과 시간 offset 왕복 재생이 정확히 일치했다. 판단은 PASS 6, WAIT 19, SKIP 5.
- **의미 검증 실패:** 세 번째 SOON 설명의 순매수 +160,508은 실제 SOON 마지막 값 -8,289.8938과 다르다. +160,508.597은 NEAR의 마지막 값이다. ID가 맞아도 종목 간 근거가 섞였다. 따라서 30/30 형식 통과를 판단 품질 통과로 간주하지 않는다.
- 최근 3일 조회 594 rows 중 production 485. 양 모델 모두 유효한 ENTRY 93건에서 GPT BUY 48건, 그중 DS SKIP 13건(27.08%). 무조건 SKIP veto를 적용했을 때의 역사적 누락 반례다. 13개 원본 decision-time packet 중 10개가 현행 24버킷 안전 검사를 통과했고 3개는 당시 저장된 unavailable 경로다.
- 위 27.08%는 **새 Top 10 prompt의 recall도, 실제 수익 기회 누락률도 아니다.** 같은 시점의 완전한 역사적 Top 10 묶음과 새 모델/GPT 비교 재생이 아직 없으므로 새 경로의 후보 포착 품질은 미검증이다.
- Node 회귀 1,444건 통과; Deno 1,055건 + 13 steps 통과; executor/generator/audit Deno type check 통과. SQL은 격리된 PGlite PostgreSQL에서 실행했다. gap/stale/역전, 부분 누락·중복 ID, transport 실패, budget refusal, cache 정산, UNKNOWN 유지, 동일 capture dedup, 5분/30분 분리, slot 0→1/1→0, late answer 차단, parent 중복 차감 방지를 검증했다.
- 기존 ENTRY, RECHECK, HOLD, EXIT, native protection 회귀도 포함했다. **실제 다중 PostgreSQL session 경합, 거래소 미확정 주문과의 동시 경합, production 0→1/1→0 전환은 검증하지 않았다.** 무포지션 운영 상태를 임의 주문으로 바꾸지 않았다.

재현: Node 24, Deno 2.5.6, @electric-sql/pglite 0.3.14. `PGLITE_MODULE`을 지정해 `node ops/dynamic-flow/run-tests.mjs`, `deno task test`를 실행한다. 원본 내보내기 파일은 로컬 작업 폴더의 `../evidence`에 있으며 `node ops/leader20/replay-batch-audit.mjs ../evidence ../evidence/replay-results.json`로 무료 재생한다. 이 스크립트는 모델과 주문을 호출하지 않는다.

## 3. 제공자별 비용과 31일 환산

금액은 **실제 응답 usage × 명시된 요금**이다. DeepSeek는 cache를 반영한 피크 요금 상한이며 청구서 실결제액이 아니다. 측정 시각의 할인이나 장래 cache hit를 보장하지 않는다. [DeepSeek 공식 요금](https://api-docs.deepseek.com/quick_start/pricing/): input cache miss $0.30/M, hit $0.006/M, output $1.20/M. GPT는 운영 코드에 고정된 gpt-5.4-mini-2026-03-17 $0.75/$0.075/$4.50/M을 사용했다.

| 실측 표본 | 평균 입력 / 출력 | 평균 비용 | 표본 p95 비용 | 지연 평균 / p95 |
| --- | ---: | ---: | ---: | ---: |
| 신규 DS Top 10 묶음, n=3 | 55,018 / 1,145 | $0.0178543 | $0.0179948 | 6.355 / 6.872초 |
| 최근 운영 DS advisory, usage n=200 | 15,765.6 / 563.6 | $0.0048357 | $0.0081683 | 전체 242 rows: 3.401 / 4.982초 |
| 운영 GPT FIRST, usage n=230 | 20,445.3 / 208.4 | $0.0162139 | $0.0385388 | 2.218 / 4.160초 |
| 운영 GPT FINAL 전체, usage n=436 | 24,320.6 / 385.8 | $0.0198992 | $0.0521085 | 4.963 / 9.891초 |
| 가장 최근 UTC 일자의 ENTRY FINAL, n=80 | 상세 JSON 참조 | $0.0320767 | $0.0522405 | 상세 JSON 참조 |

p95는 표본 분위수다. 특히 n=3의 p95는 사실상 최대 관측값이며 안정적인 장기 분포 추정이 아니다. 기존 DS 유효 144/242, FIRST 유효 224/242, FINAL은 usage가 있는 표본에서 유효 409/436이다. 오류·미정산 토큰을 0비용으로 간주하지 않았다.

- DS 3회 원장 비용 합계 $0.053562936. 31일/5분 8,928요청이면 **$159.40**, cache 0 및 최대 표본을 쓰면 **$160.99**. $100 대비 $59.40–60.99 초과이며 보유/즉시 재검토 비용은 별도다. 목표 $0.0084/묶음·입력 약 20,000은 달성하지 못했다.
- 비용만 보면 10분은 평균 $79.70/31일, 최대 표본·cache 0 기준 $80.50이며 약 $19.50–20.30가 남는다. 보수적 20% 여유를 확실히 남기는 정수 분 단위는 11분(평균 약 $72.46)이다. **품질 실패 때문에 10분/11분도 배포 승인을 의미하지 않는다.**
- 5분을 유지하면서 $20의 보호/즉시 검토 여유를 남기려면 DS 약 $179.40–180.99/월, 즉 현재 $100보다 약 $79.40–80.99 추가가 필요하다. 실제 보유 리뷰 수가 늘면 더 필요할 수 있다.
- 최근 GPT FINAL 평균 $0.0320767 기준 $2.50는 약 77.9회/일, 2,880 종목의 2.71%에 해당한다. FINAL RECHECK가 같은 진입 예산을 소비하므로 실제 신규 후보 수는 이보다 낮다. 이는 경고선이며 모델 통과율 목표로 사용하지 않았다.
- 이번 극소 표본 PASS 6/30=20%가 반복된다는 **가정 시나리오**는 576 FINAL/일, $18.48/일, 약 $572.76/31일이다. entry allowance $77.50/31일보다 약 $495.26 크며 RECHECK/보호 비용도 빠져 있다. 이는 월간 예측이 아니다. audit이므로 SOON/W/GRT/BTW/NEAR/ONE PASS 6개를 실제 GPT나 주문으로 보내지 않았다.
- 보유 0일 때 GPT 진입 $2.50/일 + 보호 $0.50/일 = $93/31일로 월 $95 안이다. 노출 증가 시 기존 보호 비율을 계승하므로 신규 진입 allowance가 더 줄어든다.
- 구 운영 경로의 가장 최근 UTC 일자 production 알려진 usage 속도는 GPT FIRST+FINAL $6.84234, DS $0.557743, 각각 단순 31일 환산 $212.11/$17.29다. GPT FIRST 10, DS 19, FINAL 17회의 attempted 기록에는 usage가 없어 추가 비용이 불명이다. 이 기간 중 운영 설정이 바뀌었으므로 이 숫자를 새 정책 전망으로 사용하면 안 된다.

## 4. 실제 배포와 artifact

- 후보 trading migration, scheduler, executor, generator는 **미배포**. DS $100/GPT $95 분리 한도도 아직 production에서 활성화되지 않았다. production에는 기존 mixed AI $95 + 저장 $5 정책이 남는다.
- `leader20-batch-audit` v1만 내부 토큰 인증으로 배포해 원장 예약 후 order-free 측정 3회 실시했다. 측정 요청을 예약한 기존 journal에 provider/model/usage/cache와 보수적 비용을 저장했으며 별도 신규 ledger로 복제하지 않았다.
- 측정 종료 후 v2 `3fbc616e932ccf64c8e21baca1b5ccd6b560a043c394eb0ff070dd8d56ba3107`로 닫았다. 인증된 확인 요청에도 HTTP 410/AUDIT_CLOSED/orders=0을 반환한다. cron이나 주문 권한을 연결하지 않았다.
- 변경과 테스트, 이 보고서 및 aggregate evidence는 draft PR에 보존한다. 배포 workflow trigger 파일은 수정하지 않았다.

## 5. Production 확인 시각

**2026-09-28 09:37:03 KST / 00:37:03 UTC.** executor v136, generator v35, ingest v5, evolution v16 및 마지막 migration이 최초 감사와 동일하다. audit v2의 종료 응답을 실제 확인했다. 측정 3회의 as-of는 09:18:24, 09:20:26, 09:21:10 KST이며 각 요청은 Top 10 전체를 포함했다.

## 6. 미통과 기준과 남은 위험

1. 5분 상시 운용의 DS 예산 증명이 실패했다: 55k 입력, $159.40–160.99 피크 환산으로 한도 초과.
2. 종목 간 판단 근거 혼입이 실제 응답에서 발생했다. ID·버전·시각 검증은 의미 정확성 검증을 대체하지 못한다.
3. 역사적 SKIP→BUY 반례 13건이 있고 새 prompt의 동일 시점 Top 10 recall은 미검증이다. 통과율 임계값으로 비용을 맞추지 않았다.
4. 새 단일 GPT FINAL 경로의 실제 토큰/비용은 아직 측정하지 않았다. 표의 GPT 비용은 운영 기존 FINAL 실측이다.
5. 다중 session 슬롯/주문 경합과 live 전환, 다른 legacy AI 장부와 새 예약의 동시 월 한도 경합은 production 검증이 남았다. SQL 테스트만으로 해당 gate를 통과했다고 표시하지 않는다.
6. 과거 미정산액의 제공자·실청구액을 완전히 복원할 수 없어 OpenAI/unknown으로 보수적으로 보유한다. UNKNOWN을 근거 없이 환급하면 안 된다.
7. 새 capture 데이터가 들어올 때의 강한 변화 감지는 현재 observer 최대 약 60초 지연이 있다. 샘플 3회만으로 월간 비용 분포나 품질을 보장할 수 없다.

따라서 release_receipt를 채우거나 enabled를 켜지 않는다. 필요한 다음 검증은 근거의 종목/버킷 일치 검증, 동일 시점 역사 Top 10/GPT paired replay, 충분한 시간대별 비용 표본과 실제 PostgreSQL 다중 session 경합 검증이다.
