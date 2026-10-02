import test from 'node:test';
import assert from 'node:assert/strict';
import {rawCapture,dynamicWire} from '../test-support/dynamic-fixtures.mjs';
import {CLOCK_VERSION,clockCaptureValid,sameClockCapture} from '../supabase/functions/_shared/leader20/clock.mjs';
import {captureDisposition} from '../collectors/doa-capture/clock.mjs';
import {validateCapture120,captureForInference} from '../supabase/functions/_shared/gpt-final-decision/capture-context.mjs';
import {entryCaptureSafety,dispatchDynamicSafety} from '../supabase/functions/_shared/gpt-final-decision/dynamic-flow.mjs';
import {buildBatch,batchPayload,unpackSymbol} from '../supabase/functions/_shared/leader20/batch.mjs';
import {selectEpoch} from '../supabase/functions/_shared/leader20/universe.mjs';
import {runEntryBatch} from '../supabase/functions/_shared/leader20/batch-runtime.mjs';
import {runFinalRecheck,preDispatchSnapshot,detectChange,recheckAllows} from '../supabase/functions/_shared/gpt-final-decision/recheck.mjs';
import {MemoryReviewStore} from '../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
import {src} from '../development/gpt-final-decision/tests/fixtures.mjs';
import {dualEntryDecision} from '../supabase/functions/_shared/gpt-final-decision/dual.mjs';
const slot=Date.parse('2026-09-28T08:50:00+09:00');
const fixed=()=>({...rawCapture(slot+200),entry_window:{version:CLOCK_VERSION,slot_ms:slot,expires_at_ms:slot+120000}});


test('48–50 capture has 24 data buckets plus one book seed; holdings and BTC remain continuous',()=>{
 const w={version:CLOCK_VERSION,slot_ms:slot},roles=['SCANNER_LEADER'];
 assert.deepEqual(captureDisposition(roles,w,slot-180001),{connect:false,persist:false});
 assert.deepEqual(captureDisposition(roles,w,slot-180000),{connect:true,persist:false});
 assert.deepEqual(captureDisposition(roles,w,slot-120000),{connect:true,persist:true});
 let entryRows=0;for(let at=slot-600000;at<=slot;at+=5000)if(captureDisposition(roles,w,at).persist)entryRows++;
 assert.equal(entryRows,25,'the immutable entry path keeps its seed plus 24 buckets');
 assert.deepEqual(captureDisposition(roles,w,slot+1001),{connect:true,persist:true});
 assert.deepEqual(captureDisposition(roles,w,slot+115000),{connect:true,persist:true});
 assert.deepEqual(captureDisposition(roles,w,slot+119999),{connect:true,persist:true});
 assert.deepEqual(captureDisposition(roles,w,slot+120000),{connect:false,persist:false});
 for(const role of ['OPEN_POSITION','MARKET_SENSOR'])for(const at of [slot-250000,slot+60000,slot+300000])
  assert.deepEqual(captureDisposition([role],w,at),{connect:true,persist:true});
 assert.equal(captureDisposition(roles,{version:CLOCK_VERSION,slot_ms:null},slot).connect,false);
});
test('fixed entry path survives AI latency only until the slot deadline, while live holdings keep the 10s rule',async()=>{
 const raw=fixed(),c=validateCapture120(raw,slot+60000);
 assert.equal(c.status,'AVAILABLE');assert.equal(clockCaptureValid(c,slot+60000),true);
 assert.equal(entryCaptureSafety(c,slot+119999).ok,true);
 assert.equal(entryCaptureSafety(c,slot+120000).ok,false);
 assert.equal(entryCaptureSafety(validateCapture120(rawCapture(slot+200),slot+200),slot+60000).ok,false);
 let reads=0;assert.deepEqual(await captureForInference('C0USDT',c,{now:()=>slot+60000,afterEndMs:c.end_ms,read:()=>{reads++;}}),c);
 assert.equal(reads,0);assert.equal(sameClockCapture(c,c,slot+60000),true);
 assert.equal(dispatchDynamicSafety({reviewed:c,latest:c,at:slot+60000}).ok,true);
 for(const change of [x=>x.entry_window.slot_ms+=1,x=>x.entry_window.expires_at_ms+=1,x=>x.trajectory[10].bucket_ms+=5000,
  x=>x.start_ms-=5000,x=>x.trajectory[23].received_at_ms=slot+60001]){
  const x=fixed();change(x);assert.equal(validateCapture120(x,slot+60000).status,'UNAVAILABLE');
 }
});
test('Top10 clock batch sends 240 original rows and preserves independent held/data blocks',async()=>{
 const rows=Array.from({length:10},(_,i)=>({symbol:`C${i}USDT`,rank:i+1,capture:fixed()}));
 const b=await buildBatch(rows,{asOf:slot+10000,epochId:'e',generation:1});
 assert.equal(b.version,'TOP10_CLOCK_DEEPSEEK_BATCH_1');assert.equal(b.symbols.length,10);
 assert.equal(b.symbols.reduce((n,s)=>n+s.matrix.length,0),240);
 for(let i=0;i<10;i++)assert.deepEqual(unpackSymbol(b,b.symbols[i]),rows[i].capture.trajectory);
 assert.equal(batchPayload(b).max_tokens,2400);
 rows[0].capture.trajectory.pop();
 const blocked=await buildBatch(rows,{asOf:slot+10000,epochId:'e',generation:1,held:['C1USDT']});
 assert.equal(blocked.symbols.filter(s=>s.state==='READY').length,8);
 await assert.rejects(buildBatch([...rows,...rows.map((r,i)=>({...r,symbol:`X${i}USDT`}))],
   {asOf:slot+10000,epochId:'e',generation:1}),/CLOCK_BATCH_TOP10_IDENTITY/);
});
test('each capture preparation ranks current rolling24h Top20 and cannot refresh mid-window',async()=>{
 const symbols=Array.from({length:25},(_,i)=>({symbol:`C${i}USDT`,status:'TRADING',contractType:'PERPETUAL',quoteAsset:'USDT',marginAsset:'USDT',underlyingType:'COIN'}));
 const make=at=>({exchangeInfo:{symbols},tickers:symbols.map((s,i)=>({symbol:s.symbol,priceChangePercent:String(i),quoteVolume:'100',openTime:at-86400000,closeTime:at})),requestedAt:at,observedAt:at+100,clock:true});
 const e=await selectEpoch(make(slot-179000));assert.equal(e.capture_slot_ms,slot);
 assert.equal(e.next_refresh_at_ms,slot+420000);assert.equal(e.members[0].symbol,'C24USDT');
 await assert.rejects(selectEpoch(make(slot-119999)),/CLOCK_PREPARATION_NOT_DUE/);

});
