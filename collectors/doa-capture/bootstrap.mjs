import {CLOCK_VERSION} from './clock.mjs';
export const STEADY_WEIGHT_LIMIT=100,CLOCK_WEIGHT_LIMIT=600;
export function exchangeMinuteWeight(info){
 const r=info?.rateLimits?.find(x=>x.rateLimitType==='REQUEST_WEIGHT'&&x.interval==='MINUTE'&&x.intervalNum===1);
 return Number.isSafeInteger(r?.limit)&&r.limit>0?r.limit:null;
}
/** One funded Top20 cohort needs 400 weight merely to initialize depth1000. */
export function restWeightLimit(window,states,now,exchangeLimit){
 const slot=window?.slot_ms;
 const active=window?.version===CLOCK_VERSION&&Number.isSafeInteger(slot)&&slot%600000===0&&
  now>=slot-180000&&now<slot+1000&&states.some(s=>s.roles?.includes('SCANNER_LEADER')&&!s.roles?.includes('OPEN_POSITION'));
 return active&&Number.isSafeInteger(exchangeLimit)&&exchangeLimit>0?
  Math.min(CLOCK_WEIGHT_LIMIT,Math.floor(exchangeLimit/4)):STEADY_WEIGHT_LIMIT;
}
/** Held exits keep priority; repeated failures cannot monopolize candidate startup. */
export function recoveryOrder(states){
 return [...states].sort((a,b)=>Number(!a.roles?.includes('OPEN_POSITION'))-Number(!b.roles?.includes('OPEN_POSITION'))||
  // A newly watched symbol must get its first authoritative snapshot before another
  // candidate consumes a second/third resync. This preserves the same REST ceiling
  // while preventing one noisy symbol from starving cold Top20 members.
  Number((a.depthSnapshots??0)>0)-Number((b.depthSnapshots??0)>0)||
  (a.lastRestAttemptAt??0)-(b.lastRestAttemptAt??0));
}
