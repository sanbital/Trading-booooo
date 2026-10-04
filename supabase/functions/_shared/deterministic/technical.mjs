/** Completed candle technical mathematics. No advisory or provider authority. */
export const TECHNICAL_DEFS=Object.freeze({
 rsi_1m_14:['technical','0..100','Wilder RSI14, completed 1m candles'],
 rsi_5m_14:['technical','0..100','Wilder RSI14, completed 5m candles'],
 stoch_k_1m:['technical','0..100','Stochastic slow K: 14-period raw K smoothed by SMA3'],
 stoch_d_1m:['technical','0..100','SMA3 of slow K'],
 stoch_k_5m:['technical','0..100','5m slow K(14,3)'],
 stoch_d_5m:['technical','0..100','5m slow D(3)'],
 stoch_cross_1m:['technical','sign','+1 bullish K/D cross, -1 bearish cross, 0 none'],
 stoch_cross_5m:['technical','sign','5m K/D cross'],
 bb_mid:['technical','price','SMA20 of completed 1m closes'],
 bb_upper:['technical','price','SMA20 plus 2 population standard deviations'],
 bb_lower:['technical','price','SMA20 minus 2 population standard deviations'],
 bb_position:['technical','ratio','(close-lower)/(upper-lower), may exceed [0,1]'],
 bb_width:['technical','ratio','(upper-lower)/mid'],
 ema9_distance:['technical','fraction','close/EMA9-1; SMA9 seed'],
 ema20_distance:['technical','fraction','close/EMA20-1; SMA20 seed'],
 ema9_vs_ema20:['technical','fraction','EMA9/EMA20-1'],
 macd_line_1m:['technical','price','MACD EMA12-EMA26 on completed 1m closes'],
 macd_signal_1m:['technical','price','EMA9 of completed 1m MACD line'],
 macd_hist_1m:['technical','price','MACD line minus signal'],
 macd_hist_delta_1m:['technical','price','Change in MACD histogram versus prior completed 1m candle'],
 obv_1m:['technical','quote_volume','OBV using completed 1m quote volume'],
 obv_delta_5m:['technical','quote_volume','OBV change across five completed 1m candles'],
 atr_1m_14_normalized:['technical','fraction','Wilder ATR14 / completed close'],
 last_lower_wick:['candle','fraction','(min(open,close)-low)/open'],
 candle_range:['candle','fraction','(high-low)/open'],
 body_to_range:['candle','ratio','abs(close-open)/(high-low)'],
 close_location_value:['candle','ratio','(close-low)/(high-low)'],
});
const mean=xs=>xs.reduce((s,x)=>s+x,0)/xs.length,finite=Number.isFinite;
function emaNumeric(xs,n){
 const out=Array(xs.length).fill(null);if(xs.length<n)return out;
 let v=mean(xs.slice(0,n));out[n-1]=v;
 for(let i=n;i<xs.length;i++){v+=(xs[i]-v)*2/(n+1);out[i]=v;}
 return out;
}
function macd(xs){
 const closes=xs.map(x=>x.c),e12=emaNumeric(closes,12),e26=emaNumeric(closes,26);
 const line=closes.map((_,i)=>finite(e12[i])&&finite(e26[i])?e12[i]-e26[i]:null),start=line.findIndex(finite);
 if(start<0)return {line:null,signal:null,hist:null,delta:null};
 const sigTail=emaNumeric(line.slice(start),9),signal=Array(start).fill(null).concat(sigTail);
 const hist=line.map((x,i)=>finite(x)&&finite(signal[i])?x-signal[i]:null),vals=hist.filter(finite);
 return {line:[...line].reverse().find(finite)??null,signal:[...signal].reverse().find(finite)??null,hist:vals.at(-1)??null,delta:vals.length>1?vals.at(-1)-vals.at(-2):null};
}
function obv(xs){
 if(!xs.length)return {value:null,delta5:null};
 let v=0;const series=[0];
 for(let i=1;i<xs.length;i++){if(xs[i].c>xs[i-1].c)v+=xs[i].q;else if(xs[i].c<xs[i-1].c)v-=xs[i].q;series.push(v);}
 return {value:v,delta5:series.length>5?v-series.at(-6):null};
}
function wilder(xs,n){if(xs.length<n)return null;let v=mean(xs.slice(0,n));for(const x of xs.slice(n))v=(v*(n-1)+x)/n;return v;}
function rsi(xs){const d=xs.slice(1).map((x,i)=>x.c-xs[i].c),up=wilder(d.map(x=>Math.max(0,x)),14),down=wilder(d.map(x=>Math.max(0,-x)),14);
 return up===null?null:up===0&&down===0?50:down===0?100:100-100/(1+up/down);}
function stoch(xs){const raw=[];for(let i=13;i<xs.length;i++){const w=xs.slice(i-13,i+1),hi=Math.max(...w.map(x=>x.h)),lo=Math.min(...w.map(x=>x.l));raw.push(hi===lo?null:100*(xs[i].c-lo)/(hi-lo));}
 const smooth=ys=>ys.slice(2).map((_,i)=>ys.slice(i,i+3).every(Number.isFinite)?mean(ys.slice(i,i+3)):null),ks=smooth(raw),ds=smooth(ks),k=ks.at(-1)??null,d=ds.at(-1)??null,pk=ks.at(-2),pd=ds.at(-2);
 return {k,d,cross:[k,d,pk,pd].every(Number.isFinite)?pk<=pd&&k>d?1:pk>=pd&&k<d?-1:0:null};}
function ema(xs,n){if(xs.length<n)return null;let v=mean(xs.slice(0,n).map(x=>x.c));for(const x of xs.slice(n))v+=(x.c-v)*2/(n+1);return v;}
export function candleShape(x){const range=x.h-x.l;return {closed_at_ms:x.end,body_sign:Math.sign(x.c-x.o),body:(x.c-x.o)/x.o,
 upper_wick:(x.h-Math.max(x.o,x.c))/x.o,lower_wick:(Math.min(x.o,x.c)-x.l)/x.o,range:range/x.o,
 body_to_range:range>0?Math.abs(x.c-x.o)/range:null,close_location:range>0?(x.c-x.l)/range:null};}
export function technicalFacts(one,five){
 const v=Object.fromEntries(Object.keys(TECHNICAL_DEFS).map(k=>[k,null])),last=one.at(-1),a=stoch(one),b=stoch(five),e9=ema(one,9),e20=ema(one,20),m=macd(one),o=obv(one);
 Object.assign(v,{rsi_1m_14:rsi(one),rsi_5m_14:rsi(five),stoch_k_1m:a.k,stoch_d_1m:a.d,stoch_k_5m:b.k,stoch_d_5m:b.d,stoch_cross_1m:a.cross,stoch_cross_5m:b.cross,
  macd_line_1m:m.line,macd_signal_1m:m.signal,macd_hist_1m:m.hist,macd_hist_delta_1m:m.delta,obv_1m:o.value,obv_delta_5m:o.delta5});
 if(last){const shape=candleShape(last);Object.assign(v,{last_lower_wick:shape.lower_wick,candle_range:shape.range,body_to_range:shape.body_to_range,close_location_value:shape.close_location,
  ema9_distance:e9?last.c/e9-1:null,ema20_distance:e20?last.c/e20-1:null,ema9_vs_ema20:e9&&e20?e9/e20-1:null});
  if(one.length>=20){const closes=one.slice(-20).map(x=>x.c),mid=mean(closes),sd=Math.sqrt(mean(closes.map(c=>(c-mid)**2))),upper=mid+2*sd,lower=mid-2*sd;
   Object.assign(v,{bb_mid:mid,bb_upper:upper,bb_lower:lower,bb_position:sd>0?(last.c-lower)/(upper-lower):null,bb_width:(upper-lower)/mid});}
  const atr=wilder(one.slice(1).map((x,i)=>Math.max(x.h-x.l,Math.abs(x.h-one[i].c),Math.abs(x.l-one[i].c))),14);v.atr_1m_14_normalized=atr===null?null:atr/last.c;
 }
 return {values:v,missing:Object.fromEntries(Object.entries(v).filter(([,x])=>x===null).map(([k])=>[k,
  ((k==='bb_position'&&v.bb_width===0)||(['body_to_range','close_location_value'].includes(k)&&v.candle_range===0))?'ZERO_RANGE':'INSUFFICIENT_COMPLETED_HISTORY_OR_ZERO_RANGE'])),
  context:{version:'COMPLETED_TECHNICAL_1',completed_1m_count:one.length,completed_5m_count:five.length,
   recent_1m_candles:one.slice(-3).map(candleShape),recent_candles_missing_reason:one.length<3?'INSUFFICIENT_COMPLETED_HISTORY':null}};
}
