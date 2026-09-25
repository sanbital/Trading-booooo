/** Bounded aggressive IOC retry planner. Pure: no DB, exchange or GPT calls. */
export const IOC_RETRY_POLICY=Object.freeze({
  version:'IOC_RETRY_2',
  // Two attempts: attempt 1 filled 82 of 118 IOCs since 2026-09-18 (69.5%); every miss
  // was the ask moving past a +3-4 bps limit while a 0.4-0.6 s old quote was in flight.
  // No production retry has run yet, so nothing supports a third attempt.
  maxAttempts:2,
  maxChaseBps:12,
  catastrophicSpreadBps:25,
  // (2026-09-25) Attempt 2 prices at least this far above the fresh ask (still within
  // maxChaseBps): attempt 1 already lost that race at +3 bps, so repeating a top-of-book
  // limit repeats the miss. An IOC fills at book prices <= the limit, so this raises only
  // the cap; expected slippage is still measured on the book and bounded by maxChaseBps.
  retryUpliftBps:8,
});
const n=x=>Number(x);
const dec=step=>Math.min(12,Math.max(0,Math.ceil(-Math.log10(step))+2));
export function floorStep(value,step){
  if(!(n(value)>0&&n(step)>0))return 0;
  return Number((Math.floor((n(value)+n(step)*1e-9)/n(step))*n(step)).toFixed(dec(n(step))));
}
export function ceilStep(value,step){
  if(!(n(value)>0&&n(step)>0))return 0;
  return Number((Math.ceil((n(value)-n(step)*1e-9)/n(step))*n(step)).toFixed(dec(n(step))));
}
export function floorTick(value,tick){
  if(!(n(value)>0))return 0;
  if(!(n(tick)>0))return n(value);
  return Number((Math.floor((n(value)+n(tick)*1e-9)/n(tick))*n(tick)).toFixed(dec(n(tick))));
}
export function ceilTick(value,tick){
  if(!(n(value)>0))return 0;
  if(!(n(tick)>0))return n(value);
  return Number((Math.ceil((n(value)-n(tick)*1e-9)/n(tick))*n(tick)).toFixed(dec(n(tick))));
}
function levels(xs){return (Array.isArray(xs)?xs:[]).map(x=>Array.isArray(x)?[n(x[0]),n(x[1])]:[n(x?.price),n(x?.size)]);}
/**
 * Recalculate ONLY the remaining quantity from a fresh book.
 * The limit is the deepest ask needed to fill that remainder, raised to at least
 * retryUpliftBps above the best ask and tick-rounded upward, bounded by maxChaseBps from
 * the current best ask. No stale limit is accepted. When that worst-case limit would put
 * the position one lot over the margin ceiling, the remainder is cut to what the ceiling
 * affords (never below the exchange minimum); the ceiling itself never moves.
 */
function walk(asks,qty){
  let left=qty,quoteCost=0,deepest=null;
  for(const [price,size] of asks){const take=Math.min(left,size);if(take>0){quoteCost+=take*price;left-=take;deepest=price;}
    if(left<=Math.max(1e-12,qty*1e-10))break;}
  return {complete:!(left>Math.max(1e-12,qty*1e-10))&&deepest>0,quoteCost,deepest};
}
export function planAggressiveIocRetry(input,policy=IOC_RETRY_POLICY){
  const bid=n(input?.quote?.best_bid),ask=n(input?.quote?.best_ask),asks=levels(input?.quote?.asks);
  const step=n(input?.quantityStep),tick=n(input?.priceTick||0),target=n(input?.targetQuantity),
    filled=n(input?.filledQuantity||0),lev=n(input?.leverage),maxMargin=n(input?.maxTotalMarginUsdt),
    currentNotional=n(input?.currentPositionNotionalUsdt||0),minNotional=Math.max(0,n(input?.minNotionalUsdt||0)),
    minQuantity=Math.max(0,n(input?.minQuantity||0)),uplift=n(policy.retryUpliftBps??0);
  if(![bid,ask,step,tick,target,filled,lev,maxMargin,currentNotional,minNotional,minQuantity,
    policy.maxChaseBps,policy.catastrophicSpreadBps,uplift].every(Number.isFinite)||
    !(bid>0&&ask>=bid&&step>0&&tick>=0&&target>=0&&filled>=0&&lev>0&&maxMargin>0&&
      currentNotional>=0&&minNotional>=0&&minQuantity>=0&&policy.maxChaseBps>=0&&policy.catastrophicSpreadBps>=0&&
      uplift>=0&&uplift<=policy.maxChaseBps)||
    (filled>0&&!(currentNotional>0)))
    return {ok:false,reason:'IOC_RETRY_INPUT_INVALID'};
  // The deepest consumed ask is a valid marketable limit only for an ordered,
  // internally consistent book. Never silently discard malformed levels.
  if(asks.some(([price,size],i)=>!Number.isFinite(price)||!Number.isFinite(size)||
    price<ask||size<0||(i>0&&price<=asks[i-1][0])))
    return {ok:false,reason:'IOC_RETRY_BOOK_INVALID'};
  const mid=(bid+ask)/2,spreadBps=(ask-bid)/mid*10000;
  if(spreadBps>policy.catastrophicSpreadBps)return {ok:false,reason:'IOC_RETRY_SPREAD_CATASTROPHIC',spreadBps};
  const remaining=floorStep(Math.max(0,target-filled),step);
  if(!(remaining>0))return {ok:true,complete:true,remainingQuantity:0,spreadBps};
  const exchangeFloor=Math.max(step,minQuantity,minNotional>0?ceilStep(minNotional/ask,step):0);
  if(remaining+Math.max(1e-12,step*1e-9)<exchangeFloor)
    return {ok:true,complete:true,underExchangeMinimum:true,remainingQuantity:remaining,spreadBps};
  const need=walk(asks,remaining);
  if(!need.complete)return {ok:false,reason:'IOC_RETRY_INSUFFICIENT_LIQUIDITY',remainingQuantity:remaining,spreadBps};
  // The depth-required level is the floor of the limit; the uplift may add to it only up to
  // the chase bound (a tick-rounded uplift that would cross it falls back inside it).
  const cap=floorTick(ask*(1+policy.maxChaseBps/10000),tick),upliftPx=ceilTick(ask*(1+uplift/10000),tick);
  let limitPrice=ceilTick(Math.max(need.deepest,upliftPx),tick);
  if(limitPrice>cap&&cap>=need.deepest)limitPrice=Math.max(ceilTick(need.deepest,tick),cap);
  const chaseBps=(limitPrice/ask-1)*10000;
  if(chaseBps>policy.maxChaseBps+1e-9)return {ok:false,reason:'IOC_RETRY_CHASE_BOUND',remainingQuantity:remaining,limitPrice,chaseBps,
    slippageBps:(need.quoteCost/remaining/ask-1)*10000,spreadBps};
  // Worst case every lot fills at the limit: fit the remainder under the margin ceiling.
  const affordable=floorStep(Math.max(0,maxMargin*lev-currentNotional)/limitPrice,step);
  let quantity=remaining,budgetShrunk=false;
  if(currentNotional+remaining*limitPrice>maxMargin*lev+1e-9){
    if(!(affordable>0)||affordable+Math.max(1e-12,step*1e-9)<exchangeFloor||affordable*limitPrice+1e-9<minNotional)
      return {ok:false,reason:'IOC_RETRY_MARGIN_BOUND',remainingQuantity:remaining,limitPrice,
        totalWorstMargin:(currentNotional+remaining*limitPrice)/lev,maxTotalMarginUsdt:maxMargin,chaseBps,spreadBps};
    quantity=affordable;budgetShrunk=true;
  }
  const fill=walk(asks,quantity),expectedVwap=fill.quoteCost/quantity,slippageBps=(expectedVwap/ask-1)*10000;
  if(slippageBps>policy.maxChaseBps+1e-9)return {ok:false,reason:'IOC_RETRY_SLIPPAGE_BOUND',remainingQuantity:quantity,limitPrice,chaseBps,slippageBps,spreadBps};
  const totalWorstNotional=currentNotional+quantity*limitPrice,totalWorstMargin=totalWorstNotional/lev;
  if(totalWorstMargin>maxMargin+1e-9)return {ok:false,reason:'IOC_RETRY_MARGIN_BOUND',remainingQuantity:quantity,limitPrice,
    totalWorstMargin,maxTotalMarginUsdt:maxMargin,chaseBps,slippageBps,spreadBps};
  return {ok:true,complete:false,remainingQuantity:quantity,limitPrice,expectedVwap,chaseBps,slippageBps,spreadBps,
    totalWorstNotional,totalWorstMargin,upliftBps:uplift,depthLimitPrice:ceilTick(need.deepest,tick),
    ...(budgetShrunk?{budgetShrunk:true,requestedRemainingQuantity:remaining}:{})};
}
