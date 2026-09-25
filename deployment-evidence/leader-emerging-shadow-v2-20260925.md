# LE-SHADOW-2 배포 증거 — SHADOW V2 (DISCOVERY + PARITY), 2026-09-25

브랜치 `claude/shadow-v2-implementation-diuxkj`. 사전등록 `research/leader-emerging-shadow-20260924/PREREGISTRATION_V2.md` (첫 V2 GPT 호출 전 커밋).

## 1. 결론

- SHADOW V2 를 구현·테스트·배포·가동했다. **production 은 한 줄도 바뀌지 않았다**(executor v86 / generator v28 버전·ezbr 동일, 배포 workflow 가 증명).
- **PARITY lane 실가동 확인**: 00:47:07Z production FD1 ENTRY(SYNUSDT, BUY)를 production 스냅샷 그대로(offset 7.9 s, spread 4.25 bps, ask depth 5.66×, slippage 7.6 bps) 이벤트로 기록. Binance weight 0.
- **ALT GPT 는 아직 호출되지 않는다**: 함수 비밀 `OPENAI_API_KEY_SHADOW` 가 없다(`health` 모드 `shadow_key_present:false`). production 키는 의도적으로 쓰지 않는다(공유 크레딧/한도). 키를 등록하면 재배포 없이 다음 이벤트부터 ALT 가 켜진다.
- **DISCOVERY lane 은 오늘 00:00Z 까지 대기**: 00:31:02Z(배포 전) shadow 의 첫 Binance 요청이 HTTP 418 을 받았다(shadow used-weight 1 → 공유 edge egress IP 문제로 판단). 사전등록대로 shadow 는 UTC 당일 Binance 를 완전히 멈췄다. production scanner 는 영향 없음(00:30~00:55Z 매 5분 정상, 차단 0).

## 2. 밤사이 LE-SHADOW-1 재검증 (DB, 00:25Z)

| 항목 | 보고치 | DB 재계산 | 판정 |
|---|---|---|---|
| SCAN / shortlist | ≈170 / ≈226 | 175 / 236 | 일치(시점 차) |
| Binance 오류 | 0 | 0 (00:25Z 까지). 00:31Z 418 1건 (이후) | 교정: 오늘 1건 |
| ALT-only BUY 60m net | −47.2 bps | **−48.2** (n=152) | 일치 |
| 120m net | −38.1 | **−41.4** | 조금 더 나쁨 |
| 60m 승률 | 36.1% | **35.5%** | 일치 |
| 손실군 rank velocity | 더 큼 | 15m 41.5 vs 27.2 계단 | 확인 |
| 손실군 volume ratio | 더 큼 | 5m 3.23 vs 2.53, vr15 평균 2.49 vs 1.96 (중앙값 1.32 vs 1.33, 꼬리 차이) | 확인(꼬리) |
| 손실군 taker buy | 더 높음 | 0.534 vs 0.537 | **교정: 차이 없음** |

- 그룹: `1_CURRENT_BUY_ALT_BUY` n=8, 60m net +175.7 — 단 V1 의 CURRENT 는 ±15/30분 창 연결이라 같은 순간 비교가 아니다(→ PARITY).
- 대형 손실: BTWUSDT −1250, BROCCOLI714 −723, NOMUSDT −636 bps. 대형 수익: LAB +450, LSK +435, BB +401, ONDO +188(MFE240 +1630), MORPHO +172.

## 3. 변경 목록

| 구분 | 내용 |
|---|---|
| 함수 (shadow 만) | `leader-emerging-shadow/v2/{axes,contract,prompt,gpt,wait,outcome,run,store}.mjs`, `shadow.mjs`(scan/outcome 후크), `index.ts`(모드 parity / v2wait / health), `guard.mjs`(451 day halt), `gpt.mjs`(parseOutput export) |
| DB (shadow_le 만) | `20260925004814_leader_emerging_shadow_v2.sql` (md5 `eab5c10d…` = 적용본), `20260925005140_leader_emerging_shadow_v2_schedule.sql` (md5 `0d8c5fce…`) |
| cron | 97 `leader-emerging-shadow-parity` (매분, 미처리 production ENTRY 가 있을 때만), 98 `leader-emerging-shadow-v2wait` (열린 V2 WAIT 가 있을 때만, :x0/:x4/:x5/:x9 제외) |
| control | `v2_parity_enabled=true`, `v2_discovery_gpt=true` (00:51:42Z, control_log 기록) |
| workflow | `.github/workflows/leader-emerging-shadow-v2-release.yml` (shadow 경로 push 시만, main 대비 production 소스 diff 0 증명) |
| 테스트 | `tests/leader-emerging-shadow-v2.test.mjs` 24개. 전체 390/390 |

## 4. 배포

| run | source | 결과 |
|---|---|---|
| 36079346322 | `dff2ca7` | v3→v4, bundle 31 파일 byte-identical, digest `70aa3845…`, executor/generator 불변 |
| 36079950472 | `451d43f` | v4→v5 (V2 WAIT/OUTCOME day-halt 준수 수정), 동일 검증 통과 |

## 5. 안전 증명

- 정적: V2 번들에 주문/계정/listenKey/leverage/marginType/서명/lease/CEC RPC/production GPT ledger/service key 문자열 없음. SQL 은 shadow_le.v2_* / cycles 에만 INSERT, production 은 기존 허용 표 SELECT 만.
- DB: `pg_stat_statements` (shadow_le_writer) 29 문장 / 2,888 호출, production 쓰기 0, DDL 0, 금지 RPC 0.
- 실거래·가상 분리: CHECK — shadow 행 `actual_trade=false`, `shadow_trade=(decision='BUY')`; PRODUCTION_GPT 행 `actual_trade=NULL`(실거래 여부는 결과 라벨 시 signal_id 로 읽기 전용 조회).
- Binance: V2 가드 cycle cap 60 / 공유 used-weight ≥1000 중단 / 418·429·451 당일 정지 / production scanner 가 weight·429 차단을 보고하면 V2 는 읽지 않음. PARITY 결정은 weight 0.
- GPT 예산: DISCOVERY 300콜 1.50 USD, PARITY 200콜 1.00 USD, 동시 3, 소진 → `SHADOW_BUDGET_EXHAUSTED`(요청 없음). production 원장·키 미사용, production 오류/429 시 stand-down.

## 6. 남은 일 (운영자)

1. `OPENAI_API_KEY_SHADOW` 를 별도 OpenAI project(월 한도 설정)로 Supabase 함수 비밀에 등록 → 코드/배포 변경 없이 ALT GPT 가동.
2. 00:00Z 이후 DISCOVERY 첫 사이클 확인 (`research/leader-emerging-shadow-20260924/v2-check.sql`).
3. 418 원인: shadow 의 공유 egress IP. 재발하면 DISCOVERY 는 그날 멈추고 PARITY 만 계속된다(설계).

## 7. 정지

- `update shadow_le.control set v2_parity_enabled=false, v2_discovery_gpt=false, set_by='…', reason='…' where singleton;`
- `select cron.unschedule('leader-emerging-shadow-parity'); select cron.unschedule('leader-emerging-shadow-v2wait');`
