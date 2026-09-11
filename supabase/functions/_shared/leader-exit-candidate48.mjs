/** Trading-rule hypotheses for offline validation. No IO or production activation.
 * Context contains only completed 1m bars available at the decision timestamp.
 */
import {EXIT_REVIEW_R5,nextExitReviewed} from './leader-exit-review.mjs';
export const CANDIDATE48_VERSION='V18_EXIT48_REVIEW_1';
export const EXIT48_VARIANTS=Object.freeze(['BASELINE','FAST_FAIL','EARLY_LOCK','VOL_TRAIL','COMBINED']);
export function completedTrend(bars,now){
  if(!Array.isArray(bars))return {strong:false,reason:'MISSING_CONTEXT'};
  const xs=bars.filter(b=>Number(b[6])<now).slice(-15);
  if(xs.length!==15||xs.at(-1)[0]!==Math.floor(now/60000)*60000-60000)return {strong:false,reason:'STALE_OR_SHORT_CONTEXT'};
  for(let i=0;i<xs.length;i++){
    const b=xs[i],nums=[b[0],b[1],b[2],b[3],b[4],b[6]].map(Number);
    if(!nums.every(Number.isFinite)||nums[0]%60000!==0||nums[5]!==nums[0]+59999||
      Math.min(...nums.slice(1,5))<=0||nums[3]>Math.min(nums[1],nums[4])||nums[2]<Math.max(nums[1],nums[4])||
      (i>0&&b[0]-xs[i-1][0]!==60000))return {strong:false,reason:'INVALID_CONTEXT'};
  }
  const last=Number(xs.at(-1)[4]),rising=Number(xs.at(-3)[4])<Number(xs.at(-2)[4])&&Number(xs.at(-2)[4])<last;
  const atr=xs.slice(1).reduce((s,b,i)=>s+Math.max(Number(b[2])-Number(b[3]),Math.abs(Number(b[2])-Number(xs[i][4])),Math.abs(Number(b[3])-Number(xs[i][4]))),0)/14;
  return {strong:rising,atr,close:last,gap:Math.max(.015,Math.min(.025,2*atr/last)),reason:rising?'RISING_CLOSED_BARS':'WEAK_OR_MIXED'};
}
export function nextExit48(position,bid,now,variant='COMBINED',bars=[]){
  if(!EXIT48_VARIANTS.includes(variant))throw Error('INVALID_EXIT48_VARIANT');
  const policy={...EXIT_REVIEW_R5,...(position.policy??{})};
  const fast=variant==='FAST_FAIL'||variant==='COMBINED',lock=variant==='EARLY_LOCK'||variant==='COMBINED';
  const trail=variant==='VOL_TRAIL'||variant==='COMBINED',context=completedTrend(bars,now);
  if(lock)policy.profitLockArmPct=.015;
  if(trail&&context.strong)policy.trailGapPct=context.gap;
  const d=nextExitReviewed(position,bid,now,policy),entry=Number(position.entryPrice);
  // Persisted candidate stops retain their origin on later ticks/restarts.
  if(position.candidateStopProvenance==='EARLY_FAILURE_CUT'&&Math.abs(d.stopPrice-Number(position.stopPrice))<=entry*1e-12){
    d.protectionStage='EARLY_FAILURE_CUT';
    if(d.action==='CLOSE'&&bid<=d.stopPrice)d.reason='V18_EARLY_FAILURE_CUT';
  }
  const early=fast&&now-Number(position.entryAt)>=300000&&d.observedMfe<.005&&bid/entry-1<=-.006;
  if(early){
    const proposed=entry*(1-.012),tick=Number(position.priceTick??0),rounded=tick>0?Math.ceil(proposed/tick-1e-10)*tick:proposed;
    if(rounded>d.stopPrice){d.stopPrice=rounded;d.protectionStage='EARLY_FAILURE_CUT';}
    if(bid<=d.stopPrice){d.action='CLOSE';d.reason=d.reason??'V18_EARLY_FAILURE_CUT';}
  }
  return {...d,candidateVersion:CANDIDATE48_VERSION,variant,earlyFailureArmed:early,trendContext:context,
    candidateStopProvenance:d.protectionStage==='EARLY_FAILURE_CUT'?'EARLY_FAILURE_CUT':null,
    executionEnabled:false,parametersValidatedByBacktest:false};
}
