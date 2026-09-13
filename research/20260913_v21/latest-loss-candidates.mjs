/**
 * Two rejected, side-effect-free hypotheses from the 2026-09-13 latest-loss
 * investigation.  The accepted post-fill rule lives in the production module
 * leader-momentum-v17.mjs and is deliberately not duplicated here.
 *
 * Every value consumed by these functions exists at the decision time.  Outcome,
 * MFE and any later candle are evaluation data only and are never accepted inputs.
 */
export const SPIKE_FILTER_VERSION='V21_SPIKE_ACCELERATION_REJECTED_1';
export const FIRST_BEAR_VERSION='V21_FIRST_BEAR_NEAR_ENTRY_REJECTED_1';

const finite=value=>Number.isFinite(Number(value));

export function spikeAccelerationEntry(features){
  if(!features||![features.dayReturn,features.return5m,features.return15m].every(finite))
    return {available:false,wouldBlock:false,reason:'PRESERVE_BASELINE_INPUT_UNAVAILABLE'};
  const dayReturn=Number(features.dayReturn),return5m=Number(features.return5m),return15m=Number(features.return15m);
  const wouldBlock=dayReturn>=.20&&return5m>=1.2*return15m;
  return {available:true,wouldBlock,reason:wouldBlock?'V21_SPIKE_ACCELERATION':'V21_SPIKE_PRESERVE',
    version:SPIKE_FILTER_VERSION,dayReturn,return5m,return15m};
}

export function firstBearNearEntry({entryPrice,favorableCandle,candle}){
  if(!finite(entryPrice)||Number(entryPrice)<=0||!Array.isArray(favorableCandle)||favorableCandle.length<7||
      !candle||![candle.openTimeMs,candle.closeTimeMs,candle.open,candle.close].every(finite))
    return {available:false,wouldClose:false,reason:'PRESERVE_BASELINE_INPUT_UNAVAILABLE'};
  const openTimeMs=Number(candle.openTimeMs),closeTimeMs=Number(candle.closeTimeMs),
    open=Number(candle.open),close=Number(candle.close),armedAt=Number(favorableCandle[0]);
  if(!Number.isSafeInteger(openTimeMs)||!Number.isSafeInteger(closeTimeMs)||closeTimeMs!==openTimeMs+59999||
      !Number.isSafeInteger(armedAt)||openTimeMs<=armedAt)
    return {available:false,wouldClose:false,reason:'PRESERVE_CANDLE_SCOPE'};
  const wouldClose=close<open&&close<=Number(entryPrice)*1.005;
  return {available:true,wouldClose,reason:wouldClose?'V21_FIRST_BEAR_NEAR_ENTRY':'V21_FIRST_BEAR_PRESERVE',
    version:FIRST_BEAR_VERSION,openTimeMs,closeTimeMs,open,close};
}
