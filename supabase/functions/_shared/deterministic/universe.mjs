/** Membership supplies observation, never entry authority. */
import {PROFILE} from './calibration.mjs';
import {POLICY} from '../leader-momentum-v17.mjs';
export function selectTop20(info,tickers,books,at){
 if(!Array.isArray(info?.symbols)||!Array.isArray(tickers)||!Array.isArray(books))throw Error('UNIVERSE_SOURCE_INVALID');
 const metadata=new Map(info.symbols.filter(s=>s.status==='TRADING'&&s.contractType==='PERPETUAL'&&s.quoteAsset==='USDT'&&s.marginAsset==='USDT'&&s.underlyingType==='COIN').map(s=>[s.symbol,s]));
 const quotes=new Map(books.map(x=>[x.symbol,x])),eligible=[];
 for(const t of tickers){
  const meta=metadata.get(t.symbol),q=quotes.get(t.symbol),bid=Number(q?.bidPrice),ask=Number(q?.askPrice),filter=k=>meta?.filters?.find(x=>x.filterType===k),
   step=Number(filter('LOT_SIZE')?.stepSize),tick=Number(filter('PRICE_FILTER')?.tickSize),minimum=Number(filter('MIN_NOTIONAL')?.notional),volume=Number(t.quoteVolume),change=Number(t.priceChangePercent),close=Number(t.closeTime),bookAt=Number(q?.time);
  if(!meta||![step,tick,minimum,volume,change,close,bookAt,bid,ask,Number(q?.bidQty),Number(q?.askQty)].every(Number.isFinite)||step<=0||tick<=0||minimum<=0||
    volume<POLICY.minQuoteVolume24h||bid<=0||ask<bid||Number(q.bidQty)<=0||Number(q.askQty)<=0||close>at+1000||at-close>30000||bookAt>at+1000||at-bookAt>10000||
    (ask-bid)/((ask+bid)/2)*10000>Math.min(25,PROFILE.bands.spread_bps.block))continue;
  eligible.push({symbol:t.symbol,price_change_percent:change,quote_volume:volume,quantity_step:step,price_tick:tick,min_notional:minimum});
 }
 return eligible.sort((a,b)=>b.price_change_percent-a.price_change_percent||b.quote_volume-a.quote_volume||a.symbol.localeCompare(b.symbol)).slice(0,20).map((x,i)=>({rank:i+1,...x}));
}
export async function refreshUniverse(db,{fetchFn=fetch,now=Date.now,force=false}={}){
 const current=await db.rpc('deterministic_universe');if(current.error)throw Error('UNIVERSE_READ_FAILED');
 if(!force&&Date.parse(current.data?.next_refresh_at)>now())return current.data;
 const requested=now(),get=async p=>{const r=await fetchFn('https://fapi.binance.com/fapi/v1/'+p,{redirect:'error',signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error('UNIVERSE_HTTP_'+r.status);return r.json();};
 const [info,tickers,books]=await Promise.all([get('exchangeInfo'),get('ticker/24hr'),get('ticker/bookTicker')]);
 const at=now();if(at-requested>10000)throw Error('UNIVERSE_REQUEST_STALE');const members=selectTop20(info,tickers,books,at);
 if(members.length!==20)throw Error('TOP20_ELIGIBLE_COVERAGE_INCOMPLETE');
 const bytes=new TextEncoder().encode(JSON.stringify(members)),digest=await crypto.subtle.digest('SHA-256',bytes),source=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
 const snapshot={members,observed_at:new Date(at).toISOString(),next_refresh_at:new Date(at+60000).toISOString(),requested_at:new Date(requested).toISOString()};
 const r=await db.rpc('deterministic_publish_universe',{p_snapshot:snapshot,p_source_hash:source});if(r.error)throw Error('UNIVERSE_PUBLISH_FAILED');return r.data;
}
