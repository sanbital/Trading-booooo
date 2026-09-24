import {POLICY} from '/home/user/Trading-booooo/supabase/functions/_shared/leader-momentum-v17.mjs';
import {EXIT_REVIEW_R5,costBreakeven} from '/home/user/Trading-booooo/supabase/functions/_shared/leader-exit-review.mjs';
import {P142_STYLE_BY_BRANCH,P142_MODES,CEC0040_44BP_COSTS,CEC0040_CONFIG,normalizeP142Bars} from '/home/user/Trading-booooo/supabase/functions/_shared/leader-cec0040.mjs';
const MINUTE=60000,EPS=1e-12;
export function replayC(entry,bars,{style,mode,costs=CEC0040_44BP_COSTS,end=Infinity,hooks={}}={}){
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
      // FD1: a time-based exit is only a CANDIDATE, decided at the completed-candle close by GPT.
      if(reason&&price>stop&&hooks.timeGate){reason=kind==='CLOSE'&&hooks.timeGate({at,reason,price,peak,lastHighAt,stop,stage,entry,price0})?reason:null;}
      if(!reason&&kind==='CLOSE'&&hooks.event&&hooks.event({at,price,peak,lastHighAt,stop,stage,entry,price0})===true)reason='FD1_GPT_EXIT';
      if(reason){if(kind==='CLOSE'){pending=reason;break;}return settle(price,at,reason);}
    }
  }
  return {status:'OPEN_CENSORED',entryAt:entry.at,reservedThrough:end,lastTime,lastPrice,quantity,mfe,mae};
}

