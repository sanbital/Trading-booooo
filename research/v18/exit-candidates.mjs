/** Research-only pure policies. No network, orders, credentials or production switch.
 * Fractions are unleveraged price returns. Every threshold is a CANDIDATE.
 */
import {POLICY} from '../../supabase/functions/_shared/leader-momentum-v17.mjs';
import {nextExitReviewed,EXIT_REVIEW_R5,EXIT_REVIEW_CANDIDATE,costBreakeven} from '../../supabase/functions/_shared/leader-exit-review.mjs';
export const CANDIDATES=Object.freeze({
  V17_ORIGINAL:{kind:'BASE'},
  V17_BE:{kind:'BE'},
  V17_R5:{kind:'R5'},
  A_LADDER:{kind:'A',beArm:.015,riskCut:.012,failMs:600000,lockArm:.025,lockCapture:.50},
  B_TREND:{kind:'B',riskCut:.012,failMs:600000,lockArm:.025,lockCapture:.40,trailArm:.03,trailGap:.02},
  C_COMBINED:{kind:'C',beArm:.015,riskCut:.012,failMs:600000,lockArm:.025,lockCapture:.50,trailArm:.03,trailGap:.02,earlyLoss:.012,earlyHoldMs:120000,earlyReturn1m:-.004},
  ATR_STOP:{kind:'ATR',atrMultiple:1,stopMin:.015,stopMax:.025},
});
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
export function nextCandidate(position,bid,now,config,features={}){
  if(!config||!Object.values(CANDIDATES).some(x=>x.kind===config.kind))throw Error('UNKNOWN_CANDIDATE');
  const k=config.kind;
  if(k==='BASE')return nextExitReviewed(position,bid,now,{});
  if(k==='BE')return nextExitReviewed(position,bid,now,EXIT_REVIEW_CANDIDATE);
  if(k==='R5')return nextExitReviewed(position,bid,now,{...EXIT_REVIEW_R5,...config});
  const hasATR=Number.isFinite(features.atrPct)&&features.atrPct>0;
  const stopPct=k==='ATR'&&hasATR?clamp(features.atrPct*config.atrMultiple,config.stopMin,config.stopMax):POLICY.stopPct;
  const fresh=Number.isSafeInteger(features.closedAt)&&features.closedAt<=now&&now-features.closedAt<=90000;
  const strong=fresh&&features.return5m>0&&features.return15m>0&&features.volumeRatio>=1.1;
  let gap=POLICY.trailGapPct;
  if(k==='B'||k==='C')gap=strong?clamp((hasATR?features.atrPct:config.trailGap)*1.0,config.trailGap,.03):.015;
  const policy={...EXIT_REVIEW_R5,stopPct,
    riskCutLevelPct:config.riskCut??EXIT_REVIEW_R5.riskCutLevelPct,
    failCutAfterMs:config.failMs??EXIT_REVIEW_R5.failCutAfterMs,
    profitLockArmPct:config.lockArm??EXIT_REVIEW_R5.profitLockArmPct,
    profitLockCapture:config.lockCapture??EXIT_REVIEW_R5.profitLockCapture,
    trailGapPct:gap,trailArmPct:config.trailArm??POLICY.trailArmPct};
  if(config.beArm)policy.breakEvenArmPct=config.beArm;
  let out=nextExitReviewed(position,bid,now,policy);
  const entry=position.entryPrice;
  // A ladder is a monotone floor. The gap above cannot lower any acknowledged stop.
  if(k==='A'||k==='C'){
    const mfe=out.observedMfe;
    let floor=out.stopPrice;
    for(const [arm,lock] of [[.04,.02],[.07,.045],[.10,.07]])if(mfe>=arm)floor=Math.max(floor,entry*(1+lock));
    if(floor>out.stopPrice){out={...out,stopPrice:floor,protectionStage:'V18_LADDER'};if(bid<=floor)out={...out,action:'CLOSE',reason:'V18_LADDER'};}
  }
  // Closed 1m feature only; a missing/future feature NEVER manufactures an exit signal.
  if(k==='C'&&out.action!=='CLOSE'&&fresh&&now-position.entryAt>=config.earlyHoldMs&&
    out.priceReturn<=-config.earlyLoss&&out.observedMfe<.01&&
    features.return1m<=config.earlyReturn1m&&features.return5m<=0)
    out={...out,action:'CLOSE',reason:'V18_EARLY_FAILURE'};
  return {...out,candidateOnly:true,trendStrong:strong};
}
export function canReenterAfterLoss({lastExitAt,lastNet,lastReason,lastFailureHigh,signalClose,price,volumeRatio,rank,exitRank,now}){
  if(!Number.isFinite(lastNet)||lastNet>=0)return {allowed:true,reason:'NORMAL_ENTRY'};
  if(!Number.isFinite(lastExitAt)||now<lastExitAt)return {allowed:false,reason:'INVALID_HISTORY'};
  if(now-lastExitAt>=30*60000)return {allowed:true,reason:'COOLDOWN_COMPLETE'};
  const renewed=signalClose>lastExitAt&&signalClose<=now&&price>lastFailureHigh&&volumeRatio>=1.2&&rank<exitRank;
  return {allowed:renewed,reason:renewed?'RENEWED_EVIDENCE':'WAIT_AFTER_LOSS',lastReason};
}
export function exitReadiness({requested,filled,status,knownFee,knownPrice}){
  if(![requested,filled].every(Number.isFinite)||requested<=0||filled<0||filled>requested+1e-8)throw Error('INVALID_FILL');
  const flat=status==='FILLED'&&Math.abs(filled-requested)<=Math.max(1e-8,requested*1e-8);
  return {flat,accountingReady:flat&&Number.isFinite(knownPrice)&&knownPrice>0&&Number.isFinite(knownFee)&&knownFee>=0,
    resubmit:false,action:flat?'RECONCILE_ACCOUNTING':'RECONCILE_ORDER'};
}
export {costBreakeven};
