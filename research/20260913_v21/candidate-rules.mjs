/**
 * Frozen V21 decay/reclaim research policy. Pure and side-effect free.
 * Values are unleveraged price returns. No future candle or outcome input.
 */
export const POLICY_VERSION='V21_DECAY_RECLAIM_1';
export const MIN_RETURN_15M=.025;
export const MAX_RETURN_5M=.012;
export const MIN_MANAGE_AGE_MS=180000;
export const REQUIRED_BELOW_OBSERVATIONS=3;
export const MIN_OBSERVATION_GAP_MS=45000;
export const MAX_OBSERVATION_GAP_MS=90000;

const finite=value=>Number.isFinite(Number(value));

export function decaySetup(features){
  if(!features||!finite(features.return15m)||!finite(features.return5m))
    return {available:false,decelerated:false,reason:'DECAY_INPUT_UNAVAILABLE'};
  const return15m=Number(features.return15m),return5m=Number(features.return5m);
  return {available:true,decelerated:return15m>=MIN_RETURN_15M&&return5m<=MAX_RETURN_5M,
    return15m,return5m,reason:'DECAY_INPUT_OK'};
}

/** Called with the exact limit price immediately before the order intent exists. */
export function entryDecision(features,limitPrice){
  const setup=decaySetup(features),referencePrice=Number(features?.referenceClose);
  if(!setup.available||!finite(referencePrice)||referencePrice<=0||!finite(limitPrice)||Number(limitPrice)<=0)
    return {available:false,wouldBlock:false,reason:'PRESERVE_BASELINE_INPUT_UNAVAILABLE'};
  const reclaimReturn=Number(limitPrice)/referencePrice-1;
  if(setup.decelerated&&Number(limitPrice)<=referencePrice)
    return {...setup,available:true,wouldBlock:true,reason:'V21_DECAY_NO_RECLAIM',referencePrice,limitPrice:Number(limitPrice),reclaimReturn};
  return {...setup,available:true,wouldBlock:false,reason:setup.decelerated?'V21_DECAY_RECLAIMED':'V21_DECAY_NOT_APPLICABLE',
    referencePrice,limitPrice:Number(limitPrice),reclaimReturn};
}

export function initialReclaimState({positionId,entryAt,entryPrice,features,limitPrice}){
  const decision=entryDecision(features,limitPrice);
  if(!decision.available||decision.wouldBlock||!decision.decelerated)return null;
  if(typeof positionId!=='string'||!positionId||!Number.isSafeInteger(entryAt)||entryAt<0||!finite(entryPrice)||Number(entryPrice)<=0)
    return null;
  return {version:POLICY_VERSION,positionId,entryAt,entryPrice:Number(entryPrice),referencePrice:decision.referencePrice,
    limitPrice:decision.limitPrice,return15m:decision.return15m,return5m:decision.return5m,belowCount:0,lastObservedAt:null};
}

export function freshQuote({detectedAtMs,quoteRequestedAtMs,quoteReceivedAtMs,exchangeBookAtMs,bid}){
  const detected=Number(detectedAtMs),requested=Number(quoteRequestedAtMs),received=Number(quoteReceivedAtMs),book=Number(exchangeBookAtMs);
  return finite(bid)&&Number(bid)>0&&[detected,requested,received,book].every(Number.isSafeInteger)&&
    received>=requested&&received-requested<=1000&&detected>=book&&detected-book<=3000&&
    detected>=received&&detected-received<=1000;
}

/**
 * Three fresh, roughly minute-spaced executable bids below the entry-time signal
 * reference are required. Missing/stale/out-of-order evidence never closes.
 */
export function reclaimExitDecision({position,state,observation}){
  if(!position||position.ownership!=='AUTO'||position.side!=='LONG'||position.state!=='OPEN'||
    !state||state.version!==POLICY_VERSION||state.positionId!==position.id||state.entryAt!==position.entryAt||
    state.entryPrice!==Number(position.entryPrice)||!finite(state.referencePrice)||state.referencePrice<=0||
    !Number.isInteger(state.belowCount)||state.belowCount<0||state.belowCount>=REQUIRED_BELOW_OBSERVATIONS)
    return {available:false,wouldClose:false,reason:'PRESERVE_SCOPE_OR_STATE',state};
  const now=Number(observation?.detectedAtMs);
  if(!freshQuote(observation)||now<position.entryAt+MIN_MANAGE_AGE_MS)
    return {available:false,wouldClose:false,reason:'PRESERVE_QUOTE_UNAVAILABLE_OR_EARLY',state};
  if(state.lastObservedAt!==null&&(!Number.isSafeInteger(state.lastObservedAt)||now<=state.lastObservedAt))
    return {available:false,wouldClose:false,reason:'PRESERVE_OBSERVATION_ORDER',state};
  let belowCount=0;
  if(Number(observation.bid)<state.referencePrice){
    const gap=state.lastObservedAt===null?null:now-state.lastObservedAt;
    belowCount=gap!==null&&gap>=MIN_OBSERVATION_GAP_MS&&gap<=MAX_OBSERVATION_GAP_MS?state.belowCount+1:1;
  }
  const next={...state,belowCount,lastObservedAt:now};
  const wouldClose=belowCount>=REQUIRED_BELOW_OBSERVATIONS;
  return {available:true,wouldClose,reason:wouldClose?'V21_RECLAIM_FAILURE_3':'V21_RECLAIM_HOLD',state:next};
}

