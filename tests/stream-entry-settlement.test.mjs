import test from 'node:test';import assert from 'node:assert/strict';
import {observeV17EntrySettlement} from '../supabase/functions/market-autotrader/v17-entry-settlement-observation.mjs';
const id='tb-v11e-'+'a'.repeat(24);
function fixture(state='RECONCILIATION_PENDING',status='PARTIALLY_FILLED_CANCELED'){
 const now=Date.now(),time=now-100;const observation={id:'stream-observation',source:'BINANCE_ACCOUNT_STREAM',requested_at_ms:now-20,received_at_ms:now-10,
  continuity:{connected:true,synchronized:true,generation:1,revision:4,snapshot_id:'venue-snapshot',last_pong_at_ms:now-100,validated_at_ms:now-10,snapshot_requested_at_ms:now-1000,snapshot_received_at_ms:now-100,max_snapshot_age_ms:900000}};
 const order={id:'intent',symbol:'BTCUSDT',intent:'OPEN_LONG',state,position_id:null,client_order_id:id,exchange_order_id:'123',requested_quantity:4.5,created_at:new Date(now-1000).toISOString(),
  request_payload:{order:{identifier:id,market:'BTCUSDT',side:'BUY',position_side:'LONG',position_effect:'OPEN',type:'LIMIT',time_in_force:'IOC',quantity:4.5}}};
 const result={exchange:'binance_futures',market:'BTCUSDT',client_order_id:id,side:'BUY',position_side:'BOTH',reduce_only:false,status,executed_volume:2,requested_volume:4.5,exchange_order_id:'123',
  raw:{symbol:'BTCUSDT',clientOrderId:id,orderId:123,side:'BUY',reduceOnly:false,positionSide:'BOTH',executedQty:'2',updateTime:time}};
 return {now,observation,orders:[order],exposures:[{market:'BTCUSDT',side:'LONG',quantity:2,tracked_quantity:0}],queryOrder:async command=>{assert.equal(command.identifier,id);return result;},result};
}
for(const state of ['PLANNED','DISPATCHED','RECONCILIATION_PENDING','RECONCILIATION_FAILED'])test(`exact partial IOC proof defers legacy scan while ${state}, without adopting ownership`,async()=>{
 const f=fixture(state),r=await observeV17EntrySettlement(f);assert.equal(r.defer,true);assert.equal(r.reason,'V17_ENTRY_SETTLEMENT_PENDING');assert.equal(r.quantity,2);assert.equal(f.orders[0].position_id,null);
});
test('stale stream, unrelated client ID and larger untracked exposure never suppress the legacy safety latch',async()=>{
 const f=fixture();f.observation.continuity.last_pong_at_ms=f.now-3001;assert.equal((await observeV17EntrySettlement(f)).defer,false);
 const other=fixture();other.result.raw.clientOrderId='manual';assert.equal((await observeV17EntrySettlement(other)).defer,false);
 const larger=fixture();larger.exposures[0].quantity=3;assert.equal((await observeV17EntrySettlement(larger)).defer,false);
});
test('honest REST recovery proof remains supported; zero-fill and wrong exchange order ID cannot prove a live position',async()=>{
 const f=fixture('DISPATCHED','FILLED');f.observation={id:'REST',source:'BINANCE_ACCOUNT_REST',requested_at_ms:f.now-100,received_at_ms:f.now-10};
 assert.equal((await observeV17EntrySettlement(f)).defer,true);f.result.executed_volume=0;assert.equal((await observeV17EntrySettlement(f)).defer,false);
 const wrong=fixture();wrong.result.exchange_order_id='124';assert.equal((await observeV17EntrySettlement(wrong)).defer,false);
});
