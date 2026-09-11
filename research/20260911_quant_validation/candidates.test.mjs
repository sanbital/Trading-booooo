import test from 'node:test';
import assert from 'node:assert/strict';
import {entryDecision,exitDecision,VARIANTS} from './candidates.mjs';
import {nextExitReviewed,EXIT_REVIEW_R5} from '../../supabase/functions/_shared/leader-exit-review.mjs';
const at=1800000;
const f={strategy:'LEADER_MOMENTUM_V17',signal5Open:at-300000,signal5Close:at,signal15Close:at,referenceClose:100,return5m:.02,atr:1};
const p={entryPrice:100,entryAt:at,entryFee:.06,quantity:1.2,peakPrice:100,lastHighAt:at,stopPrice:97.5};
test('ATR gate uses only completed signal fields and fixed one-ATR threshold',()=>{
 assert.equal(entryDecision(f,at+5000,100,'ATR_ENTRY').verdict,'REJECT');
 assert.equal(entryDecision({...f,atr:2},at+5000,100,'ATR_ENTRY').verdict,'KEEP');
 assert.equal(entryDecision({...f,atr:NaN},at+5000,100,'ATR_ENTRY').verdict,'UNAVAILABLE');
});
test('future and stale entries retain baseline rejection',()=>{
 assert.equal(entryDecision(f,at-1,100,'ATR_ENTRY').reason,'SIGNAL_STALE_OR_FUTURE');
 assert.equal(entryDecision(f,at+120001,100,'ATR_ENTRY').reason,'SIGNAL_STALE_OR_FUTURE');
 assert.equal(entryDecision({...f,signal5Open:at-1},at,100,'ATR_ENTRY').verdict,'UNAVAILABLE');
});
test('baseline policy is unchanged for every decision field',()=>{
 const expected=nextExitReviewed(p,101,at+20000,EXIT_REVIEW_R5);
 const actual=exitDecision(p,101,at+20000);
 for(const [k,v] of Object.entries(expected))assert.deepEqual(actual[k],v);
});
test('no-progress threshold preserves native risk cut and acts only after 15m',()=>{
 assert.equal(exitDecision(p,99.5,at+899999,'NO_PROGRESS').action,'HOLD');
 assert.equal(exitDecision(p,99.5,at+900000,'NO_PROGRESS').reason,'QV2_NO_PROGRESS_15M');
 assert.notEqual(exitDecision(p,98,at+900000,'NO_PROGRESS').reason,'QV2_NO_PROGRESS_15M');
 assert.equal(exitDecision({...p,peakPrice:101.1},99.5,at+900000,'NO_PROGRESS').action,'HOLD');
});
test('plateau requires elapsed peak and falling completed closes; future candles cannot trigger',()=>{
 const now=at+600000,bar=(t,c)=>[t,c,c+.1,c-.1,c,0,t+59999];
 const s={...p,peakPrice:104,lastHighAt:now-300000,stopPrice:102.5};
 const bars=[bar(now-120000,103.5),bar(now-60000,103.4),bar(now,90)];
 assert.equal(exitDecision(s,103.3,now,'PLATEAU',bars).reason,'QV2_PROFIT_PLATEAU_5M');
 assert.equal(exitDecision({...s,lastHighAt:now-299999},103.3,now,'PLATEAU',bars).action,'HOLD');
 assert.equal(exitDecision(s,103.3,now,'PLATEAU',bars.slice(0,1)).action,'HOLD');
 assert.equal(exitDecision(s,103.3,now,'PLATEAU',[bar(now-120000,103.3),bar(now-60000,103.4),bar(now,90)]).action,'HOLD');
});
test('existing peak stop quantity and partial flags are not mutated or lowered',()=>{
 const s={...p,peakPrice:104,stopPrice:103,t1_completed:true,remaining_quantity:.6};const copy=structuredClone(s);
 for(const variant of VARIANTS){const d=exitDecision(s,103.5,at+1000000,variant);assert.ok(d.stopPrice>=s.stopPrice);assert.ok(d.peakPrice>=s.peakPrice);assert.equal(d.executionEnabled,false);}
 assert.deepEqual(s,copy);
});
test('manual and unknown ownership are preserved and invalid variants fail closed',()=>{
 for(const ownership of ['MANUAL','UNKNOWN'])assert.equal(exitDecision({...p,ownership},90,at+1000000,'ALL').action,'PRESERVE');
 assert.throws(()=>exitDecision(p,101,at+1,'INVALID'),/UNKNOWN_VARIANT/);
});
