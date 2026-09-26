/** Review-time market microstructure from PUBLIC Binance USD-M endpoints only
 * (no account, no signature): order book, mark/index premium + funding, open interest.
 * Values describe the book a few seconds BEFORE the GPT answer; the executor still
 * re-reads the live quote/depth immediately before any order (unchanged guards). */
import {ensure,metric,numberOrNull} from './contract.mjs';
const host='https://fapi.binance.com';
/** Max age of any microstructure source at snapshot time; older values are withheld. */
export const MICRO_MAX_AGE_MS=5000;
/** Target order notional of one slot (200 USDT x 3). Reference only; sizing is unchanged. */
export const SLOT_ORDER_NOTIONAL_USDT=450;
export const MICRO_FIELDS=Object.freeze({
  spread:['bps','best ask / best bid - 1, in basis points of mid, from the order book snapshot'],
  depth:['USDT','ask-side notional within 25 bps above mid (liquidity available to a buyer)'],
  bid_depth_25bps:['USDT','bid-side notional within 25 bps below mid'],
  book_imbalance_25bps:['ratio','(bid notional - ask notional) / (bid + ask) within 25 bps of mid'],
  ask_depth_to_slot_notional:['ratio','ask notional within 25 bps / 450 USDT slot order notional'],
  funding:['fraction','last funding rate per funding interval (premiumIndex.lastFundingRate)'],
  mark_index_premium:['fraction','mark price / index price - 1'],
  open_interest_usdt:['USDT','open interest contracts x mark price'],
  oi_change_5m:['fraction','latest 5m open-interest bucket / previous bucket - 1'],
  oi_change_60m:['fraction','latest 5m open-interest bucket / bucket 60 minutes earlier - 1']
});
export function missingMicro(reason){
  return Object.fromEntries(Object.entries(MICRO_FIELDS).map(([k,[unit,formula]])=>[k,metric(null,unit,formula,reason)]));
}
/** Pure. Each source is {data,requestedAt,receivedAt}|{error}. asOf = snapshot time. */
export function computeMicro({book,premium,oi,oiHist},asOf){
  const m=missingMicro('NOT_COLLECTED'),put=(k,v,reason)=>{m[k]=metric(v,MICRO_FIELDS[k][0],MICRO_FIELDS[k][1],reason);};
  const fresh=x=>x&&!x.error&&Number.isSafeInteger(x.requestedAt)&&Number.isSafeInteger(x.receivedAt)&&
    x.receivedAt>=x.requestedAt&&x.receivedAt<=asOf&&asOf-x.receivedAt<=MICRO_MAX_AGE_MS;
  const why=x=>!x||x.error?'SOURCE_UNAVAILABLE':'STALE_OR_INVALID_TIMING';
  if(fresh(book)){
    const lvl=a=>(Array.isArray(a)?a:[]).map(r=>[Number(r?.[0]),Number(r?.[1])]).filter(([p,q])=>p>0&&q>=0&&Number.isFinite(p)&&Number.isFinite(q));
    const bids=lvl(book.data?.bids),asks=lvl(book.data?.asks),bid=bids[0]?.[0],ask=asks[0]?.[0];
    if(bid>0&&ask>=bid){
      const mid=(bid+ask)/2,band=mid*.0025;
      const bidN=bids.filter(([p])=>p>=mid-band).reduce((s,[p,q])=>s+p*q,0),askN=asks.filter(([p])=>p<=mid+band).reduce((s,[p,q])=>s+p*q,0);
      put('spread',(ask-bid)/mid*1e4);put('depth',askN);put('bid_depth_25bps',bidN);
      put('book_imbalance_25bps',bidN+askN>0?(bidN-askN)/(bidN+askN):null,'EMPTY_BOOK_BAND');
      put('ask_depth_to_slot_notional',askN/SLOT_ORDER_NOTIONAL_USDT);
    }else for(const k of ['spread','depth','bid_depth_25bps','book_imbalance_25bps','ask_depth_to_slot_notional'])put(k,null,'BOOK_INVALID');
  }else for(const k of ['spread','depth','bid_depth_25bps','book_imbalance_25bps','ask_depth_to_slot_notional'])put(k,null,why(book));
  let mark=null;
  if(fresh(premium)){
    mark=numberOrNull(premium.data?.markPrice);const index=numberOrNull(premium.data?.indexPrice);
    put('funding',numberOrNull(premium.data?.lastFundingRate),'FUNDING_UNAVAILABLE');
    put('mark_index_premium',mark>0&&index>0?mark/index-1:null,'PREMIUM_UNAVAILABLE');
  }else{put('funding',null,why(premium));put('mark_index_premium',null,why(premium));}
  if(fresh(oi)&&mark>0){const c=numberOrNull(oi.data?.openInterest);put('open_interest_usdt',c>=0?c*mark:null,'OI_UNAVAILABLE');}
  else put('open_interest_usdt',null,fresh(oi)?'MARK_UNAVAILABLE':why(oi));
  if(fresh(oiHist)&&Array.isArray(oiHist.data)){
    const xs=oiHist.data.map(x=>({t:Number(x?.timestamp),v:Number(x?.sumOpenInterest)})).filter(x=>Number.isSafeInteger(x.t)&&x.v>0).sort((a,b)=>a.t-b.t);
    const last=xs.at(-1),prev=xs.at(-2),hour=last&&xs.find(x=>x.t===last.t-3600000);
    put('oi_change_5m',last&&prev&&last.t-prev.t===300000?last.v/prev.v-1:null,'OI_HISTORY_GAP');
    put('oi_change_60m',hour?last.v/hour.v-1:null,'OI_HISTORY_GAP');
  }else{put('oi_change_5m',null,why(oiHist));put('oi_change_60m',null,why(oiHist));}
  const sources={book,premium,oi,oi_history:oiHist};
  return {metrics:m,availability:Object.entries(sources).map(([source,x])=>({source,ok:fresh(x),
    request_ms:x&&Number.isSafeInteger(x.requestedAt)&&Number.isSafeInteger(x.receivedAt)?x.receivedAt-x.requestedAt:null,
    age_at_snapshot_ms:x&&Number.isSafeInteger(x.receivedAt)?asOf-x.receivedAt:null}))};
}
/** Four bounded public reads in parallel; a failure only blanks that source. */
export async function readMicro(symbol,{fetchFn=fetch,now=Date.now,ms=2000,signal}={}){
  ensure(/^[A-Z0-9]{2,60}USDT$/.test(symbol),'SYMBOL_INVALID');
  const get=async path=>{
    const requestedAt=now();
    try{
      const abort=AbortSignal.timeout(ms),r=await fetchFn(host+path,{method:'GET',redirect:'error',signal:signal?AbortSignal.any([signal,abort]):abort});
      if(!r.ok)return {error:'HTTP_'+r.status};
      const text=await r.text();if(text.length>400000)return {error:'TOO_LARGE'};
      return {data:JSON.parse(text),requestedAt,receivedAt:now()};
    }catch{return {error:'FETCH_FAILED'};}
  };
  const q=s=>new URLSearchParams({symbol:s});
  const [book,premium,oi,oiHist]=await Promise.all([get('/fapi/v1/depth?'+q(symbol)+'&limit=100'),get('/fapi/v1/premiumIndex?'+q(symbol)),
    get('/fapi/v1/openInterest?'+q(symbol)),get('/futures/data/openInterestHist?'+q(symbol)+'&period=5m&limit=13')]);
  return {book,premium,oi,oiHist};
}
