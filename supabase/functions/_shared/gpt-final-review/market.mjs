import {LIMITS,VERSION,metric,numberOrNull,hash,ensure,arithmeticCheck,FACTORS} from './contract.mjs';
import {cacheFor} from './candle-cache.mjs';
import {readMicro,computeMicro,missingMicro} from './micro.mjs';
const MIN=60000;
const host='https://fapi.binance.com';
const fields=['return_5m','return_15m','return_30m','return_60m','volume_ratio_3m','taker_buy_ratio_3m',
  'relative_strength_btc_15m','distance_recent_high_15m','distance_sma20','distance_trigger_reference',
  'last_body','last_upper_wick','last_lower_wick','last_close_change','day_return'];
export function normalizeBars(raw,interval,cutoff){
  ensure(Array.isArray(raw),'BARS_NOT_ARRAY');
  const xs=raw.filter(b=>Array.isArray(b)&&Number(b[6])<cutoff).map(b=>{
    const t=Number(b[0]),end=Number(b[6]),o=Number(b[1]),h=Number(b[2]),l=Number(b[3]),c=Number(b[4]);
    ensure(Number.isSafeInteger(t)&&t%interval===0&&end===t+interval-1,'BAR_TIMING');
    ensure([o,h,l,c].every(v=>Number.isFinite(v)&&v>0)&&h>=Math.max(o,l,c)&&l<=Math.min(o,h,c),'BAR_OHLC');
    const volume=numberOrNull(b[5]),quote=numberOrNull(b[7]),buy=numberOrNull(b[10]);
    ensure(volume===null||volume>=0,'BAR_VOLUME');ensure(quote===null||quote>=0,'BAR_QUOTE_VOLUME');
    ensure(buy===null||(buy>=0&&quote!==null&&buy<=quote),'BAR_BUY_VOLUME');
    return {t,end,o,h,l,c,volume,quote,buy};
  }).sort((a,b)=>a.t-b.t);
  ensure(xs.every((b,i)=>i===0||b.t-xs[i-1].t===interval),'BAR_DUPLICATE_OR_GAP');return xs;
}
function missingMarket(reason){return {metrics:{...Object.fromEntries(fields.map(k=>[k,metric(null,'fraction','unavailable',reason)])),...missingMicro(reason)},
  one_minute:[],five_minute:[],quality:{complete:false,missing_reason:reason,microstructure_complete:false},availability:[],microstructure_availability:[]};}
/** A replay clock (shifted away from wall time) cannot read historical books/OI: withhold them. */
const POINT_IN_TIME_TOLERANCE_MS=2000;
/** Read public candles only. Never an exchange account or signed endpoint. */
export async function collectMarket(identity,{fetchFn=fetch,now=Date.now,deadlineMs,signal}={}){
  const requested=now(),symbol=identity.symbol;
  if(!/^[\p{L}\p{N}_]{1,60}USDT$/u.test(symbol))return missingMarket('SYMBOL_INVALID');
  const ms=Math.min(2500,deadlineMs-requested);
  if(ms<=0)return missingMarket('TRIGGER_EXPIRED');
  async function read(market,interval,limit){
    const duration=interval==='5m'?5*MIN:MIN;
    // Binance counts the in-progress bar toward limit. End at the last CLOSED bar.
    const endTime=Math.floor(requested/duration)*duration-1;
    const url=host+'/fapi/v1/klines?'+new URLSearchParams({symbol:market,interval,limit:String(limit),endTime:String(endTime)});
    const load=async()=>{
    const abort=AbortSignal.timeout(ms);
    const r=await fetchFn(url,{method:'GET',redirect:'error',signal:signal?AbortSignal.any([signal,abort]):abort});
    ensure(r.ok,'PUBLIC_MARKET_UNAVAILABLE');
    const text=await r.text();ensure(text.length<=200000,'MARKET_RESPONSE_TOO_LARGE');
    return {rows:JSON.parse(text),requestedAt:requested,receivedAt:now()};
    };
    // A caller-specific cancellation must not cancel another caller's shared read.
    return signal?load():cacheFor(fetchFn).read(url,load,now);
  }
  try{
    const live=Math.abs(requested-Date.now())<=POINT_IN_TIME_TOLERANCE_MS;
    const [one,five,btc,micro]=await Promise.all([read(symbol,'1m',61),read(symbol,'5m',12),read('BTCUSDT','1m',16),
      live?readMicro(symbol,{fetchFn,now,ms,signal}):Promise.resolve(null)]);
    return computeMarket(identity,{one,five,btc,micro,microMissingReason:live?null:'NOT_POINT_IN_TIME_REPLAY'},now());
  }catch{return missingMarket('PUBLIC_MARKET_UNAVAILABLE');}
}
export function computeMarket(identity,{one,five,btc,micro=null,microMissingReason='NOT_COLLECTED'},asOf){
  const o=normalizeBars(one.rows,MIN,one.requestedAt),f=normalizeBars(five.rows,5*MIN,five.requestedAt),b=normalizeBars(btc.rows,MIN,btc.requestedAt);
  ensure([one,five,btc].every(x=>Number.isSafeInteger(x.requestedAt)&&x.receivedAt>=x.requestedAt&&x.receivedAt<=asOf),'AVAILABILITY_INVALID');
  const last=o.at(-1);if(!last)return missingMarket('NO_COMPLETED_CANDLE');
  const metrics=Object.fromEntries(fields.map(k=>[k,metric(null,'fraction','not supplied by public candle source','NOT_COLLECTED')]));
  const put=(k,value,unit,formula)=>metrics[k]=metric(value,unit,formula,'INSUFFICIENT_COMPLETED_CANDLES');
  for(const n of [5,15,30,60])put('return_'+n+'m',o.length>n?last.c/o.at(-n-1).c-1:null,'fraction','last completed close / completed close N minutes earlier - 1');
  const recent=o.slice(-3),prior=o.slice(-6,-3),sum=(xs,k)=>xs.some(x=>x[k]===null)?null:xs.reduce((s,x)=>s+x[k],0);
  const rv=sum(recent,'volume'),pv=sum(prior,'volume'),qv=sum(recent,'quote'),buy=sum(recent,'buy');
  put('volume_ratio_3m',o.length>=6&&rv!==null&&pv>0?rv/pv:null,'ratio','volume of last 3 complete 1m bars / preceding 3 complete 1m bars');
  put('taker_buy_ratio_3m',recent.length===3&&buy!==null&&qv>0?buy/qv:null,'ratio','taker-buy quote volume / total quote volume in last 3 complete bars');
  const btcRet=b.length>=16?b.at(-1).c/b.at(-16).c-1:null;
  put('relative_strength_btc_15m',metrics.return_15m.value!==null&&btcRet!==null?metrics.return_15m.value-btcRet:null,'fraction_difference','symbol 15m return minus BTC 15m return');
  put('distance_recent_high_15m',o.length>=15?last.c/Math.max(...o.slice(-15).map(x=>x.h))-1:null,'fraction','latest close / max high of last 15 completed 1m bars - 1');
  put('distance_sma20',o.length>=20?last.c/(o.slice(-20).reduce((s,x)=>s+x.c,0)/20)-1:null,'fraction','latest close / SMA20 of completed 1m closes - 1');
  put('distance_trigger_reference',identity.reference_close>0?last.c/identity.reference_close-1:null,'fraction','latest close / original signal reference close - 1');
  put('last_body',last.c/last.o-1,'fraction','(close-open)/open');
  put('last_upper_wick',(last.h-Math.max(last.o,last.c))/last.o,'fraction','(high-max(open,close))/open');
  put('last_lower_wick',(Math.min(last.o,last.c)-last.l)/last.o,'fraction','(min(open,close)-low)/open');
  put('last_close_change',o.length>=2?last.c/o.at(-2).c-1:null,'fraction','latest close / preceding completed close - 1');
  const scale=100/last.c;
  const series=xs=>xs.map(x=>({open_offset_ms:x.t-identity.trigger_at_ms,close_offset_ms:x.end-identity.trigger_at_ms,
    open:x.o*scale,high:x.h*scale,low:x.l*scale,close:x.c*scale,unit:'price_index_latest_close_100'}));
  const complete=o.length>=61&&f.length>=12&&b.length>=16&&asOf-last.end<=90000&&
    asOf-f.at(-1).end<=330000&&asOf-b.at(-1).end<=90000;
  const ms=micro?computeMicro(micro,asOf):{metrics:missingMicro(microMissingReason),availability:[]};
  Object.assign(metrics,ms.metrics);
  const microComplete=ms.availability.length>0&&ms.availability.every(x=>x.ok);
  return {metrics,one_minute:series(o.slice(-LIMITS.bars1m)),five_minute:series(f.slice(-LIMITS.bars5m)),
    quality:{complete,missing_reason:complete?null:'INCOMPLETE_OR_STALE_CANDLES',microstructure_complete:microComplete,
      microstructure_max_age_ms:ms.availability.length?Math.max(...ms.availability.map(x=>x.age_at_snapshot_ms??Infinity)):null},
    microstructure_availability:ms.availability,
    availability:[one,five,btc].map((x,i)=>({source:['symbol_1m','symbol_5m','btc_1m'][i],
      requested_offset_ms:x.requestedAt-identity.trigger_at_ms,available_offset_ms:x.receivedAt-identity.trigger_at_ms}))};
}
export async function buildPacket(identity,current,asOf){
  const cid='c_'+(await hash(identity.signal_id)).slice(0,32),factorMetrics=Object.fromEntries(FACTORS.map(k=>
    [k,{value:identity.factors[k],unit:'boolean',formula:'original B06133 factor; verify against cited metrics',missing_reason:identity.factors[k]===null?'ORIGINAL_FACTOR_UNKNOWN':null}]));
  const originalMetrics=Object.fromEntries(Object.entries(identity.metrics).map(([k,v])=>[k,metric(v,k==='volumeRatio'?'ratio':'fraction','original selector source.featureValues.'+k)]));
  const pre=identity.prebars;
  const totalQuote=pre.length===3&&pre.every(x=>x.quoteVolume>0)?pre.reduce((sum,x)=>sum+x.quoteVolume,0):null;
  const totalBuy=pre.length===3&&pre.every(x=>x.takerBuyQuote!==null)?pre.reduce((sum,x)=>sum+x.takerBuyQuote,0):null;
  originalMetrics.btc_return30m=metric(identity.btc.return30m,'fraction','original completed BTC 15m bars: close[8]/close[6]-1');
  originalMetrics.btc_return2h=metric(identity.btc.return2h,'fraction','original completed BTC 15m bars: close[8]/close[0]-1');
  originalMetrics.source_buy_share_3m=metric(totalQuote>0&&totalBuy!==null?totalBuy/totalQuote:null,'ratio','sum taker-buy quote / sum quote across original three completed minutes');
  originalMetrics.source_price_change_3m=metric(pre.length===3&&pre[0].open>0&&pre[2].close>0?pre[2].close/pre[0].open-1:null,'fraction','original last completed close / first completed open - 1');
  for(const [i,name] of ['first','previous','latest'].entries()){
    const x=pre[i];originalMetrics['source_buy_share_'+name]=metric(x&&x.quoteVolume>0&&x.takerBuyQuote!==null?x.takerBuyQuote/x.quoteVolume:null,'ratio','original completed minute taker-buy quote / quote volume');
  }
  const packet={version:VERSION,candidate_id:cid,snapshot_hash:'',as_of_offset_ms:asOf-identity.trigger_at_ms,
    original_model:{proposed_action:'BUY_LONG',branch:identity.selector_branch,
      decision_basis:identity.selector_branch==='R62'?'absorption AND volumeTails AND fresh15over30 AND btcAnyUp':
        identity.selector_branch==='BUYER_SHARE_RESCUE'?'buyerShareRise AND NOT fresh5over15 AND NOT recentHourLead':
        '(absorption AND volumeTails AND fresh15over30 AND btcAnyUp) OR (buyerShareRise AND NOT fresh5over15 AND NOT recentHourLead)',
      metrics:originalMetrics,factors:factorMetrics,arithmetic_check:arithmeticCheck(identity),
      source_timing:{decision_offset_ms:0,original_available_offset_ms:null,
        missing_reason:'ORIGINAL_SELECTOR_RECEIPT_TIME_NOT_RECORDED; values are available at this new review snapshot, not claimed available at the historical trigger'},
      global_control:{scope:'STRATEGY_GLOBAL_NOT_SYMBOL_EXPECTED_RETURN',action:identity.cec.action,enforcement_enabled:identity.cec.enforcementEnabled}},
    current_market:current};
  packet.snapshot_hash=await packetHash(packet);
  ensure(new TextEncoder().encode(canonicalPacket(packet)).length<=LIMITS.inputBytes,'INPUT_TOO_LARGE');
  return packet;
}
import {canonical as canonicalPacket} from './contract.mjs';
export async function packetHash(packet){const p={...packet};delete p.snapshot_hash;return hash(p);}
