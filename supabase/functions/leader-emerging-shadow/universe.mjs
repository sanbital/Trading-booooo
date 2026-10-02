/** LE-SHADOW-1 universe: live KST-day ranking from the regime observer's 5-minute prices.
 * Pure. No I/O. The universe costs zero Binance weight: prices come from
 * market_regime_observations.liquid_prices ('BF:<SYMBOL>' keys), the KST-day anchor is the
 * first observer snapshot at/after 15:00Z, and the COIN-perpetual filter is the production
 * activeSymbols() applied to a once-per-day exchangeInfo read. */
export const MIN=60_000,DAY=86_400_000,KST_OFFSET=9*3_600_000;
export const OBSERVER_REVISION='MARKET-REGIME-OBSERVER-v2-C01-HYSTERESIS-v1-FULLMARKET';
export const OBSERVER_MAX_AGE_MS=6*MIN;
export const ANCHOR_ON_TIME_MS=6*MIN;
/** velocity is void for 60 minutes after KST midnight (the mechanical day-open rank jump) */
export const VELOCITY_BLACKOUT_MS=60*MIN;
/** a historical cycle is accepted as "N minutes ago" within this tolerance */
export const HISTORY_TOLERANCE_MS=150_000;
const SYMBOL=/^[A-Z0-9]{1,40}USDT$/;

export function kstDayStart(t){return Math.floor((t+KST_OFFSET)/DAY)*DAY-KST_OFFSET;}
export function kstDay(t){return new Date(kstDayStart(t)+KST_OFFSET).toISOString().slice(0,10);}

/** liquid_prices -> Map(symbol -> price) for BF: (Binance futures) keys only. */
export function observerPrices(liquid){
  const out=new Map();
  if(!liquid||typeof liquid!=='object')return out;
  for(const [k,v] of Object.entries(liquid)){
    if(!k.startsWith('BF:'))continue;
    const s=k.slice(3),p=Number(v);
    if(SYMBOL.test(s)&&Number.isFinite(p)&&p>0)out.set(s,p);
  }
  return out;
}

/** /fapi/v1/ticker/price (all symbols) -> Map(symbol -> price). */
export function tickerPrices(rows){
  const out=new Map();
  for(const r of Array.isArray(rows)?rows:[]){const s=String(r?.symbol??''),p=Number(r?.price);if(SYMBOL.test(s)&&p>0)out.set(s,p);}
  return out;
}

/**
 * Rank the COIN perpetual universe by live KST-day return (desc, ties by symbol).
 * Symbols without an anchor price (listed after the anchor) are left out and counted.
 */
export function rankUniverse(prices,anchorPrices,coinSymbols){
  const coin=new Set(coinSymbols),rows=[];let unanchored=0;
  for(const [s,p] of prices){
    if(!coin.has(s))continue;
    const a=Number(anchorPrices?.[s]);
    if(!(a>0)){unanchored++;continue;}
    rows.push({symbol:s,price:p,anchor:a,dayReturn:p/a-1});
  }
  rows.sort((x,y)=>y.dayReturn-x.dayReturn||(x.symbol<y.symbol?-1:x.symbol>y.symbol?1:0));
  rows.forEach((r,i)=>{r.rank=i+1;});
  return {ranked:rows,unanchored};
}

/** Choose the historical cycle closest to `target` within tolerance (cycles: [{observedAt, rankOrder}]). */
export function cycleNear(cycles,target,tol=HISTORY_TOLERANCE_MS){
  let best=null;
  for(const c of cycles){const d=Math.abs(c.observedAt-target);if(d<=tol&&(!best||d<Math.abs(best.observedAt-target)))best=c;}
  return best;
}
export function rankIn(cycle,symbol){
  if(!cycle)return null;
  const i=cycle.rankOrder.indexOf(symbol);
  return i<0?null:i+1;
}

/**
 * Velocity validity for one cycle observed at `t`: void inside the first 60 minutes after KST
 * midnight, and void for any lookback whose reference snapshot is from an earlier KST day.
 */
export function velocityWindow(t,refs){
  const start=kstDayStart(t),sinceMidnight=t-start;
  const blackout=sinceMidnight<VELOCITY_BLACKOUT_MS;
  const ok=ref=>!!ref&&!blackout&&ref.observedAt>=start&&ref.observedAt<t;
  return {minutesSinceMidnight:Math.floor(sinceMidnight/MIN),blackout,valid15:ok(refs.m15),valid30:ok(refs.m30),valid60:ok(refs.m60)};
}

/**
 * Per-symbol day history from today's earlier cycles (top10 prefixes only).
 * @param today [{observedAt, top10:[symbols]}] strictly before `t`, same KST day
 */
export function dayHistory(today,t){
  const firstTop3=new Map(),lastTop3=new Map(),firstTop10=new Map(),top10Count=new Map();
  for(const c of [...today].sort((a,b)=>a.observedAt-b.observedAt)){
    if(!(c.observedAt<t))continue;
    c.top10.forEach((s,i)=>{
      if(i<3){if(!firstTop3.has(s))firstTop3.set(s,c.observedAt);lastTop3.set(s,c.observedAt);}
      if(!firstTop10.has(s))firstTop10.set(s,c.observedAt);
      top10Count.set(s,(top10Count.get(s)??0)+1);
    });
  }
  return {firstTop3,lastTop3,firstTop10,top10Count};
}
