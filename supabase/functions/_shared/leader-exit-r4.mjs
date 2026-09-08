// Offline/review only. Emits decisions for two explicitly sized legs; no orders.
import {R3_CANDIDATE,newR3State,nextR3Exit} from './leader-exit-r3.mjs';
export const R4_CANDIDATE=Object.freeze({riskFraction:.5,stallAfterMs:300000,
  minimumProgressPct:.0025,stallLossPct:.01,runnerBreakEvenArmPct:.01,
  runnerTrailGapPct:.015,emergencyStopPct:.035});
export function r4PolicyKey(p){return JSON.stringify(Object.keys(R4_CANDIDATE).sort().map(k=>[k,p[k]]));}
export function newR4State(entry,p=R4_CANDIDATE){
  if(Object.keys(R4_CANDIDATE).some(k=>!Number.isFinite(p[k])))throw Error('INVALID_R4_CONFIG');
  if(!(p.riskFraction>0&&p.riskFraction<1&&p.stallAfterMs>0&&p.minimumProgressPct>=0&&
    p.stallLossPct>0&&p.stallLossPct<1&&p.emergencyStopPct>0&&p.emergencyStopPct<1&&
    p.runnerBreakEvenArmPct>0&&p.runnerTrailGapPct>0&&p.runnerTrailGapPct<1&&entry.quantityStep>0))throw Error('INVALID_R4_CONFIG');
  const units=entry.quantity/entry.quantityStep;
  if(Math.abs(units-Math.round(units))>1e-6)throw Error('QUANTITY_STEP_MISMATCH');
  const riskUnits=Math.floor(Math.round(units)*p.riskFraction);
  const riskQuantity=Number((riskUnits*entry.quantityStep).toPrecision(14));
  const runnerQuantity=Number((entry.quantity-riskQuantity).toPrecision(14));
  if(!(riskQuantity>0&&runnerQuantity>0))throw Error('POSITION_TOO_SMALL_TO_SPLIT');
  const riskFee=entry.entryFee*riskQuantity/entry.quantity;
  const rp={...R3_CANDIDATE,emergencyStopPct:p.emergencyStopPct};
  const risk=newR3State({...entry,quantity:riskQuantity,entryFee:riskFee},rp);
  return {...entry,policyKey:r4PolicyKey(p),risk,riskPolicy:rp,riskQuantity,runnerQuantity,runnerFee:entry.entryFee-riskFee,
    runnerClosed:false,runnerPeak:entry.entryPrice,runnerStop:entry.entryPrice*.975,
    runnerHighAt:entry.entryAt,peak:entry.entryPrice,lastTickAt:null,lastSequence:null,
    lastBarClose:null,lastEventAt:entry.entryAt,coverageBroken:false};
}
export function nextR4Exit(s,event,p=R4_CANDIDATE){
  if(s.policyKey!==r4PolicyKey(p))throw Error('R4_POLICY_STATE_MISMATCH');
  const signals=[];
  const eventAt=event.type==='bar'?event.closeAt:event.at;
  if(event.type==='tick'&&Number.isFinite(eventAt)&&eventAt<s.lastEventAt)return {state:s,signals,ignored:true};
  const emit=(leg,reason,at)=>{signals.push({leg,reason,at,quantity:leg==='risk'?s.riskQuantity:s.runnerQuantity,
    entryFee:leg==='risk'?s.risk.entryFee:s.runnerFee});};
  if(event.type==='tick'){
    const {price,at,sequence,receivedAt=at}=event;
    if(!Number.isFinite(price)||price<=0||!Number.isFinite(at)||!Number.isFinite(receivedAt)||at<s.entryAt||receivedAt<at||
      (sequence!=null&&!Number.isSafeInteger(sequence)))throw Error('INVALID_TICK');
    if((s.lastTickAt!==null&&at<s.lastTickAt)||(sequence!=null&&s.lastSequence!==null&&sequence<=s.lastSequence))
      return {state:s,signals,ignored:true};
    if(receivedAt-at>R3_CANDIDATE.maxDataAgeMs)return {state:{...s,coverageBroken:true,risk:{...s.risk,breachSince:null}},signals,dataGap:true};
    const missing=(s.lastTickAt===null&&at-s.entryAt>R3_CANDIDATE.maxDataAgeMs)||
      (sequence!=null&&s.lastSequence!==null&&sequence!==s.lastSequence+1);
    if(missing)s={...s,risk:{...s.risk,breachSince:null}};
    s={...s,peak:Math.max(s.peak,price),lastEventAt:at,lastTickAt:at,lastSequence:sequence??s.lastSequence,
      coverageBroken:s.coverageBroken||missing};
    // Missing events invalidate a claim that no favorable excursion occurred.
    const stalled=!s.coverageBroken&&at-s.entryAt>=p.stallAfterMs&&
      s.peak/s.entryPrice-1<p.minimumProgressPct&&price/s.entryPrice-1<=-p.stallLossPct;
    if(!s.risk.closed){
      if(stalled){emit('risk','R4_FAILED_PROGRESS',at);s={...s,risk:{...s.risk,closed:true,exitReason:'R4_FAILED_PROGRESS'}};}
      else {const o=nextR3Exit(s.risk,event,s.riskPolicy);s={...s,risk:o.state};if(o.action==='CLOSE')emit('risk',o.reason,at);}
    }
    if(!s.runnerClosed&&(stalled||price<=s.entryPrice*(1-p.emergencyStopPct))){
      emit('runner',stalled?'R4_FAILED_PROGRESS':'R4_RUNNER_EMERGENCY',at);s={...s,runnerClosed:true};
    }
  }else if(event.type==='bar'){
    const {openAt,closeAt,close,receivedAt=closeAt}=event;
    if(![openAt,closeAt,close,receivedAt].every(Number.isFinite)||close<=0||closeAt!==openAt+60000||receivedAt<closeAt)
      throw Error('INVALID_CONFIRMED_BAR');
    if(openAt<s.entryAt||s.runnerClosed||(s.lastBarClose!==null&&closeAt<=s.lastBarClose))return {state:s,signals,ignored:true};
    if(receivedAt-closeAt>R3_CANDIDATE.maxDataAgeMs)return {state:{...s,coverageBroken:true},signals,dataGap:true};
    const peak=Math.max(s.runnerPeak,close),highAt=close>s.runnerPeak?closeAt:s.runnerHighAt,mfe=peak/s.entryPrice-1;
    let stop=s.runnerStop;
    if(mfe>=p.runnerBreakEvenArmPct)stop=Math.max(stop,s.risk.breakEvenPrice);
    if(mfe>=.02)stop=Math.max(stop,s.entryPrice+(peak-s.entryPrice)*.5);
    if(mfe>=.03)stop=Math.max(stop,peak*(1-p.runnerTrailGapPct));
    s={...s,runnerPeak:peak,runnerStop:stop,runnerHighAt:highAt,lastBarClose:closeAt,lastEventAt:Math.max(s.lastEventAt,closeAt)};
    let reason=null;
    if(close<=stop)reason='R4_RUNNER_CLOSED_BAR';
    else if(closeAt-s.entryAt>=R3_CANDIDATE.maxHoldMs)reason='R4_RUNNER_MAX_HOLD';
    else if(closeAt-highAt>=R3_CANDIDATE.staleMs)reason='R4_RUNNER_STALE';
    if(reason){emit('runner',reason,Math.max(closeAt,receivedAt));s={...s,runnerClosed:true};}
  }else throw Error('UNKNOWN_EVENT_TYPE');
  return {state:s,signals,done:s.risk.closed&&s.runnerClosed};
}

export function restoreR4State(saved,p=R4_CANDIDATE){
  if(saved.policyKey!==r4PolicyKey(p))throw Error('R4_POLICY_STATE_MISMATCH');
  // No peak/stop reset and no counting elapsed downtime as continuous evidence.
  return {...structuredClone(saved),coverageBroken:true,risk:{...saved.risk,breachSince:null,lastEventAt:null}};
}
