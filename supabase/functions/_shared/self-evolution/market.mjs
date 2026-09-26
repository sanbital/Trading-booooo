/** Public market data ONLY. No signed Binance endpoint or API credential accepted. */
const PATHS=new Set(['/fapi/v1/exchangeInfo','/fapi/v1/ticker/24hr','/fapi/v1/klines','/fapi/v1/aggTrades','/fapi/v1/fundingRate']);
export async function publicMarket(path,params={},fetchFn=fetch){if(!PATHS.has(path)||Object.keys(params).some(k=>/signature|secret|key/i.test(k)))throw Error('MARKET_ENDPOINT_DENIED');
 if(params.symbol&&!/^[A-Z0-9]{1,24}USDT$/.test(params.symbol))throw Error('MARKET_SYMBOL');
 const r=await fetchFn('https://fapi.binance.com'+path+'?'+new URLSearchParams(params),{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000)});
 if(!r.ok)throw Error('BINANCE_PUBLIC_'+r.status);const raw=await r.text();if(raw.length>8000000)throw Error('MARKET_BODY_LIMIT');return JSON.parse(raw);
}
export async function marketUniverse(fetchFn=fetch){const [info,tickers]=await Promise.all([publicMarket('/fapi/v1/exchangeInfo',{},fetchFn),publicMarket('/fapi/v1/ticker/24hr',{},fetchFn)]);
 const active=info.symbols.filter(s=>s.status==='TRADING'&&s.contractType==='PERPETUAL'&&s.quoteAsset==='USDT'&&s.marginAsset==='USDT');
 const map=new Map(tickers.map(t=>[t.symbol,t]));return {captured_at_ms:Date.now(),source:'BINANCE_EXCHANGE_INFO_AND_ALL_24H_TICKERS',universe:active.map(s=>({symbol:s.symbol,onboard_ms:s.onboardDate,filters:s.filters,ticker:map.get(s.symbol)??null})),order_calls:0};}
export async function historicalPath(symbol,start,end,{fetchFn=fetch,maxPages=8}={}){
 // Historical 1m candles support long-window review. They cannot manufacture 5-second counterfactuals.
 const rows=[],pageLimit=499;let cursor=Math.floor(start/60000)*60000;
 for(let i=0;i<maxPages&&cursor<end;i++){const p=await publicMarket('/fapi/v1/klines',{symbol,interval:'1m',startTime:String(cursor),endTime:String(end),limit:String(pageLimit)},fetchFn);
  if(!p.length)break;rows.push(...p.filter(r=>Number(r[6])<=end));cursor=Number(p.at(-1)[0])+60000;if(p.length<pageLimit)break;}
 const funding=await publicMarket('/fapi/v1/fundingRate',{symbol,startTime:String(start),endTime:String(end),limit:'1000'},fetchFn);
 return {symbol,start,end,resolution_ms:60000,candles:rows.map(r=>({at_ms:Number(r[6]),open_ms:Number(r[0]),open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),price:Number(r[4]),quote:Number(r[7]),buy_quote:Number(r[10]),trades:Number(r[8])})),funding,
  coverage_complete:rows.length>0&&Number(rows[0][0])<=start&&Number(rows.at(-1)[6])>=end-60000,order_calls:0};
}
