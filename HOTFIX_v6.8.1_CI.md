# v6.8.1 CI Hotfix

## 원인

`residual-accounting.test.ts`의 BNB 기준자산 수수료 사례에서 기대값이 잘못 기재되어 있었습니다.

입력값:

- 청산 전 수량: `0.071 BNB`
- 매도 수량: `0.070 BNB`
- BNB 지급 수수료: `0.0000525 BNB`
- 평가가격: `573.2 USDT`

실제 잔량가치는 다음과 같습니다.

```text
(0.071 - 0.070 - 0.0000525) × 573.2
= 0.0009475 × 573.2
= 0.543107 USDT
```

기존 테스트의 `0.543707`은 계산 오기였으며, 운영 로직의 산출값 `0.543107`이 맞습니다.

## 수정

```diff
- assertAlmostEquals(out.residualValueQuote, 0.543707, 1e-6);
+ assertAlmostEquals(out.residualValueQuote, 0.543107, 1e-6);
```

운영 회계 로직은 변경하지 않았습니다.

## 버전 일치 확인

다음 네 위치는 모두 `6.8.1-RESIDUAL-LABEL-INTEGRITY`로 통일되어 있습니다.

- `supabase/functions/market-scanner/engine.ts`
- `supabase/functions/market-autotrader/index.ts`
- `gateway/server.mjs`
- `docs/index.html`

이전 GitHub Actions의 version drift 오류는 일부 파일만 덮어쓴 중간 커밋에서 발생한 것입니다. 이 전체 패키지를 저장소 루트에 덮어쓰면 일치합니다.
