// The BOO common entry gate runs in front of the legacy admission path. Which of the
// two decides is a single operator row, boo_entry_gate_control.enforcement, and the
// production posture on 2026-09-16 was OBSERVE.
//
// That posture only means anything if OBSERVE really is independent. The gate's
// verdict in production is allowed=false and has been for all 166 recorded decisions
// -- there is no approved strategy record, no measured cost edge, and the live risk
// settings are refused as implausible. If OBSERVE leaked into admission, nothing
// could ever enter, and the sizing fix here would be invisible.
//
// These tests pin both directions against the REAL adapter and the REAL executor
// source: OBSERVE observes, ENFORCE stops.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {harness} from '../v18-ops/harness.mjs';
import {ENFORCEMENT} from '../../supabase/functions/v10-lane-executor/boo-entry-adapter.mjs';
import {SLOT_SIZING_CONTRACT} from '../../supabase/functions/_shared/leader-slot-sizing.mjs';
import {SETUP_POLICY_VERSION,SETUP_STATE} from '../../supabase/functions/_shared/leader-pullback-reaccel.mjs';
import {B06133_VERSION} from '../../supabase/functions/_shared/leader-b06133-entry.mjs';
import {CEC0040_VERSION,CEC0040_TARGET_VERSION} from '../../supabase/functions/_shared/leader-cec0040.mjs';

function stampCurrentEntry(h){
  const signal=h.state.tables.v11_long_regime_signals[0],at=signal.features.v17Setup.triggerAt;
  Object.assign(signal.features,{sizingContractVersion:SLOT_SIZING_CONTRACT.version,
    targetMarginUsdt:SLOT_SIZING_CONTRACT.targetMarginUsdt,leverage:SLOT_SIZING_CONTRACT.leverage,
    v17Setup:{...signal.features.v17Setup},
    b06133:{version:B06133_VERSION,source:{decisionAt:at}},
    cec0040:{version:CEC0040_VERSION,targetVersion:CEC0040_TARGET_VERSION,ready:true,decisionAt:at,action:'ADMIT'}});
  Object.assign(h.ctx,{B06133_VERSION,CEC0040_VERSION,CEC0040_TARGET_VERSION,V30_FRONT_LIVE_VERSION:'TEST',
    baselineAllowedV30:()=>true,entryBranchOf:()=> 'TEST_BRANCH',
    gptFinalCheck:()=>({allowed:true,review:{decision:'PASS'}}),
    gptBeginExecution:()=>({}),gptConfirmFirstFinality:()=>true,
    finalRecheckStep:async()=>({proceed:true,reason:'TEST_PASS',record:{recheck_triggered:false}}),
    withOrderTiming:x=>x,IOC_RETRY_POLICY:{maxAttempts:1}});
  return signal;
}

/** One admission attempt, with the gate set to `enforcement`. */
async function attempt(enforcement) {
  const h = harness({booEnforcement: enforcement});
  h.state.createOrder = (cmd, state) => ({order: {
    orderId: 'boo-probe', clientOrderId: cmd.order.identifier, symbol: cmd.order.market,
    side: 'BUY', positionSide: 'BOTH', reduceOnly: false, origQty: String(cmd.order.quantity),
    executedQty: '0', status: 'EXPIRED', avgPrice: '0', updateTime: state.now, fills: []}});
  const signal = stampCurrentEntry(h);
  const result = await h.ctx.open(signal, [], []);
  const verdicts = h.state.tables.boo_entry_gate_decisions ?? [];
  return {result, verdicts, dispatched: h.state.calls.filter(c => c.action === 'create_order')};
}

// CASE 10 -- OBSERVE with a refusing verdict must not block the legacy path.
test('CASE 10: BOO OBSERVE with verdict=false does not block a legacy entry', async () => {
  const {result, dispatched} = await attempt(ENFORCEMENT.OBSERVE);
  assert.ok(!String(result.reason ?? '').startsWith('BOO_ENTRY_GATE'),
    `OBSERVE must not refuse admission, got ${result.reason}`);
  assert.equal(dispatched.length, 1,
    'the legacy path must reach dispatch while the gate only observes');
});

// CASE 11 -- ENFORCE with the same refusing verdict must stop the entry.
test('CASE 11: BOO ENFORCE with verdict=false blocks the entry, fail-closed', async () => {
  const {result, dispatched} = await attempt(ENFORCEMENT.ENFORCE);
  assert.match(String(result.reason), /^BOO_ENTRY_GATE:/);
  assert.equal(result.entered, false);
  assert.equal(dispatched.length, 0, 'nothing may be sent once the gate enforces');
  // And it hands the claim back rather than burning the signal: enforcement is a
  // hold on this attempt, not a verdict on the signal.
  assert.equal(result.releaseClaim, true);
});

test('an absent control row enforces rather than defaults to observing', async () => {
  // The read is the operator's authority. Missing means unknown, and unknown must
  // not become permission.
  const h = harness({booEnforcement: ENFORCEMENT.OBSERVE});
  h.state.tables.boo_entry_gate_control = [];
  const signal = stampCurrentEntry(h);
  const result = await h.ctx.open(signal, [], []);
  assert.match(String(result.reason), /^BOO_ENTRY_GATE:/);
});

test('a refusing BOO verdict is a SYMBOL-scoped release, not an account halt', () => {
  // It is one signal's verdict. Under ENFORCE it must still stop THAT entry, but it
  // must not end the run for every other candidate -- that is how the queue starved.
  const source = readFileSync(
    new URL('../../supabase/functions/v10-lane-executor/index.ts', import.meta.url), 'utf8');
  const at = source.indexOf('BOO_ENTRY_GATE:${booAdmission.verdict.reason}');
  assert.ok(at > 0);
  const tail = source.slice(at, at + 220);
  assert.match(tail, /releaseScope:RELEASE_SCOPE\.SYMBOL/);
});
