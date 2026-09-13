import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import vm from 'node:vm';import {stripTypeScriptTypes} from 'node:module';
import {observeV17EntrySettlement} from '../../supabase/functions/market-autotrader/v17-entry-settlement-observation.mjs';
function fixture(){const now=Date.now(),symbol='我踏马来了USDT',client='tb-v11e-7fb0d342f7984d0bbb68e227',quantity=9627;
 const o={id:'order-1',symbol,intent:'OPEN_LONG',state:'DISPATCHED',position_id:null,client_order_id:client,exchange_order_id:'715728094',requested_quantity:quantity,created_at:new Date(now-33000).toISOString(),request_payload:{order:{identifier:client,market:symbol,side:'BUY',position_side:'LONG',position_effect:'OPEN',type:'LIMIT',time_in_force:'IOC',quantity}}};
 const r={exchange:'binance_futures',market:symbol,side:'BUY',position_side:'BOTH',reduce_only:false,status:'FILLED',client_order_id:client,exchange_order_id:'715728094',executed_volume:quantity,requested_volume:quantity,raw:{symbol,side:'BUY',positionSide:'BOTH',reduceOnly:false,clientOrderId:client,orderId:715728094,executedQty:String(quantity),updateTime:now-32000}};
 const input={now,exposures:[{market:symbol,side:'LONG',quantity}],orders:[o],observation:{id:'snapshot',source:'BINANCE_ACCOUNT_REST',requested_at_ms:now-600,received_at_ms:now-300},queryOrder:async()=>({order:r})};return{input,o,r};}
test('filled IOC before position row is a deferred scan, without mutating state',async()=>{const f=fixture(),before=JSON.stringify([f.input.exposures,f.o,f.r]);const r=await observeV17EntrySettlement(f.input);assert.equal(r.defer,true);assert.equal(r.reason,'V17_ENTRY_SETTLEMENT_PENDING');assert.equal(JSON.stringify([f.input.exposures,f.o,f.r]),before);});
for(const [name,edit] of Object.entries({
 'manual identity':f=>f.o.client_order_id='manual-order',
 'unknown order':f=>f.input.orders=[],
 'duplicate claims':f=>f.input.orders.push(structuredClone(f.o)),
 'external excess quantity':f=>f.input.exposures[0].quantity++,
 'wrong side':f=>f.r.side='SELL',
 'wrong account':f=>f.r.exchange='binance',
 'wrong order id':f=>f.r.raw.orderId++,
 'wrong symbol':f=>f.r.market='4USDT',
 'stale snapshot':f=>f.input.observation.requested_at_ms-=6000,
 'future snapshot':f=>f.input.observation.received_at_ms=f.input.now+1,
 'expired pending row':f=>f.o.created_at=new Date(f.input.now-180001).toISOString(),
 'fill after snapshot':f=>f.r.raw.updateTime=f.input.now,
 'position already exists':f=>f.o.position_id='existing',
 'mixed accounted exposure':f=>f.input.exposures[0].tracked_quantity=1,
 'multiple unknown positions':f=>f.input.exposures.push({...f.input.exposures[0],market:'4USDT'}),
 'order query timeout':f=>f.input.queryOrder=async()=>{throw Error('timeout');},
 'unknown execution result':f=>f.r.status='UNKNOWN',
 'wrong quantity request':f=>f.o.request_payload.order.quantity++,
})){test(name+' retains exposure safety handling',async()=>{const f=fixture();edit(f);assert.equal((await observeV17EntrySettlement(f.input)).defer,false);});}
test('actual scan mismatch branch defers confirmed settlement and still latches unproven exposure',async()=>{
 const src=readFileSync(new URL('../../supabase/functions/market-autotrader/index.ts',import.meta.url),'utf8');
 const start=src.indexOf('  if (untrackedFutures.length) {'),end=src.indexOf('  const snapshotPositions',start);
 const code=stripTypeScriptTypes(`async function check(){${src.slice(start,end)}};globalThis.check=check;`);
 for(const known of [true,false]){const f=fixture(),writes=[],reads=[];if(!known)f.r.raw.orderId++;
  const ctx={untrackedFutures:f.input.exposures,futuresPortfolio:{observation:f.input.observation},P10_STRATEGY_KEY:'P10',cycleId:'cycle',Date,observeV17EntrySettlement,
   db:async p=>{reads.push(p);return[f.o];},gateway:async(ex,cmd)=>{assert.equal(ex,'binance_futures');assert.equal(cmd.action,'get_order');return{order:f.r};},
   patchTradingHeartbeat:async()=>{},latchP10EntrySafety:async r=>{writes.push(r);return true;},event:async()=>{}};
  vm.createContext(ctx);vm.runInContext(code,ctx);const r=await ctx.check();assert.equal(r.skipped,true);assert.equal(reads.length,1);assert.deepEqual(writes,known?[]:['P10_UNTRACKED_FUTURES_EXPOSURE']);
  assert.equal(r.reason,known?'V17_ENTRY_SETTLEMENT_PENDING':'P10_UNTRACKED_FUTURES_EXPOSURE');}
});
