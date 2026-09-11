/** Frozen research-only rules. No I/O, account client, order or control mutation. */
import {nextExitReviewed, EXIT_REVIEW_R5} from '../../supabase/functions/_shared/leader-exit-review.mjs';
import {entryFresh} from '../../supabase/functions/_shared/leader-momentum-v17.mjs';
export const VARIANTS=Object.freeze(['BASELINE','ATR_ENTRY','NO_PROGRESS','PLATEAU','ATR_ENTRY+NO_PROGRESS','ATR_ENTRY+PLATEAU','NO_PROGRESS+PLATEAU','ALL']);
function enabled(variant,key){if(!VARIANTS.includes(variant))throw Error('UNKNOWN_VARIANT');return variant==='ALL'||variant.split('+').includes(key);}
export function entryDecision(features,now,price,variant='BASELINE'){
  const use=enabled(variant,'ATR_ENTRY'),reason=entryFresh(features,now,price);
  if(reason)return {verdict:'REJECT',reason,executionEnabled:false};
  if(!use)return {verdict:'KEEP',reason:'BASELINE',executionEnabled:false};
  const {atr,referenceClose,return5m,signal5Open,signal5Close,signal15Close}=features;
  if(![atr,referenceClose,return5m,signal5Open,signal5Close,signal15Close].every(Number.isFinite)||atr<=0||referenceClose<=0||return5m<=-1||
    signal5Close-signal5Open!==300000||signal5Open%300000!==0||signal15Close%900000!==0||
    signal15Close>signal5Close||signal5Close-signal15Close>=900000)
    return {verdict:'UNAVAILABLE',reason:'INVALID_OR_UNAVAILABLE_COMPLETED_FEATURES',executionEnabled:false};
  const jumpAtr=(referenceClose-referenceClose/(1+return5m))/atr;
  return {verdict:jumpAtr>1?'REJECT':'KEEP',reason:jumpAtr>1?'CLOSED_5M_JUMP_OVER_ONE_ATR':'ATR_ENTRY_WITHIN_LIMIT',jumpAtr,executionEnabled:false};
}
function fallingCompletedCloses(bars,now){
  if(!Array.isArray(bars))return false;
  const completed=bars.filter(b=>Number(b[6])<now).slice(-2);
  if(completed.length!==2)return false;
  const latestExpected=Math.floor(now/60000)*60000-60000;
  for(let i=0;i<2;i++){
    const b=completed[i],v=[b[0],b[1],b[2],b[3],b[4],b[6]].map(Number);
    if(!v.every(Number.isFinite)||v[0]!==latestExpected-(1-i)*60000||v[5]!==v[0]+59999||
      Math.min(...v.slice(1,5))<=0||v[3]>Math.min(v[1],v[4])||v[2]<Math.max(v[1],v[4]))return false;
  }
  return Number(completed[1][4])<Number(completed[0][4]);
}
export function exitDecision(position,bid,now,variant='BASELINE',bars=[]){
  const time=enabled(variant,'NO_PROGRESS'),plateau=enabled(variant,'PLATEAU');
  if(position.ownership && position.ownership!=='AUTO')return {action:'PRESERVE',reason:'OWNERSHIP_NOT_AUTO',executionEnabled:false};
  const policy={...EXIT_REVIEW_R5,...(position.policy??{})};
  const d=nextExitReviewed(position,bid,now,policy);
  // Existing risk protection wins; candidate exits never reset or loosen stored state.
  if(d.action==='HOLD'&&time&&now-position.entryAt>=900000&&d.observedMfe<.01&&bid<=position.entryPrice){
    d.action='CLOSE';d.reason='QV2_NO_PROGRESS_15M';
  }
  if(d.action==='HOLD'&&plateau&&d.observedMfe>=.03&&now-d.lastHighAt>=300000&&fallingCompletedCloses(bars,now)){
    d.action='CLOSE';d.reason='QV2_PROFIT_PLATEAU_5M';
  }
  return {...d,variant,executionEnabled:false,parametersValidatedByBacktest:false};
}
