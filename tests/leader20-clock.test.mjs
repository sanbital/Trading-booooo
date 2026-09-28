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
 let rows=0;for(let at=slot-600000;at<=slot+590000;at+=5000)if(captureDisposition(roles,w,at).persist)rows++;
 assert.equal(rows,25);
 assert.deepEqual(captureDisposition(roles,w,slot+1001),{connect:false,persist:true});
 assert.deepEqual(captureDisposition(roles,w,slot+5000),{connect:false,persist:false});
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
test('Top20 sends all 480 original rows in one request and preserves independent held/data blocks',async()=>{
 const rows=Array.from({length:20},(_,i)=>({symbol:`C${i}USDT`,rank:i+1,capture:fixed()}));
 const b=await buildBatch(rows,{asOf:slot+10000,epochId:'e',generation:1});
 assert.equal(b.version,'TOP20_DEEPSEEK_BATCH_1');assert.equal(b.symbols.length,20);
 assert.equal(b.symbols.reduce((n,s)=>n+s.matrix.length,0),480);
 for(let i=0;i<20;i++)assert.deepEqual(unpackSymbol(b,b.symbols[i]),rows[i].capture.trajectory);
 assert.equal(batchPayload(b).max_tokens,4800);
 rows[0].capture.trajectory.pop();
 const blocked=await buildBatch(rows,{asOf:slot+10000,epochId:'e',generation:1,held:['C1USDT']});
 assert.equal(blocked.symbols.filter(s=>s.state==='READY').length,18);
});
test('each capture preparation ranks current rolling24h Top20 and cannot refresh mid-window',async()=>{
 const symbols=Array.from({length:25},(_,i)=>({symbol:`C${i}USDT`,status:'TRADING',contractType:'PERPETUAL',quoteAsset:'USDT',marginAsset:'USDT',underlyingType:'COIN'}));
 const make=at=>({exchangeInfo:{symbols},tickers:symbols.map((s,i)=>({symbol:s.symbol,priceChangePercent:String(i),quoteVolume:'100',openTime:at-86400000,closeTime:at})),requestedAt:at,observedAt:at+100,clock:true});
 const e=await selectEpoch(make(slot-179000));assert.equal(e.capture_slot_ms,slot);
 assert.equal(e.next_refresh_at_ms,slot+420000);assert.equal(e.members[0].symbol,'C24USDT');
 await assert.rejects(selectEpoch(make(slot-119999)),/CLOCK_PREPARATION_NOT_DUE/);
 const next=await selectEpoch({...make(slot+421000),previous:e});assert.equal(next.capture_slot_ms,slot+600000);
});
test('off-clock wakes perform no market, account, capture or paid reads',async()=>{
 let reads=0;const db={rpc:()=>{reads++;throw Error('off clock');},from:()=>{reads++;throw Error('off clock');}};
 for(const at of [slot-1,slot,slot+30000,slot+100000,slot+480000]){
  assert.equal((await runEntryBatch(db,{clock_capture_enabled:true},{now:()=>at})).reason,'CLOCK_BATCH_NOT_DUE');
 }
 assert.equal(reads,0);
});
test('actual FINAL RECHECK accepts the identical clock path with a new quote and only BUY permits execution',async()=>{
 for(const decision of ['BUY','WAIT','SKIP']){
  const at=slot+60000,c=validateCapture120(fixed(),at),leader20={version:'LEADER20_DYNAMIC_1',batch_advice:{id:'C0USDT'}};
  const ticket={expires:slot+120000,snapshotHash:'fixed-'+decision,identityJson:'{}',initial:{facts:{},support:[],leader20,capture_context:c}},
   preDispatch=preDispatchSnapshot({at,rawQuote:{best_bid:1,best_ask:1.001},capture:c});
  let calls=0;
  const result=await runFinalRecheck({signal:{id:decision,symbol:'C0USDT',features:{referenceClose:1,leader20}},ticket,preDispatch,
   detection:detectChange(ticket.initial,preDispatch),store:new MemoryReviewStore(),
   config:{mode:'ENFORCE',modeValid:true,enforceApproved:true,approvalRef:'fixture',apiBudgetUsd:100,maxCalls:100},apiKey:'offline',now:()=>at,
   readFresh:async()=>({src:{...src(at),captureContext:c},errors:{}}),
   review:async(packet,options)=>dualEntryDecision(packet,{...options,fetchFn:async()=>{throw Error('offline');},
    counterCall:async()=>({valid:false,attempted:false,error:'FIXTURE_UNAVAILABLE'}),gptCall:async(p,o)=>{
     assert.ok(o.timeoutMs>0);const input=JSON.parse(o.payloadFn(p).input[1].content);
     if(!input.independent_reviews)return {valid:false,attempted:false,error:'FIXTURE_FIRST'};
     calls++;assert.deepEqual(p.facts.capture_context.trajectory,c.trajectory);assert.equal(p.current_ref.at,at);
     const wire={...dynamicWire({t:'RECHECK',c:p.candidate_id,d:decision,reasons:decision==='SKIP'?[{r:'GPT_JUDGMENT',e:['return_5m']}]:[],support:decision==='BUY'?['return_5m']:[],n:'Observed flow'},p),
      action:decision==='BUY'?'ENTER':'DEFER',pressure_state:'MIXED',decision_reason:'Boundary evidence assessed',counter_evidence:[],
      thesis_invalidation:'Demand fails',next_review_conditions:'Next clock window',
      arbitration:{considered:[],adopted:[],rejected:[],supporting:[],opposing:[],reason:'Independent judgment'}};
     return {valid:true,wire,answer:wire,decision,attempted:true,completed_at_ms:at};
    }})});
  assert.equal(result.valid,true,JSON.stringify({error:result.error,decision:result.decision}));assert.equal(calls,1);
  assert.equal(recheckAllows(result,at),decision==='BUY');
 }
});
