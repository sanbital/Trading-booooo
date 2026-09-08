/** Offline-reviewed exit candidate. No IO, timers, exchange client or account access.
 * Candidate thresholds are NOT validated by a market-wide out-of-sample backtest.
 * Fractions refer to unleveraged price returns. All executable fills may gap.
 */
import {nextExit as baselineNextExit, POLICY} from './leader-momentum-v17.mjs';

export const EXIT_REVIEW_CANDIDATE = Object.freeze({
  breakEvenArmPct: .01,
  profitLockArmPct: .02,
  profitLockCapture: .50,
  estimatedExitFeeRate: .0005,
  exitSlippageBudgetPct: .001,
  parametersValidatedByBacktest: false,
});

export function costBreakeven(entry, entryFee, quantity, exitFeeRate, slipBudget) {
  if (![entry,entryFee,quantity,exitFeeRate,slipBudget].every(Number.isFinite) ||
      entry<=0 || entryFee<0 || quantity<=0 || exitFeeRate<0 || exitFeeRate>=1 ||
      slipBudget<0 || slipBudget>=1) throw Error('INVALID_COST_INPUT');
  return (entry+entryFee/quantity)/((1-exitFeeRate)*(1-slipBudget));
}

export function nextExitReviewed(position,bid,now,config={}) {
  const policy={...POLICY,...config};
  const base=baselineNextExit(position,bid,now,policy);
  const be=config.breakEvenArmPct??null, lock=config.profitLockArmPct??null;
  // No candidate values are activated implicitly by importing this module.
  if(be===null && lock===null) return base;
  if(be!==null && (!Number.isFinite(be)||be<=0)) throw Error('INVALID_BE_ARM');
  if(lock!==null && (!Number.isFinite(lock)||lock<=0 ||
      !Number.isFinite(config.profitLockCapture)||config.profitLockCapture<=0||
      config.profitLockCapture>=1 || (be!==null && lock<be))) throw Error('INVALID_PROFIT_LOCK');
  const entry=Number(position.entryPrice), tick=position.priceTick??0;
  if(!Number.isFinite(tick)||tick<0) throw Error('INVALID_PRICE_TICK');
  const bePrice=costBreakeven(entry,Number(position.entryFee),Number(position.quantity),
      config.estimatedExitFeeRate,config.exitSlippageBudgetPct);
  // The caller persists the raised stop and feeds it back as the baseline stop on the
  // next tick, so "did this level improve on the incoming stop" cannot identify which
  // rule is holding the line: after one tick the protection level merely EQUALS it and
  // the exit gets attributed to the trailing stop instead. Pick the binding level by
  // height and let a protection level win an exact tie, which keeps provenance stable
  // across ticks. Ordering matters: later entries win ties.
  const levels=[{stage:'BASELINE',price:base.stopPrice}];
  if(be!==null && base.observedMfe+1e-12>=be) levels.push({stage:'COST_BREAKEVEN',price:bePrice});
  if(lock!==null && base.observedMfe+1e-12>=lock) {
    levels.push({stage:'PROFIT_LOCK',price:entry+(base.peakPrice-entry)*config.profitLockCapture});
  }
  const binding=levels.reduce((best,x)=>x.price>=best.price?x:best);
  let stop=binding.price, reason=base.reason;
  const protectionStage=binding.stage;
  // A protective SELL trigger rounds upward: rounding must not increase allowed loss.
  if(tick>0) stop=Math.ceil(stop/tick-1e-10)*tick;
  if(bid<=stop) {
    if(protectionStage==='COST_BREAKEVEN') reason='V17_COST_BREAKEVEN';
    else if(protectionStage==='PROFIT_LOCK') reason='V17_PROFIT_LOCK';
    else if(!reason) reason='V17_RATCHET_STOP';
  }
  return {...base,stopPrice:stop,action:reason?'CLOSE':'HOLD',reason,
    protectionStage,breakevenTriggerPrice:bePrice,
    parametersValidatedByBacktest:false};
}

/** The caller creates attemptId once, persists this identifier before dispatch,
 * and reuses it while reconciling that SAME attempt. A subsequent residual exit
 * must receive a different attemptId. No new id on a transport timeout alone.
 */
export async function exitAttemptId(positionId,attemptId,prefix='v11x') {
  if(!/^[a-z0-9]{1,5}$/.test(prefix)||!positionId||!attemptId) throw Error('INVALID_ATTEMPT_ID');
  const bytes=new TextEncoder().encode(JSON.stringify([String(positionId),String(attemptId)]));
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  const hex=Array.from(hash,b=>b.toString(16).padStart(2,'0')).join('');
  return `tb-${prefix}-${hex.slice(0,27)}`.slice(0,36);
}

/** Preparation only. The host must persist and reconcile the conditional order;
 * this function does NOT submit, cancel, authenticate or enable trading.
 * One-way mode is deliberate: hedge mode needs a separate tested quantity guard.
 */
export function protectiveStopSpec({symbol,positionId,ownedQuantity,exchangeQuantity,
  manualSymbols=[],positionMode,stopPrice,priceTick,quantityStep,clientAlgoId}) {
  if(positionMode!=='ONE_WAY') throw Error('POSITION_MODE_NOT_SUPPORTED');
  if(!/^[A-Z0-9]+USDT$/.test(symbol)||!positionId||!/^tb-[.A-Za-z0-9_:/-]{1,33}$/.test(clientAlgoId))
    throw Error('INVALID_PROTECTION_IDENTITY');
  if(manualSymbols.map(String).map(x=>x.toUpperCase()).includes(symbol)) throw Error('MANUAL_SYMBOL_CONFLICT');
  if(![ownedQuantity,exchangeQuantity,stopPrice,priceTick,quantityStep].every(Number.isFinite)||
      ownedQuantity<=0||exchangeQuantity<=0||stopPrice<=0||priceTick<=0||quantityStep<=0)
    throw Error('INVALID_PROTECTION_NUMBERS');
  if(Math.abs(ownedQuantity-exchangeQuantity)>Math.max(1e-10,ownedQuantity*1e-8))
    throw Error('OWNERSHIP_QUANTITY_MISMATCH');
  const qty=Math.floor(ownedQuantity/quantityStep+1e-9)*quantityStep;
  if(qty<=0||Math.abs(qty-ownedQuantity)>Math.max(1e-10,quantityStep*1e-8))
    throw Error('UNPROTECTED_QUANTITY_RESIDUAL');
  const trigger=Math.ceil(stopPrice/priceTick-1e-10)*priceTick;
  return {method:'POST',path:'/fapi/v1/algoOrder',positionId,
    params:{algoType:'CONDITIONAL',symbol,side:'SELL',positionSide:'BOTH',
      type:'STOP_MARKET',quantity:Number(qty.toPrecision(14)),
      triggerPrice:Number(trigger.toPrecision(14)),workingType:'CONTRACT_PRICE',
      priceProtect:'false',reduceOnly:'true',clientAlgoId},
    executionEnabled:false};
}

/** A pending/partial/unknown response is not a completed exit. */
export function classifyExitResponse(requestedQty,fillQty,status,step) {
  if(![requestedQty,fillQty,step].every(Number.isFinite)||requestedQty<=0||fillQty<0||step<=0)
    throw Error('INVALID_EXIT_FILL');
  const eps=Math.max(1e-10,requestedQty*1e-8);
  if(fillQty>requestedQty+eps) throw Error('EXIT_OVERFILL');
  const remaining=Math.max(0,requestedQty-fillQty);
  if(remaining<=eps && ['FILLED','EXPIRED','CANCELED','CANCELLED','PARTIALLY_FILLED_CANCELED'].includes(status))
    return {state:'FILLED',remaining,closed:true};
  if(fillQty>0)return {state:'PARTIALLY_FILLED',remaining,closed:false};
  if(['REJECTED','EXPIRED','CANCELED','CANCELLED'].includes(status))return {state:'REJECTED',remaining,closed:false};
  return {state:'RECONCILIATION_FAILED',remaining,closed:false};
}
