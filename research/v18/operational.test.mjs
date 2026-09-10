import test from 'node:test';import assert from 'node:assert/strict';
import {protectNewLeaderPosition} from '../../supabase/functions/_shared/leader-entry-protection.mjs';
import {createPositionProtectionStore} from '../../supabase/functions/_shared/leader-protection-adapter.mjs';
const pos={id:'p1',symbol:'EDGEUSDT',side:'LONG',remaining_quantity:93};
test('immediate protection uses actual partial fill, not requested quantity',async()=>{const calls=[];const r=await protectNewLeaderPosition({enabled:true,position:pos,readPortfolio:async()=>{calls.push('read');return{positions:[{market:'EDGEUSDT',side:'LONG',quantity:93}]}},manage:async ctx=>{calls.push('protect');assert.equal(ctx.exchangeQuantity.get('EDGEUSDT'),93);return{action:'HOLD',nativeStop:{status:'PROTECTED'}}}});assert.equal(r.status,'PROTECTED');assert.deepEqual(calls,['read','protect']);});
test('ownership mismatch cannot reach the protection writer',async()=>{const r=await protectNewLeaderPosition({enabled:true,position:pos,readPortfolio:async()=>({positions:[{market:'EDGEUSDT',side:'LONG',quantity:196}]}),manage:()=>{throw Error('must not reach')}});assert.equal(r.status,'RECONCILIATION_PENDING');assert.match(r.error,/OWNERSHIP/);});
test('a protection timeout preserves filled-entry semantics and requires monitoring',async()=>{const r=await protectNewLeaderPosition({enabled:true,position:pos,readPortfolio:async()=>{throw Error('timeout')},manage:()=>{throw Error('unreached')}});assert.equal(r.status,'RECONCILIATION_PENDING');assert.equal(r.softwareMonitorRequired,true);});
test('disabled protection has no IO',async()=>{assert.equal((await protectNewLeaderPosition({enabled:false,readPortfolio:()=>{throw Error('unreached')}})).status,'DISABLED');});
test('already failed price can close using the existing host policy',async()=>{const r=await protectNewLeaderPosition({enabled:true,position:pos,readPortfolio:async()=>({positions:[{market:'EDGEUSDT',side:'LONG',quantity:93}]}),manage:async()=>({action:'CLOSE'})});assert.equal(r.status,'CLOSED');});
function dbMock(initial){
 let row=structuredClone(initial),patch;
 return {get row(){return row},from(){
  return {select(){return this},eq(){return this},update(x){patch=x;return this},
   single:async()=>({data:structuredClone(row)}),
   maybeSingle:async()=>{row={...row,...patch};return {data:structuredClone(row)}}};
 }};
}
for(const [before,reason,expected] of [['CLOSED','V17_MOMENTUM_STALE','V17_MOMENTUM_STALE'],['OPEN',null,'V17_NATIVE_STOP'],['CLOSED','V17_HARD_STOP','V17_HARD_STOP']])test(`stop cleanup preserves ${before}/${reason}`,async()=>{const db=dbMock({id:'p1',symbol:'EDGEUSDT',side:'LONG',entry_price:1,remaining_quantity:before==='OPEN'?93:0,realized_pnl_usdt:1,state:before,closed_at:before==='CLOSED'?new Date().toISOString():null,exit_reason:reason,metadata:{},updated_at:new Date().toISOString()});const s=createPositionProtectionStore(db),old=await s.load('p1');const next={...old,version:1,position:{...old.position,state:'CLOSED',remainingQuantity:0,closedAt:Date.now()}};assert.equal(await s.compareAndSwap('p1',0,next),true);assert.equal(db.row.exit_reason,expected);});
