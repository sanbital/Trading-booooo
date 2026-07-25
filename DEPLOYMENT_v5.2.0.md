# Trading-booooo v5.2.0 최종 업로드 및 실행

## 1. GitHub 업로드

압축을 풀고 안쪽 `Trading-booooo` 폴더를 연 뒤 내부 파일과 폴더 전체를 저장소 루트에 덮어씁니다. 바깥 폴더 자체를 올려 `Trading-booooo/Trading-booooo` 구조가 되면 안 됩니다.

커밋 메시지 예시:

```text
Deploy Trading-booooo v5.2.0 dashboard and capital controls
```

## 2. 추가 Secret

GitHub `Settings → Secrets and variables → Actions`에서 `DASHBOARD_ACCESS_TOKEN`을 32자 이상으로 추가합니다. 생략하면 기존 `LEARNING_ACCESS_TOKEN`으로 대시보드에 접속할 수 있습니다.

## 3. 자동 배포 확인

업로드 후 다음 작업이 실행됩니다.

```text
Deploy Supabase Trading Engine
Deploy Multi-Exchange Static-IP Gateway
pages build and deployment
```

Supabase 작업은 신규 DB migration, Edge Function, 대시보드 제어 API를 배포합니다. Gateway 작업은 이미 등록된 업비트·바이낸스 키를 유지하며 스케줄러를 활성화합니다.

## 4. 대시보드 접속

GitHub Pages 주소에서 `자동매매 대시보드` 탭을 누르고 `DASHBOARD_ACCESS_TOKEN`을 입력합니다.

처음에는 `PAPER` 상태를 유지합니다. 계좌 잔액과 운용 한도를 확인한 뒤 거래소별로 설정합니다.

- 업비트: KRW 기준 `전액` 또는 `선택 금액`
- 바이낸스: USDT 기준 `전액` 또는 `선택 금액`
- 보호 원화·보호 USDT는 자동 투자 대상에서 제외
- 수동 보유 코인 평가액은 운용 한도에서 제외

## 5. 출금 절차

1. 대시보드에서 `출금 모드 시작`
2. 신규 매수 중지 확인
3. 필요한 수동 매도 및 출금
4. `계좌 즉시 대조`
5. 출금 완료 후 `즉시 재개 + 지금 스캔`

재개 버튼은 별도 대기시간 없이 즉시 운용을 다시 열고 통합 스캔을 시작합니다.

## 6. 실거래 전환

대시보드의 `LIVE_LIMITED 전환`을 누르고 `ENABLE_LIVE`를 정확히 입력해야 실제 주문이 허용됩니다. 먼저 PAPER 운용과 계좌 대조를 충분히 확인하십시오.
