import test from "node:test";
import assert from "node:assert/strict";
import {
  sha256Hex, verifyChecksumBytes, logicalDatasetHash,
  collectMonthlyWithDailyFallback, fetchFundingHistory, fundingHistoryFromCache,
  cutoffCoverageSummary, longFundingCost, strengthLossDecision,
} from "./data-source-integrity.mjs";

const row=(t,v="1")=>[t,v,v,v,v,"0",t+899_999,"1",0,"0","0.5","0"];

test("Binance checksum verification is fail-closed",()=>{
  const bytes=new TextEncoder().encode("verified archive bytes");
  const digest=sha256Hex(bytes);
  assert.equal(verifyChecksumBytes(bytes,`${digest}  BTCUSDT-15m-2026-05.zip\n`,`BTCUSDT-15m-2026-05.zip`),digest);
  assert.throws(()=>verifyChecksumBytes(bytes,`${"0".repeat(64)}  BTCUSDT-15m-2026-05.zip\n`,`BTCUSDT-15m-2026-05.zip`),/CHECKSUM_MISMATCH/);
});

test("logical dataset hash is stable across cache/retrieval order",()=>{
  const a=[{source:"B",sha256:"b".repeat(64)},{source:"A",sha256:"a".repeat(64)}];
  const b=[...a].reverse();
  assert.equal(logicalDatasetHash(a),logicalDatasetHash(b));
});

test("mixed monthly availability falls back per missing month/day",async()=>{
  const I=900_000;
  const start=Date.UTC(2026,0,31,23,30), end=Date.UTC(2026,1,1,0,30);
  const jan=[row(start),row(start+I)];
  const feb=[row(start+2*I),row(start+3*I),row(start+4*I)];
  const seen=[];
  const out=await collectMonthlyWithDailyFallback({
    start,end,intervalMs:I,
    loadMonthly:async(month)=>month==="2026-01"?jan:[],
    loadDaily:async(day)=>{seen.push(day);return day==="2026-02-01"?feb:[];},
  });
  assert.equal(out.complete,true);
  assert.equal(out.rows.length,5);
  assert.deepEqual(seen,["2026-02-01"]);
  assert.equal(out.diagnostics[1].missingBefore,3);
  assert.equal(out.diagnostics[1].missingAfter,0);
});

test("funding provider refuses blocked/missing history instead of zeroing it",async()=>{
  const fake=async()=>({ok:false,status:451,json:async()=>({})});
  await assert.rejects(()=>fetchFundingHistory({symbol:"CETUSUSDT",startTime:1,endTime:2,fetchImpl:fake}),/FUNDING_HTTP_451/);
});

test("funding cache distinguishes verified zero events from missing coverage",()=>{
  const cache={coverage:[{symbol:"APTUSDT",startTime:100,endTime:200,events:[]}]};
  assert.deepEqual(fundingHistoryFromCache({cache,symbol:"APTUSDT",startTime:120,endTime:180}),[]);
  assert.throws(()=>fundingHistoryFromCache({cache,symbol:"APTUSDT",startTime:90,endTime:180}),/FUNDING_CACHE_COVERAGE_MISSING/);
  assert.throws(()=>fundingHistoryFromCache({cache,symbol:"STOUSDT",startTime:120,endTime:180}),/FUNDING_CACHE_COVERAGE_MISSING/);
});

test("funding cache returns only verified events inside requested interval",()=>{
  const a={symbol:"CETUSUSDT",fundingTime:150,fundingRate:"0.00005000",markPrice:"0.03585000"};
  const b={symbol:"CETUSUSDT",fundingTime:190,fundingRate:"0.00006000",markPrice:"0.03600000"};
  const cache={coverage:[{symbol:"CETUSUSDT",startTime:100,endTime:220,events:[a,b]}]};
  assert.deepEqual(fundingHistoryFromCache({cache,symbol:"CETUSUSDT",startTime:140,endTime:180}),[a]);
});

test("cutoff quality summary derives blocked count from actual completed bars",()=>{
  const I=900_000, cut1=10*I, cut2=11*I;
  const rowsBySymbol=new Map([
    ["A",[row(7*I),row(8*I),row(9*I),row(10*I)]],
    ["B",[row(8*I),row(9*I),row(10*I)]],
  ]);
  const out=cutoffCoverageSummary({
    cutoffs:[cut1,cut2],
    expectedByCutoff:()=>["A","B"],
    rowsBySymbol,
    intervalMs:I,
    requiredBars:3,
    minCoverage:0.75,
  });
  assert.equal(out.totalCutoffs,2);
  assert.equal(out.blockedCutoffs,1);
  assert.deepEqual(out.details.map(x=>({evaluated:x.evaluated,coverage:x.coverage,blocked:x.blocked})),[
    {evaluated:1,coverage:0.5,blocked:true},
    {evaluated:2,coverage:1,blocked:false},
  ]);
});

test("actual CETUS event produces exact long funding cost",async()=>{
  const event={symbol:"CETUSUSDT",fundingTime:1778428800000,fundingRate:"0.00005000",markPrice:"0.03585000"};
  const fake=async()=>({ok:true,status:200,json:async()=>[event]});
  const rows=await fetchFundingHistory({symbol:"CETUSUSDT",startTime:1778428140000,endTime:1778429280000,fetchImpl:fake});
  const base=longFundingCost(rows,1778428140000,1778429280000,194);
  const stress2=longFundingCost(rows,1778428140000,1778429280000,174);
  assert.equal(base.events,1);
  assert.ok(Math.abs(base.signedCost-0.000347745)<1e-15);
  assert.ok(Math.abs(stress2.signedCost-0.000311895)<1e-15);
});

test("strength-loss decision uses completed price/flow evidence, never holding time",()=>{
  const bars=[
    {high:105,close:104,quoteVolume:100,takerBuyQuote:60},
    {high:104,close:102,quoteVolume:100,takerBuyQuote:40},
    {high:103,close:99,quoteVolume:100,takerBuyQuote:39},
  ];
  assert.deepEqual(strengthLossDecision({bars,referencePrice:100,peakPrice:105}),{close:true,reason:"STRENGTH_LOSS"});
  assert.equal(strengthLossDecision({bars:[...bars.slice(0,2),{...bars[2],takerBuyQuote:70}],referencePrice:100,peakPrice:105}).close,false);
});
