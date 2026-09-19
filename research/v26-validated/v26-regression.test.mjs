import test from "node:test";
import assert from "node:assert/strict";
import { entryReason, POLICY } from "../../supabase/functions/_shared/leader-momentum-v17.mjs";
import { resolveRiskPolicy } from "../../supabase/functions/_shared/boo/risk-policy.mjs";
import { solveQuantity } from "../../supabase/functions/_shared/boo/risk-budget.mjs";
import {
  structuralStopPrice,
  earlyFailureDecision,
  marketParticipationDecision,
  accelerationReignitionDecision,
  compressionExpansionDecision,
  rankPersistenceDecision,
  V26_CANDIDATES,
} from "../../supabase/functions/_shared/boo/v26-candidate-policy.mjs";
import { runExit, summarise } from "../v25-pullback-reaccel/replay.mjs";

const validFeature = () => ({
  rank: 1,
  dayReturn: 0.04,
  qv24: 8_000_000,
  return15m: 0.002,
  return30m: 0.008,
  return60m: 0.016,
  volumeRatio: 1.30,
});

test("selection gate fails closed on null/NaN and respects exact boundaries", () => {
  assert.equal(entryReason(validFeature()), "ELIGIBLE");
  assert.equal(entryReason({ ...validFeature(), dayReturn: 0.08 }), "DAY_RETURN_CHASE_CAP");
  assert.equal(entryReason({ ...validFeature(), dayReturn: 0.03 }), "ELIGIBLE");
  assert.equal(entryReason({ ...validFeature(), volumeRatio: 1.299999 }), "VOLUME_ACCELERATION");
  assert.equal(entryReason({ ...validFeature(), volumeRatio: 1.30 }), "ELIGIBLE");
  assert.equal(entryReason({ ...validFeature(), dayReturn: null }), "INVALID_FEATURES");
  assert.equal(entryReason({ ...validFeature(), dayReturn: Number.NaN }), "INVALID_FEATURES");
  const missing = validFeature(); delete missing.rank;
  assert.equal(entryReason(missing), "INVALID_FEATURES");
  assert.equal(POLICY.minVolumeRatio, 1.30);
  assert.equal(POLICY.maxDayReturn, 0.08);
});

test("registered C0-C15 definitions preserve the frozen C0-C5 prefix", () => {
  assert.deepEqual(Object.keys(V26_CANDIDATES).slice(0,6), ["C0","C1","C2","C3","C4","C5"]);
  assert.ok(V26_CANDIDATES.C12);
  assert.ok(V26_CANDIDATES.C15);
  assert.equal(V26_CANDIDATES.C0.structuralStop, false);
  assert.equal(V26_CANDIDATES.C4.earlyFailureExit, true);
  assert.equal(V26_CANDIDATES.C4.marketParticipation, true);
  assert.equal(V26_CANDIDATES.C5.maxDayReturn, 0.05);
});

test("C13-C15 structural gates use only completed preregistered inputs", () => {
  const triggerAt=1_800_000_300_000;
  const mk=(i,{o=100,h=100.3,l=99.9,c=100,q=1000,tb=500}={})=>({openTime:triggerAt-(4-i)*60_000,open:o,high:h,low:l,close:c,closeTime:triggerAt-(4-i)*60_000+59_999,quoteVolume:q,takerBuyQuote:tb});
  const accel=[mk(0,{c:100,tb:450}),mk(1,{c:100.02,tb:480}),mk(2,{c:100.05,tb:560}),mk(3,{h:100.3,c:100.2,tb:650})];
  assert.equal(accelerationReignitionDecision({triggerAt,now:triggerAt,bars:accel,return5m:.006,return15m:.009}).action,"ENTER");
  const comp=[];for(let i=0;i<4;i++)comp.push({openTime:triggerAt-(5-i)*60_000,open:100,high:100.1,low:99.9,close:100,closeTime:triggerAt-(5-i)*60_000+59_999,quoteVolume:1000,takerBuyQuote:520});
  comp.push({openTime:triggerAt-60_000,open:100,high:100.7,low:99.95,close:100.65,closeTime:triggerAt-1,quoteVolume:1800,takerBuyQuote:1200});
  assert.equal(compressionExpansionDecision({triggerAt,now:triggerAt,bars:comp}).action,"ENTER");
  assert.equal(rankPersistenceDecision({currentRank:4,priorRanks:[6,null],return30m:.02,return60m:.03}).action,"ENTER");
});

test("structural stop uses the larger of two ticks and 0.1 ATR then rounds outward", () => {
  const r = structuralStopPrice({ setupLow: 100, priceTick: 0.01, atr5m14: 1 });
  assert.equal(r.status, "OK");
  assert.equal(r.buffer, 0.1);
  assert.ok(Math.abs(r.price - 99.9) < 1e-9);
});

test("early failure uses only completed post-entry bars and exact four conditions", () => {
  const t0 = 1_800_000_000_000;
  const bars = [0,1,2].map((i) => ({
    openTime: t0 + i*60_000,
    closeTime: t0 + i*60_000 + 59_999,
    high: 100.2,
    close: 99.8 - i*0.1,
    quoteVolume: 1000,
    takerBuyQuote: 400,
  }));
  const r = earlyFailureDecision({
    entryPrice:100, initialStopPrice:98, signalReference:100,
    entryAt:t0, now:t0+3*60_000+1, completedBars:bars,
  });
  assert.equal(r.action, "CLOSE");
  assert.equal(r.reason, "V26_EARLY_FAILURE");
  assert.ok(r.observedMfe < r.initialRiskR * 0.25);

  const unknown = earlyFailureDecision({
    entryPrice:100, initialStopPrice:98, signalReference:100,
    entryAt:t0, now:t0+2*60_000, completedBars:bars.slice(0,2),
  });
  assert.equal(unknown.action, "UNKNOWN");
});

test("market participation never invents missing historical breadth", () => {
  assert.equal(marketParticipationDecision({
    btcReturn60m:0, rising30mCount:50, liquidUniverseCount:100,
  }).allowed, true);
  assert.equal(marketParticipationDecision({
    btcReturn60m:-0.0001, rising30mCount:80, liquidUniverseCount:100,
  }).allowed, false);
  const missing=marketParticipationDecision({btcReturn60m:0,rising30mCount:null,liquidUniverseCount:100});
  assert.equal(missing.status, "UNKNOWN");
  assert.equal(missing.allowed, false);
});

test("risk solver budgets at the executable IOC price cap", () => {
  const resolved = resolveRiskPolicy({
    risk_per_trade_pct:0.25,
    max_daily_loss_pct:1,
    max_weekly_loss_pct:3,
    max_open_positions:1,
    max_open_positions_per_exchange:1,
    max_consecutive_losses:3,
  });
  assert.equal(resolved.ok, true);
  const common = {
    policy: resolved.policy,
    equity: "30",
    bookAsks: [["100","100"]],
    bookBids: [["99","100"]],
    structuralStop: "99.7",
    stopSlippageFrac: "0",
    takerFeeRate: 0,
    stopFeeRate: 0,
    expectedFundingCost: 0,
    filters: { minQty:"0.001", maxQty:"100", stepSize:"0.001", minNotional:"5" },
    reservedRisk:0,
    openGrossNotional:0,
    availableMargin:30,
    leverage:3,
    dailyRemaining:"0.3",
    weeklyRemaining:"0.9",
  };
  const base=solveQuantity(common);
  const capped=solveQuantity({...common,entryPriceCap:"100.2"});
  assert.equal(base.decision,"ENTER");
  assert.equal(capped.decision,"ENTER");
  assert.ok(Number(capped.plan.entryVwap.toString()) >= 100.2);
  assert.ok(Number(capped.plan.quantity.toString()) <= Number(base.plan.quantity.toString()));
  const q=Number(capped.plan.quantity.toString());
  assert.ok(Math.abs(Number(capped.plan.notional.toString()) - q*100.2) < 1e-8);
});

test("replay applies the entry-bar stop immediately", () => {
  const entry={price:100,at:0,quantity:1,fee:0};
  const bars=[[0,100,101,97,100]];
  const r=runExit(entry,bars,{stressPct:0,qv3:"off"});
  assert.equal(r.status,"SETTLED");
  assert.equal(r.reason,"V17_HARD_STOP");
  assert.equal(r.exitAt,0);
  assert.ok(r.exitPrice < 97.5);
});

test("replay does not fabricate a realized exit at window end", () => {
  const entry={price:100,at:0,quantity:1,fee:0};
  const bars=[[0,100,100.1,99.9,100.05]];
  const r=runExit(entry,bars,{stressPct:0,qv3:"off"});
  assert.equal(r.status,"UNSETTLED");
  assert.equal(r.exitPrice,null);
  assert.equal(r.netPnl,null);
  const s=summarise([r]);
  assert.equal(s.trades,0);
  assert.equal(s.unresolved,1);
});
