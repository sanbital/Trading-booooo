# 첫 실거래 체결 추적 및 FINAL RECHECK 오류 수정

후속 검증: [명시적 좌표 후보의 형식 개선 및 품질 미통과](COORDINATE_CANDIDATE_20260928.md). 정규 executor/generator 배포는 그대로이며 audit는 v11로 닫혔다.

**2026-09-28 10:59 KST: 체결 대기. 기술 오류 1개를 production executor v138에 수정 배포했다. 최신 자연 QNT 리뷰는 유효한 SKIP이다.** 이 결과를 BUY나 실제 체결로 표시하지 않는다. 첫 체결을 확인하고 거래소·DB·보호 주문을 대사할 때까지 이 대화의 10분 추적 heartbeat를 유지한다.

## 현재 운영 기준과 변경

- [10분 Top 10 배포 보고](RELEASE_20260928_10M.md)의 품질 보류를 계승한다. 새 묶음과 제공자별 enforcement는 false이고 기존 30분 제한 경로가 실행 중이다. 10분 추적 heartbeat와 10분 유료 Top 10 운영은 별개다.
- 최신 main `e104c14896d1fc5a5e2d1e8498e1e7f39e4e2066`를 재확인했다. QNT collector·ingest·gateway, 설정상 최대 슬롯 10개(당시 자금 기준 가용 2개), 증거금·레버리지·손절, AI 월/일 예산과 요청 크기 상한은 변경하지 않았다.
- ONEUSDT는 00:54:06 UTC ENTRY BUY 이후 두 번 캡처 준비 실패를 겪었다. 유효한 캡처를 확보한 00:55:12 FINAL RECHECK도 요청 **177,265 bytes**로 기존 GPT 상한 **130,000 bytes**를 넘어 `FD_REQUEST_COST_BOUND`였다. DeepSeek 역시 90,000 bytes 상한 때문에 호출되지 않았다.
- 현재·최초·주문 전 캡처의 24개 버킷 전체와 각 값은 유지하면서 중복된 pre_dispatch와 critical row를 참조로 바꿨다. 정수 시각 열은 시작 시각에 대한 정확한 차이로 전송한다. 원본 journal은 그대로 유지하며 모델 입력에서 복구 진단 중복만 제거했다. 평균으로 대체하거나 수치 정밀도를 낮추지 않았다.
- 주문 없는 stored replay가 최종 clock과 그에 대응하는 실제 final_packet을 함께 읽도록 수정했다. 이전에는 refresh 전 packet과 refresh 후 시각이 짝지어질 수 있었다.

## 재생 검증 결과

[기계 판독 증거](evidence/20260928-first-fill.json)와 `tests/fd1-recheck-wire.test.mjs`에 원본 job·요청 크기·비용을 보존했다.

- 세 캡처의 모든 셀과 절대 시각을 완전히 복원하는 검사, null·0·비정수 시각 보존, 원본 불변성, 기존 요청 상한 검사와 잘못된 응답의 BUY 불허를 검증했다.
- Node 전체 **1,452/1,452**, Deno **1,055/1,055 + 13 steps**, Edge type check 통과. 마지막 stored-replay 회귀 사례 추가 후 관련 **13/13**도 통과했다. 처음 Node 실행은 PGlite 환경 변수를 URI로 잘못 지정해 실패했으며 filesystem 경로로 고친 전체 실행이 위 성공 결과다.
- 배포 후 원래 실패했던 ONE packet을 **실제 DS·GPT API로 1회 재생**했다. GPT FIRST **81,850 bytes**, DeepSeek **86,164 bytes**, GPT FINAL **118,269 bytes**로 모든 기존 상한 안이다. **valid WAIT, error=null, 5.979초, orderCalls=0**. 최종 캡처 나이 7.282초, 24버킷 유효, DS/GPT snapshot hash 동일이다.
- 이 검증은 과거 시각의 주문 없는 재생이다. 당시 BUY를 현재 주문으로 승계하지 않았다. 형식 검증 성공이 판단 내용의 정확성을 보장하지 않는다. DS 설명의 buy_share 소수점 오류와 GPT 설명의 s60 단위 혼동이 관찰돼 의미 검증 위험으로 남겼다.
- **자연 production QNT 리뷰 01:58:06 UTC**는 24버킷 유효, 캡처 나이 7.296초, DS SKIP·GPT SKIP, error=null이다. 이유는 현재 매수 흐름과 참여가 약하다는 판단이다. QNT의 과거 부분 장애와 이번 정상 SKIP을 혼동하지 않는다.

## 실측 비용 및 전망

이번 ONE 재생 1건은 기존 journal에 **$0.0689592** 한 번만 정산됐다. 새 ledger로 중복 복사하지 않았다. 아래는 실제 usage와 코드 요금에 따른 계산이며 청구서 확정액은 아니다.

| 호출 | 입력 / 출력 | 기록한 비용 |
| --- | ---: | ---: |
| GPT FIRST | 31,963 / 95 | $0.02439975 |
| GPT FINAL | 41,025 / 657 | $0.03372525 |
| DeepSeek | 35,110 / 251, cache hit 1,792 | $0.0108342 (모든 입력을 cache miss로 계산한 피크 상한) |

재생의 GPT 합계는 **$0.058125**다. 이는 최초 ENTRY를 제외한 RECHECK 비용이며 신규 묶음의 단일 GPT FINAL 비용으로 취급하지 않는다. RECHECK도 일일 진입 예산을 소비하므로 유력 후보 처리 가능 건수는 상황에 따라 줄어든다.

- 01:58:50 UTC 월 사용액은 DS **$1.685333144**, GPT/unknown **$38.91506428**이다. 최근 24시간 보수적 장부 속도의 31일 환산은 **$24.42 / $363.25**이며 GPT에는 미정산 예약 **$6.75**가 포함된다. 감사 호출·이전 정책·예약이 섞여 있어 새 10분 운용의 확정 전망은 아니다.
- 이전 실제 Top 10 비용 표본의 10분·31일 기본 전망은 DS **$78.47**, 이전 최대 표본 기준 **$80.50**이다. 추가·보유 리뷰와 비용 꼬리, 후보 포착 품질이 아직 활성화 조건을 충족하지 않았다.

## 배포 및 production 확인

- executor **v138**, SHA `d4f6e09ab921f6e55606b376c29b03598a28b3040897ef412a5e0992cc08b479`, 배포 시각 **01:54:11 UTC**. 다운로드한 81개 파일 모두 로컬 bundle과 일치했다.
- generator v36, QNT ingest v5, evolution v16은 변경하지 않았다. DB migration 추가 없음. audit v9 측정 endpoint는 계속 닫혀 있다.
- 읽기 전용 거래소 진단 **2026-09-28 10:58:56 KST / 01:58:56 UTC**: HTTP 200, 거래소/DB 열린 포지션 0, 일반·조건부 미체결 0, unresolved 0, 가용 금액 331.34419204 USDT, 슬롯 2. circuit=false, last_error=null, native stop 활성, hard safety 독립, AI 실패 시 기존 보호 유지.
- [PR #228](https://github.com/sanbital/Trading-booooo/pull/228)에 변경을 보존한다. 새 Top 10 품질 gate가 미통과이므로 PR은 draft이며 기능 활성화 성공으로 표시하지 않는다.
- 기존 heartbeat `v18`을 **현재 대화의 10분 최초 체결 추적**으로 갱신했다. 기준 시각은 01:40 UTC이며 상태는 `../work/first-fill-monitor.json`에 보존한다. 첫 실제 fill 뒤 주문 ID·실제 fills·수량·native stop ACK·중복 여부를 확인하고 추적을 일시중지한다. 로컬 추적은 Codex 앱과 컴퓨터가 실행 중이어야 한다.

## 남은 위험

위 최초 보고 이후 상태는 [좌표 후보 검증](COORDINATE_CANDIDATE_20260928.md)과 [수집 타이머 수정·production 검증](CAPTURE_JITTER_20260928.md)에 이어 기록한다. 11:59 KST 최신 자연 결과는 WUSDT의 유효한 SKIP이며 체결은 0건이다. PR #229의 타이머 수정은 수집기에 배포하고 기존 10분 관찰 gate를 통과했다. 시장 판단을 BUY로 바꾸거나 과거 BUY를 재사용하지 않는다. 신규 Top 10 후보 v3는 선택된 과거 반례 9/10 미전달과 의미 오류가 남아 비활성이다. 실제 신규 FINAL·슬롯 전환·보유·청산 검증과 비용 꼬리 검증도 미완료다. 첫 체결 추적은 계속한다.
