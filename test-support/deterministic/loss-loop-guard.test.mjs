import test from 'node:test';
import assert from 'node:assert/strict';
import {LOSS_LOOP_POLICY,evaluateAccountLossCircuit,evaluateSymbolReentry} from '../../supabase/functions/_shared/deterministic/loss-loop-guard.mjs';

const NOW=Date.parse('2026-10-04T12:00:00Z');
const closed=(symbol,agoMs,pnl,patch={})=>({symbol,state:'CLOSED',closed_at:new Date(NOW-agoMs).toISOString(),
 realized_pnl_usdt:pnl,entry_price:100,peak_price:101,exit_reason:'DETERMINISTIC_THESIS_FAILURE',...patch});
const signal=(symbol,patch={})=>({symbol,features:{deterministic:{decision:{decision:'BUY',phase:'MOMENTUM_CONTINUATION',
 confirmation:'PASS',current_propulsion:'STRONG',reference_price:100.5,...patch}}}});

test('three fresh consecutive losses block all new entries temporarily',()=>{
 const h=[closed('A',60_000,-1),closed('B',120_000,-1),closed('C',180_000,-1),closed('D',240_000,1)];
 const g=evaluateAccountLossCircuit(h,NOW);
 assert.equal(g.allowed,false);assert.equal(g.reason,'RECENT_CONSECUTIVE_LOSS_CIRCUIT');assert.equal(g.consecutive_losses,3);
 assert.equal(evaluateAccountLossCircuit(h,NOW+LOSS_LOOP_POLICY.accountBlockMs).allowed,true);
});

test('one symbol loss blocks immediate reentry and repeated losses extend the lock',()=>{
 const one=[closed('STRKUSDT',30_000,-1)];
 let g=evaluateSymbolReentry(signal('STRKUSDT'),one,NOW);
 assert.equal(g.allowed,false);assert.equal(g.reason,'REENTRY_LOCK_AFTER_LOSS');assert.equal(g.lock_ms,LOSS_LOOP_POLICY.symbolSingleLossMs);
 const repeated=[closed('STRKUSDT',30_000,-1),closed('STRKUSDT',5*60_000,-2)];
 g=evaluateSymbolReentry(signal('STRKUSDT'),repeated,NOW);
 assert.equal(g.allowed,false);assert.equal(g.reason,'REENTRY_LOCK_REPEATED_SYMBOL_LOSSES');assert.equal(g.lock_ms,LOSS_LOOP_POLICY.symbolRepeatedLossMs);
});

test('a genuine new breakout above the prior peak can release the symbol lock early',()=>{
 const h=[closed('PHAUSDT',30_000,-1,{peak_price:101.2})];
 const weak=evaluateSymbolReentry(signal('PHAUSDT',{phase:'MOMENTUM_CONTINUATION',reference_price:101.3}),h,NOW);
 assert.equal(weak.allowed,false);
 const fresh=evaluateSymbolReentry(signal('PHAUSDT',{phase:'BREAKOUT_CONFIRMATION',reference_price:101.3}),h,NOW);
 assert.equal(fresh.allowed,true);assert.equal(fresh.early_release,'FRESH_BREAKOUT_ABOVE_PRIOR_PEAK');
});

test('a profitable last trade clears the symbol loss latch',()=>{
 const h=[closed('STRKUSDT',20_000,0.2),closed('STRKUSDT',60_000,-1)];
 assert.equal(evaluateSymbolReentry(signal('STRKUSDT'),h,NOW).allowed,true);
});
