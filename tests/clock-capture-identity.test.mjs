import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {clockCaptureValid,sameClockCapture} from '../supabase/functions/_shared/leader20/clock.mjs';
import {validateCapture120} from '../supabase/functions/_shared/gpt-final-decision/capture-context.mjs';
import {hash} from '../supabase/functions/_shared/gpt-final-decision/snapshot-hash.mjs';
import {runFinalRecheck,recheckAllows,postRecheckSafety,detectChange} from '../supabase/functions/_shared/gpt-final-decision/recheck.mjs';
import {MemoryReviewStore} from '../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
import {src} from '../development/gpt-final-decision/tests/fixtures.mjs';
const original=JSON.parse(readFileSync(new URL('./fixtures/nmr-clock-capture-20260928.json',import.meta.url)));
const at=original.source.at,expiry=original.leader20.expires_at_ms;
function pair(){
 const initial=structuredClone(original.initial);
 const raw={...structuredClone(original.raw),entry_window:structuredClone(initial.entry_window)};
 return {initial,current:validateCapture120(raw,at)};
}
async function run(current,{store=new MemoryReviewStore(),now=at,decision='WAIT'}={}){
 let reviews=0,transports=0;store.transport=async()=>{transports++;return ()=>{throw Error('NETWORK_FORBIDDEN');};};
 const ticket={expires:expiry,snapshotHash:'original-nmr',identityJson:'{}',initial:{facts:{},support:[],leader20:original.leader20,capture_context:structuredClone(original.initial)}};
 const result=await runFinalRecheck({signal:{id:'original-nmr-replay',symbol:'NMRUSDT',features:{leader20:original.leader20}},ticket,
  detection:detectChange(ticket.initial,{at:now}),preDispatch:null,store,
  config:{mode:'ENFORCE',modeValid:true,enforceApproved:true,approvalRef:'offline-replay',apiBudgetUsd:100,maxCalls:100},apiKey:'offline',now:()=>now,
  readFresh:async()=>({src:{...src(now),captureContext:current},errors:{}}),
  review:async(packet,options)=>{reviews++;assert.deepEqual(packet.initial.capture_context.trajectory,original.initial.trajectory);
   assert.deepEqual(packet.facts.capture_context.trajectory,original.initial.trajectory);assert.equal(packet.current_ref.at,now);
   assert.ok(options.deadlineMs<=expiry-3000);return {valid:true,decision,attempted:false,api_cost_usd:0,completed_at_ms:now};}});
 return {result,reviews,transports};
}
test('original NMR JSONB initial and freshly normalized FINAL are identical despite key order',async()=>{
 const {initial,current}=pair();assert.equal(current.status,'AVAILABLE');
 assert.equal(clockCaptureValid(initial,at),true);assert.equal(clockCaptureValid(current,at),true);
 assert.deepEqual(initial.trajectory,current.trajectory);
 assert.notEqual(JSON.stringify(initial.trajectory),JSON.stringify(current.trajectory));
 assert.equal(await hash(current.trajectory),initial.trajectory_hash);
 assert.equal(original.source.result.error,'RC_BATCH_CAPTURE_NOT_ADVANCED');
 assert.equal(sameClockCapture(initial,current,at),true);
});
test('actual recheck reaches one offline FINAL; WAIT still forbids execution and sequence reuse',async()=>{
 const {current}=pair(),store=new MemoryReviewStore(),r=await run(current,{store});
 assert.equal(r.result.valid,true,r.result.error);assert.equal(r.result.decision,'WAIT');assert.equal(r.reviews,1);assert.equal(r.transports,1);
 assert.equal(recheckAllows(r.result,at),false);
 const second=await run(current,{store});assert.equal(second.result.error,'RC_LIMIT_REACHED');assert.equal(second.reviews,0);assert.equal(second.transports,0);
});
for(const [name,change] of [
 ['numeric value',c=>c.trajectory[3].aggressive_buy+=0.001],
 ['missing point field',c=>delete c.trajectory[3].imbalance],
 ['additional point field',c=>c.trajectory[3].invented=0],
 ['bucket order',c=>[c.trajectory[3],c.trajectory[4]]=[c.trajectory[4],c.trajectory[3]]],
 ['epoch',c=>c.entry_window.epoch_id='other'],
 ['generation',c=>c.entry_window.generation++],
 ['capture binding',c=>c.entry_window.capture_hash='other'],
 ['expiry extension',c=>c.entry_window.expires_at_ms++],
 ['nonfinite value',c=>c.trajectory[3].aggressive_buy=NaN]
])test(`changed ${name} cannot inherit the same clock capture or dispatch`,async()=>{
 const {initial,current}=pair();change(current);assert.equal(sameClockCapture(initial,current,at),false);
 const r=await run(current);assert.equal(r.result.error,name==='nonfinite value'?'RC_PREPARATION_FAILED':'RC_BATCH_CAPTURE_NOT_ADVANCED');assert.equal(r.reviews,0);assert.equal(r.transports,0);
});
test('clock expiry and live rolling capture cannot use the fixed-path exception',async()=>{
 const {initial,current}=pair();assert.equal(sameClockCapture(initial,current,expiry),false);
 const expired=await run(current,{now:expiry});assert.equal(expired.result.error,'RC_TRIGGER_EXPIRED');assert.equal(expired.reviews,0);
 delete current.entry_window;assert.equal(sameClockCapture(initial,current,at),false);
 const rolling=await run(current);assert.equal(rolling.result.error,'RC_BATCH_CAPTURE_NOT_ADVANCED');assert.equal(rolling.transports,0);
});
test('even an offline FINAL BUY needs a newer executable quote and stays within original expiry',async()=>{
 const r=await run(pair().current,{decision:'BUY'});assert.equal(r.result.valid,true,r.result.error);
 assert.ok(r.result.valid_until_ms<=expiry-3000);assert.equal(recheckAllows(r.result,expiry),false);
 assert.equal(postRecheckSafety({recheck:r.result,quote:{best_bid:1,best_ask:1.001,timing:{received_at_ms:at-1}},at}).reason,'RC_POST_QUOTE_NOT_AFTER_ANSWER');
});
