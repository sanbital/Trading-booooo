# Trading-booooo v6.0.0-LOB 검증 기록

## 결과

로컬 정적 검사와 실행 가능한 회귀 테스트는 통과했습니다.

| 검사 | 결과 |
|---|---:|
| TypeScript 정적 검사 | 통과 |
| TypeScript 테스트 파일 | 30개 |
| TypeScript 테스트 케이스 | 239/239 통과 |
| 게이트웨이 Node 테스트 | 11/11 통과 |
| LOB 소스 불변조건 | 17/17 통과 |
| Gateway·Dashboard JavaScript 문법 검사 | 통과 |

## 확인한 핵심 불변조건

- `LOB_SCALP`이 기본 전략이며 실제 진입 결정권을 가짐
- 하락 추세 컨텍스트가 뜨거운 LOB 매수 후보를 단독 거절하지 못함
- 흡수·소진·스윕·OFI·재충전의 다섯 신호군 존재
- 아이스버그·재충전 추정은 단독 진입 불가
- 수수료·예상 슬리피지 차감 목표 순수익이 양수여야 함
- 보수적 순EV가 양수여야 함
- LOB 경로에는 별도의 pWin·pFill 하드 게이트가 없음
- 거래당 손실 5%, 일일 손실 30% 반영
- 일일 거래 횟수의 실질적 상한 제거
- LOB 경로에서 `SCALP_RATE_CONTROL` 미생성
- 기본 180초·절대 300초 타임아웃
- 청산 우선순위 고정
- 마이그레이션 적용 후 `PAPER` 모드
- 게이트웨이 기본 15초 스캔·5초 감시

## 사용한 정적 검사

```bash
npx tsc --noEmit --allowImportingTsExtensions \
  --moduleResolution bundler --module esnext --target es2022 \
  --lib es2022,dom --skipLibCheck \
  /tmp/deno-shim.d.ts \
  supabase/functions/_shared/lob/*.ts \
  supabase/functions/market-scanner/index.ts \
  supabase/functions/market-autotrader/index.ts
```

## 테스트 환경 제한

빌드 환경에 Deno 실행 파일이 없어 네이티브 `deno task check`와 `deno task test`는 실행하지 못했습니다. Deno 테스트 등록·파일 API와 표준 assert 모듈을 로컬 호환 계층으로 연결해 Node.js 22에서 30개 테스트 파일의 239개 테스트를 실행했습니다.

다음은 검증하지 않았습니다.

- 실제 Supabase 프로젝트에 대한 마이그레이션 실행
- 거래소 인증 주문과 실제 부분체결·취소 동작
- 실제 계정 수수료 응답의 모든 변형
- 수익성, 승률, 최대 낙폭, 실현 슬리피지
- 장시간 WebSocket 이벤트 누락·재동기화 스트레스

따라서 이 결과는 코드 통합·회귀 안정성 검증이지 실거래 성과 검증이 아닙니다.
