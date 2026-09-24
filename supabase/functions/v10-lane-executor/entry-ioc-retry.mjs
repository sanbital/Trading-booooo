/** Bounded aggressive IOC retry planner. Pure: no DB, exchange or GPT calls. */
export const IOC_RETRY_POLICY=Object.freeze({
  version:'IOC_RETRY_1',
  maxAttempts:2,
  maxChaseBps:12,
  catastrophicSpreadBps:25,
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
export function ceilTick(value,tick){
  if(!(n(value)>0))return 0;
  if(!(n(tick)>0))return n(value);
  return Number((Math.ceil((n(value)-n(tick)*1e-9)/n(tick))*n(tick)).toFixed(dec(n(tick))));
}
function levels(xs){return (Array.isArray(xs)?xs:[]).map(x=>Array.isArray(x)?[n(x[0]),n(x[1])]:[n(x?.price),n(x?.size)]);}
/**
 * Recalculate ONLY the remaining quantity from a fresh book.
 * The limit is the deepest ask needed to fill that remainder, tick-rounded upward,
 * bounded by maxChaseBps from the current best ask. No stale limit is accepted.
 */
export function planAggressiveIocRetry(input,policy=IOC_RETRY_POLICY){
  const bid=n(input?.quote?.best_bid),ask=n(input?.quote?.best_ask),asks=levels(input?.quote?.asks);
  const step=n(input?.quantityStep),tick=n(input?.priceTick||0),target=n(input?.targetQuantity),
    filled=n(input?.filledQuantity||0),lev=n(input?.leverage),maxMargin=n(input?.maxTotalMarginUsdt),
    currentNotional=n(input?.currentPositionNotionalUsdt||0),minNotional=Math.max(0,n(input?.minNotionalUsdt||0)),
    minQuantity=Math.max(0,n(input?.minQuantity||0));
  if(![bid,ask,step,tick,target,filled,lev,maxMargin,currentNotional,minNotional,minQuantity,
    policy.maxChaseBps,policy.catastrophicSpreadBps].every(Number.isFinite)||
    !(bid>0&&ask>=bid&&step>0&&tick>=0&&target>=0&&filled>=0&&lev>0&&maxMargin>0&&
      currentNotional>=0&&minNotional>=0&&minQuantity>=0&&policy.maxChaseBps>=0&&policy.catastrophicSpreadBps>=0)||
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
  let left=remaining,quoteCost=0,deepest=null;
  for(const [price,size] of asks){const take=Math.min(left,size);if(take>0){quoteCost+=take*price;left-=take;deepest=price;}
    if(left<=Math.max(1e-12,remaining*1e-10))break;}
  if(left>Math.max(1e-12,remaining*1e-10)||!(deepest>0))
    return {ok:false,reason:'IOC_RETRY_INSUFFICIENT_LIQUIDITY',remainingQuantity:remaining,spreadBps};
  const expectedVwap=quoteCost/remaining,limitPrice=ceilTick(deepest,tick),
    chaseBps=(limitPrice/ask-1)*10000,slippageBps=(expectedVwap/ask-1)*10000;
  if(chaseBps>policy.maxChaseBps+1e-9)return {ok:false,reason:'IOC_RETRY_CHASE_BOUND',remainingQuantity:remaining,limitPrice,chaseBps,slippageBps,spreadBps};
  if(slippageBps>policy.maxChaseBps+1e-9)return {ok:false,reason:'IOC_RETRY_SLIPPAGE_BOUND',remainingQuantity:remaining,limitPrice,chaseBps,slippageBps,spreadBps};
  const totalWorstNotional=currentNotional+remaining*limitPrice,totalWorstMargin=totalWorstNotional/lev;
  if(totalWorstMargin>maxMargin+1e-9)return {ok:false,reason:'IOC_RETRY_MARGIN_BOUND',remainingQuantity:remaining,limitPrice,
    totalWorstMargin,maxTotalMarginUsdt:maxMargin,chaseBps,slippageBps,spreadBps};
  return {ok:true,complete:false,remainingQuantity:remaining,limitPrice,expectedVwap,chaseBps,slippageBps,spreadBps,
    totalWorstNotional,totalWorstMargin};
}
