import test from 'node:test';
import assert from 'node:assert/strict';
import {newR4Journal} from '../../supabase/functions/_shared/leader-exit-r4-coordinator.mjs';
import {createR4PositionStore} from '../../supabase/functions/_shared/leader-exit-r4-store.mjs';
import {r4GatewayCommand} from '../../supabase/functions/_shared/leader-exit-r4-gateway-contract.mjs';
function setup(){
 const journal=newR4Journal({positionId:'p',symbol:'TESTUSDT',strategy:'LEADER_MOMENTUM_V17',side:'LONG',
  entryPrice:100,entryAt:0,quantity:100,remainingQuantity:100,quantityStep:1,entryFee:5});
 let row={id:'p',symbol:'TESTUSDT',side:'LONG',remaining_quantity:100,realized_pnl_usdt:-5,state:'OPEN',peak_price:100,
  updated_at:'2026-09-08T00:00:00.000Z',metadata:{executionMode:'LEADER_MOMENTUM_V17',exitManager:'R4_EVENT_WORKER',unrelated:'keep',r4Journal:journal}};
 const db={from(table){assert.equal(table,'v11_long_regime_positions');let patch=null,filters=[];
  return {select(){return this;},eq(k,v){filters.push([k,v]);return this;},update(x){patch=x;return this;},
   async single(){return {data:structuredClone(row)};},async maybeSingle(){
    if(filters.some(([k,v])=>(k==='metadata->>exitManager'?row.metadata.exitManager:row[k])!==v))return {data:null};
    row={...row,...structuredClone(patch)};return {data:structuredClone(row)};}};}};
 return {store:createR4PositionStore(db,'p'),get row(){return row;},mutate:f=>f(row)};
}
test('position totals and journal/outbox persist together without erasing other metadata',async()=>{
 const f=setup(),j=await f.store.load();j.revision++;j.remainingQuantity=50;j.legs.risk.filled=50;
 j.realizedPnl=-107.45;j.exitQuote=4900;j.updatedAt=1000;
 assert.equal(await f.store.compareAndSwap(0,j),true);assert.equal(f.row.remaining_quantity,50);
 assert.equal(f.row.metadata.r4Journal.remainingQuantity,50);assert.equal(f.row.metadata.unrelated,'keep');
 assert.equal(f.row.state,'OPEN');
});
test('a competing row update fails CAS instead of overwriting the other writer',async()=>{
 const f=setup(),j=await f.store.load();j.revision++;f.mutate(r=>{r.updated_at='2026-09-08T00:00:01.000Z';r.metadata.unrelated='new';});
 assert.equal(await f.store.compareAndSwap(0,j),false);assert.equal(f.row.metadata.unrelated,'new');
});
test('manual/external accounting drift is detected on load',async()=>{
 const f=setup();f.mutate(r=>{r.remaining_quantity=99;});await assert.rejects(f.store.load(),/ACCOUNTING_DRIFT/);
});
test('Gateway request contract cannot turn a partial exit into an entry',()=>{
 const i={clientId:'tb-r4-'+'a'.repeat(28),symbol:'TESTUSDT',side:'SELL',type:'MARKET',quantity:3,reduceOnly:true,positionSide:'BOTH'};
 const c=r4GatewayCommand(i);assert.equal(c.order.position_effect,'CLOSE');assert.equal(c.order.quantity,3);
 assert.throws(()=>r4GatewayCommand({...i,side:'BUY'}),/INVALID_GATEWAY/);
});
