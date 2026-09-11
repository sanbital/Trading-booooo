/** Public market observations only. No trade actions or account credentials. */
export const MARKET_VERSION='V18_PAPER_MARKET_1';
export function paperMarket(books,info,symbols,observedAt){
  if(!Array.isArray(books)||books.length===0||books.length>10000||!Array.isArray(info?.symbols)||
    !Number.isSafeInteger(observedAt))throw Error('INVALID_PAPER_MARKET_RESPONSE');
  const quotes=[],rules={},seen=new Set();let excludedQuotes=0;
  for(const b of books){
    if(typeof b.symbol!=='string'||!b.symbol.endsWith('USDT'))continue;
    if(seen.has(b.symbol))throw Error('DUPLICATE_BOOK_SYMBOL');seen.add(b.symbol);
    const values=[b.bidPrice,b.askPrice,b.bidQty,b.askQty,b.time];
    if(values.some(x=>x===null||x===''||x===undefined)){excludedQuotes++;continue;}
    const [bid,ask,bidQty,askQty,at]=values.map(Number);
    if(![bid,ask,bidQty,askQty,at].every(Number.isFinite)||bid<=0||ask<bid||bidQty<0||askQty<0||!Number.isSafeInteger(at)){
      excludedQuotes++;continue;
    }
    quotes.push({symbol:b.symbol,bid,ask,bidQty,askQty,at});
  }
  const wanted=new Set(symbols);
  for(const s of info.symbols){
    if(!wanted.has(s.symbol))continue;
    const f=Object.fromEntries((s.filters??[]).map(x=>[x.filterType,x]));
    rules[s.symbol]={step:Number(f.LOT_SIZE?.stepSize),tick:Number(f.PRICE_FILTER?.tickSize),
      minNotional:Number(f.MIN_NOTIONAL?.notional),
      trading:s.status==='TRADING'&&s.contractType==='PERPETUAL'&&s.quoteAsset==='USDT'&&s.underlyingType==='COIN'};
  }
  if(!quotes.length)throw Error('NO_VALID_PAPER_BOOKS');
  return {version:MARKET_VERSION,observedAt:new Date(observedAt).toISOString(),quotes,rules,excludedQuotes,
    depthModel:'L1_ONLY_NOT_GUARANTEED_FILLS',fundingVerified:false};
}
