import test from 'node:test';
import assert from 'node:assert/strict';
import {R4_CANDIDATE as C,newR4State,nextR4Exit} from '../../supabase/functions/_shared/leader-exit-r4.mjs';
const entry={positionId:'review',entryPrice:100,entryAt:0,quantity:101,quantityStep:1,entryFee:5.05};
const tick=(s,price,at,sequence)=>nextR4Exit(s,{type:'tick',price,at,sequence});
test('split uses actual quantity step and conserves quantity and entry commission',()=>{
 const s=newR4State(entry);assert.equal(s.riskQuantity,50);assert.equal(s.runnerQuantity,51);
 assert.equal(s.riskQuantity+s.runnerQuantity,101);assert.equal(s.risk.entryFee+s.runnerFee,5.05);
 assert.throws(()=>newR4State({...entry,quantity:1}),/TOO_SMALL/);
 assert.throws(()=>newR4State({...entry,quantity:101.5}),/STEP/);
});
test('failed-progress condition closes both legs once, after the grace period',()=>{
 let s=tick(newR4State(entry),100,0,1).state;
 let out=tick(s,98.9,299999,2);assert.equal(out.signals.length,0);
 out=tick(out.state,98.9,300000,3);assert.equal(out.signals.length,2);
 assert.ok(out.signals.every(x=>x.reason==='R4_FAILED_PROGRESS'));assert.equal(out.done,true);
 assert.equal(tick(out.state,98,301000,4).signals.length,0);
});
test('realized favorable progress disables the no-progress condition',()=>{
 let s=tick(newR4State(entry),100.3,0,1).state;
 assert.equal(tick(s,98.9,300000,2).signals.length,0);
});
test('a missing aggregate event invalidates a no-progress assertion',()=>{
 let s=tick(newR4State(entry),100,0,1).state;
 const out=tick(s,98.9,300000,3);assert.equal(out.state.coverageBroken,true);assert.equal(out.signals.length,0);
});
test('runner ignores intraminute profit spikes and uses only closed candle values',()=>{
 let s=tick(newR4State(entry),103.5,1000,1).state;
 s=tick(s,100.3,2000,2).state;
 const out=nextR4Exit(s,{type:'bar',openAt:0,closeAt:60000,close:100.3});
 assert.equal(out.state.runnerStop,97.5);assert.equal(out.state.runnerClosed,false);
});
test('runner closes its own quantity after a confirmed protection breach',()=>{
 let s=nextR4Exit(newR4State(entry),{type:'bar',openAt:0,closeAt:60000,close:101.5}).state;
 const out=nextR4Exit(s,{type:'bar',openAt:60000,closeAt:120000,close:100});
 assert.equal(out.signals.length,1);assert.equal(out.signals[0].leg,'runner');assert.equal(out.signals[0].quantity,51);
});
test('pre-entry candles and events older than an already processed bar are ignored',()=>{
 const s=newR4State({...entry,entryAt:1000});
 assert.equal(nextR4Exit(s,{type:'bar',openAt:0,closeAt:60000,close:90}).signals.length,0);
 const s2=nextR4Exit(s,{type:'bar',openAt:60000,closeAt:120000,close:101}).state;
 assert.equal(tick(s2,95,119000,1).ignored,true);
});
test('emergency breach emits both legs; future bars do not emit them again',()=>{
 const out=tick(newR4State(entry),96,1000,1);assert.equal(out.signals.length,2);assert.equal(out.done,true);
 assert.equal(nextR4Exit(out.state,{type:'bar',openAt:0,closeAt:60000,close:95}).signals.length,0);
});
test('unclosed candles and stale price messages cannot cause exits',()=>{
 const s=newR4State(entry);
 assert.throws(()=>nextR4Exit(s,{type:'bar',openAt:0,closeAt:60000,receivedAt:59999,close:90}),/INVALID/);
 const o=nextR4Exit(s,{type:'tick',at:1000,receivedAt:5001,price:90,sequence:1});
 assert.equal(o.signals.length,0);assert.equal(o.state.coverageBroken,true);
});
