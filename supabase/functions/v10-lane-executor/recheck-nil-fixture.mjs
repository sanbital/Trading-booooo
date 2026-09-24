/** NILUSDT 2026-09-24 05:32 UTC (signal 4562515b), the production trade that motivated the
 * FINAL RECHECK. Values are the stored production records:
 *  - initial: GPT journal 8960f3c6... (FD1 facts at the snapshot, the BUY support and summary);
 *  - pre-dispatch: the E1 observation and dispatch evidence stored on position 589f9bd6.
 * Not recorded at the time (this release starts recording them): the initial book mid and the
 * dispatch depth. The initial price reference is the last Binance aggTrade before the
 * snapshot (0.14779 @ 05:32:06.859); the dispatch quote is top-of-book only (ask 0.1475 from
 * E1's evaluatedPrice, bid one tick lower), so book deltas are unknown (null) in this fixture.
 * This is a PATH fixture (does the detector ask GPT again?), not a target: nothing here is
 * tuned so that NIL is skipped. */
export const NIL_SIGNAL_ID='4562515b-8e47-4735-beba-4ff1dbe32b82';
export const NIL_INITIAL_FACTS=Object.freeze({last_body:0.012948550175631901,return_1m:0.013646702047005466,return_4h:0.09179862563489682,
  return_5m:0.02645170295924082,day_return:0.6073235100065979,return_15m:0.06233747471828943,return_30m:0.05805755395683443,
  return_60m:0.10895792489820555,spread_bps:2.0298386278292395,signal_rank:1,funding_rate:0.00005,oi_change_5m:-0.0004941959155142506,
  oi_change_60m:0.045909499913034946,premium_index:0.00231602,btc_return_15m:-0.000501558158164328,btc_return_60m:0.0027317224398299977,
  distance_sma20:0.04058471422304599,accel_5m_vs_15m:0.0056725447198110075,last_upper_wick:0.0030993870101247048,
  accel_15m_vs_60m:0.035097993493738044,distance_high_4h:-0.0030504338394794495,distance_low_15m:0.06758130081300817,
  distance_high_60m:-0.010562432723358328,ask_depth_to_order:69.178280015,bid_depth_to_order:32.078208133333334,
  buyer_share_change:0.014370376227814008,open_interest_usdt:20336400.80882455,taker_buy_ratio_5m:0.5558123177868759,
  taker_buy_ratio_15m:0.5640951218211314,taker_buy_ratio_60m:0.5414419415590619,ask_depth_25bps_usdt:41506.968009,
  bid_depth_25bps_usdt:19246.92488,book_imbalance_25bps:-0.36639698413515764,est_buy_slippage_bps:1.5023316781159757,
  quote_volume_5m_usdt:7145018.965209,max_ask_wall_to_order:34.01338466666667,max_bid_wall_to_order:64.35438023,
  relative_strength_15m:0.06283903287645376,relative_strength_60m:0.10622620245837555,minutes_since_high_60m:1,
  volume_ratio_5m_vs_60m:3.37724994285169,distance_trigger_reference:0.006157214202640926});
export const NIL_TRIGGER_AT=1790227920000,NIL_SNAPSHOT_AT=1790227926883,NIL_INITIAL_DONE_AT=1790227928776,NIL_DISPATCH_AT=1790227937612;
/** The BUY ticket as the coordinator now builds it (initial context included). */
export function nilTicket({expires=NIL_TRIGGER_AT+60000}={}){
  return {decision:'BUY',validUntil:NIL_SNAPSHOT_AT+15000,expires,candidateId:'c_fc92ab268124a5c7f8d63686',
    snapshotHash:'ddb4aa85fc425f4f27c09ccce2e89150dbbd4d9d40989d666f5e9b019e9d16d7',model:'gpt-5.4-mini-2026-03-17',
    summary:'상승 흐름이 전 구간에서 유지되고 체결도 매수 우위다. 스프레드와 슬리피지도 낮아 지금 진입해도 무리가 적다.',
    identityJson:JSON.stringify({judgments:{v17:{strategy:'LEADER_MOMENTUM_V17',setup_state:'TRIGGERED',rank:1,day_return:0.6073235100065979,
      signal_return_5m:0.025754385964912307,confirmation_return_15m:0.06406056635364354},
      b06133:{allowed:false,branch:null,reason:'B06133_REJECT',factors:{absorption:false,btcAnyUp:true,buyerShareRise:false,fresh15over30:true,
        fresh5over15:true,recentHourLead:true,volumeTails:false}},
      v30:{admitted:true,failed:[],rule:'fresh5over15=true AND volumeTails=false'},
      cec0040:{action:'REJECT',effective_allowed:false,ready:true,prediction_usdt_per_trade:-3.666810247208153,
        note:'strategy-wide causal edge estimate from recent closed trades (not symbol specific)'}}}),
    initial:{version:'GPT_FINAL_RECHECK_FD1_RC1',snapshotAt:NIL_SNAPSHOT_AT,completedAt:NIL_INITIAL_DONE_AT,facts:{...NIL_INITIAL_FACTS},
      lastClose:0.14707,executionRef:{mid:0.14779,source:'AGGTRADE_LAST_BEFORE_SNAPSHOT',at:1790227926859},
      support:['return_1m','return_5m','return_15m','return_30m','return_60m','return_4h'],
      summary:'상승 흐름이 전 구간에서 유지되고 체결도 매수 우위다. 스프레드와 슬리피지도 낮아 지금 진입해도 무리가 적다.'}};
}
/** E1's stored decision at dispatch (E1_NOT_FAST_WEAK). */
export const NIL_E1=Object.freeze({confirmationState:'BASELINE_ELIGIBLE',reasonCodes:['E1_NOT_FAST_WEAK'],expectedCostBps:14.89663507144856,
  expectedEntryVWAP:0.14752261745131265,observations:[{startAt:1790227925761,endAt:1790227935761,return:-0.001353637901861271,
    buyShare:0.48506951964084827,tradeCount:779,quoteReceivedAt:1790227936162}]});
export const NIL_DISPATCH_QUOTE=Object.freeze({best_bid:0.14749,best_ask:0.1475,timing:{received_at_ms:1790227936162}});
export const NIL_SIGNAL=Object.freeze({id:NIL_SIGNAL_ID,symbol:'NILUSDT',features:{strategy:'LEADER_MOMENTUM_V17',referenceClose:0.14617,
  dayReturn:0.6073235100065979,rank:1,v17Setup:{state:'TRIGGERED',triggerAt:NIL_TRIGGER_AT}}});
