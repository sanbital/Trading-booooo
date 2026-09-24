import test from 'node:test';
import assert from 'node:assert/strict';
import {entryExecutionWindow, entryPriceEvidence, normalizeEntryBook, gatewayTakerFeeRate, supportedFuturesMode} from '../supabase/functions/v10-lane-executor/entry-evidence.mjs';

// Read-only production fixture: CYSUSDT at 2026-09-24 04:31 UTC.
// CEC rejected this signal. Tests exercise timing ONLY, not trading admission.
const policy = Object.freeze({version:'V17_GPT_CONTINUATION_ENTRY_2',setupTtlMs:900000,
  entryTriggerTtlMs:60000,minReaccelPct:0.0025,maxChasePct:0.01});
const fixture = {
  id:'7052b34f-d1eb-4b62-9400-5eacd71081d4',symbol:'CYSUSDT',status:'REJECTED',reject_reason:'CEC0040_REJECT',
  features:{signal5Close:1790224200000,referenceClose:0.1782,
    b06133:{version:'B06133_ENTRY_SELECTION_1',source:{decisionAt:1790224260000,prebars:[
      {openTime:1790224080000,closeTime:1790224139999,open:0.1766,high:0.1774,low:0.1766,close:0.1773},
      {openTime:1790224140000,closeTime:1790224199999,open:0.1774,high:0.1784,low:0.1774,close:0.1782},
      {openTime:1790224200000,closeTime:1790224259999,open:0.1782,high:0.1794,low:0.1781,close:0.1789}]}},
    v17Setup:{state:'TRIGGERED',symbol:'CYSUSDT',armedAt:1790224200000,
      identity:'V17_GPT_CONTINUATION_ENTRY_2:CYSUSDT:7052b34f-d1eb-4b62-9400-5eacd71081d4:1790224200000',
      signalId:'7052b34f-d1eb-4b62-9400-5eacd71081d4',expiresAt:1790225100000,lastClose:0.1789,
      triggerAt:1790224260000,pullbackLow:null,transitions:[
        {at:1790224200000,to:'ARMED',reason:'V17_SETUP_ARMED'},
        {at:1790224268614,to:'TRIGGERED',reason:'V17_CONTINUATION_TRIGGERED'}],
      triggerMode:'CONTINUATION_NO_PULLBACK',signal5Close:1790224200000,triggerClose:0.1789,
      policyVersion:'V17_GPT_CONTINUATION_ENTRY_2',referencePrice:0.1782,terminalReason:null,
      pullbackObserved:false,triggerExpiresAt:1790224320000,lastCandleOpenTime:1790224200000}}};
const make=()=>structuredClone(fixture);
const windowOf=(r,p=policy)=>entryExecutionWindow(r,true,120000,p);
function pullback(version=policy.version){
  const r=make(),s=r.features.v17Setup;
  delete s.triggerMode;s.pullbackObserved=true;s.pullbackLow=0.177;
  s.policyVersion=version;s.identity=`${version}:${r.symbol}:${r.id}:${r.features.signal5Close}`;
  return r;
}

test('actual no-pullback timing is accepted without altering the CEC rejection',()=>{
  const r=make(),before=JSON.stringify(r),w=windowOf(r);
  assert.deepEqual(w,{valid:true,basis:'CONTINUATION_TRIGGER',featureAsOf:1790224200000,
    startsAt:1790224260000,expiresAt:1790224320000});
  assert.equal(JSON.stringify(r),before);
  assert.equal(r.status,'REJECTED');assert.equal(r.reject_reason,'CEC0040_REJECT');
});
test('existing pullback timing remains unchanged',()=>{
  assert.deepEqual(windowOf(pullback()),{valid:true,basis:'PULLBACK_TRIGGER',featureAsOf:1790224200000,
    startsAt:1790224260000,expiresAt:1790224320000});
});
test('legacy policy still accepts pullback',()=>{
  const p={...policy,version:'V17_PULLBACK_REACCEL_ENTRY_1'};
  assert.equal(windowOf(pullback(p.version),p).valid,true);
});
test('legacy policy must not acquire the new continuation path',()=>{
  const r=make(),p={...policy,version:'V17_PULLBACK_REACCEL_ENTRY_1'},s=r.features.v17Setup;
  s.policyVersion=p.version;s.identity=`${p.version}:${r.symbol}:${r.id}:${r.features.signal5Close}`;
  assert.equal(windowOf(r,p).valid,false);
});
test('non-governed legacy clock is unchanged',()=>{
  assert.deepEqual(entryExecutionWindow(make(),false,120000,policy),{
    valid:true,basis:'LEGACY_SIGNAL',featureAsOf:1790224200000,startsAt:1790224200000,expiresAt:1790224320000});
});
const mutations=[
 ['missing explicit mode',r=>delete r.features.v17Setup.triggerMode],
 ['unknown mode',r=>r.features.v17Setup.triggerMode='OTHER'],
 ['contradictory pullback flag',r=>r.features.v17Setup.pullbackObserved=true],
 ['missing pullback flag',r=>delete r.features.v17Setup.pullbackObserved],
 ['fabricated pullback low',r=>r.features.v17Setup.pullbackLow=0.1],
 ['wrong signal identity',r=>r.features.v17Setup.signalId='different'],
 ['wrong symbol',r=>r.features.v17Setup.symbol='BTCUSDT'],
 ['rebased reference',r=>r.features.v17Setup.referencePrice=0.177],
 ['rewritten arm clock',r=>r.features.v17Setup.armedAt+=60000],
 ['extended setup expiry',r=>r.features.v17Setup.expiresAt+=60000],
 ['extended trigger expiry',r=>r.features.v17Setup.triggerExpiresAt+=60000],
 ['trigger before signal',r=>r.features.v17Setup.triggerAt=r.features.signal5Close],
 ['wrong last candle time',r=>r.features.v17Setup.lastCandleOpenTime-=60000],
 ['changed trigger close',r=>r.features.v17Setup.triggerClose=0.179],
 ['wrong source cutoff',r=>r.features.b06133.source.decisionAt-=60000],
 ['missing completed bars',r=>delete r.features.b06133.source.prebars],
 ['non-adjacent bars',r=>r.features.b06133.source.prebars[1].openTime-=60000],
 ['incomplete final bar',r=>r.features.b06133.source.prebars[2].closeTime+=60000],
 ['non-bullish final bar',r=>r.features.b06133.source.prebars[2].open=0.1789],
 ['no higher close',r=>{const b=r.features.b06133.source.prebars[1];b.close=0.1789;b.high=0.179;}],
 ['malformed OHLC',r=>r.features.b06133.source.prebars[2].low=0.179],
 ['missing transition',r=>r.features.v17Setup.transitions=[]],
 ['wrong transition reason',r=>r.features.v17Setup.transitions[1].reason='V17_REACCEL_TRIGGERED'],
 ['transition before candle close',r=>r.features.v17Setup.transitions[1].at=1790224259000],
 ['below continuation floor',r=>{const s=r.features.v17Setup,b=r.features.b06133.source.prebars[2];s.lastClose=s.triggerClose=b.close=0.1783;}],
 ['above chase ceiling',r=>{const s=r.features.v17Setup,b=r.features.b06133.source.prebars[2];s.lastClose=s.triggerClose=b.close=0.181;b.high=0.182;}],
 ['expired setup state',r=>r.features.v17Setup.state='EXPIRED_NO_PULLBACK'],
 ['wrong policy version',r=>r.features.v17Setup.policyVersion='UNKNOWN'],
];
for(const [name,mutate] of mutations)test('refuses '+name,()=>{
  const r=make();mutate(r);assert.equal(windowOf(r).valid,false);
});
test('missing continuation thresholds are not an admission',()=>{
  assert.equal(windowOf(make(),{...policy,minReaccelPct:undefined}).valid,false);
});
test('acceptance never renews the expired historical clock',()=>{
  const r=make(),w=windowOf(r);assert.equal(w.expiresAt,1790224320000);
  assert.ok(w.expiresAt<1790224320001);
});
test('telemetry never grants order admission',()=>{
  const r=make(),w=windowOf(r),e=entryPriceEvidence(r,0.1789,1790224269000,'TEST',null,w,0.01,null);
  assert.equal(e.finalAdmission,false);assert.equal(e.orderDispatched,false);
});
test('empty book is still rejected',()=>assert.equal(normalizeEntryBook({},1000,1790224269000).health.bookHealthy,false));
test('missing fees are still unavailable',()=>assert.equal(gatewayTakerFeeRate(null,'CYSUSDT'),undefined));
test('unknown futures mode is still rejected',()=>assert.equal(supportedFuturesMode({},1790224269000),false));
