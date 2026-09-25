# DOA microstructure prospective protocol v1

상태: 수집 전 사전등록안 / NOT STARTED / authority=[].
이번 과거 분석 데이터 전부 DEV이며 새 VALIDATION/TEST에 넣지 않는다. 기존 deepseek-loss-defense PROTOCOL의 A–D 연구는 별개다. 이 문서는 수집 설계이고 구현·운영 승인이 완료된 배포물이 아니다. 변경 시 버전을 올리고 아직 관찰하지 않은 새 cohort에서 시작한다.

## 1. 채택 범위

결정론적 비용 계산과 시계열 캡처를 우선 채택한다. LLM 영역 분담은 배제하지 않고 E 비교안으로 남긴다. 먼저 수집 단계만 제안하며 LLM 호출0, 주문0이다. 동일 전체 패킷 독립 판단과 부분 정보 분담은 후속 shadow 단계에서 함께 평가한다. 최소 DOA100건은 필요조건이고 검정력 보증이나 승격 조건은 아니다.

운영자 승인 후 시작 시각 T0를 UTC 분 경계로 고정해 manifest에 기록한다. 최대14일 또는 후보2000건 또는 예산/저장 cap 중 먼저 도달하면 종료한다. 일수·건수 부족이면 INCONCLUSIVE로 종료하고 자동 연장하지 않는다.
새 DEV=T0~4일, VALIDATION=4~9일, TEST=9~14일. 경계 앞6시간의 신호는 다음 split의 가격 경로와 겹치므로 주검정에서 제외하고 별도 count한다. 실제6시간보다 긴 보유는 종료 시 미완료로 남긴다.
최소 총 DOA100, VALIDATION/TEST 각각 DOA30, TEST 최소5일과 시간군집30개 미달이면 성능 결론 보류. TEST 결과는 단 한 번 개봉하며 실패한 규칙을 수정해 같은 TEST를 재사용하지 않는다.

## 2. 캡처

연구 전용 장기 실행 collector + 비공개 DB ingestion을 매매 경로와 분리한다. 기존 executor, trade gateway, cron 변경0. 상시 WebSocket worker를 Edge Function 내부의 무한 루프로 만들지 않는다. Edge wall-clock/CPU 제한 때문에 rolling buffer 유지가 보장되지 않는다.
별도 read-only DB 계정은 필요한 신호/보유 watchlist projection만, writer는 doa_research 스키마만 접근한다. 거래소 private 주문 권한이나 production service_role을 collector에 전달하지 않는다. 수수료 schedule과 계정 cashflow의 읽기 전용 export는 별도 경계가 필요하다.

Watchlist: V17 후보가 될 top10 universe, 이미 ARMED/triggered인 후보, 보유 심볼, BTC의 합집합. 상한32심볼. 신규 후보는 빠짐없이 metadata 기록, 이미 watch 중이지 않아 -60초가 없으면 UNWATCHED; 데이터를 꾸미거나 future backfill로 실시간 정보가 있었다고 취급하지 않는다. 상한 초과는 고정 우선순위(보유→armed→rank→symbol) 및 제외 사유를 기록한다. 완전 캡처가 안 된 후보도 분모와 누락률에 포함한다.

시작 시점부터 depth diff와 aggTrade 스트림을 연속 수신하고, 거래소 snapshot/update sequence를 맞춰 로컬 호가를 구축한다. received/event/available 시각을 모두 기록한다. 이전 update와 이어지지 않으면 GAP, 새 REST snapshot으로 재동기화; 공백은 0으로 채우지 않는다.
연속60초 prehistory를 메모리 ring에 유지하고, 후보 t0 -60~+120초를 5초 bucket37개로 영속화한다. 실제 체결이 t0와 다르면 fill -60~+120초도 저장하며 겹친 (symbol,bucket) 중복 저장 금지. 최대 후보당74개 상당을 예산에 잡는다.
보유 전체 1분봉과 미체결/거부 후보의 t0~+60분 경로를 별도로 저장한다. 거래소마감/received/available을 구분하고 1분봉 시작 전에 체결된 가격처럼 취급하지 않는다.

각 bucket:
- best bid/ask/quantity, mid, spread, ±25/50bp 양쪽 명목 깊이, 주문 금액별 매수/매도 VWAP. snapshot depth가 해당 band까지 안 닿으면 coverage=false 및 하한값 표시.
- 5초 taker buy/sell 명목, 1초 최대 매도명목/5초 매도명목, 체결 수와 trade id gap.
- 연속 depth 업데이트의 표시 ask 추가/제거 총량. 이를 '진짜 매도벽 재충전' 또는 spoofing으로 단정하지 않는다. 취소·체결·이동의 완전 분리는 L2만으로 불가능하다.
- BTC 동일 closed-minute 수익률, 사전 고정된 버전별 sector-map의 동등가중 수익률. map 없는 종목은 null. 미래 구성종목 정보 사용 금지.
- 관측된 liquidation만 저장하고 completeness=false. 공개 stream snapshot은 전체 강제청산 거래 원장을 보장하지 않는다.
- 실제 계정 maker/taker 요율, 적용 자산/할인/시각, funding 지급 이벤트와 실제 진입·청산 fill 연결키. 요율 모르면 null.
- best quote의 source/event time, 수신지연, sequence gap, depth truncation, 메모리/행/비용 cap 등 quality flags.

REST 5초 polling만으로 ask 재충전 속도를 계산하지 않는다. 호가 snapshot 차이는 유입과 제거가 상쇄된 순변화일 뿐이다.

## 3. 비용 계산과 라벨

수학 계산은 코드가 담당한다. 주문 q에 대해:
entry impact=(buyVWAP(q)/mid-1)*10000;
exit impact=(1-sellVWAP(q)/mid)*10000;
round-trip bps=entry impact+exit impact+entry fee bps+exit fee bps+known funding cost bps.
VWAP-to-mid에는 spread가 이미 포함되므로 spread를 다시 더하지 않는다. 미래 exit book은 모른다; 현재 양방향 round-trip estimate와 실제 체결비용을 별도 표기한다.
expected cost / planned stop bps가 비용/위험 비율이다. LLM이 제시한 upside를 검증된 expected return으로 취급하지 않는다.

고정 결정론 comparator B1: 이 비율>0.10이면 shadow SKIP, 데이터 불충분은 UNKNOWN. 0.10은 이번 표본을 최적화한 값이 아닌 새 실험 설계값이며 이득은 미검증이다.
B2: 기존 published bands(spread>10bp 또는 buy slippage>=8bp 또는 bid depth/order<3 또는 ask depth/order<5)로 shadow SKIP.
시계열 T1: 직전60초 spread 중앙값 대비 현재>=2배 AND 직전5초 taker buy share<=0.44. T2: 직전60초 bid25 중앙값 대비 현재<=0.5 AND 같은 매도우위. 중간 가격/깊이가0, history coverage불완전이면 UNKNOWN. 이 두 규칙도 DEV 탐색으로 선택하지 않았고 성능은 새 데이터에서만 평가한다.
단독 규칙 및 B1 OR T1 한 조합만 confirmatory family로 고정한다. 나머지 조합 탐색은 DEV 부록, 승격 근거 금지. VALIDATION에서도 임계값을 변경하지 않는다.

후보 라벨 primary: t0의 유효 best ask 기준 60분 MFE<0.005 AND MAE<=-0.012. 모두 관측됐을 때만 확정한다. 5/15/60분 MFE·MAE 각각 유지.
보조: 첫5분 MFE<0.003, 고정1.2%/2.5% stop-hit, 실제 체결부터청산까지 peak<0.003; 이들은 다른 표적이므로 혼합하지 않는다. 가격 high/low는 시장 거래가격 기준이며 매도 가능한 bid 경로와도 구분한다.
실손익=실제 exit proceeds−entry costs−양쪽 실제 commission+실제 funding cashflow. 비용불명·부분체결미정산은 제외건수와 오차범위를 명시. position realized_pnl가 funding을 포함한다고 가정하지 않는다.
프록시 stop과 target가 같은1분봉에서 함께 닿으면 순서를 알 수 없음. 보수 stop-first와 최선경계 둘 다 제시. 모든 후보 shadow경로는 현재 실행기 정책의 해시를 고정한 독립 simulator가 있어야 PnL 비교 가능하며 executor코드를 수정하지 않는다.

## 4. 후속 LLM shadow 비교안 (이번 수집 승인 범위 밖)

- A: GPT 전체 패킷 단독 baseline.
- B: A에 사전 고정 결정론 B1/B2/T1/T2를 각각 적용한 simulation.
- C: GPT와 Flash에 동일 전체 패킷, 상대 답변과 미래 label 없이 독립 판단. Flash 분류만으로 veto하지 않고 검증된 numeric reason만 별도 수집.
- E0: GPT 전체 패킷 + Flash micro 전담; 전체정보 GPT를 유지하며 '추가 micro 검증'의 효과를 측정.
- E: GPT trend/thesis 하위 패킷 + Flash micro/cost 하위 패킷. 공통 symbol/time/plan stop/notional/cost summary 제공. E0와 비교하여 GPT 정보 제거 효과를 분리한다.
C/E의 가상 fusion은 baseline GPT BUY에 대해 Flash가 사전고정 B1/B2/T1/T2 위반을 정확히 인용할 때만 가상 SKIP; 같은 위반이면 모델이 없어도 SKIP 가능한 deterministic comparator도 반드시 비교한다. 규칙 없는 자유로운 ADVERSE는 tag만 기록한다.
ENTRY뿐 아니라 fill+2분/+5분 HOLD도 별도 task. 새 exit policy의 사전등록 없이 HOLD 태그를 조기청산 손익으로 치환하지 않는다.

모든 arm은 동일 input_available_at, packet hash, 동일 q/fee/stop, 동일 결과 경로를 사용한다. 호출 순서 랜덤화/균형화, 예산·출력 cap와 모델·프롬프트 해시를 실행 전에 다시 고정해야 한다. A/A와 E/E 반복을 outcome-blind hash로10% 선택한다.
API latency와 전체 결과 지연을 모두 재고, 입력신선도/4초 HOLD·8초 RECHECK 및 실행예약3000ms를 별도로 검증한다. Counter는 baseline 완료를 지연시키지 않는다. 실패/기한초과/취소는 baseline을 보존하고 candidate를 분석 분모에서 삭제하지 않는다. late response는 offline tag일 뿐 거래 의사결정의 usable signal이 아니다.
counter가 동일단계에서 완료되어야만가용한 역할분담의 latency/failure 비용도 ITT 성과에 포함한다. 결과가 좋았던 완료응답만 골라 평가하지 않는다.
실행 전 모델별 입력·출력상한에 대한 가격검증, 원자적 예산예약, 호출수상한, timeout회귀, fusion코드 및 packet contract가 별도 commit되어야 한다. 따라서 지금은 E의 공정 비교 설계가 가능하다는 판단이며 E 실행/성능 완료 주장이 아니다.

## 5. Maker shadow

실제 주문 전 best bid에 post-only buy 한 번, 대기5초, 미체결시 cancel, taker fallback 없음, q와 가격은 t0에 고정. 실제로 주문을 보내지 않는다.
1분봉 low<=limit은 '접촉 가능'이라는 낙관적 상한이다. 체결 확정으로 세지 않는다. sequence완전 depth/trades가 있는 경우 displayed queue ahead + 매도 aggressor 체결량으로 보수 추정하되 hidden liquidity/cancellation 위치는 불명이라는 경계를 유지한다.
낙관/보수 fill율, 실제 eligible전부기준 ITT net PnL, 조건부 DOA율, MFE>=3% 승자중 미체결비율, fill후1/5/30초 markout을 같이 제시한다. 절약 commission만 더한 손익을 maker전환 기대수익이라고 부르지 않는다.
queue증거가 없으면 수수료절감 시나리오까지만 제시하고 실제 maker 우위는 판단 보류한다.

## 6. 통계·승격

candidate_id별1행; 같은 심볼의60분 이내 연속 신호를 한 episode로 처리하며 원자료 전체 결과와 첫신호 thinning 결과를 함께 낸다. 진입·청산패치별 별도층, day×symbol cluster 및 UTC일block을 고려한다.
primary는 paired 비용차감 PnL 차이, secondary는 DOA recall/precision, 손실5% tail, 최대낙폭, baseline 3%+ winner 보존율. 효용은 accuracy만으로 판정하지 않는다.
confirmatory family B1/B2/T1/T2/(B1 OR T1)에 Holm .05; 새 LLM arms는 별도 사전고정family와 min-effect/power 계획을 동결한 뒤 수집한다. 데이터본뒤 families를 줄이지 않는다.
TEST net PnL 개선의 cluster CI하한>0, tail 악화 없음, winner 보존율>=95%를 모두 만족해야 추가 실거래 검토 대상으로 삼는다. 100 DOA만 채웠다고 자동승격하지 않는다. 매매 authority는 계속없음.

## 7. 용량·비용·레이트리밋·보존 및 승인 범위

상한:14일/2000후보/32동시심볼, LLM0회, 주문0회, 직렬화 저장500MB, DB 물리1.5GB 중 먼저 도달. 1.2GB에서 중지 예약을 걸어 여유를 남긴다. raw event 영구저장없음; process memory256MB 넘기 전 GAP중지. 압축률을 cap확대 근거로 사용하지 않는다.
후보당 최대74bucket×2000=148,000 rows; 1.5KB/row 가정222MB. candidate 61개1분봉×2000=122,000 rows; held10×14×1440=201,600 rows. candle0.4KB/row 가정129.44MB. 중복제거 전 원자료 약351MB, index/WAL 등3배 가정약1.05GB; 실제크기 측정필수. 복제/WAL/storage billing은 이근사와 다를수있다.
5초마다 전체32심볼 depth100 REST polling이면32×12×5=1920 weight/min으로 운영과공유하기에는 부담이 크다. 대신 WebSocket diff 유지, REST는 초기화/복구, collector 총REST100 weight/min cap,429/418시 Retry-After 준수·수집중단; 주문시스템과 다른 egress IP 권장. depth1000 초기화는20weight라 분산시작하고, 50bp미커버시 null로표시한다.
후보 없는 watchlist ring은 DB에 저장하지 않는다. batch ingestion최대10초1회, 지연/실패는 로컬 boundedqueue후 GAP, production DB에 무한retry하지 않는다. 수집의 DB polling도최대5초1회, indexedprojection만.
14일 원본 micro/candles보존, 확정라벨/manifest/집계90일; TEST개봉 전 필요한 평가 artifact는 hash된 immutable export 후 만료한다. TTL cron은 연구schema만 대상으로 별도승인하며 10,000행 이하batch. 실제거래기록삭제없음.

승인 요청 예산: 수집 전용 runtime+증분저장 합계 **최대 $25/14일**, LLM $0. 이는 사업자 견적이 아닌 운영자 지출 한도다. collector host/요금제·기존 Supabase 잔여quota가 미확정이므로 지금 실제비용이 $25 이내라고 보증하지 않는다. 배포 전 고정가격/선불 한도 또는 지출차단 수단을 확인하고 이한도 안에서만 provision; 확인불가면 유료리소스를 시작하지 않는다.
스키마 초안에는 전체 insert/byte cap을 원자적으로강제하는 ingestion이 아직없다. schema CHECK만으로 예산이 보장되지 않는다. 구현·통합테스트와구체host견적을 배포승인 자료에붙여야 한다.

롤백: run.enabled=false → collector중단/읽기전용 자격폐기 → 연구스케줄만해제. in-flight batch의idempotency와disabled check로추가쓰기차단. 기록보존, executor재배포/주문취소/보호주문변경 없음.
이번 검토 중 DB는 SELECT만 실행했다. migration/수집함수/cron/추가LLMcall을 실행하지 않았다.

## 공식 문서 확인

- [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security): private schema+권한과RLS 병행. broad service role을제한계정으로부르지 않는다.
- [Edge limits](https://supabase.com/docs/guides/functions/limits): worker wall clock과CPU 제한.
- [Binance depth REST](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Order-Book): depth limit별weight, 공개호가의RPI제외.
- [local order book sequence](https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/How-to-manage-a-local-order-book-correctly): snapshot/diff 동기화.
- [liquidation stream](https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Liquidation-Order-Streams): 관측범위 제한.
