import test from 'node:test';
import assert from 'node:assert/strict';
import {nextExit48,completedTrend} from '../../supabase/functions/_shared/leader-exit-candidate48.mjs';
import {nextExitReviewed,EXIT_REVIEW_R5} from '../../supabase/functions/_shared/leader-exit-review.mjs';
const at=Date.parse('2026-09-11T12:00:00Z');
const p={entryPrice:100,entryAt:at,quantity:1,entryFee:.05,peakPrice:100,lastHighAt:at,stopPrice:97.5};
const bars=(now,rising=true)=>Array.from({length:15},(_,i)=>{const c=rising?100+i*.1:101-i*.1,t=now-(15-i)*60000;return[t,c, c+2,c-2,c,1,t+59999,100,1,1,1,0];});
test('baseline variant reproduces current R5 decision and stop exactly',()=>{
  for(const [ms,bid] of [[60000,99],[600000,99],[120000,102.5],[300000,97]]){
    const a=nextExit48(p,bid,at+ms,'BASELINE'),b=nextExitReviewed(p,bid,at+ms,EXIT_REVIEW_R5);
    assert.equal(a.stopPrice,b.stopPrice);assert.equal(a.action,b.action);assert.equal(a.reason,b.reason);
  }
});
test('early failure needs elapsed time, weak MFE and current adversity together',()=>{
  assert.equal(nextExit48(p,99,at+299999,'FAST_FAIL').stopPrice,97.5);
  assert.equal(nextExit48(p,99.5,at+300000,'FAST_FAIL').stopPrice,97.5);
  assert.equal(nextExit48({...p,peakPrice:100.6},99,at+300000,'FAST_FAIL').stopPrice,97.5);
  assert.equal(nextExit48(p,99,at+300000,'FAST_FAIL').stopPrice,98.8);
  assert.equal(nextExit48(p,98.7,at+300000,'FAST_FAIL').action,'CLOSE');
});
test('early lock arms at 1.5 percent and never loosens an acknowledged stop',()=>{
  assert.equal(nextExit48(p,101.5,at+60000,'EARLY_LOCK').stopPrice,100.75);
  assert.equal(nextExit48({...p,peakPrice:102,stopPrice:101.4},101.8,at+60000,'EARLY_LOCK').stopPrice,101.4);
});
test('volatility trail uses completed rising bars and is bounded to 1.5–2.5 percent',()=>{
  const now=at+120000,bs=bars(now);assert.equal(completedTrend(bs,now).gap,.025);
  const pos={...p,peakPrice:110,stopPrice:105};
  const baseline=nextExit48(pos,110,now,'BASELINE',bs),adaptive=nextExit48(pos,110,now,'VOL_TRAIL',bs);
  assert.ok(adaptive.stopPrice<baseline.stopPrice);assert.ok(adaptive.stopPrice>=pos.stopPrice);
  assert.equal(nextExit48({...pos,stopPrice:109},110,now,'VOL_TRAIL',bs).stopPrice,109);
});
test('future high/low/close values cannot alter current volatility context',()=>{
  const now=at+120000,bs=bars(now),future=[now,100,500,1,499,1,now+59999,1,1,1,1,0];
  assert.deepEqual(completedTrend([...bs,future],now),completedTrend(bs,now));
  assert.equal(completedTrend(bs.slice(0,-1),now).strong,false);
  assert.equal(completedTrend(bars(now,false),now).strong,false);
});
test('candidate paths maintain monotone stops and fixed exposure',()=>{
  for(const variant of ['FAST_FAIL','EARLY_LOCK','VOL_TRAIL','COMBINED']){
    let state={...p};
    for(let i=1;i<=20;i++){
      const now=at+i*60000,d=nextExit48(state,100+Math.sin(i)*2+i*.2,now,variant,bars(now));
      assert.ok(d.stopPrice>=state.stopPrice);assert.equal(state.quantity,1);
      state={...state,peakPrice:d.peakPrice,lastHighAt:d.lastHighAt,stopPrice:d.stopPrice};
    }
  }
});
test('persisted early failure stop retains exit attribution after restart',()=>{
  const first=nextExit48(p,99,at+300000,'FAST_FAIL');
  const restored={...p,stopPrice:first.stopPrice,candidateStopProvenance:first.candidateStopProvenance};
  const next=nextExit48(restored,98.7,at+360000,'FAST_FAIL');
  assert.equal(next.reason,'V18_EARLY_FAILURE_CUT');assert.equal(next.stopPrice,98.8);
});
