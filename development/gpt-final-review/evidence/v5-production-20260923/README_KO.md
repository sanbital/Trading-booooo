# GPT 최종검수 V5 — 운영 배포·주문 없는 검증 기록 (2026-09-23)

## 배포
- main `bdefc29` → `v10-lane-executor` v70 (ezbr `073c585c…`), 38개 파일 전체가 main과 바이트 동일(수동 release workflow run 35869942639).
- 저장소 migration `20260923132101` (제어 행 OFF/예산 0, 원장 telemetry 열, 완료 CAS·비용 정산, 롤백 전용 CEC preview).
- 거래 정책 파일(slot sizing, exit, protection, entry-control, ops-isolation, CEC, B06133, pullback)은 `fea185c` 대비 변경 없음(workflow가 diff로 검증).

## 실제 API (운영 secret, 주문 없음)
- V4: 8/8 HTTP 200, 검증 통과 0/8 (프롬프트가 s/o 의미를 정의하지 않았고 m을 오용).
- V5 최종: 35/35 검증 통과, p50 2.3초 / p95 3.9초(n=35) / 최대 4.2초, 평균 출력 336 토큰, 평균 $0.0037/건.
- 근거 ID → 원본 값·단위 복원 100% 일치, candidate_id·snapshot_hash 35/35 일치.
- 실제 엔진 승인 후보 10건 재현(point-in-time) 모두 PASS: **GPT가 걸러낸 후보는 0건이다. 수익 개선 효과는 입증되지 않았다.**

## 운영 전환 방법(운영자 승인 필요, 이번 작업에서 실행하지 않음)
```sql
-- SHADOW: 주문 영향 없음, 검수만 기록
update public.gpt_final_review_control set mode='SHADOW', approval_ref='<승인 ID>', daily_cap_usd=<USD>, max_calls_per_day=<N>,
  set_reason='<사유>', set_by='<운영자>', updated_at=now() where singleton;
-- ENFORCE: enforce_approved=true 필요. 긴급 중지: mode='OFF' 또는 함수 env GPT_FINAL_REVIEW_MODE=OFF
```

## 안전 차단(미해제)
- 현재 incident gen 123 `MANUAL_REVIEW_REQUIRED`. 원인: 08:46:11 INCOMPLETE_OR_STALE_SNAPSHOT(gen 122) 직후 같은 주기의 v19 복구 RPC가 lock timeout(750ms)으로 실패 → 주기 오류가 runtime.last_error에 기록 → `v18_external_incident_epoch` trigger가 이를 외부 writer로 판단해 MANUAL_REVIEW로 승격. 9/21 gen 118에서도 같은 패턴.
- v70: 복구 lock timeout을 `RECOVERY_LOCK_BUSY`(재시도)로 처리해 이 경로의 재발을 막음. 다른 치명 오류의 승격 동작은 유지.
- MANUAL_REVIEW_REQUIRED는 기존 복구 함수가 자동 해제하지 않는 종류다. 해제는 운영자 승인 재분류 절차(기존 `docs/operations/v18-approve-flat-legacy-incident.sql` 방식, 해당 파일은 TAC/SAGA 전용)가 필요하며, 해제되면 기존 모델의 실자금 신규 진입이 재개되므로 이번 작업에서는 수행하지 않았다.

## 임시 검증 함수
`gpt-final-review-verify`는 DB token을 삭제해 모든 호출을 거부하는 상태로 두었다(삭제는 CLI/대시보드 필요).
