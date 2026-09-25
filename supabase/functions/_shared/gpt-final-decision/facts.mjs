/** GPT FINAL DECISION (FD1): point-in-time fact builder. Pure, no I/O.
 *
 * Raw facts (candles, taker flow, BTC, derivatives, order book) and machine-model
 * judgments (V17, B06133, V30, CEC0040) are kept in SEPARATE sections. Every fact is
 * computed from data whose close/receipt time is strictly before `asOf`; the same
 * function builds production packets (live reads) and historical replay packets
 * (Binance history endpoints), so the two cannot drift apart. The order book has no
 * history: in replay those facts are null with reason NOT_POINT_IN_TIME_REPLAY. */
export const FACTS_VERSION='FD1_FACTS_1';
const MIN=60000;
export const SLOT_ORDER_NOTIONAL_USDT=600; // 200 USDT x 3 (reference only; sizing is unchanged)
const finite=x=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(Number(x));
const num=x=>finite(x)?Number(x):null;
function ensure(ok,reason){if(!ok)throw Error(reason);}

/** Fact dictionary: key -> [section, unit, definition]. The ONLY keys GPT may cite. */
export const FACT_DEFS=Object.freeze({
  // trend (symbol candles)
  return_1m:['trend','fraction','last completed 1m close / previous close - 1'],
  return_5m:['trend','fraction','close / close 5 completed minutes earlier - 1'],
  return_15m:['trend','fraction','close / close 15 minutes earlier - 1'],
  return_30m:['trend','fraction','close / close 30 minutes earlier - 1'],
  return_60m:['trend','fraction','close / close 60 minutes earlier - 1'],
  return_4h:['trend','fraction','close / close of the completed 5m bar 4h earlier - 1'],
  day_return:['trend','fraction','KST-day return stamped by the signal generator at signal time'],
  accel_5m_vs_15m:['trend','fraction','return_5m - return_15m/3 (positive = accelerating)'],
  accel_15m_vs_60m:['trend','fraction','return_15m - return_60m/4 (positive = accelerating)'],
  distance_high_60m:['trend','fraction','close / max 1m high of last 60 minutes - 1 (0 = at the high)'],
  minutes_since_high_60m:['trend','minutes','minutes since the max 1m high of the last 60 minutes'],
  distance_high_4h:['trend','fraction','close / max 5m high of last 4h - 1'],
  distance_low_15m:['trend','fraction','close / min 1m low of last 15 minutes - 1'],
  distance_sma20:['trend','fraction','close / SMA20 of 1m closes - 1'],
  last_body:['trend','fraction','last 1m (close-open)/open'],
  last_upper_wick:['trend','fraction','last 1m (high-max(open,close))/open'],
  distance_trigger_reference:['trend','fraction','close / signal reference close - 1'],
  // volume / flow
  quote_volume_5m_usdt:['volume','USDT','quote volume of last 5 completed minutes'],
  volume_ratio_5m_vs_60m:['volume','ratio','mean 1m quote volume of last 5 min / mean of the 55 before'],
  taker_buy_ratio_5m:['volume','ratio','taker-buy quote / quote volume, last 5 minutes (0.5 = balanced)'],
  taker_buy_ratio_15m:['volume','ratio','taker-buy quote / quote volume, last 15 minutes'],
  taker_buy_ratio_60m:['volume','ratio','taker-buy quote / quote volume, last 60 minutes'],
  buyer_share_change:['volume','fraction_difference','taker_buy_ratio_5m - taker_buy_ratio_60m'],
  // market
  btc_return_15m:['market','fraction','BTCUSDT close / close 15 minutes earlier - 1'],
  btc_return_60m:['market','fraction','BTCUSDT close / close 60 minutes earlier - 1'],
  relative_strength_15m:['market','fraction_difference','return_15m - btc_return_15m'],
  relative_strength_60m:['market','fraction_difference','return_60m - btc_return_60m'],
  signal_rank:['market','rank','KST-day return rank among USDT perpetuals at signal time (1 = strongest)'],
  // derivatives
  funding_rate:['derivatives','fraction','latest funding rate per interval (positive = longs pay)'],
  premium_index:['derivatives','fraction','latest completed 1m premium index close (perp vs index)'],
  open_interest_usdt:['derivatives','USDT','latest 5m open interest value'],
  oi_change_5m:['derivatives','fraction','latest 5m open-interest bucket / previous - 1'],
  oi_change_60m:['derivatives','fraction','latest 5m open-interest bucket / bucket 60 min earlier - 1'],
  // microstructure (order book; live only)
  spread_bps:['micro','bps','(best ask - best bid) / mid x 10000'],
  ask_depth_25bps_usdt:['micro','USDT','ask notional within 25 bps above mid'],
  bid_depth_25bps_usdt:['micro','USDT','bid notional within 25 bps below mid'],
  book_imbalance_25bps:['micro','ratio','(bid - ask)/(bid + ask) notional within 25 bps (negative = sellers dominate)'],
  ask_depth_to_order:['micro','ratio','ask notional within 25 bps / 600 USDT order (higher = safer)'],
  bid_depth_to_order:['micro','ratio','bid notional within 25 bps / 600 USDT order (exit liquidity)'],
  max_ask_wall_to_order:['micro','ratio','largest single ask level within 50 bps / 600 USDT'],
  max_bid_wall_to_order:['micro','ratio','largest single bid level within 50 bps / 600 USDT'],
  est_buy_slippage_bps:['micro','bps','estimated average fill vs mid for a 600 USDT market buy, walking the asks'],
  // position (hold review only)
  position_return:['position','fraction','current price / average entry - 1'],
  position_peak_return:['position','fraction','peak price since entry / entry - 1'],
  position_drawdown_from_peak:['position','fraction','current price / peak since entry - 1'],
  position_minutes_held:['position','minutes','minutes since entry fill'],
  position_minutes_since_new_high:['position','minutes','minutes since the position last made a new high'],
  position_stop_distance:['position','fraction','current price / protective stop - 1 (distance to the hard/lock stop)']
});
export const FACT_KEYS=Object.freeze(Object.keys(FACT_DEFS));
export const MICRO_KEYS=Object.freeze(FACT_KEYS.filter(k=>FACT_DEFS[k][0]==='micro'));
export const POSITION_KEYS=Object.freeze(FACT_KEYS.filter(k=>FACT_DEFS[k][0]==='position'));

/** Binance kline arrays -> completed bars strictly before `cutoff`, contiguous. */
export function bars(raw,interval,cutoff){
  ensure(Array.isArray(raw),'BARS_NOT_ARRAY');
  const xs=raw.filter(b=>Array.isArray(b)&&Number(b[6])<cutoff).map(b=>({t:Number(b[0]),end:Number(b[6]),o:Number(b[1]),h:Number(b[2]),
    l:Number(b[3]),c:Number(b[4]),q:num(b[7]),buy:num(b[10])})).sort((a,b)=>a.t-b.t);
  for(const [i,x] of xs.entries()){
    ensure(Number.isSafeInteger(x.t)&&x.t%interval===0&&x.end===x.t+interval-1,'BAR_TIMING');
    ensure([x.o,x.h,x.l,x.c].every(v=>v>0)&&x.h>=Math.max(x.o,x.c,x.l)&&x.l<=Math.min(x.o,x.c),'BAR_OHLC');
    ensure(x.q===null||x.q>=0,'BAR_QUOTE');ensure(x.buy===null||(x.q!==null&&x.buy>=0&&x.buy<=x.q*(1+1e-9)),'BAR_BUY');
    ensure(i===0||x.t-xs[i-1].t===interval,'BAR_GAP');
  }
  return xs;
}
const ret=(xs,n)=>xs.length>n?xs.at(-1).c/xs.at(-1-n).c-1:null;
const share=xs=>{if(!xs.length||xs.some(x=>x.q===null||x.buy===null))return null;const q=xs.reduce((s,x)=>s+x.q,0);return q>0?xs.reduce((s,x)=>s+x.buy,0)/q:null;};
const sub=(a,b)=>a===null||b===null?null:a-b;

/** Order-book facts from a depth snapshot {bids,asks}. */
export function bookFacts(book){
  const lvl=a=>(Array.isArray(a)?a:[]).map(r=>[Number(r?.[0]),Number(r?.[1])]).filter(([p,q])=>p>0&&q>=0&&Number.isFinite(p)&&Number.isFinite(q));
  const bids=lvl(book?.bids),asks=lvl(book?.asks),bid=bids[0]?.[0],ask=asks[0]?.[0];
  if(!(bid>0&&ask>=bid))return null;
  const mid=(bid+ask)/2,n=([p,q])=>p*q,O=SLOT_ORDER_NOTIONAL_USDT;
  const a25=asks.filter(([p])=>p<=mid*1.0025).reduce((s,x)=>s+n(x),0),b25=bids.filter(([p])=>p>=mid*.9975).reduce((s,x)=>s+n(x),0);
  const aw=Math.max(0,...asks.filter(([p])=>p<=mid*1.005).map(n)),bw=Math.max(0,...bids.filter(([p])=>p>=mid*.995).map(n));
  let left=O,cost=0,qty=0;for(const [p,q] of asks){const take=Math.min(left,p*q);cost+=take;qty+=take/p;left-=take;if(left<=1e-9)break;}
  return {spread_bps:(ask-bid)/mid*1e4,ask_depth_25bps_usdt:a25,bid_depth_25bps_usdt:b25,
    book_imbalance_25bps:a25+b25>0?(b25-a25)/(a25+b25):null,ask_depth_to_order:a25/O,bid_depth_to_order:b25/O,
    max_ask_wall_to_order:aw/O,max_bid_wall_to_order:bw/O,est_buy_slippage_bps:left>1e-9?null:((cost/qty)/mid-1)*1e4};
}

/**
 * @param src {one:1m kline rows (>=121), five:5m rows (>=49), btc:BTC 1m rows (>=61),
 *   oiHist:[{timestamp,sumOpenInterest,sumOpenInterestValue}], premium:premiumIndexKlines 1m rows,
 *   funding:{rate}|null, book:{bids,asks}|null, bookMissingReason}
 * @param ctx {asOf, referenceClose, dayReturn, rank, position?}
 */
export function computeFacts(src,ctx){
  const asOf=Number(ctx.asOf);ensure(Number.isSafeInteger(asOf),'AS_OF_INVALID');
  const o=bars(src.one??[],MIN,asOf),f=bars(src.five??[],5*MIN,asOf),b=bars(src.btc??[],MIN,asOf);
  const v={},why={},put=(k,x,reason='INSUFFICIENT_DATA')=>{ensure(Object.hasOwn(FACT_DEFS,k),'FACT_UNKNOWN:'+k);v[k]=num(x);why[k]=v[k]===null?reason:null;};
  const last=o.at(-1);
  const candlesComplete=!!last&&o.length>=61&&f.length>=12&&b.length>=61&&asOf-last.end<=90000&&asOf-b.at(-1).end<=90000&&asOf-f.at(-1).end<=330000;
  for(const n of [1,5,15,30,60])put('return_'+n+'m',ret(o,n));
  put('return_4h',ret(f,48)??(f.length>1?f.at(-1).c/f[0].c-1:null));
  put('day_return',ctx.dayReturn,'NOT_STAMPED');
  put('accel_5m_vs_15m',v.return_5m!==null&&v.return_15m!==null?v.return_5m-v.return_15m/3:null);
  put('accel_15m_vs_60m',v.return_15m!==null&&v.return_60m!==null?v.return_15m-v.return_60m/4:null);
  if(last){
    const h60=o.slice(-60),hi=Math.max(...h60.map(x=>x.h)),hiBar=h60.findLast(x=>x.h===hi);
    put('distance_high_60m',o.length>=60?last.c/hi-1:null);put('minutes_since_high_60m',o.length>=60?(last.t-hiBar.t)/MIN:null);
    put('distance_high_4h',f.length?last.c/Math.max(last.h,...f.slice(-48).map(x=>x.h))-1:null);
    put('distance_low_15m',o.length>=15?last.c/Math.min(...o.slice(-15).map(x=>x.l))-1:null);
    put('distance_sma20',o.length>=20?last.c/(o.slice(-20).reduce((s,x)=>s+x.c,0)/20)-1:null);
    put('last_body',last.c/last.o-1);put('last_upper_wick',(last.h-Math.max(last.o,last.c))/last.o);
    put('distance_trigger_reference',num(ctx.referenceClose)>0?last.c/Number(ctx.referenceClose)-1:null,'NO_REFERENCE');
    const q5=o.slice(-5);put('quote_volume_5m_usdt',q5.every(x=>x.q!==null)?q5.reduce((s,x)=>s+x.q,0):null);
    const prior=o.slice(-60,-5),mean=xs=>xs.length&&xs.every(x=>x.q!==null)?xs.reduce((s,x)=>s+x.q,0)/xs.length:null,pm=mean(prior);
    put('volume_ratio_5m_vs_60m',o.length>=60&&pm>0?mean(q5)/pm:null);
    put('taker_buy_ratio_5m',share(q5));put('taker_buy_ratio_15m',share(o.slice(-15)));put('taker_buy_ratio_60m',o.length>=60?share(o.slice(-60)):null);
    put('buyer_share_change',sub(v.taker_buy_ratio_5m,v.taker_buy_ratio_60m));
  }else for(const k of ['distance_high_60m','minutes_since_high_60m','distance_high_4h','distance_low_15m','distance_sma20','last_body','last_upper_wick',
    'distance_trigger_reference','quote_volume_5m_usdt','volume_ratio_5m_vs_60m','taker_buy_ratio_5m','taker_buy_ratio_15m','taker_buy_ratio_60m','buyer_share_change'])put(k,null,'NO_COMPLETED_CANDLE');
  put('btc_return_15m',ret(b,15));put('btc_return_60m',ret(b,60));
  put('relative_strength_15m',sub(v.return_15m,v.btc_return_15m));put('relative_strength_60m',sub(v.return_60m,v.btc_return_60m));
  put('signal_rank',ctx.rank,'NOT_STAMPED');
  // derivatives: only points already published before asOf
  const oi=(Array.isArray(src.oiHist)?src.oiHist:[]).map(x=>({t:Number(x?.timestamp),v:num(x?.sumOpenInterest),usd:num(x?.sumOpenInterestValue)}))
    .filter(x=>Number.isSafeInteger(x.t)&&x.t<=asOf&&x.v>0).sort((a,b)=>a.t-b.t);
  const ol=oi.at(-1),op=oi.at(-2),oh=ol&&oi.find(x=>x.t===ol.t-3600000),oiFresh=ol&&asOf-ol.t<=11*MIN;
  put('open_interest_usdt',oiFresh?ol.usd:null,'OI_UNAVAILABLE_OR_STALE');
  put('oi_change_5m',oiFresh&&op&&ol.t-op.t===300000?ol.v/op.v-1:null,'OI_UNAVAILABLE_OR_STALE');
  put('oi_change_60m',oiFresh&&oh?ol.v/oh.v-1:null,'OI_UNAVAILABLE_OR_STALE');
  const pk=(Array.isArray(src.premium)?src.premium:[]).filter(r=>Array.isArray(r)&&Number(r[6])<asOf).sort((a,b)=>Number(a[0])-Number(b[0])).at(-1);
  put('premium_index',pk&&asOf-Number(pk[6])<=3*MIN?pk[4]:null,'PREMIUM_UNAVAILABLE');
  put('funding_rate',src.funding?.rate,'FUNDING_UNAVAILABLE');
  const bk=src.book?bookFacts(src.book):null;
  for(const k of MICRO_KEYS)put(k,bk?.[k]??null,src.book?'BOOK_INVALID':(src.bookMissingReason??'BOOK_NOT_COLLECTED'));
  const p=ctx.position;
  if(p&&last){
    const quoteAt=src.book?.requestedAtMs,receivedAt=src.book?.receivedAtMs,exchangeAt=Number(src.book?.T??src.book?.E);
    const liveValid=bk&&Number.isSafeInteger(quoteAt)&&Number.isSafeInteger(receivedAt)&&quoteAt<=receivedAt&&
      receivedAt<=asOf&&asOf-quoteAt<=5000&&Number.isSafeInteger(exchangeAt)&&exchangeAt<=asOf&&asOf-exchangeAt<=5000;
    const price=p.requireLiveQuote?(liveValid?Number(src.book.bids[0][0]):null):last.c;
    const entry=num(p.entryPrice),peak=Math.max(num(p.peakPrice)??entry,entry,price??0),stop=num(p.stopPrice);
    put('position_return',price!==null&&entry>0?price/entry-1:null);put('position_peak_return',entry>0?peak/entry-1:null);
    put('position_drawdown_from_peak',price!==null&&peak>0?price/peak-1:null);
    put('position_minutes_held',num(p.entryAt)!==null?(asOf-Number(p.entryAt))/MIN:null);
    put('position_minutes_since_new_high',num(p.lastHighAt)!==null?(asOf-Number(p.lastHighAt))/MIN:null);
    put('position_stop_distance',price!==null&&stop>0?price/stop-1:null);
  }else for(const k of POSITION_KEYS)put(k,null,'NOT_A_POSITION_REVIEW');
  return {version:FACTS_VERSION,values:v,missing:why,...(src.captureContext?{capture_context:src.captureContext}:{}),quality:{candles_complete:candlesComplete,
    micro_complete:MICRO_KEYS.every(k=>v[k]!==null),derivatives_complete:['funding_rate','premium_index','oi_change_5m'].every(k=>v[k]!==null),
    last_close:last?.c??null,last_close_at_ms:last?.end??null}};
}

/** Machine-model judgments, sent as REFERENCE ONLY and never merged into raw facts. */
export function modelJudgments(features){
  const f=features??{},b=f.b06133??{},c=f.cec0040??{},t=f.v17Setup??{},v=f.v30Front??null;
  const tri=x=>x===true||x===false?x:null;
  return {
    v17:{strategy:f.strategy??null,setup_state:t.state??null,rank:num(f.rank),day_return:num(f.dayReturn),
      signal_return_5m:num(f.return5m),confirmation_return_15m:num(f.confirmationReturn15m),note:'V17 generated this candidate (top-10 KST day leader, 5m confirmation, pullback then re-acceleration trigger)'},
    b06133:{allowed:b.allowed===true,branch:b.branch??null,reason:b.reason??null,
      factors:Object.fromEntries(['absorption','volumeTails','fresh15over30','btcAnyUp','buyerShareRise','fresh5over15','recentHourLead'].map(k=>[k,tri(b.factors?.[k])]))},
    v30:v?{admitted:v.admitted===true,failed:[...(v.failed??[])],negative_evidence:[...(v.negativeEvidence??[])],
      rule:'volumeTails=false is required; fresh5over15=false is negative evidence for GPT, not a veto'}:null,
    cec0040:{action:c.action??null,effective_allowed:c.effectiveAllowed===true,ready:c.ready===true,prediction_usdt_per_trade:num(c.predictionUsdt),
      note:'strategy-wide causal edge estimate from recent closed trades (not symbol specific)'}
  };
}
