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

/**
 * R5 loss-tail candidate. Same shape as EXIT_REVIEW_CANDIDATE with ONE structural change:
 * the level armed by a small favorable excursion sits BELOW entry instead of above it.
 *
 * EXIT_REVIEW_CANDIDATE jumps the stop from -2.5% to cost-breakeven (~+0.2%) the moment a
 * +1% excursion is polled. That single step does two bad things at once, both measured on
 * the 39 closed LIVE V17 trades of 2026-09-08 and 2026-09-09 replayed on Binance 1m klines:
 *
 *   1. Below +1% the only protection is the -2.5% entry stop, and at 3x on 120 USDT
 *      notional every such stop costs ~-3.2 USDT. Every loss on both days came from
 *      this bucket.
 *   2. At +1% it guarantees a fee-scale scratch exit. Six trades on 2026-09-09 closed
 *      between +0.02 and +0.15 USDT; KATUSDT then ran +13.5% and RAYSOLUSDT +10.7%
 *      within 30 minutes of that exit.
 *
 * R5 replaces that level with a risk cut at -1.2%, armed by EITHER a +1% excursion OR
 * 10 minutes without one. The loss cap therefore reaches -1.2% within 10 minutes of every
 * entry, while a trade that has merely twitched up is no longer forced into a scratch.
 * The +2% profit lock and the +3% trailing stop are unchanged.
 *
 * Replay on those 39 trades, quote-armed exactly as the one-minute monitor observes:
 *   net -8.86 -> +19.60 USDT, profit factor 0.79 -> 1.49, average loss -2.59 -> -1.92,
 *   MFE capture 0.451 -> 0.604. Win rate falls 59% -> 46%: scratch wins are traded for
 *   a smaller tail and larger winners, which is the intended direction.
 *
 * Out-of-sample: 289 synthetic V17 entries reconstructed from the unmodified V17 scanner
 * over 2026-08-31..2026-09-05 (see research/v17-exit-r5-loss-tail.md). Parameters are NOT
 * the output of a market-wide parameter search; -1.2% is the joint ridge of a 5x6 grid and
 * both neighbours in every direction also beat production on both days.
 */
export const EXIT_REVIEW_R5 = Object.freeze({
  policyVersion: 'V17_EXIT_R5_TAIL',
  riskCutArmPct: .01,
  riskCutLevelPct: .012,
  failCutAfterMs: 600000,
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
  const riskArm=config.riskCutArmPct??null, failMs=config.failCutAfterMs??null;
  // No candidate values are activated implicitly by importing this module.
  if(be===null && lock===null && riskArm===null && failMs===null) return base;
  if(be!==null && (!Number.isFinite(be)||be<=0)) throw Error('INVALID_BE_ARM');
  if(lock!==null && (!Number.isFinite(lock)||lock<=0 ||
      !Number.isFinite(config.profitLockCapture)||config.profitLockCapture<=0||
      config.profitLockCapture>=1 || (be!==null && lock<be))) throw Error('INVALID_PROFIT_LOCK');
  if(riskArm!==null && (!Number.isFinite(riskArm)||riskArm<=0)) throw Error('INVALID_RISK_CUT_ARM');
  if(failMs!==null && (!Number.isFinite(failMs)||failMs<=0)) throw Error('INVALID_FAIL_CUT');
  // The risk cut must sit strictly INSIDE the entry stop and strictly BELOW entry. Above
  // entry it would be a breakeven lock, which is the behaviour this level exists to remove;
  // outside the entry stop it could never bind and would be dead configuration.
  if(riskArm!==null || failMs!==null) {
    if(!Number.isFinite(config.riskCutLevelPct) || config.riskCutLevelPct<=0 ||
       config.riskCutLevelPct>=policy.stopPct) throw Error('INVALID_RISK_CUT_LEVEL');
  }
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
  // One level, two triggers: a favorable excursion that proves the leader moved, or a
  // deadline that proves it did not. Either way the loss cap tightens from the entry stop
  // to riskCutLevelPct, and because the level is below entry it never converts a live trade
  // into a fee-scale scratch. It is only ever a candidate for the max() below, so it can
  // no more lower an already-ratcheted stop than the other protection stages can.
  const heldMs=now-Number(position.entryAt);
  if((riskArm!==null && base.observedMfe+1e-12>=riskArm) || (failMs!==null && heldMs>=failMs))
    levels.push({stage:'RISK_CUT',price:entry*(1-config.riskCutLevelPct)});
  const binding=levels.reduce((best,x)=>x.price>=best.price?x:best);
  let stop=binding.price, reason=base.reason;
  const protectionStage=binding.stage;
  // A protective SELL trigger rounds upward: rounding must not increase allowed loss.
  if(tick>0) stop=Math.ceil(stop/tick-1e-10)*tick;
  if(bid<=stop) {
    if(protectionStage==='COST_BREAKEVEN') reason='V17_COST_BREAKEVEN';
    else if(protectionStage==='PROFIT_LOCK') reason='V17_PROFIT_LOCK';
    else if(protectionStage==='RISK_CUT') reason='V17_RISK_CUT';
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
  if(!/^[\p{L}\p{N}]+USDT$/u.test(symbol)||!positionId||!/^tb-[.A-Za-z0-9_:/-]{1,33}$/.test(clientAlgoId))
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
