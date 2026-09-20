import test from "node:test";
import assert from "node:assert/strict";
import { entryReason, POLICY } from "../../supabase/functions/_shared/leader-momentum-v17.mjs";
import { resolveRiskPolicy } from "../../supabase/functions/_shared/boo/risk-policy.mjs";
import { solveQuantity } from "../../supabase/functions/_shared/boo/risk-budget.mjs";
import {
  structuralStopPrice,
  earlyFailureDecision,
  marketParticipationDecision,
  marketBreadthInflectionDecision,
  accelerationReignitionDecision,
  compressionExpansionDecision,
  rankPersistenceDecision,
  rankAccelerationLeaderDecision,
  pullbackAbsorptionDecision,
  relativeStrengthResidualDecision,
  sweepReclaimDecision,
  freshLeaderRotationDecision,
  accountFeasibleLadderDecision,
  twoPulseResetDecision,
  liquidityAdjustedEfficiencyDecision,
  selectiveLeaderRegimeDecision,
  distributedTrendDecision,
  breakoutRetestHold2mDecision,
  controlledPullbackReclaim3mDecision,
  breakoutAcceptance3mDecision,
  sellerExhaustionDecision,
  volumeDryupReaccelDecision,
  buyerNotionalEscalationDecision,
  rollingPullbackQualityPercentiles,
  crossSectionalPullbackQualityDecision,
  buyerFlowAccelerationScore,
  crossSectionalBuyerFlowDecision,
  executionAdjustedBreakoutScore,
  crossSectionalExecutionValueDecision,
  compressionExpansion60mScore,
  crossSectionalCompressionExpansionDecision,
  selectCompressionExpansionQueueWinners,
  selectCompressionExpansionCycleWinners,
  selectCompressionExpansionSetupReservations,
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

test("registered C0-C40 definitions preserve the frozen C0-C5 prefix", () => {
  assert.deepEqual(Object.keys(V26_CANDIDATES).slice(0,6), ["C0","C1","C2","C3","C4","C5"]);
  assert.ok(V26_CANDIDATES.C12);
  assert.ok(V26_CANDIDATES.C15);
  assert.ok(V26_CANDIDATES.C18);
  assert.ok(V26_CANDIDATES.C21);
  assert.ok(V26_CANDIDATES.C24);
  assert.ok(V26_CANDIDATES.C27);
  assert.ok(V26_CANDIDATES.C30);
  assert.ok(V26_CANDIDATES.C31);
  assert.ok(V26_CANDIDATES.C32);
  assert.ok(V26_CANDIDATES.C33);
  assert.ok(V26_CANDIDATES.C34);
  assert.ok(V26_CANDIDATES.C35);
  assert.ok(V26_CANDIDATES.C36);
  assert.ok(V26_CANDIDATES.C37);
  assert.ok(V26_CANDIDATES.C38);
  assert.ok(V26_CANDIDATES.C39);
  assert.ok(V26_CANDIDATES.C40);
  assert.equal(V26_CANDIDATES.C0.structuralStop, false);
  assert.equal(V26_CANDIDATES.C4.earlyFailureExit, true);
  assert.equal(V26_CANDIDATES.C4.marketParticipation, true);
  assert.equal(V26_CANDIDATES.C5.maxDayReturn, 0.05);
});

test("C40 requires two completed rank improvements and recent-half acceleration",()=>{
  assert.equal(V26_CANDIDATES.C40.rankAccelerationLeader,true);
  assert.equal(V26_CANDIDATES.C40.rankPersistence,false);
  assert.equal(rankAccelerationLeaderDecision({currentRank:3,priorRanks:[5,8],return30m:.03,return60m:.05}).action,"ENTER");
  assert.equal(rankAccelerationLeaderDecision({currentRank:3,priorRanks:[5,4],return30m:.03,return60m:.05}).action,"REJECT");
  assert.equal(rankAccelerationLeaderDecision({currentRank:3,priorRanks:[5,null],return30m:.03,return60m:.05}).action,"UNKNOWN");
  assert.equal(rankAccelerationLeaderDecision({currentRank:3,priorRanks:[5,8],return30m:.02,return60m:.05}).action,"REJECT");
});

test("C39 requires joint completed-snapshot breadth and BTC improvement",()=>{
  assert.equal(V26_CANDIDATES.C39.marketBreadthInflection,true);
  assert.equal(V26_CANDIDATES.C39.marketParticipation,false);
  assert.equal(V26_CANDIDATES.C39.crossSectionalCompressionExpansion60m,true);
  assert.equal(marketBreadthInflectionDecision({
    btcReturn30m:.002,priorBtcReturn30m:-.001,rising30mFraction:.52,priorRising30mFraction:.47,
  }).action,"ENTER");
  assert.equal(marketBreadthInflectionDecision({
    btcReturn30m:.002,priorBtcReturn30m:-.001,rising30mFraction:.45,priorRising30mFraction:.47,
  }).action,"REJECT");
  assert.equal(marketBreadthInflectionDecision({
    btcReturn30m:null,priorBtcReturn30m:-.001,rising30mFraction:.52,priorRising30mFraction:.47,
  }).action,"UNKNOWN");
});

test("C38 composes unchanged market participation with C34 expansion",()=>{
  assert.equal(V26_CANDIDATES.C38.marketParticipation,true);
  assert.equal(V26_CANDIDATES.C38.crossSectionalCompressionExpansion60m,true);
  assert.equal(V26_CANDIDATES.C38.structuralStop,true);
  assert.equal(V26_CANDIDATES.C38.compressionExpansionQueueWinner,false);
  assert.equal(V26_CANDIDATES.C38.compressionExpansionCycleAuction,false);
  assert.equal(V26_CANDIDATES.C38.compressionExpansionSetupReservation,false);
});

test("C37 reserves one deterministic setup before any later trigger evidence",()=>{
  const selected=selectCompressionExpansionSetupReservations([
    {id:"weak",at:1_000_000,score:1.5},
    {id:"strong",at:1_000_000,score:2.5},
    {id:"later",at:1_300_000,score:1.1},
  ]);
  assert.deepEqual(selected.map(x=>x.id),["strong","later"]);
  assert.equal(V26_CANDIDATES.C37.crossSectionalCompressionExpansion60m,true);
  assert.equal(V26_CANDIDATES.C37.compressionExpansionSetupReservation,true);
  assert.equal(V26_CANDIDATES.C37.compressionExpansionCycleAuction,false);
});

test("C36 holds a causal 15m auction and enters at the completed cycle boundary",()=>{
  const m=60_000,cycle=15*m;
  const selected=selectCompressionExpansionCycleWinners([
    {id:"early",at:90*m+1*m,score:4},
    {id:"winner",at:90*m+14*m,score:5},
    {id:"boundary",at:90*m+15*m,score:3},
    {id:"next",at:90*m+16*m,score:2},
  ],{cycleMs:cycle});
  assert.deepEqual(selected.map(x=>x.id),["winner","next"]);
  assert.equal(selected[0].entryAt,105*m);
  assert.equal(selected[1].entryAt,120*m);
  assert.equal(V26_CANDIDATES.C36.compressionExpansionCycleAuction,true);
});

test("C35 selects one deterministic highest pre-entry score per queue timestamp",()=>{
  const selected=selectCompressionExpansionQueueWinners([
    {id:"z",at:1000,score:2},{id:"b",at:1000,score:3},{id:"a",at:1000,score:3},
    {id:"c",at:2000,score:1},{id:"invalid",at:2000,score:Number.NaN},
  ]);
  assert.deepEqual(selected.map(x=>x.id),["a","c"]);
  assert.equal(V26_CANDIDATES.C35.crossSectionalCompressionExpansion60m,true);
  assert.equal(V26_CANDIDATES.C35.compressionExpansionQueueWinner,true);
});

test("C34 scores only completed 60m compression-to-expansion evidence",()=>{
  const triggerAt=1_800_003_600_000;
  const bars=Array.from({length:60},(_,i)=>{
    const open=100+i*.001,wide=i>=55?.15:.02,close=open+(i>=55?.08:.002);
    return {openTime:triggerAt-(60-i)*60_000,open,high:open+wide,low:open-wide/2,close,
      closeTime:triggerAt-(59-i)*60_000-1,quoteVolume:1000,takerBuyQuote:550};
  });
  const scored=compressionExpansion60mScore({triggerAt,now:triggerAt,bars});
  assert.equal(scored.status,"KNOWN");
  assert.ok(scored.score>1);
  assert.equal(compressionExpansion60mScore({triggerAt,now:triggerAt,bars:bars.slice(1)}).status,"UNKNOWN");
  assert.equal(crossSectionalCompressionExpansionDecision({expansionPercentile:.60,observations:20}).action,"ENTER");
  assert.equal(crossSectionalCompressionExpansionDecision({expansionPercentile:.59,observations:20}).action,"REJECT");
});

test("C33 scores completed breakout surplus against structural risk and fixed costs",()=>{
  const scored=executionAdjustedBreakoutScore({signalReference:100,triggerClose:101,structuralStop:99,
    takerFee:.0005,entryBps:3,stopBps:10,fundingAllowanceRate:.001});
  assert.equal(scored.status,"KNOWN");
  assert.ok(scored.score>0&&scored.score<1);
  assert.equal(executionAdjustedBreakoutScore({signalReference:101,triggerClose:101,structuralStop:99}).status,"UNKNOWN");
  assert.equal(crossSectionalExecutionValueDecision({valuePercentile:.60,observations:20}).action,"ENTER");
  assert.equal(crossSectionalExecutionValueDecision({valuePercentile:.59,observations:20}).action,"REJECT");
});

test("C32 ranks completed buyer-flow acceleration relative to seller flow",()=>{
  const triggerAt=1_800_002_400_000;
  const mk=(i,q,tb)=>({openTime:triggerAt-(4-i)*60_000,open:100+i*.1,high:100.2+i*.1,
    low:99.9+i*.1,close:100.1+i*.1,closeTime:triggerAt-(3-i)*60_000-1,
    quoteVolume:q,takerBuyQuote:tb});
  const scored=buyerFlowAccelerationScore({triggerAt,now:triggerAt,bars:[
    mk(0,1000,450),mk(1,1000,470),mk(2,1100,650),mk(3,1200,780),
  ]});
  assert.equal(scored.status,"KNOWN");
  assert.ok(scored.score>0);
  assert.equal(crossSectionalBuyerFlowDecision({flowPercentile:.60,observations:20}).action,"ENTER");
  assert.equal(crossSectionalBuyerFlowDecision({flowPercentile:.59,observations:20}).action,"REJECT");
  assert.equal(crossSectionalBuyerFlowDecision({flowPercentile:null,observations:19}).action,"UNKNOWN");
});

test("C31 rolling pullback quality is causal and uses one cross-sectional gate",()=>{
  const records=Array.from({length:24},(_,i)=>({id:`R${i}`,at:1_800_000_000_000+i*60_000,score:i+1}));
  const ranked=rollingPullbackQualityPercentiles(records,{lookbackMs:24*60*60_000,minObservations:20});
  assert.equal(ranked[18].percentile,null);
  assert.equal(ranked[19].observations,20);
  assert.equal(ranked[19].percentile,1);
  assert.equal(crossSectionalPullbackQualityDecision({qualityPercentile:.60,observations:20}).action,"ENTER");
  assert.equal(crossSectionalPullbackQualityDecision({qualityPercentile:.59,observations:20}).action,"REJECT");
  const withFuture=rollingPullbackQualityPercentiles([...records,{id:"FUTURE",at:records.at(-1).at+86_400_000,score:999}],
    {lookbackMs:7*86_400_000,minObservations:20});
  assert.equal(withFuture.find(x=>x.id==="R19").percentile,ranked[19].percentile);
});

test("C28-C30 use seller exhaustion, volume dry-up and absolute buyer notional",()=>{
  const triggerAt=1_800_002_400_000;
  const mk=(openTime,{o,h,l,c,q,tb})=>({openTime,open:o,high:h,low:l,close:c,
    closeTime:openTime+59_999,quoteVolume:q,takerBuyQuote:tb});
  const five=[
    mk(triggerAt-300_000,{o:100.4,h:100.6,l:100.2,c:100.3,q:1200,tb:480}),
    mk(triggerAt-240_000,{o:100.3,h:100.5,l:100.15,c:100.2,q:1000,tb:420}),
    mk(triggerAt-180_000,{o:100.2,h:100.35,l:100.1,c:100.15,q:800,tb:360}),
    mk(triggerAt-120_000,{o:100.15,h:100.3,l:100.1,c:100.25,q:650,tb:325}),
    mk(triggerAt-60_000,{o:100.25,h:100.9,l:100.2,c:100.8,q:1300,tb:780}),
  ];
  assert.equal(sellerExhaustionDecision({triggerAt,now:triggerAt,bars:five,signalReference:100.1}).action,"ENTER");
  const six=[
    mk(triggerAt-360_000,{o:100,h:100.4,l:99.9,c:100.3,q:1200,tb:650}),
    mk(triggerAt-300_000,{o:100.3,h:100.7,l:100.2,c:100.6,q:1300,tb:720}),
    mk(triggerAt-240_000,{o:100.6,h:100.9,l:100.5,c:100.8,q:1100,tb:620}),
    mk(triggerAt-180_000,{o:100.8,h:100.82,l:100.55,c:100.65,q:600,tb:280}),
    mk(triggerAt-120_000,{o:100.65,h:100.75,l:100.5,c:100.7,q:500,tb:260}),
    mk(triggerAt-60_000,{o:100.7,h:101.2,l:100.65,c:101.1,q:1500,tb:900}),
  ];
  assert.equal(volumeDryupReaccelDecision({triggerAt,now:triggerAt,bars:six,signalReference:100.5}).action,"ENTER");
  const four=[
    mk(triggerAt-240_000,{o:100.2,h:100.4,l:100.1,c:100.3,q:800,tb:400}),
    mk(triggerAt-180_000,{o:100.3,h:100.5,l:100.2,c:100.4,q:900,tb:500}),
    mk(triggerAt-120_000,{o:100.4,h:100.6,l:100.3,c:100.5,q:1000,tb:600}),
    mk(triggerAt-60_000,{o:100.5,h:101.1,l:100.45,c:101,q:1400,tb:1000}),
  ];
  assert.equal(buyerNotionalEscalationDecision({triggerAt,now:triggerAt,bars:four,signalReference:100.1}).action,"ENTER");
});

test("C25-C27 delay entry until completed retest, reclaim, or acceptance evidence",()=>{
  const triggerAt=1_800_001_800_000;
  const mk=(i,{o,h,l,c,tb,q=1000})=>({openTime:triggerAt+i*60_000,open:o,high:h,low:l,close:c,
    closeTime:triggerAt+(i+1)*60_000-1,quoteVolume:q,takerBuyQuote:tb});
  const retest=[
    mk(0,{o:100.7,h:100.8,l:100.35,c:100.55,tb:500}),
    mk(1,{o:100.55,h:101.2,l:100.5,c:101.1,tb:600}),
  ];
  assert.equal(breakoutRetestHold2mDecision({triggerAt,now:triggerAt+120_000,bars:retest,
    signalReference:100.2,setupLow:100.1,triggerClose:100.6,triggerHigh:101}).action,"ENTER");
  const reclaim=[
    mk(0,{o:100.7,h:100.8,l:100.3,c:100.5,tb:480}),
    mk(1,{o:100.5,h:100.65,l:100.25,c:100.45,tb:500}),
    mk(2,{o:100.45,h:101,l:100.4,c:100.9,tb:620}),
  ];
  assert.equal(controlledPullbackReclaim3mDecision({triggerAt,now:triggerAt+180_000,bars:reclaim,
    signalReference:100.2,setupLow:100.1,triggerClose:100.6}).action,"ENTER");
  const accepted=[
    mk(0,{o:100.8,h:101.3,l:100.4,c:101.15,tb:540}),
    mk(1,{o:101.15,h:101.4,l:100.6,c:101.2,tb:520}),
    mk(2,{o:101.2,h:101.5,l:100.8,c:101.3,tb:560}),
  ];
  assert.equal(breakoutAcceptance3mDecision({triggerAt,now:triggerAt+180_000,bars:accepted,
    signalReference:100.2,triggerHigh:101}).action,"ENTER");
  assert.equal(breakoutAcceptance3mDecision({triggerAt,now:triggerAt+120_000,bars:accepted,
    signalReference:100.2,triggerHigh:101}).action,"UNKNOWN");
});

test("C22-C24 use contemporaneous efficiency, selective breadth and distributed trend",()=>{
  const triggerAt=1_800_001_200_000;
  const trigger={openTime:triggerAt-60_000,open:100.4,high:100.8,low:100.3,close:100.7,closeTime:triggerAt-1,quoteVolume:1000,takerBuyQuote:600};
  assert.equal(liquidityAdjustedEfficiencyDecision({
    return30m:.02,return60m:.03,return30mPercentile:.8,volumeRatioPercentile:.7,
    efficiencyPercentile:.6,triggerAt,now:triggerAt,bar:trigger,
  }).action,"ENTER");
  assert.equal(selectiveLeaderRegimeDecision({
    return30m:.02,return60m:.03,return30mPercentile:.9,efficiencyPercentile:.8,
    leaderBreadth30m:.4,triggerAt,now:triggerAt,bar:trigger,
  }).action,"ENTER");
  const bars=[0,1,2,3,4,5].map((i)=>{
    const open=100+i*.1,close=open+.08;
    return {openTime:triggerAt-(6-i)*60_000,open,high:close+.06,low:open-.06,close,
      closeTime:triggerAt-(6-i)*60_000+59_999,quoteVolume:1000,takerBuyQuote:550};
  });
  assert.equal(distributedTrendDecision({
    triggerAt,now:triggerAt,bars,signalReference:100.2,leaderBreadth30m:.7,
  }).action,"ENTER");
});

test("C19-C21 add rotation, executable geometry and two-pulse structures",()=>{
  const triggerAt=1_800_000_480_000;
  const bar=(i,{o,h,l,c,tb,q=1000})=>({
    openTime:triggerAt-(8-i)*60_000,open:o,high:h,low:l,close:c,
    closeTime:triggerAt-(8-i)*60_000+59_999,quoteVolume:q,takerBuyQuote:tb,
  });
  const pulse=[
    bar(0,{o:100,h:100.4,l:99.9,c:100.3,tb:560}),
    bar(1,{o:100.3,h:100.8,l:100.2,c:100.7,tb:590}),
    bar(2,{o:100.7,h:101,l:100.6,c:100.8,tb:570}),
    bar(3,{o:100.8,h:100.85,l:100.45,c:100.55,tb:470}),
    bar(4,{o:100.55,h:100.75,l:100.4,c:100.65,tb:480}),
    bar(5,{o:100.65,h:100.8,l:100.5,c:100.7,tb:500}),
    bar(6,{o:100.7,h:101,l:100.65,c:100.9,tb:600}),
    bar(7,{o:100.9,h:101.3,l:100.85,c:101.2,tb:650}),
  ];
  assert.equal(freshLeaderRotationDecision({
    currentRank:5,priorRanks:[11,14],return30m:.03,return60m:.045,
    triggerAt,now:triggerAt,bar:pulse.at(-1),
  }).action,"ENTER");
  const ladder=pulse.slice(-4);
  assert.equal(accountFeasibleLadderDecision({
    triggerAt,now:triggerAt,bars:ladder,signalReference:100.5,entryPrice:101.25,stopPrice:100.5,
    filters:{minNotional:5,minQty:.001,stepSize:.001},
  }).action,"ENTER");
  assert.equal(twoPulseResetDecision({triggerAt,now:triggerAt,bars:pulse,signalReference:100}).action,"ENTER");
});

test("C16-C18 structural gates use completed absorption, residual and reclaim evidence",()=>{
  const triggerAt=1_800_000_360_000;
  const rows=[
    {o:100,c:99.8,h:100.1,l:99.7,tb:470},{o:99.8,c:99.6,h:99.9,l:99.5,tb:460},
    {o:99.6,c:99.7,h:99.8,l:99.55,tb:500},{o:99.7,c:99.8,h:99.9,l:99.6,tb:520},
    {o:99.8,c:99.9,h:100,l:99.7,tb:540},{o:99.9,c:100.2,h:100.25,l:99.8,tb:650},
  ].map((x,i)=>({openTime:triggerAt-(6-i)*60_000,open:x.o,high:x.h,low:x.l,close:x.c,closeTime:triggerAt-(6-i)*60_000+59_999,quoteVolume:1000,takerBuyQuote:x.tb}));
  assert.equal(pullbackAbsorptionDecision({triggerAt,now:triggerAt,bars:rows,signalReference:100}).action,"ENTER");
  assert.equal(relativeStrengthResidualDecision({return30m:.03,return60m:.05,btcReturn30m:.005,btcReturn60m:.01}).action,"ENTER");
  assert.equal(sweepReclaimDecision({triggerAt,now:triggerAt,bars:rows,signalReference:100}).action,"ENTER");
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
