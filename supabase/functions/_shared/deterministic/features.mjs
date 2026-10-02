/** Completed candles only. One shared feature cache per minute, not per decision. */
import {technicalFacts,candleShape} from './technical.mjs';
import {bucketDynamics,trajectoryDynamics} from './trajectory.mjs';
import {captureSafety} from './market-state.mjs';
import {PROFILE} from './calibration.mjs';
const MIN=60000,mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
export function candles(raw,interval,at){
 if(!Array.isArray(raw))throw Error('CANDLE_SOURCE_INVALID');
 const a=raw.filter(x=>Number(x?.[6])<at).map(x=>({t:Number(x[0]),end:Number(x[6]),o:Number(x[1]),h:Number(x[2]),l:Number(x[3]),c:Number(x[4]),q:Number(x[7]),buy:Number(x[10])})).sort((a,b)=>a.t-b.t);
 for(let i=0;i<a.length;i++){const x=a[i];if(!Number.isSafeInteger(x.t)||x.t%interval!==0||x.end!==x.t+interval-1||
  ![x.o,x.h,x.l,x.c,x.q,x.buy].every(Number.isFinite)||Math.min(x.o,x.h,x.l,x.c)<=0||x.h<Math.max(x.o,x.c)||x.l>Math.min(x.o,x.c)||x.q<0||x.buy<0||x.buy>x.q*(1+1e-9)||i>0&&x.t-a[i-1].t!==interval)throw Error('NONCAUSAL_OR_INCOMPLETE_CANDLES');}
 return a;
}
const ret=(a,n)=>a.length>n?a.at(-1).c/a.at(-1-n).c-1:null;
const sum=(a,k)=>a.reduce((s,x)=>s+x[k],0);
function ema(a,n){if(a.length<n)return null;let x=mean(a.slice(0,n).map(x=>x.c));for(const p of a.slice(n))x+=(p.c-x)*2/(n+1);return x;}
export function completedFeatures({one,five,btc,at}){
 const a=candles(one,MIN,at),b=candles(five,5*MIN,at),market=candles(btc,MIN,at),last=a.at(-1);
 const technical=technicalFacts(a,b),v={...technical.values};
 for(const n of [1,5,15,30,60])v['return_'+n+'m']=ret(a,n);
 v.return_4h=ret(b,48);
 v.accel_5m_vs_15m=v.return_5m-v.return_15m/3;
 v.accel_15m_vs_60m=v.return_15m-v.return_60m/4;
 for(const n of [9,20,50]){const e=ema(a,n),old=ema(a.slice(0,-5),n);v['ema'+n]=e;v['ema'+n+'_slope']=e&&old?e/old-1:null;v['ema'+n+'_distance']=e&&last?last.c/e-1:null;}
 v.btc_return_1m=ret(market,1);v.btc_return_15m=ret(market,15);v.btc_return_60m=ret(market,60);
 v.btc_atr_normalized=technicalFacts(market,[]).values.atr_1m_14_normalized;
 v.relative_strength_15m=v.return_15m-v.btc_return_15m;v.relative_strength_60m=v.return_60m-v.btc_return_60m;
 v.realized_volatility=mean(a.slice(-60).slice(1).map((x,i)=>(Math.log(x.c/a.slice(-60)[i].c))**2))**.5;
 if(last){
  const s=candleShape(last);v.last_body=s.body;v.last_upper_wick=s.upper_wick;v.last_lower_wick=s.lower_wick;
  v.candle_range_atr=s.range/v.atr_1m_14_normalized;
  for(const n of [15,60]){v['recent_high_'+n+'m']=Math.max(...a.slice(-n).map(x=>x.h));v['recent_low_'+n+'m']=Math.min(...a.slice(-n).map(x=>x.l));v['distance_high_'+n+'m']=last.c/v['recent_high_'+n+'m']-1;}
  v.distance_high_4h=last.c/Math.max(...b.slice(-48).map(x=>x.h),last.h)-1;
  const base=a.slice(-60,-5),baseline=base.length?mean(base.map(x=>x.q)):null;
  for(const n of [1,5,15,60])v['quote_volume_'+n+'m_usdt']=sum(a.slice(-n),'q');
  v.quote_volume_60m_baseline=baseline;v.volume_ratio_5m_vs_60m=baseline>0?mean(a.slice(-5).map(x=>x.q))/baseline:null;
  v.volume_ratio_1m_vs_baseline=baseline>0?last.q/baseline:null;
  v.breakout_volume=last.c>a.at(-2)?.h?last.q:null;v.pullback_volume=last.c<a.at(-2)?.c?last.q:null;
  v.sell_volume_expansion=last.c<last.o&&last.q>a.at(-2)?.q;
  const precedingPeak=Math.max(...a.slice(-15,-1).map(x=>x.q));v.volume_climax_decline=baseline>0&&precedingPeak/baseline>PROFILE.bands.volume.caution&&last.q<baseline&&s.upper_wick>Math.abs(s.body);
  for(const n of [5,15,60]){const xs=a.slice(-n),q=sum(xs,'q');v['taker_buy_ratio_'+n+'m']=q>0?sum(xs,'buy')/q:null;}
  v.buyer_share_change=v.taker_buy_ratio_5m-v.taker_buy_ratio_60m;
  v.higher_high=Math.max(...a.slice(-5).map(x=>x.h))>Math.max(...a.slice(-10,-5).map(x=>x.h));
  v.higher_low=Math.min(...a.slice(-5).map(x=>x.l))>Math.min(...a.slice(-10,-5).map(x=>x.l));
  for(const kind of ['bullish','bearish']){let count=0;for(const x of [...a].reverse()){if(kind==='bullish'?x.c>x.o:x.c<x.o)count++;else break;}v['consecutive_'+kind]=count;}
  const prev=a.at(-2);v.engulfing=!!prev&&last.o<=prev.c&&last.c>=prev.o&&last.c>last.o&&prev.c<prev.o;
  v.failed_breakout_candle=!!prev&&last.h>prev.h&&last.c<prev.h&&s.upper_wick>Math.abs(s.body);
 }
 return {values:v,quality:{candles_complete:a.length>=61&&b.length>=49&&market.length>=61&&at-last?.end<=90000&&at-b.at(-1)?.end<=330000&&at-market.at(-1)?.end<=90000,
  last_close:last?.c??null,last_close_at_ms:last?.end??null},technical_context:{completed_1m_count:a.length,completed_5m_count:b.length,recent_1m_candles:a.slice(-5).map(candleShape)}};
}
export function normalizeCapture(raw,at){
 if(raw?.status!=='AVAILABLE')return raw??{status:'UNAVAILABLE',reason:'MISSING'};
 try{
  if(!Array.isArray(raw.trajectory)||raw.trajectory.length!==24)return {status:'UNAVAILABLE',reason:'INCOMPLETE_TRAJECTORY'};
  const c={...raw,trajectory:bucketDynamics(raw.trajectory),dynamics:trajectoryDynamics(raw.trajectory)},safety=captureSafety(c,at);
  return safety.ok?c:{status:'UNAVAILABLE',reason:safety.reason};
 }catch{return {status:'UNAVAILABLE',reason:'MALFORMED_TRAJECTORY'};}
}
export function mergeSnapshot(facts,capture,{return24h=null,rank=null,derivatives=null}={}){
 const v={...facts?.values},p=capture?.trajectory?.at(-1);
 if(p){v.spread_bps=p.spread_bps;v.book_imbalance_25bps=p.imbalance;v.bid_depth_25bps_usdt=p.bid_depth_25_usdt;v.ask_depth_25bps_usdt=p.ask_depth_25_usdt;
  v.expected_entry_vwap=p.mid*(1+p.buy_impact_450_bps/10000);v.expected_exit_vwap=p.mid*(1-p.sell_impact_450_bps/10000);
  v.expected_execution_cost_bps=p.buy_impact_450_bps+p.sell_impact_450_bps+10;
  if(Number.isFinite(p.btc_return_1m))v.btc_return_1m=p.btc_return_1m;
 }
 v.day_return=return24h;v.signal_rank=rank;
 if(derivatives)Object.assign(v,derivatives);
 return {...facts,values:v};
}
export function createFeatureCache({fetchFn=fetch,now=Date.now,maxEntries=40}={}){
 const cache=new Map();
 const get=async(symbol,interval,limit,endTime)=>{
  const url='https://fapi.binance.com/fapi/v1/klines?'+new URLSearchParams({symbol,interval,limit:String(limit),endTime:String(endTime)});
  const r=await fetchFn(url,{redirect:'error',signal:AbortSignal.timeout(2500)});if(!r.ok)throw Error('CANDLE_HTTP_'+r.status);return r.json();
 };
 const series=(symbol,interval,limit,endTime)=>{const key=[symbol,interval,endTime].join(':');if(!cache.has(key)){
  const p=get(symbol,interval,limit,endTime).catch(e=>{cache.delete(key);throw e;});cache.set(key,p);
  while(cache.size>maxEntries*3)cache.delete(cache.keys().next().value);
 }return cache.get(key);};
 return {async read(symbol,at=now()){
  const end=Math.floor(at/MIN)*MIN-1,end5=Math.floor(at/(5*MIN))*5*MIN-1;
  const [one,five,btc]=await Promise.all([series(symbol,'1m',121,end),series(symbol,'5m',49,end5),series('BTCUSDT','1m',121,end)]);
  return completedFeatures({one,five,btc,at});
 },size:()=>cache.size};
}
