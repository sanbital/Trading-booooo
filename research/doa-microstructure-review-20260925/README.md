# 외부 리뷰 검증: DOA와 GPT·DeepSeek 영역 분담

2026-09-25, Supabase etaajwpernzrcdrifdnw 읽기 전용 조사. 이번 작업은 매매 실행기, authority, 운영 함수/cron을 변경하지 않았다. 과거 분석은 모두 DEV이며 사후 규칙 최적화나 기존 TEST 재사용을 하지 않았다.

**결론: 결정론적 비용 계산과 시계열 수집을 먼저 하자는 순서에는 동의한다. 그러나 “호가로 DOA를 구분할 수 없다”, “슬리피지는 원인이 아니다”, “분담은 부적절하다”를 확정 결론으로 받아들이지는 않는다.** 현재 자료는 작은 full-feature 표본과 제한된 체결 기준 비교여서 효과 부재나 인과관계 배제를 증명하지 못한다.

## 주장별 재현 결과

| 주장 | 직접 확인 | 판단 |
|---|---|---|
| 1. 현재 진입 전 호가로 DOA 구분 불가 | 과거 GPT 재생 BUY68, DOA9 재현. 더 큰 V17 주문 스프레드 표본517 중 결과511/DOA44 확보. 낮은·높은 3분위 DOA7.02%/8.19%, p=.837, 60분 중복 축소 p=.826 | **부분동의**. 검증된 필터 없음. full-feature와 새 DOA 표본 부족으로 “불가능”은 판단 보류 |
| 2. 체결 슬리피지는 원인 아님 |83건 reference 대비 평균−6.5266bp/중앙0/p90+26.1195bp, DOA−3.1441 vs winner−2.9961 재현. reference는 triggerClose/신호 기준. 주문별 실제 ask 기준15건 평균−.5734bp/p90+3.3060bp | **부분동의**. 관측15건에서 큰 평균 체결마찰 증거는 약하지만 83건 슬리피지 검증이 아님. 인과관계 배제 불가 |
| 3. 수수료가 순손익을 뒤집음 | 실제 fill: gross+8.073447, entry fee20.681355, exit fee20.685391, net−33.293299 USDT. DB net−33.293259와 거의 일치 | **동의(손익 산술)**. 가격 경로 DOA의 직접 원인과는 구분. funding 포함 계정 순수익은 별도 미확인 |
| 4. 영역 분담이 부적절 | 현 prod ENTRY GPT p50 2.304초, packet quote 기준 완료까지 p50 2.396초. 초기→재확인12.052초 동안 mid 절대변화 p50 16.20bp. 이전 전담 Flash226회 연구에서도 유효 손실 필터 미입증 | **부분동의**. 계산은 코드가 우선. 지연은 실제이나 LLM 호출 동안의 변화량은 미관측. 분담안 E의 공정한 shadow 비교는 가능 |

## 1. 통계 재현과 표본 확대

historical.json은 기존76 ENTRY 연구 중 GPT 재생 BUY68의 job_key와 facts, signal_id 라벨을 고정해 옮긴 자료다. 새 DB 조회의 같은68개 signal_id와 5/60분 MFE·MAE를 대조했고 결측·변경0건이었다. 실제 운영 GPT BUY와 혼동하지 않는다. signal_id 중복0. 재생선택68개 중 동일심볼60분 thinning47,180분42,첫심볼32로 줄어든다. 18개 지표/DOA9라는 작은 표본이다.

리뷰어 p=.055(OI5m), .099(spread), 나머지>=.34는 **정확 재현되지 않았다**. 순열 방식/3분위 끝점/동률 처리/seed가 제공되지 않아 두 방식을 명시했다.
- 전체68개 라벨을 섞고 양끝22개씩 비교: OI .0442, spread .1208. 다른 일부 지표 .266대로 “나머지 모두>=.34”도 일치하지 않는다. Bonferroni18 보정 OI .796, 나머지1.
- rank ntile의 양끝23/22에서만 라벨을 섞는 조건부 검정: OI .0198, spread .0458; Holm18 .356/.779.
- 동일값을 임의로 갈라놓지 않는 quantile 경계 민감도: OI .0197/Holm .335, spread .1088/Holm1. 상수값은 검정하지 않는다.
이는 적절한 방법을 골라 유의성을 주장하는 작업이 아니다. 서로 다른 귀무분포가 다른 p를 낸다는 재현 한계이며 어느 방식도 다중비교 후 통과하지 않는다.

원래68건에 대해 5분MFE<.3%(19건),60분1.2% stop-hit(46건),2.5% stop-hit(26건)도 계산했다. 가장 작은 보정 p는 1.2% stop 정의의 taker_buy_ratio_5m .122로 .05를 넘었다. 이 표적들은 “진입 직후”와 “60분 내 최종 MAE”를 동일시하지 않는다. 후보 기준가격 라벨과 실제 체결 후 peak도 다르다.

확대한 저장 자료:
- initial_gpt_record full facts103개 중60분 라벨81/DOA11. 나머지22는 음성이 아닌 미완료. 5분 라벨은 별도 coverage를 사용한다.
- live initial BUY85개 중60분 라벨66/DOA10.
- pre_dispatch book68개 중라벨51/DOA9.
- 실제 포지션과 full facts 연결27개, peak<.3%9개. 18지표 모두 보정 p1.
- 전체 OPEN_LONG 주문별 최초 snapshot을 signal당1개로 축소608건, spread존재604/라벨598/DOA60. 그중 V17만517/라벨511/DOA44. 전체후보가 아니라 주문단계까지 도달한 선택표본이다.
- V17확대 spread3분위7.02% vs8.19%, 차이+1.17%p. symbol×UTCday block bootstrap95% CI [−4.82,+6.98]%p, UTCday16개 block CI [−5.15,+7.85]%p. 60분 thinning과 실제 peak<.3% 정의(p=.587)에서도 뚜렷한 구분 없음.
- executorPatch별 전체주문 spread 분석도 저장했다. n175인 V23-E1-X1 표본은1.69% vs10.34%, raw p=.060이나, 다른 patch에서 방향이 뒤집히고 버전별 다중 탐색이다. 채택 근거로 쓰지 않는다.
- 과거 다른 전략의 entryFeatures spread/bookImbalance 후보138개 및 실포지션54개도 따로 계산했다. 후보spread p1/book p.388(Holm .777). 같은 이름이라도 depth25bp와 bookImbalance 정의가 같다는 보장이 없어 V17과 합치지 않았다.
- entryFeatures의 V17자료에는 18개 full micro가 없다. v10_usdm_forward_snapshots24,875 / crossvenue19,418건은 모두09-01에 끝나 최근 cohort와 연결 불가. 연구 klines 역시 최근09-19 이후0건.

68건의 symbol-day bootstrap은 작은 사건 수와 바닥률0 때문에 조심해야 한다. UTC날짜가2개뿐이라 그 day CI는 시간 일반화 근거가 아니다. 효과 부재를 입증하는 동등성 검정도 수행하지 않았으므로 “정보 없음”을 강하게 주장하지 않는다. 여러 정의·cohort를 합친 전체 탐색 횟수는18보다 많으며, 어떤 raw p도 승격 근거로 사용하지 않았다.

사전 선택한 탐색 조합:
- spread>10bp AND taker buy<=.44: 해당표본0 → 평가 불가.
- spread상위1/3 AND taker buy하위1/3:11건 중DOA2(18.2%), 나머지70건 중9(12.9%), p=.641.
- bid depth/order<3 AND 매도우위:0 → 평가 불가.
- imbalance<=−.45 AND 매도우위:1건/DOA0 → 평가 불가.
강한 조합 효과 증거도 없지만 표본이 희소하고 기존진입게이트로범위가잘린 표본이라 조합 무용을 증명한 것은 아니다.

## 2. 기준가·실제 체결·부분체결

DB의 missed_opportunity_sync 정의를 supplement.json에 저장했다. reference_price는 chase이면lastClose, 그외triggerClose 우선, 없으면features.referenceClose다. best ask가 아니다.
실제 exchange_trade_fills는 position_id가 아닌 **v17_position_id**로 연결한다. 주문ID별 부분 fill의 quantity/quote_amount/fee를 먼저 합치고 그 주문의 execution_attempts.best_ask와 비교한 뒤 수량가중했다.

| 기준 | 비교 가능한 수 | 평균 bp | p90 bp |
|---|---:|---:|---:|
| journal reference |83|−6.527|26.119|
| pre_dispatch ask |26|−.651|9.001|
| pre_dispatch mid |26|1.068|10.100|
| 실제 주문별 best ask |15|−.573|3.306|

주문ask 표본 DOA5건 평균−1.727bp, winner6건−.152bp. 나머지4건은 중간peak다. 음수는 고정된 과거 호가보다 이후 체결가격이 내려갔을 수 있다는 뜻이며 “역슬리피지이므로 무위험”이 아니다.
83건 중partial 기록12, retry>1인3. 주문ask 연결 partial3건 평균+3.363bp, retry3건−1.386bp, partial없고단일시도10건−1.195bp. 일부 범주는겹친다. 제외해도 관측평균이 크게양수라는 증거는없지만 n이작아원인배제는못한다.
pre_dispatch와 실제dispatch사이도시간차가있으며 주문ask는 quote_age_ms만큼이미낡았을수있다. 정확한matched exchange-event-time arrival price 경로는없다.

## 3. 실제 수수료와 maker

83포지션의 buy/sell quantity를 original_quantity와 대조: mismatch0, fee결측0. 실제수수료로 재계산한net과 DB net의 최대차이0.0000395USDT(반올림수준)다. 모든 진입fill은taker이며maker표본0.
DOA peak<.3%19건의net합계−181.0365, 양쪽fee9.2611로 손실대비약5.1%다. 리뷰어의 “−6USDT/왕복.45USDT≈7%”는450명목의 개별예시로는 타당하지만 이83건전체DOA 비중을 대표하는 관측수치는 아니다.
수수료는 가격MFE/MAE 자체를 바꾸지 않지만 작은gross우위를net손실로바꾼다. 실제fillgross+8.07을 수수료를없앨수있다는실행가능한수익으로해석하지않는다.

leader-exit-settlement.mjs와 native protection 정산식은 매매proceeds−cost−commissions다. 실제net이이식과맞고funding cashflow원장이이연결자료에없다. 별도fundingRate연구자료는 계정의실제수령/지급원장이아니다. **−33.29는funding포함계정순수익으로검증되지 않았다.**

maker2bp/taker5bp를가정하고체결가격·수량·선택이전혀안바뀐다는조건이면 entryfee절감은12.4088USDT, net약−20.8845다. 2bp는계정확인요율이아닌시나리오다. 실제maker의fill확률/역선택/승자누락률을추정한값이아니다.
최근후행1분경로가DB에없어 “pullback지정가였다면체결” cohort와승자누락률은계산하지않았다. 전봉 high/low나MFE·MAE4개 horizon만으로시점/queue를재구성할수없다. 설령1분봉을얻어도limit접촉은체결보장이아니다. 필요한event-levelqueue/aggTrade와maker shadow는 PROTOCOL에명시했다.

## 4. 지연·분담의 공정성

실제 production ENTRY103건 API p50 2.304s/p95 3.046s; execution_ref.at→api_completed_at96건 p50 2.396s/p95 3.142s. RECHECK46건 p501.825s, HOLD28건2.189s. 리뷰어1.6s는 이cohort의수치가아니다.
execution_ref.at은 packet의로컬수신/as-of시간이며 거래소의각depth event시각과완전히동일하지않다.
초기→pre_dispatch68쌍은 p50 12.052s. 재확인은GPT완료보다 p50 9.526s후다. 그동안mid절대변화 p50 16.20bp/p90 38.86bp, spread절대변화p50 .965bp, book imbalance .152, askdepth24.51%다. GPT완료정확시점스냅샷0건. 이전체12초변화를GPT의2초호출탓으로돌릴수없다.

(i) 비용산술결정론우선 동의. (ii) stale위험동의, 정확호가변화인과는미검증. (iii) 부분정보/fusion실패지점은실제설계위험이나 안전한비동기shadow를불가능하게하지않는다. (iv) chase_risk의약한DEV태그도 다중비교후미확정이고승자제거문제가있다.
직전 role-split 연구는103과거입력226회, GPT과거답재사용, Flash전담p501.138s였고 손실방어효과미입증이다. 이것은 실제 GPT축소입력+Flash분담E를평가한실험이아니다.
E0(전체GPT+전담Flash), E(부분GPT+전담Flash), C(동일전체패킷독립판단)를새데이터에서동일budget/deadline/실패처리로비교하는설계는가능하다. 현재는설계만등록했으며추가API호출없다.

## 제안 채택과 운영 범위

1. 시계열캡처 **수정채택**: -60초prehistory는 watchlist를미리구독해야한다. 5초snapshot차이만으로재충전속도는측정불가라diff/trade연속수신후bucket집계. 누락·truncated depth·liquidation coverage를명시한다.
2. 결정론적검증 **채택**: 비용비율/기존bands/사전고정시계열규칙부터. DOA100은필요조건일뿐충분조건아님.
3. LLM독립검증 **수정채택**: 전체패킷독립안을포함하고분담E도배제하지않는다. 현결과로자유로운ADVERSE자동veto는금지.
4. maker shadow **채택**: 실주문없음. 보수/낙관체결경계와승자누락률을수수료절감과함께평가.

[PROTOCOL.md](PROTOCOL.md)에14일/2000후보/32심볼/저장500MB·물리1.5GB/LLM0회/최대$25 지출한도와롤백을제시했다. 실제collectorhost·견적및원자적cap구현은아직없으므로 **지금배포준비완료라는주장은하지않는다.**
[capture-schema.draft.sql](capture-schema.draft.sql)은private6테이블/RLS/collector-label권한분리초안이며production미적용이다. collection기능·cron배포승인은구체host와비용차단구현검증이붙은뒤별도로요청해야한다. 사용자가지정한 “운영자승인후”조건때문에이번에는배포하지않았다.

## 재현·검증

1. queries.sql과supplement-queries.sql을같은프로젝트에서read-only실행. 운영DB는계속변하므로현재집계와frozen snapshot이달라질수있다. 조회전체가단일DBtransaction snapshot은아니다.
2. node research/doa-microstructure-review-20260925/analyze.mjs
3. PGLITE_MODULE을 로컬 @electric-sql/pglite@0.3.14 ESM경로로 설정한 뒤 node --test --test-isolation=none research/doa-microstructure-review-20260925/verify.test.mjs (검증 환경 Node24.19.0)

4/4검증통과: 중복/라벨결측, 실제수량·수수료정산, 통계한계, PGlite스키마생성·미래라벨시간·authority·권한·RLS.
PGlite는SQL/권한구조검증이며배포환경성능이나통합collector안전성을검증한것은아니다.
원본 snapshot.json / supplement.json / historical.json / v17-ids.json과고정seed를제공한다. 결과 results.json. 스키마생성·비용상한배포는실행하지않았다.
