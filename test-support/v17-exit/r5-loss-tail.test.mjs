import test from 'node:test';
import assert from 'node:assert/strict';
import {POLICY} from '../../supabase/functions/_shared/leader-momentum-v17.mjs';
import {EXIT_REVIEW_CANDIDATE as C, EXIT_REVIEW_R5 as R5, nextExitReviewed}
  from '../../supabase/functions/_shared/leader-exit-review.mjs';

const pos = {entryPrice:100, entryAt:0, peakPrice:100, stopPrice:97.5, lastHighAt:0, entryFee:.05, quantity:1};
const step = (p,bid,now,cfg=R5) => nextExitReviewed(p,bid,now,cfg);
const carry = (p,s) => ({...p, peakPrice:s.peakPrice, stopPrice:s.stopPrice, lastHighAt:s.lastHighAt});
const MIN = 60000;

test('R5 arms the risk cut below entry where the old ladder locked a scratch above it', () => {
  const old = nextExitReviewed(pos, 101.2, MIN, C);
  assert.equal(old.protectionStage, 'COST_BREAKEVEN');
  assert.ok(old.stopPrice > 100, 'old ladder puts the stop above entry at +1%');

  const now = step(pos, 101.2, MIN);
  assert.equal(now.protectionStage, 'RISK_CUT');
  assert.ok(Math.abs(now.stopPrice - 98.8) < 1e-9, 'R5 cuts risk to -1.2% instead');
  assert.ok(now.stopPrice < 100, 'the risk cut never sits above entry');
});

test('a +1% excursion that fades to breakeven is held, not scratched', () => {
  const armed = step(pos, 101.2, MIN);
  const back = step(carry(pos, armed), 100.05, 2*MIN);
  assert.equal(back.action, 'HOLD');
  assert.equal(nextExitReviewed(carry(pos, nextExitReviewed(pos,101.2,MIN,C)), 100.05, 2*MIN, C).action, 'CLOSE');
});

test('the risk cut binds before the -2.5% entry stop once armed', () => {
  const armed = step(pos, 101.2, MIN);
  const hit = step(carry(pos, armed), 98.7, 2*MIN);
  assert.equal(hit.action, 'CLOSE');
  assert.equal(hit.reason, 'V17_RISK_CUT');
  assert.ok(hit.priceReturn > -0.02, 'loss is capped well inside the 2.5% entry stop');
});

test('ten minutes without a 1% excursion arms the same cut', () => {
  const early = step(pos, 100.4, 9*MIN);
  assert.equal(early.stopPrice, 97.5, 'before the deadline the entry stop still owns the trade');
  const late = step(pos, 100.4, 10*MIN);
  assert.equal(late.protectionStage, 'RISK_CUT');
  assert.ok(Math.abs(late.stopPrice - 98.8) < 1e-9);
});

test('the deadline cut cannot fire on a trade that is already winning', () => {
  const s = step(pos, 103.5, 20*MIN);
  assert.ok(s.stopPrice > 100, 'a +3.5% trade trails above entry, not at the risk cut');
  assert.equal(s.action, 'HOLD');
});

test('profit lock and trailing stop are untouched by R5', () => {
  const lock = step(pos, 102.2, MIN);
  assert.equal(lock.protectionStage, 'PROFIT_LOCK');
  assert.ok(Math.abs(lock.stopPrice - 101.1) < 1e-10);
  const trail = step(pos, 110, MIN);
  assert.equal(trail.stopPrice, 108.35);
});

test('R5 never lowers a stop that a previous tick already ratcheted', () => {
  let p = pos;
  for (let i = 1; i < 200; i++) {
    const s = step(p, 100 + Math.sin(i/3)*2.5 + i*0.02, i*30000);
    assert.ok(s.stopPrice >= p.stopPrice, `stop loosened at tick ${i}`);
    p = carry(p, s);
  }
});

test('an already-open position keeps its inherited stop when R5 takes over', () => {
  // The live cutover case: a position ratcheted to +0.2% under the old ladder is
  // re-evaluated by R5. The risk cut is a lower level, so it must not bind.
  const inherited = {...pos, stopPrice:100.2, peakPrice:101.5, lastHighAt:MIN};
  const s = step(inherited, 101, 5*MIN);
  assert.equal(s.stopPrice, 100.2);
  assert.equal(s.protectionStage, 'BASELINE');
});

test('a risk cut outside or above the entry stop is rejected as dead configuration', () => {
  assert.throws(() => step(pos, 101, MIN, {...R5, riskCutLevelPct: POLICY.stopPct}), /INVALID_RISK_CUT_LEVEL/);
  assert.throws(() => step(pos, 101, MIN, {...R5, riskCutLevelPct: 0}), /INVALID_RISK_CUT_LEVEL/);
  assert.throws(() => step(pos, 101, MIN, {...R5, riskCutLevelPct: -0.01}), /INVALID_RISK_CUT_LEVEL/);
  assert.throws(() => step(pos, 101, MIN, {...R5, failCutAfterMs: -1}), /INVALID_FAIL_CUT/);
  assert.throws(() => step(pos, 101, MIN, {...R5, riskCutArmPct: 0}), /INVALID_RISK_CUT_ARM/);
});

test('R5 keeps the entry stop as the last-resort floor', () => {
  const s = step(pos, 97.4, 2*MIN);
  assert.equal(s.action, 'CLOSE');
  assert.equal(s.reason, 'V17_HARD_STOP');
});

test('importing R5 activates nothing by itself', () => {
  const bare = nextExitReviewed(pos, 101.2, MIN, {});
  assert.equal(bare.stopPrice, 97.5);
  assert.equal(bare.protectionStage, undefined);
});

test('R5 declares the fields the executor and the deploy guard rely on', () => {
  for (const k of ['policyVersion','riskCutArmPct','riskCutLevelPct','failCutAfterMs',
                   'profitLockArmPct','profitLockCapture','estimatedExitFeeRate','exitSlippageBudgetPct']) {
    assert.ok(k in R5, `EXIT_REVIEW_R5 is missing ${k}`);
  }
  assert.equal(R5.policyVersion, 'V17_EXIT_R5_TAIL');
  assert.ok(R5.riskCutLevelPct < POLICY.stopPct);
  assert.equal(R5.breakEvenArmPct, undefined, 'the above-entry breakeven lock must be gone');
});
