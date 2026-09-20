import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  B06133_RULE, B06133_VERSION, and3, not3, or3,
  evaluateB06133, evaluateB06133Factors, fetchB06133Inputs,
} from './leader-b06133-entry.mjs';

const MIN = 60_000, QTR = 15 * MIN;
const AT = Date.parse('2026-09-20T12:07:00Z');
function kline(t,{open=100,high=101,low=99,close=100,qv=100,buy=40,interval=MIN}={}) {
  return [t,String(open),String(high),String(low),String(close),'1',t+interval-1,String(qv),'10','1',String(buy),'0'];
}
function prebars(shares=[.3,.4,.45],lastClose=101) {
  return [3,2,1].map((n,i)=>kline(AT-n*MIN,{open:100,close:i===2?lastClose:100,qv:100,buy:shares[i]*100}));
}
function btc(closes=[90,91,92,93,94,95,96,97,98]) {
  const last=Math.floor(AT/QTR)*QTR-QTR;
  return closes.map((close,i)=>kline(last-(8-i)*QTR,{open:close,high:close+1,low:close-1,close,qv:1000,buy:500,interval:QTR}));
}
const features={volumeRatio:.9,return5m:.001,return15m:.01,return30m:.015,return60m:.005};

test('catalog identity is the attached B06133 R62-rescue rule',()=>{
  assert.equal(B06133_VERSION,'B06133_ENTRY_SELECTION_1');
  assert.equal(B06133_RULE.id,'B06133');
  assert.deepEqual(B06133_RULE.clauses,[[4,4128],[89,0]]);
  assert.ok(!B06133_RULE.label.includes('slowSetup'));
});

test('R62 admits only its four exact factors',()=>{
  const d=evaluateB06133({features,prebars:prebars([.4,.4,.4]),btcBars:btc(),decisionAt:AT});
  assert.equal(d.allowed,true);assert.equal(d.branch,'R62');assert.equal(d.r62,true);
  assert.deepEqual(d.factors,{absorption:true,volumeTails:true,fresh15over30:true,btcAnyUp:true,
    buyerShareRise:false,fresh5over15:false,recentHourLead:true});
});

test('rescue branch has no slowSetup, volume-tail, or BTC common requirement',()=>{
  const d=evaluateB06133({features:{...features,volumeRatio:2,return5m:0,return60m:.2},
    prebars:prebars([.2,.3,.4],99),btcBars:btc([100,99,98,97,96,95,94,93,92]),decisionAt:AT});
  assert.equal(d.factors.volumeTails,false);assert.equal(d.factors.btcAnyUp,false);
  assert.equal(d.factors.absorption,false);assert.equal(d.rescue,true);
  assert.equal(d.allowed,true);assert.equal(d.branch,'BUYER_SHARE_RESCUE');
});

test('NOT unknown stays unknown and cannot grant entry',()=>{
  assert.equal(not3(null),null);assert.equal(and3(true,null,true),null);
  const d=evaluateB06133Factors({absorption:false,volumeTails:false,fresh15over30:false,btcAnyUp:false,
    buyerShareRise:true,fresh5over15:null,recentHourLead:false});
  assert.equal(d.rescue,null);assert.equal(d.result,null);assert.equal(d.allowed,false);
});

test('a confirmed true OR branch dominates unknown in the other branch',()=>{
  assert.equal(or3(true,null),true);
  const d=evaluateB06133Factors({absorption:true,volumeTails:true,fresh15over30:true,btcAnyUp:true,
    buyerShareRise:null,fresh5over15:null,recentHourLead:null});
  assert.equal(d.r62,true);assert.equal(d.rescue,null);assert.equal(d.allowed,true);assert.equal(d.branch,'R62');
});

test('strict factor boundaries are preserved',()=>{
  let d=evaluateB06133({features:{...features,volumeRatio:1,return15m:.01,return30m:.02},
    prebars:prebars([.4,.4,.4]),btcBars:btc(),decisionAt:AT});
  assert.equal(d.factors.volumeTails,false);assert.equal(d.factors.fresh15over30,false);
  d=evaluateB06133({features:{...features,volumeRatio:4,return15m:.0100001,return30m:.02},
    prebars:prebars([.4,.4,.4]),btcBars:btc(),decisionAt:AT});
  assert.equal(d.factors.volumeTails,true);assert.equal(d.factors.fresh15over30,true);
});

test('incomplete/future 1m candle and stale BTC remain unknown, never synthesized',()=>{
  const future=prebars();future[2][6]=AT;
  let d=evaluateB06133({features,prebars:future,btcBars:btc(),decisionAt:AT});
  assert.equal(d.factors.absorption,null);assert.equal(d.factors.buyerShareRise,null);
  const stale=btc();stale.forEach(row=>{row[0]-=QTR;row[6]-=QTR;});
  d=evaluateB06133({features,prebars:prebars([.4,.4,.4]),btcBars:stale,decisionAt:AT});
  assert.equal(d.factors.btcAnyUp,null);assert.equal(d.source.btc.known,false);
});

test('fetch is bounded to exact point-in-time windows',async()=>{
  const seen=[];
  const got=await fetchB06133Inputs('TESTUSDT',AT,async url=>{
    const parsed=new URL(url);seen.push(parsed);
    return {ok:true,json:async()=>parsed.searchParams.get('interval')==='1m'?prebars():btc()};
  });
  assert.equal(got.prebars.length,3);assert.equal(got.btcBars.length,9);
  const one=seen.find(x=>x.searchParams.get('interval')==='1m');
  const fifteen=seen.find(x=>x.searchParams.get('interval')==='15m');
  assert.equal(one.searchParams.get('startTime'),String(AT-3*MIN));
  assert.equal(one.searchParams.get('endTime'),String(AT-1));
  assert.equal(one.searchParams.get('limit'),'3');
  assert.equal(fifteen.searchParams.get('limit'),'9');
});

test('BTC fetch failure cannot block a confirmed rescue OR branch',async()=>{
  const input=await fetchB06133Inputs('TESTUSDT',AT,async url=>{
    const interval=new URL(url).searchParams.get('interval');
    if(interval==='15m')throw Error('BTC_UNAVAILABLE');
    return {ok:true,json:async()=>prebars([.2,.3,.4],99)};
  });
  const d=evaluateB06133({features:{...features,volumeRatio:2,return5m:0,return60m:.2},...input,decisionAt:AT});
  assert.equal(d.factors.btcAnyUp,null);assert.equal(d.r62,false);
  assert.equal(d.rescue,true);assert.equal(d.allowed,true);assert.equal(d.branch,'BUYER_SHARE_RESCUE');
  assert.equal(d.source.marketErrors.btc,'BTC_UNAVAILABLE');
});

const executor=await readFile(new URL('../v10-lane-executor/index.ts',import.meta.url),'utf8');
test('executor gates only after trigger and before queue/claim',()=>{
  const trigger=executor.indexOf('if(state.state!==SETUP_STATE.TRIGGERED)');
  const gate=executor.indexOf('selected=await applyB06133Selection');
  const queue=executor.indexOf('executable.push(selected.row)');
  const claim=executor.indexOf('update({status:"CLAIMED"');
  assert.ok(trigger>=0&&trigger<gate&&gate<queue&&queue<claim);
  assert.ok(executor.includes('throw new Error("B06133_SELECTION_INVALID")'));
});

test('order and position retain selector evidence while risk geometry stays fixed',()=>{
  assert.ok(executor.includes('entry_selection:rec(s.features).b06133'));
  assert.ok(executor.includes('entrySelectionPolicyVersion:intent.request_payload?.entry_selection?.version'));
  assert.ok(executor.includes('b06133:intent.request_payload?.entry_selection??null'));
  assert.ok(executor.includes('const MAX_SLOTS=10'));
  assert.ok(executor.includes('const SETUP_MAX_CONCURRENT=2'));
  assert.ok(executor.includes('const MARGIN=SLOT_SIZING_CONTRACT.targetMarginUsdt,LEV=SLOT_SIZING_CONTRACT.leverage'));
});
