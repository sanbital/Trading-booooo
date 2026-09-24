/**
 * Deployment-grade CEC0040 and P142 policy primitives.
 *
 * This module is pure: no database, exchange, clock or network access.  The host
 * owns persistence and obtains completed 1m candles / public funding observations.
 * All price fractions are unleveraged.  Target PnL is normalized to the frozen
 * 200 USDT margin x 3 leverage research contract (600 USDT notional).
 */
import {POLICY} from './leader-momentum-v17.mjs';
import {EXIT_REVIEW_R5, costBreakeven, nextExitReviewed} from './leader-exit-review.mjs';

export const CEC0040_VERSION='CEC0040_CAUSAL_EDGE_CONTROLLER_1';
export const CEC0040_TARGET_VERSION='CEC0040_P142_MEAN44_1';
export const P142_POLICY_VERSION='P142_COMPLETED_PRICE_BRANCH_1';
export const CEC0040_CONFIG=Object.freeze({
  scope:'global',alpha:.05,trainingTarget:'P142_MEAN44',winsorUsdt:20,
  minTrainingTrades:10,admissionThresholdUsdt:0,probeEveryRejectedSignals:3,
  targetNotionalUsdt:600,
});
export const CEC0040_44BP_COSTS=Object.freeze({
  entryFee:.0007,exitFee:.0007,entrySlip:.001,exitSlip:.002,
  actualBaselineEntrySlip:.0005,
});
export const P142_STYLE_BY_BRANCH=Object.freeze({
  R62:'retestAnchor',BUYER_SHARE_RESCUE:'rangeFloor',BOTH:'pivotFloor',
  // V30 front admission without a B06133 branch (2026-09-24): R62's retest-anchor exit,
  // the style the V30 validation replay used for branchless candidates.
  V30_SCORE:'retestAnchor',
});
export const P142_MODES=Object.freeze(['LOW_FIRST','HIGH_FIRST','CLOSE_ONLY']);
const MINUTE=60000,EPS=1e-12;

const finite=x=>Number.isFinite(Number(x));
const num=x=>Number(x);
const clamp=(x,cap)=>Math.max(-cap,Math.min(cap,x));

export function p142StyleForBranch(branch){
  const style=P142_STYLE_BY_BRANCH[String(branch??'')];
  if(!style)throw Error('P142_BRANCH_INVALID');
  return style;
}

export function cec0040Decision({ewmaUsdt,trainingCount,rejectRun},config=CEC0040_CONFIG){
  const n=Number(trainingCount),run=Number(rejectRun),ewma=ewmaUsdt===null?null:Number(ewmaUsdt);
  if(!Number.isSafeInteger(n)||n<0||!Number.isSafeInteger(run)||run<0||run>=config.probeEveryRejectedSignals||
     (n>=config.minTrainingTrades&&!Number.isFinite(ewma)))throw Error('CEC0040_STATE_INVALID');
  const prediction=n<config.minTrainingTrades?null:ewma;
  if(prediction===null||prediction>=config.admissionThresholdUsdt)
    return {action:'ADMIT',allowed:true,probe:false,prediction,trainingCount:n,rejectRunBefore:run,rejectRunAfter:0};
  const next=run+1;
  if(next>=config.probeEveryRejectedSignals)
    return {action:'PROBE',allowed:true,probe:true,prediction,trainingCount:n,rejectRunBefore:run,rejectRunAfter:0};
  return {action:'REJECT',allowed:false,probe:false,prediction,trainingCount:n,rejectRunBefore:run,rejectRunAfter:next};
}

export function cec0040Fold(state,targetNet,config=CEC0040_CONFIG){
  const n=Number(state?.trainingCount),old=state?.ewmaUsdt===null?null:Number(state?.ewmaUsdt),raw=Number(targetNet);
  if(!Number.isSafeInteger(n)||n<0||!Number.isFinite(raw)||(n>0&&!Number.isFinite(old)))throw Error('CEC0040_FOLD_INVALID');
  const y=clamp(raw,config.winsorUsdt),ewma=n===0?y:config.alpha*y+(1-config.alpha)*old;
  return {...state,ewmaUsdt:ewma,trainingCount:n+1,lastTargetNetUsdt:raw,lastWinsorNetUsdt:y};
}

export function normalizeP142Bars(raw){
  if(!Array.isArray(raw))throw Error('P142_BARS_INVALID');
  const out=[],seen=new Set();
  for(const row of raw){
    if(!Array.isArray(row)||row.length<5)throw Error('P142_BAR_INVALID');
    // Research caches use compact [t,o,h,l,c,...] rows. Binance REST rows carry
    // the inclusive close time at index 6 and have at least 11 fields.
    const [t,o,h,l,c]=[0,1,2,3,4].map(i=>Number(row[i])),
      end=row.length>=11?Number(row[6]):t+MINUTE-1;
    if(!Number.isSafeInteger(t)||t<0||t%MINUTE!==0||end!==t+MINUTE-1||
       ![o,h,l,c].every(x=>Number.isFinite(x)&&x>0)||h<Math.max(o,c)||l>Math.min(o,c)||seen.has(t))
      throw Error('P142_BAR_INVALID');
    seen.add(t);out.push([t,o,h,l,c,Number(row[5]??0),end]);
  }
  out.sort((a,b)=>a[0]-b[0]);
  for(let i=1;i<out.length;i++)if(out[i][0]-out[i-1][0]!==MINUTE)throw Error('P142_BAR_GAP');
  return out;
}

/** Exact production copy of the frozen R94 P142 replay kernel. */
export function replayP142Target(entry,bars,{style,mode,costs=CEC0040_44BP_COSTS,end=Infinity}={}){
  if(!Object.values(P142_STYLE_BY_BRANCH).includes(style)||!P142_MODES.includes(mode)||
     !Number.isSafeInteger(entry?.at)||!(Number(entry?.price)>0))throw Error('P142_REPLAY_INPUT');
  const xs=normalizeP142Bars(bars),price0=Number(entry.price),notional=CEC0040_CONFIG.targetNotionalUsdt,
    quantity=notional/price0,entryFee=notional*costs.entryFee,initial=price0*(1-POLICY.stopPct),
    be=costBreakeven(price0,entryFee,quantity,EXIT_REVIEW_R5.estimatedExitFeeRate,EXIT_REVIEW_R5.exitSlippageBudgetPct),completed=[];
  let stop=initial,stage='NATIVE_HARD_STOP',peak=price0,lastHighAt=entry.at,accepted=price0,pending=null,
    mfe=0,mae=0,lastTime=entry.at,lastPrice=price0,expected=Math.floor(entry.at/MINUTE)*MINUTE;
  const settle=(raw,at,reason)=>{const exitPrice=raw*(1-costs.exitSlip),grossPnl=(exitPrice-price0)*quantity,
    fees=entryFee+exitPrice*quantity*costs.exitFee;return {status:'CLOSED',entryAt:entry.at,entryPrice:price0,
      exitAt:at,exitPrice,quantity,grossPnl,fees,netBeforeFunding:grossPnl-fees,reason,mfe,mae,holdMs:at-entry.at};};
  for(const bar of xs){
    if(bar[0]+MINUTE<=entry.at)continue;
    if(bar[0]>=end)break;
    if(bar[0]!==expected)return {status:'UNKNOWN_GAP',entryAt:entry.at,reservedThrough:end};
    expected+=MINUTE;if(bar[0]+MINUTE>end)break;
    if(pending&&bar[0]>=entry.at)return settle(bar[1],bar[0],pending);
    const lowFirst=mode!=='HIGH_FIRST',points=[[bar[0],bar[1],'OPEN'],
      [bar[0]+20000,lowFirst?bar[3]:bar[2],'EXTREME1'],[bar[0]+40000,lowFirst?bar[2]:bar[3],'EXTREME2'],
      [bar[0]+MINUTE-1,bar[4],'CLOSE']];
    for(const [at,price,kind] of points){
      if(at<entry.at)continue;
      if(price<=stop){const raw=kind==='OPEN'?Math.min(price,stop):stop;mae=Math.min(mae,raw/price0-1);return settle(raw,at,stage);}
      mfe=Math.max(mfe,price/price0-1);mae=Math.min(mae,price/price0-1);lastTime=at;lastPrice=price;
      if(mode==='CLOSE_ONLY'&&kind!=='CLOSE')continue;
      if(price>peak){peak=price;lastHighAt=at;}
      const oldStop=stop;let proposed=stop,nextStage=stage;
      if(peak/price0-1+EPS>=EXIT_REVIEW_R5.riskCutArmPct||at-entry.at>=EXIT_REVIEW_R5.failCutAfterMs){
        const risk=price0*(1-EXIT_REVIEW_R5.riskCutLevelPct);if(risk>proposed){proposed=risk;nextStage='R5_RISK_CUT';}
      }
      if(kind==='CLOSE'&&bar[0]>=entry.at){
        completed.push(bar);const n=completed.length,previous=completed[n-2];
        if(style==='retestAnchor'&&previous&&price>=previous[2])accepted=Math.max(accepted,previous[2]);
        if(style==='retestAnchor'){
          if(accepted/price0-1>=POLICY.trailArmPct){const trail=accepted*(1-POLICY.trailGapPct);if(trail>proposed){proposed=trail;nextStage='retestAnchor_TRAIL';}}
          if(accepted/price0-1+EPS>=EXIT_REVIEW_R5.profitLockArmPct){const lock=price0+(accepted-price0)*EXIT_REVIEW_R5.profitLockCapture;if(lock>=proposed){proposed=lock;nextStage='retestAnchor_LOCK';}}
        }else if(n>=3&&peak/price0-1+EPS>=EXIT_REVIEW_R5.profitLockArmPct){
          const a=completed[n-3],b=completed[n-2],c=completed[n-1],
            floor=style==='rangeFloor'?Math.min(a[3],b[3],c[3]):b[3]<a[3]&&b[3]<=c[3]?b[3]:null;
          if(floor!==null&&floor>=be&&floor<price&&floor>proposed){proposed=floor;nextStage=style+'_SUPPORT';}
        }
      }
      if(proposed<oldStop-EPS||proposed<initial-EPS)throw Error('P142_STOP_WIDENED');
      stop=proposed;stage=nextStage;
      let reason=price<=stop?stage:at-entry.at>=POLICY.maxHoldMs?'V17_MAX_HOLD':at-lastHighAt>=POLICY.staleMs?'V17_MOMENTUM_STALE':null;
      if(reason){if(kind==='CLOSE'){pending=reason;break;}return settle(price,at,reason);}
    }
  }
  return {status:'OPEN_CENSORED',entryAt:entry.at,reservedThrough:end,lastTime,lastPrice,quantity,mfe,mae};
}

function fundingFor(outcome,events){
  let total=0;
  for(const e of events??[]){
    const at=Number(e.fundingTime),rate=Number(e.fundingRate),mark=Number(e.markPrice);
    if(!Number.isSafeInteger(at)||!Number.isFinite(rate)||!(mark>0))throw Error('P142_FUNDING_INVALID');
    if(at>outcome.entryAt&&at<=outcome.exitAt)total+=outcome.quantity*rate*mark;
  }
  return total;
}

export function p142Mean44Target({entryAt,actualEntryPrice,branch,bars,fundingEvents=[]}){
  if(!Number.isSafeInteger(entryAt)||!(Number(actualEntryPrice)>0))throw Error('CEC0040_TARGET_ENTRY_INVALID');
  const style=p142StyleForBranch(branch),adjustedEntry=Number(actualEntryPrice)*
    (1+CEC0040_44BP_COSTS.entrySlip-CEC0040_44BP_COSTS.actualBaselineEntrySlip),
    outcomes=P142_MODES.map(mode=>replayP142Target({at:entryAt,price:adjustedEntry},bars,{style,mode}));
  if(outcomes.some(x=>x.status==='UNKNOWN_GAP'))return {status:'UNKNOWN_GAP',version:CEC0040_TARGET_VERSION,style,outcomes};
  if(outcomes.some(x=>x.status!=='CLOSED'))return {status:'PENDING',version:CEC0040_TARGET_VERSION,style,outcomes};
  const nets=outcomes.map(x=>x.netBeforeFunding-fundingFor(x,fundingEvents));
  return {status:'RESOLVED',version:CEC0040_TARGET_VERSION,style,
    targetExitAt:Math.max(...outcomes.map(x=>x.exitAt)),targetNetUsdt:nets.reduce((a,b)=>a+b,0)/nets.length,
    pathNets:Object.fromEntries(P142_MODES.map((mode,i)=>[mode,nets[i]])),outcomes};
}

function validateP142State(prior,position){
  const base={version:P142_POLICY_VERSION,positionId:String(position.id),entryAt:Number(position.entryAt),
    entryPrice:Number(position.entryPrice),style:p142StyleForBranch(position.branch),lastBarOpen:null,
    accepted:Number(position.entryPrice),completed:[],stopPrice:Number(position.stopPrice),stage:'BASELINE'};
  if(!prior||!Object.keys(prior).length)return base;
  if(prior.version!==base.version||String(prior.positionId)!==base.positionId||Number(prior.entryAt)!==base.entryAt||
     Number(prior.entryPrice)!==base.entryPrice||prior.style!==base.style||!finite(prior.accepted)||!finite(prior.stopPrice)||
     !Array.isArray(prior.completed)||prior.completed.length>3)throw Error('P142_STATE_MISMATCH');
  return {...base,...prior,completed:normalizeP142Bars(prior.completed)};
}

/** Advance P142 only from completed candles. It may raise, never lower, the live stop. */
export function advanceP142Completed(position,rawBars,prior=null){
  const state=validateP142State(prior,position),bars=normalizeP142Bars(rawBars),entry=Number(position.entryPrice),
    entryFee=Number(position.entryFee),quantity=Number(position.quantity),initial=entry*(1-POLICY.stopPct),
    be=costBreakeven(entry,entryFee,quantity,EXIT_REVIEW_R5.estimatedExitFeeRate,EXIT_REVIEW_R5.exitSlippageBudgetPct);
  let accepted=Number(state.accepted),stop=Math.max(Number(position.stopPrice),Number(state.stopPrice),initial),stage=state.stage,
    completed=state.completed.slice(),last=state.lastBarOpen===null?null:Number(state.lastBarOpen);
  for(const bar of bars){
    if(bar[0]+MINUTE<=position.entryAt||last!==null&&bar[0]<=last)continue;
    const expected=last===null?Math.floor(Number(position.entryAt)/MINUTE)*MINUTE:last+MINUTE;
    if(bar[0]!==expected)throw Error('P142_BAR_GAP');
    completed.push(bar);completed=completed.slice(-3);const price=bar[4],previous=completed.at(-2);
    let proposed=stop,nextStage=stage;
    if(state.style==='retestAnchor'){
      if(previous&&price>=previous[2])accepted=Math.max(accepted,previous[2]);
      if(accepted/entry-1>=POLICY.trailArmPct){const trail=accepted*(1-POLICY.trailGapPct);if(trail>proposed){proposed=trail;nextStage='retestAnchor_TRAIL';}}
      if(accepted/entry-1+EPS>=EXIT_REVIEW_R5.profitLockArmPct){const lock=entry+(accepted-entry)*EXIT_REVIEW_R5.profitLockCapture;if(lock>=proposed){proposed=lock;nextStage='retestAnchor_LOCK';}}
    }else if(completed.length>=3&&Number(position.peakPrice)/entry-1+EPS>=EXIT_REVIEW_R5.profitLockArmPct){
      const [a,b,c]=completed,floor=state.style==='rangeFloor'?Math.min(a[3],b[3],c[3]):b[3]<a[3]&&b[3]<=c[3]?b[3]:null;
      if(floor!==null&&floor>=be&&floor<price&&floor>proposed){proposed=floor;nextStage=state.style+'_SUPPORT';}
    }
    if(proposed<stop-EPS||proposed<initial-EPS)throw Error('P142_STOP_WIDENED');
    stop=proposed;stage=nextStage;last=bar[0];
  }
  return {...state,accepted,stopPrice:stop,stage,completed,lastBarOpen:last};
}

/** Combine the existing R5 ladder and persisted P142 level; the higher stop binds. */
export function nextExitP142(position,bid,now,policy,p142State){
  const base=nextExitReviewed(position,bid,now,policy),candidate=Number(p142State?.stopPrice),
    stage=String(p142State?.stage??''),p142Owned=stage.startsWith('retestAnchor_')||
      stage==='rangeFloor_SUPPORT'||stage==='pivotFloor_SUPPORT',
    p142Binds=p142Owned&&Number.isFinite(candidate)&&candidate>=base.stopPrice-EPS&&
      candidate>Number(position.entryPrice)*(1-policy.stopPct)+EPS,
    stopPrice=Math.max(base.stopPrice,Number.isFinite(candidate)?candidate:0);
  if(bid<=stopPrice&&p142Binds)return {...base,action:'CLOSE',reason:stage,
    stopPrice,protectionStage:stage,p142:true};
  return {...base,stopPrice,p142:p142Binds,protectionStage:p142Binds?stage:base.protectionStage};
}
