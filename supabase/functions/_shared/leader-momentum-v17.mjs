/** Pure production policy. No exchange/account access and no order side effects.
 * Percent values are UNLEVERAGED price returns. Defaults are unoptimized engineering
 * starting values, NOT results of the unfinished Binance backtest.
 */
export const STRATEGY = 'LEADER_MOMENTUM_V17';
export const POLICY = Object.freeze({
  rankLimit: 10, minDayReturn: .03, min30mReturn: .0075,
  min60mReturn: .015, minVolumeRatio: 1.1, minQuoteVolume24h: 5_000_000,
  min5mReturn: .002, stopPct: .025, trailArmPct: .03, trailGapPct: .015,
  staleMs: 45*60_000, maxHoldMs: 6*60*60_000, maxEntryAgeMs: 120_000,
  maxEntryDriftPct: .01, cooldownMs: 30*60_000, maxSlots: 10,
  minCoverage: .98, marginUsdt: 40, leverage: 3,
});
export const M5=300_000, M15=900_000, DAY=86_400_000;
const num=v=>typeof v==='number'?v:(typeof v==='string'&&v.trim()!==''?Number(v):NaN);
const cmp=(a,b)=>a<b?-1:a>b?1:0;
export function kstDayStart(t) {
  if(!Number.isSafeInteger(t)||t<0) throw Error('INVALID_TIMESTAMP');
  return Math.floor((t+9*3600_000)/DAY)*DAY-9*3600_000;
}
export function parseBars(raw, interval, cutoff, required=1) {
  if(!Array.isArray(raw)||![M5,M15].includes(interval)) throw Error('INVALID_KLINES');
  const map=new Map();
  for(const r of raw) {
    if(!Array.isArray(r)||r.length<11) throw Error('INVALID_KLINE_ROW');
    const [t,o,h,l,c,ct,qv,tb]=[r[0],r[1],r[2],r[3],r[4],r[6],r[7],r[10]].map(num);
    if(![t,o,h,l,c,ct,qv,tb].every(Number.isFinite)||!Number.isSafeInteger(t)||
       t%interval!==0||ct!==t+interval-1||Math.min(o,h,l,c)<=0||
       l>Math.min(o,c)||h<Math.max(o,c)||l>h||qv<0||tb<0||tb>qv*(1+1e-7))
      throw Error('INVALID_KLINE_VALUES');
    // Binance ct is inclusive: only bars whose next open is <= cutoff are closed.
    if(ct>=cutoff) continue;
    const b={t,o,h,l,c,ct,qv,tb};
    if(map.has(t)&&JSON.stringify(map.get(t))!==JSON.stringify(b)) throw Error('CONFLICTING_DUPLICATE');
    map.set(t,b);
  }
  const bars=[...map.values()].sort((a,b)=>a.t-b.t).slice(-required);
  if(bars.length!==required) throw Error('INSUFFICIENT_HISTORY');
  if(bars.at(-1).t!==Math.floor(cutoff/interval)*interval-interval) throw Error('STALE_KLINE');
  for(let i=1;i<bars.length;i++) if(bars[i].t-bars[i-1].t!==interval) throw Error('KLINE_GAP');
  return bars;
}
export function activeSymbols(info, cutoff) {
  if(!info||!Array.isArray(info.symbols)) throw Error('INVALID_EXCHANGE_INFO');
  const symbols=[],excluded=[];
  for(const s of info.symbols) {
    if(s.status!=='TRADING'||s.contractType!=='PERPETUAL'||s.quoteAsset!=='USDT') continue;
    // Do not silently treat stock/commodity/index derivatives as crypto.
    if(s.underlyingType!=='COIN') {excluded.push({symbol:s.symbol,reason:'NON_COIN_OR_UNKNOWN_TYPE'});continue;}
    if(!s.symbol||typeof s.symbol!=='string'||/[\s/?#]/.test(s.symbol)) throw Error('INVALID_SYMBOL');
    if(Number(s.onboardDate)>cutoff-110*M15) {excluded.push({symbol:s.symbol,reason:'WARMUP_27H30M'});continue;}
    symbols.push(s.symbol);
  }
  return {symbols:[...new Set(symbols)].sort(cmp),excluded};
}
export function feature15(symbol, bars, cutoff) {
  if(bars.length<110) throw Error('INSUFFICIENT_HISTORY');
  const n=bars.length-1,b=bars[n];
  // At precisely midnight rank the just-completed day, not an unopened new day.
  const dayStart=kstDayStart(cutoff-1),dayOpen=bars.find(x=>x.t===dayStart)?.o;
  if(!(dayOpen>0)) throw Error('KST_DAY_OPEN_MISSING');
  const avg=bars.slice(n-20,n).reduce((a,x)=>a+x.qv,0)/20;
  const tr=bars.slice(n-13,n+1).map((x,j)=>Math.max(x.h-x.l,Math.abs(x.h-bars[n-14+j].c),Math.abs(x.l-bars[n-14+j].c)));
  return {symbol,signal15Close:cutoff,dayStart,dayReturn:b.c/dayOpen-1,
    return15m:b.c/bars[n-1].c-1,return30m:b.c/bars[n-2].c-1,
    return60m:b.c/bars[n-4].c-1,volumeRatio:avg>0?b.qv/avg:0,
    qv24:bars.slice(-96).reduce((a,x)=>a+x.qv,0),
    atr:tr.reduce((a,x)=>a+x,0)/14,reference15Close:b.c};
}
export function rankFeatures(features) {
  const seen=new Set();
  for(const f of features) {
    if(seen.has(f.symbol)||![f.dayReturn,f.return15m,f.return30m,f.return60m,f.volumeRatio,f.qv24,f.atr,f.signal15Close].every(Number.isFinite))
      throw Error('INVALID_RANK_FEATURE');
    seen.add(f.symbol);
  }
  if(new Set(features.map(x=>x.signal15Close)).size>1) throw Error('MIXED_SNAPSHOT_TIMES');
  return [...features].sort((a,b)=>b.dayReturn-a.dayReturn||cmp(a.symbol,b.symbol)).map((x,i)=>({...x,rank:i+1}));
}
export function entryReason(f,p=POLICY) {
  if(f.rank>p.rankLimit) return 'OUTSIDE_TOP10';
  if(f.dayReturn<p.minDayReturn) return 'DAY_RETURN';
  if(f.qv24<p.minQuoteVolume24h) return 'LIQUIDITY';
  if(f.return15m<=0||f.return30m<p.min30mReturn||f.return60m<p.min60mReturn) return 'MOMENTUM';
  if(f.volumeRatio<p.minVolumeRatio) return 'VOLUME_ACCELERATION';
  return 'ELIGIBLE';
}
export function confirm5(f,bars,cutoff,p=POLICY) {
  if(bars.length<14) throw Error('INSUFFICIENT_5M_HISTORY');
  const b=bars.at(-1),prev=bars.at(-2),r5=b.c/prev.c-1,r15=b.c/bars.at(-4).c-1;
  if(r5<p.min5mReturn||r15<=0||b.c<b.o) return null;
  return {...f,strategy:STRATEGY,referenceClose:b.c,signal5Open:b.t,signal5Close:cutoff,
    return5m:r5,confirmationReturn15m:r15,stopPct:p.stopPct,
    // stopAtr is legacy-schema compatibility; the executor uses stopPct for V17.
    stopAtr:b.c*p.stopPct/f.atr,bbPos:0,exitPolicy:{stopPct:p.stopPct,
      trailArmPct:p.trailArmPct,trailGapPct:p.trailGapPct,staleMs:p.staleMs,maxHoldMs:p.maxHoldMs},
    maxHoldHours:p.maxHoldMs/3600_000,method:'KST_TOP10_15M_THEN_CLOSED_5M_ACCELERATION',
    rankBasis:'KST_DAY_CLOSED_15M',parametersValidatedByBacktest:false};
}
export function entryFresh(features,now,price,p=POLICY) {
  if(features?.strategy!==STRATEGY) return 'WRONG_STRATEGY';
  const close=num(features.signal5Close),ref=num(features.referenceClose);
  if(!Number.isFinite(close)||now<close||now-close>p.maxEntryAgeMs) return 'SIGNAL_STALE_OR_FUTURE';
  if(!(ref>0&&price>0)) return 'INVALID_PRICE';
  if(Math.abs(price/ref-1)>p.maxEntryDriftPct) return 'ENTRY_DRIFT';
  return null;
}
export function nextExit(position,bid,now,p=POLICY) {
  const entry=num(position.entryPrice),at=num(position.entryAt),oldPeak=num(position.peakPrice??entry);
  const highAt=num(position.lastHighAt??at),oldStop=num(position.stopPrice??entry*(1-p.stopPct));
  if(![entry,at,oldPeak,highAt,oldStop,bid,now,p.stopPct,p.trailArmPct,p.trailGapPct,p.staleMs,p.maxHoldMs].every(Number.isFinite)||
    entry<=0||bid<=0||at>now||highAt<at||highAt>now||oldPeak<entry||oldStop<=0||
    !(p.stopPct>0&&p.stopPct<1&&p.trailArmPct>0&&p.trailGapPct>0&&p.trailGapPct<1&&p.staleMs>0&&p.maxHoldMs>0))
    throw Error('INVALID_EXIT_STATE');
  const peakPrice=Math.max(oldPeak,bid),lastHighAt=bid>oldPeak?now:highAt;
  const armed=peakPrice/entry-1>=p.trailArmPct;
  const stopPrice=Math.max(oldStop,entry*(1-p.stopPct),armed?peakPrice*(1-p.trailGapPct):0);
  let reason=null;
  if(bid<=stopPrice) reason=stopPrice>entry*(1-p.stopPct)+entry*1e-12?'V17_TRAILING_STOP':'V17_HARD_STOP';
  else if(now-at>=p.maxHoldMs) reason='V17_MAX_HOLD';
  else if(now-lastHighAt>=p.staleMs) reason='V17_MOMENTUM_STALE';
  return {action:reason?'CLOSE':'HOLD',reason,peakPrice,lastHighAt,stopPrice,
    observedMfe:peakPrice/entry-1,priceReturn:bid/entry-1,armed};
}
export function portfolioMatches(dbPositions,portfolio) {
  if(!portfolio||!Array.isArray(portfolio.positions)||portfolio.positions_complete===false)
    return {ok:false,reason:'INCOMPLETE_PORTFOLIO',ext:[]};
  const ext=[];
  for(const x of portfolio.positions) {
    const q=num(x.quantity??x.positionAmt??x.position_amount);
    if(!Number.isFinite(q)) return {ok:false,reason:'INVALID_EXCHANGE_QUANTITY',ext};
    if(Math.abs(q)<=1e-12) continue;
    const symbol=String(x.market??x.symbol??'').toUpperCase();
    const rawSide=String(x.position_side??x.positionSide??x.side??'').toUpperCase();
    let side=rawSide==='LONG'||rawSide==='SHORT'?rawSide:null;
    const signed=num(x.positionAmt??x.position_amount);
    if(!side&&Number.isFinite(signed)&&signed!==0) side=signed>0?'LONG':'SHORT';
    if(!side||!symbol) return {ok:false,reason:'UNKNOWN_POSITION_IDENTITY',ext};
    ext.push({...x,symbol,side,absoluteQuantity:Math.abs(q)});
  }
  if(ext.length!==dbPositions.length) return {ok:false,reason:`COUNT:${ext.length}:${dbPositions.length}`,ext};
  const keys=new Set();
  for(const p of dbPositions) {
    const symbol=String(p.symbol).toUpperCase(),side=String(p.side??'LONG').toUpperCase(),key=`${symbol}:${side}`;
    const matches=ext.filter(x=>x.symbol===symbol&&x.side===side),q=num(p.remaining_quantity);
    if(keys.has(key)||matches.length!==1||!Number.isFinite(q)||q<=0) return {ok:false,reason:`IDENTITY:${key}`,ext};
    keys.add(key);
    // Do not permit a whole-lot discrepancy; absorb floating-point serialization only.
    if(Math.abs(matches[0].absoluteQuantity-q)>Math.max(1e-10,q*1e-8)) return {ok:false,reason:`QUANTITY:${key}`,ext};
  }
  return {ok:true,reason:'OK',ext};
}
