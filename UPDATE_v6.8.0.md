# v6.8.0 업데이트 절차

## 배포 전

1. 현재 Supabase 데이터베이스 백업을 만든다.
2. 기존 Fly/Supabase/GitHub Secrets를 변경하거나 ZIP에 넣지 않는다.
3. ZIP의 `Trading-booooo-main` 내용을 저장소 루트에 덮어쓴다.
4. 특히 아래 신규 파일이 올라갔는지 확인한다.

```text
supabase/migrations/202607270020_validated_pareto_learning_v680.sql
supabase/functions/_shared/lob/governance.ts
supabase/functions/_shared/lob/governance.test.ts
```

이 마이그레이션은 슬롯, 운용 배분, 보호금, 주문 상한, 손실 한도를 수정하지 않는다.

## 권장 배포

저장소의 기존 `Deploy Supabase` GitHub Actions를 사용한다. 워크플로는 테스트 후
`supabase db push`를 먼저 실행하고 Edge Functions를 배포한다. 마이그레이션보다
v6.8 autotrader를 먼저 배포하면 신규 LOB 진입이 의도적으로 fail-closed 된다.

수동 배포가 필요한 경우 순서는 다음과 같다.

```bash
supabase db push --db-url "$SUPABASE_DB_URL"

for fn in market-scanner market-learning market-autotrader scalp-calibration lob-calibration
do
  supabase functions deploy "$fn" --project-ref "$SUPABASE_PROJECT_REF"
done
```

`gateway/server.mjs`도 v6.8 엔진 문자열을 포함한다. 기존 게이트웨이 배포
워크플로를 실행해 Upbit/Binance 게이트웨이를 갱신한다. API 키·토큰 값은
변경하지 않는다.

## 배포 직후 확인

Supabase SQL Editor에서 `SQL_VERIFY_v680.sql`을 실행한다.

정상 초기 상태:

- `get_lob_policy_status().mode` =
  `VALIDATED_PARETO_CHAMPION_CHALLENGER`
- CHAMPION 정확히 1개
- CHALLENGER/CONTROL은 처음에는 0개일 수 있음
- `trading_settings.scalp_position_slots = 6`
- 신규 포지션의 `metadata.lob_signal.policy.version`이 1 이상
- 대시보드 활성 모델이 `CHAMPION P번호`로 표시

`LEGACY ONLINE #표본수`가 계속 표시되거나 신규 포지션의 정책 버전이 0이면
Edge Function보다 마이그레이션 상태를 먼저 확인한다.

## 언제 새 모델이 적용되는가

1. 거래 종료 즉시 원시 코인·패턴 통계가 갱신된다.
2. 마지막 평가 스냅숏 이후 새 결과 20건이 쌓여야 CHALLENGER가 생성된다.
3. 시간별 `lob-calibration` 작업이 평가를 실행한다.
4. 정책별 40건 이상과 배정 스캔 20건 이상이 쌓이고 모든 공동 조건을 통과하면
   잠정 승격한다.
5. 두 번째 독립 cohort에서 다시 통과하면 확정한다.
6. 악화가 명백하면 20건/arm부터 조기 거절하며, 잠정 승격 후 악화하면 자동
   롤백한다.

따라서 원시 표본 숫자는 매 거래마다 늘지만 CHAMPION 버전은 검증을 통과할 때만
증가한다. 버전이 자주 바뀌지 않는 것은 학습 중지가 아니라 미검증 변경의 실전
자동 적용을 막는 동작이다.

## 운영 중 금지 사항

- `lob_policy_versions`의 status를 수동 UPDATE하지 않는다.
- CHALLENGER 성과가 나쁘다고 중간에 주문금액만 줄이지 않는다.
- 검증 중 슬롯·배분·필터를 바꾸면 두 cohort의 비교 가능성이 사라진다.
- 과거 LEGACY 결과를 policy_version에 수동 귀속하지 않는다.

긴급 중지는 기존 대시보드 제어를 사용하고, DB 정책 행을 직접 수정하지 않는다.
