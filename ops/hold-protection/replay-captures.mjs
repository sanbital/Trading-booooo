import {validateCapture120,CAPTURE_VERSION} from '../../supabase/functions/_shared/gpt-final-decision/capture-context.mjs';
/** Matches doa_gpt_capture_context_v3's recorded boundary/delta rules. No invented rows. */
export function reconstructCapture(rows){
 if(rows.length!==25)return null;
 const n=x=>x==null?null:Number(x),ms=x=>x==null?null:Date.parse(x),ratio=(a,b)=>a!=null&&b>0?a/b-1:null,sub=(a,b)=>a!=null&&b!=null?a-b:null;
 const points=rows.map((r,i)=>{const x=r.payload,prev=rows[i-1]?.payload??{},mid=n(x.mid),buy=n(x.buy_quote_5s),sell=n(x.sell_quote_5s),total=buy+sell,
  b=n(x.bid_25_usdt),a=n(x.ask_25_usdt),pb=n(prev.buy_quote_5s),ps=n(prev.sell_quote_5s),share=total>0?buy/total:null,
  bi=ratio(n(x.buy_vwap_450),mid),si=ratio(n(x.sell_vwap_450),mid),pbi=ratio(n(prev.buy_vwap_450),n(prev.mid)),psi=ratio(n(prev.sell_vwap_450),n(prev.mid));
 return {bucket_ms:ms(r.at),start_ms:ms(x.interval_start),end_ms:ms(x.interval_end),received_at_ms:ms(r.received_at),exchange_event_ms:ms(x.exchange_at),book_received_at_ms:ms(x.received_at),
  flow_event_ms:ms(x.trade_event_at),flow_received_at_ms:ms(x.trade_received_at),mid,start_mid:i&&ms(r.at)-ms(rows[i-1].at)===5000?n(prev.mid):null,
  aggressive_buy:buy,aggressive_sell:sell,d_mid_bps:ratio(mid,n(prev.mid))*10000,d_spread_bps:sub(n(x.spread_bps),n(prev.spread_bps)),
  d_ask_depth_25_pct:ratio(a,n(prev.ask_25_usdt)),d_bid_depth_25_pct:ratio(b,n(prev.bid_25_usdt)),buy_share_5s:share,d_buy_share:sub(share,pb+ps>0?pb/(pb+ps):null),
  net_taker_quote_5s:buy-sell,d_net_taker_quote:sub(buy-sell,pb!=null&&ps!=null?pb-ps:null),trade_count:n(x.trade_count),arrival_rate:n(x.trade_count)/(n(x.interval_ms)/1000),aggressive_notional:total,
  bid_book_net_5s:sub(n(x.displayed_bid_added_5s),n(x.displayed_bid_removed_5s)),ask_book_net_5s:sub(n(x.displayed_ask_added_5s),n(x.displayed_ask_removed_5s)),
  spread_bps:n(x.spread_bps),bid_depth_25_usdt:b,ask_depth_25_usdt:a,imbalance:b+a>0?(b-a)/(b+a):null,btc_return_1m:n(x.btc_return_1m),
  buy_impact_450_bps:bi==null?null:bi*10000,sell_impact_450_bps:si==null?null:-si*10000,d_buy_impact_bps:sub(bi,pbi)==null?null:sub(bi,pbi)*10000,d_sell_impact_bps:sub(si,psi)==null?null:-sub(si,psi)*10000};});
 const raw={version:CAPTURE_VERSION,status:'AVAILABLE',position_id:rows[0].position_id,buckets:24,start_ms:points[1].start_ms,end_ms:points.at(-1).end_ms,
  ingested_at_ms:Math.max(...points.slice(1).map(x=>x.received_at_ms)),trajectory:points.slice(1)};
 return validateCapture120(raw,Math.max(raw.end_ms,raw.ingested_at_ms));
}
