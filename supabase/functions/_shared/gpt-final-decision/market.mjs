/** FD1 public-market reads (no account, no signature). LIVE reads the current state;
 * REPLAY reads Binance history endpoints with endTime strictly before `asOf`, so a
 * replay packet contains only what was published before the historical decision. */
const HOST='https://fapi.binance.com',MIN=60000;
async function get(fetchFn,path,ms){
  const r=await fetchFn(HOST+path,{method:'GET',redirect:'error',signal:AbortSignal.timeout(ms)});
  if(!r.ok)throw Error('HTTP_'+r.status);const t=await r.text();if(t.length>600000)throw Error('TOO_LARGE');return JSON.parse(t);
}
const q=o=>new URLSearchParams(Object.fromEntries(Object.entries(o).map(([k,v])=>[k,String(v)])));
/** @returns src for computeFacts, plus per-source errors. Never throws for a single source. */
export async function readSources(symbol,asOf,{mode='LIVE',fetchFn=fetch,ms=3000,btcCache=null}={}){
  if(!/^[\p{L}\p{N}_]{1,60}USDT$/u.test(symbol))throw Error('SYMBOL_INVALID');
  const end=Math.floor(asOf/MIN)*MIN-1,end5=Math.floor(asOf/(5*MIN))*5*MIN-1,errors={};
  const safe=async(name,fn)=>{try{return await fn();}catch(e){errors[name]=String(e?.message??e).slice(0,60);return null;}};
  const kl=(s,interval,limit,endTime)=>get(fetchFn,'/fapi/v1/klines?'+q({symbol:s,interval,limit,endTime}),ms);
  const btcKey='BTC:'+end;
  const btcRead=()=>kl('BTCUSDT','1m',61,end);
  const btc=btcCache?(btcCache.get(btcKey)??(btcCache.set(btcKey,safe('btc',btcRead)),btcCache.get(btcKey))):safe('btc',btcRead);
  const live=mode==='LIVE';
  const [one,five,b,oiHist,premium,funding,book]=await Promise.all([
    safe('one',()=>kl(symbol,'1m',121,end)),safe('five',()=>kl(symbol,'5m',49,end5)),btc,
    safe('oi',()=>get(fetchFn,'/futures/data/openInterestHist?'+q({symbol,period:'5m',limit:13,...(live?{}:{endTime:asOf})}),ms)),
    safe('premium',()=>get(fetchFn,'/fapi/v1/premiumIndexKlines?'+q({symbol,interval:'1m',limit:3,endTime:end}),ms)),
    live?safe('funding',async()=>({rate:Number((await get(fetchFn,'/fapi/v1/premiumIndex?'+q({symbol}),ms)).lastFundingRate)}))
      :safe('funding',async()=>{const x=await get(fetchFn,'/fapi/v1/fundingRate?'+q({symbol,limit:1,endTime:asOf}),ms);
        const r=Array.isArray(x)?x.filter(y=>Number(y.fundingTime)<=asOf).at(-1):null;return r?{rate:Number(r.fundingRate)}:null;}),
    live?safe('book',()=>get(fetchFn,'/fapi/v1/depth?'+q({symbol,limit:100}),ms)):Promise.resolve(null)]);
  return {src:{one,five,btc:b,oiHist,premium,funding,book,bookMissingReason:live?(book?null:'BOOK_UNAVAILABLE'):'NOT_POINT_IN_TIME_REPLAY'},errors};
}
