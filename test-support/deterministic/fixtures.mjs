import {normalizeCapture} from '../../supabase/functions/_shared/deterministic/features.mjs';
import {PROFILE} from '../../supabase/functions/_shared/deterministic/calibration.mjs';
export const AT=Date.parse('2026-10-02T10:00:00.500Z');
export function scenario({prices=null,pressure=null,bidDepth=null,askDepth=null,values={},at=AT}={}){
 const end=Math.floor(at/5000)*5000,rows=[];
 for(let i=0;i<24;i++){
  const mid=prices?.[i]??100+.01*(i+1),prior=i?rows[i-1]:null,share=pressure?.[i]??.51+i*.01,
   total=1000+i*100,buy=total*share,sell=total-buy,bd=bidDepth?.[i]??20000+i*500,ad=askDepth?.[i]??18000-i*150,
   finish=end-(23-i)*5000,start=finish-5000;
  rows.push({bucket_ms:finish,start_ms:start,end_ms:finish,received_at_ms:finish+Math.min(100,at-finish),exchange_event_ms:finish-100,
   book_received_at_ms:finish-50,flow_event_ms:finish-200,flow_received_at_ms:finish-150,mid,start_mid:prior?.mid??100,
   aggressive_buy:buy,aggressive_sell:sell,net_taker_quote_5s:buy-sell,buy_share_5s:share,trade_count:50+i,arrival_rate:(50+i)/5,
   aggressive_notional:total,bid_depth_25_usdt:bd,ask_depth_25_usdt:ad,imbalance:(bd-ad)/(bd+ad),spread_bps:1.5,
   buy_impact_450_bps:1.5,sell_impact_450_bps:1.5,d_mid_bps:(mid/(prior?.mid??100)-1)*10000,
   d_bid_depth_25_pct:bd/(prior?.bid_depth_25_usdt??bd)-1,d_ask_depth_25_pct:ad/(prior?.ask_depth_25_usdt??ad)-1,
   d_buy_share:share-(prior?.buy_share_5s??share),d_net_taker_quote:(buy-sell)-(prior?.net_taker_quote_5s??0)});
 }
 const raw={status:'AVAILABLE',buckets:24,start_ms:rows[0].start_ms,end_ms:end,trajectory:rows};
 const facts={values:{return_15m:.025,return_60m:.05,ema9_vs_ema20:.003,ema20_distance:.002,ema9_distance:.001,ema20_slope:.003,ema50_slope:.002,ema50_distance:.02,
  atr_1m_14_normalized:.008,volume_ratio_5m_vs_60m:1.4,last_body:.003,last_upper_wick:.0005,last_lower_wick:.001,
  body_to_range:.7,close_location_value:.85,rsi_1m_14:58,rsi_5m_14:60,bb_position:.8,distance_high_60m:-.01,
  btc_return_1m:.0002,btc_atr_normalized:.001,...values},quality:{candles_complete:true},technical_context:{recent_1m_candles:[{body_sign:1},{body_sign:1},{body_sign:1}]}};
 return {raw,facts,capture:normalizeCapture(raw,at),profile:PROFILE,at,price:rows.at(-1).mid,return24h:.12};
}
export function bearish(options={}){
 return scenario({prices:Array.from({length:24},(_,i)=>100.5-i*.025),pressure:Array.from({length:24},(_,i)=>.6-i*.015),
  bidDepth:Array.from({length:24},(_,i)=>30000-i*900),askDepth:Array.from({length:24},(_,i)=>20000+i*900),
  ...options,values:{last_body:-.002,last_upper_wick:.004,last_lower_wick:.0003,close_location_value:.15,...options.values}});
}
export function position(patch={}){return {id:'position',symbol:'TESTUSDT',entry_price:100,peak_price:101,entry_at:new Date(AT-120000).toISOString(),
 original_quantity:4.5,remaining_quantity:4.5,entry_fee_usdt:.225,hard_stop_price:97.5,metadata:{entryMarketRules:{priceTick:.01}},...patch};}
export function executableQuote({at=AT,price=100.24,depth=30000,askDepth=15000}={}){
 const bid=price-.0075,ask=price+.0075;
 return {best_bid:bid,best_ask:ask,bids:[{price:bid,size:depth/bid}],asks:[{price:ask,size:askDepth/ask}],timing:{requested_at_ms:at-100,received_at_ms:at-50}};
}
