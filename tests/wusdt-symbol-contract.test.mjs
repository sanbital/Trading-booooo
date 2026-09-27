import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fetchB06133Inputs,evaluateB06133} from '../supabase/functions/_shared/leader-b06133-entry.mjs';
import {readMicro} from '../supabase/functions/_shared/gpt-final-review/micro.mjs';
import * as lifecycle from '../supabase/functions/v10-lane-executor/entry-lifecycle.mjs';
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/usdt-symbol-contract.json',import.meta.url)));
fixtures.push({symbol:'A'.repeat(60)+'USDT',valid:true},{symbol:'A'.repeat(61)+'USDT',valid:false});
const T=1790478420000;
for(const f of fixtures)test('canonical symbol '+JSON.stringify(f.symbol),async()=>{
 let requests=0;const fetchFn=async()=>{requests++;return Response.json([])};
 if(f.valid){await fetchB06133Inputs(f.symbol,T,fetchFn);assert.equal(requests,2);await readMicro(f.symbol,{fetchFn});assert.equal(requests,6)}
 else {await assert.rejects(()=>fetchB06133Inputs(f.symbol,T,fetchFn),/B06133_MARKET_INPUT/);await assert.rejects(()=>readMicro(f.symbol,{fetchFn}),/SYMBOL_INVALID/);assert.equal(requests,0)}
});
test('normalization stays at B06133 boundary, micro consumes canonical uppercase',async()=>{
 const urls=[];await fetchB06133Inputs('wusdt',T,async url=>{urls.push(new URL(url));return Response.json([])});
 assert.equal(urls[0].searchParams.get('symbol'),'WUSDT');await assert.rejects(()=>readMicro('wusdt'),/SYMBOL_INVALID/);
});
test('W uses unchanged 3 x 1m and 9 x 15m windows; timestamp rejects before fetch',async()=>{
 const urls=[];await fetchB06133Inputs('WUSDT',T,async u=>{urls.push(new URL(u));return Response.json([])});
 const last=Math.floor(T/900000)*900000-900000;
 assert.deepEqual(urls.map(u=>Object.fromEntries(u.searchParams)),[
  {symbol:'WUSDT',interval:'1m',startTime:String(T-180000),endTime:String(T-1),limit:'3'},
  {symbol:'BTCUSDT',interval:'15m',startTime:String(last-8*900000),endTime:String(T-1),limit:'9'}]);
 for(const at of [null,NaN,0,-1,T+1,Infinity])await assert.rejects(()=>fetchB06133Inputs('WUSDT',at,()=>{throw Error('should not fetch')}),/B06133_MARKET_INPUT/);
});
test('technical cause survives another lifecycle note and window expiry',()=>{
 const row={id:'signal',symbol:'WUSDT',features:{v17Setup:{triggerAt:T,triggerExpiresAt:T+60000}}};
 const first=lifecycle.technicalFailureNote({row,at:T+9000,stage:'B06133',error:Error('B06133_MARKET_INPUT'),blocking:false});
 row.features.entryLifecycle=first;
 const next=lifecycle.technicalFailureNote({row,at:T+10000,stage:'CEC0040',error:Error('CEC0040_DECISION:CEC0040_DECISION_INPUT_INVALID')});
 const merged=lifecycle.mergeLifecycleNote(next,lifecycle.lifecycleNote({at:T+11000,stage:'QUEUE',reason:'WAIT'}));
 assert.equal(merged.technicalFailure.first.code,'B06133_MARKET_INPUT');
 assert.equal(merged.technicalFailure.latest.code,'CEC0040_DECISION_INPUT_INVALID');
 assert.equal(merged.technicalFailure.root.code,'CEC0040_DECISION_INPUT_INVALID');
 assert.equal(merged.technicalFailure.latest.remainingMs,50000);
 assert.equal(merged.technicalFailure.latest.gptAttempted,false);assert.equal(merged.technicalFailure.latest.orderDispatched,false);
 assert.equal(lifecycle.expiredTriggerReason(merged),'STALE:TRIGGER_WINDOW_CLOSED');
});
test('selection-local input errors continue; fatal and unknown exceptions propagate',()=>{
 assert.equal(lifecycle.isSymbolLocalSelectionError(Error('CEC0040_DECISION:CEC0040_DECISION_INPUT_INVALID')),true);
 for(const msg of ['EXECUTION_LEASE_LOST','ACCOUNT_UNKNOWN','ORDER_UNCONFIRMED','CEC0040_DECISION:CEC0040_STATE_IDENTITY_INVALID','unexpected failure'])
  assert.equal(lifecycle.isSymbolLocalSelectionError(Error(msg)),false,msg);
});
test('W malformed or missing completed candles stay unknown with the original formulas',async()=>{
 const last=Math.floor(T/900000)*900000-900000;
 const bars=(n,start,step)=>Array.from({length:n},(_,i)=>[start+i*step,1,1.2,.9,1.01,100,start+(i+1)*step-1,100,1,30,30]);
 const good={prebars:bars(3,T-180000,60000),btcBars:bars(9,last-8*900000,900000)};
 const features={volumeRatio:.5,return5m:.01,return15m:.02,return30m:.03,return60m:.06};
 const expected=evaluateB06133({features,...good,decisionAt:T});
 assert.equal(expected.source.prebars.length,3);assert.equal(expected.source.btcBars.length,9);
 for(const mutate of [x=>x.prebars.pop(),x=>x.prebars.push(x.prebars[0]),x=>x.prebars[2][6]=T,x=>x.prebars[1][7]=0,x=>x.prebars[1][1]='bad']){
  const bad=structuredClone(good);mutate(bad);const r=evaluateB06133({features,...bad,decisionAt:T});assert.equal(r.factors.absorption,null);assert.equal(r.factors.buyerShareRise,null);
 }
 for(const mutate of [x=>x.btcBars.pop(),x=>x.btcBars[8][6]=T,x=>x.btcBars[3][4]='bad']){
  const bad=structuredClone(good);mutate(bad);assert.equal(evaluateB06133({features,...bad,decisionAt:T}).factors.btcAnyUp,null);
 }
 // Existing BTC duplicate deduplication stays exactly the same.
 assert.deepEqual(evaluateB06133({features,...good,btcBars:[...good.btcBars,good.btcBars[0]],decisionAt:T}),expected);
});
