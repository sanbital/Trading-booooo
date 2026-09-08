import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeProtection,createProtectionLoop} from '../../supabase/functions/_shared/leader-native-protection.mjs';
const clone=structuredClone;
function fixture(){
 let state={version:0,position:{id:'position-1',symbol:'FORMUSDT',strategy:'LEADER_MOMENTUM_V17',side:'LONG',manual:false,remainingQuantity:10,entryPrice:100,realizedPnl:-.5,state:'OPEN'},protection:{generation:0,orders:[],health:'NONE'}};
 const orders=new Map(),fills=new Map(),calls=[];
 const store={load:async()=>clone(state),compareAndSwap:async(id,v,next)=>{if(v!==state.version)return false;state=clone(next);return true;}};
 const exchange={
  async createStop(p){calls.push(['create',p.clientAlgoId]);const a={...p,algoId:String(orders.size+1),algoStatus:'NEW',orderType:p.type};orders.set(p.clientAlgoId,a);return clone(a)},
  async queryStop(id){calls.push(['query',id]);if(!orders.has(id))throw Error('UNKNOWN_ORDER');return clone(orders.get(id))},
  async cancelStop(id){calls.push(['cancel',id]);const a=orders.get(id);if(a.algoStatus==='NEW')a.algoStatus='CANCELED';return clone(a)},
  async getFill(id){calls.push(['fill',id]);return clone(fills.get(id))}
 };
 const request={exchangeQuantity:10,positionMode:'ONE_WAY',stopPrice:97.5,priceTick:.1,quantityStep:1,lastPrice:100,manualSymbols:['MAGMAUSDT']};
 const api=()=>createNativeProtection({store,exchange,clock:()=>1000});
 return {api,store,exchange,request,orders,fills,calls,state:()=>clone(state)};
}
test('accepted native stop survives a restart without duplicate submission',async()=>{
 const f=fixture();assert.equal((await f.api().ensure('position-1',f.request)).status,'PROTECTED');
 assert.equal((await f.api().ensure('position-1',f.request)).status,'PROTECTED');
 assert.equal(f.calls.filter(x=>x[0]==='create').length,1);
});
test('timeout after acceptance queries the persisted client ID, with no second POST',async()=>{
 const f=fixture(),create=f.exchange.createStop;
 f.exchange.createStop=async p=>{await create(p);throw Error('CONNECTION_LOST')};
 assert.equal((await f.api().ensure('position-1',f.request)).status,'RECONCILIATION_PENDING');
 assert.equal((await f.api().ensure('position-1',f.request)).status,'PROTECTED');
 assert.equal(f.calls.filter(x=>x[0]==='create').length,1);
});
test('uncertain missing order remains pending rather than assuming no submission',async()=>{
 const f=fixture();f.exchange.createStop=async()=>{f.calls.push(['create']);throw Error('TIMEOUT')};
 await f.api().ensure('position-1',f.request);
 assert.equal((await f.api().ensure('position-1',f.request)).status,'RECONCILIATION_PENDING');
 assert.equal(f.calls.filter(x=>x[0]==='create').length,1);
});
test('replacement is acknowledged before old stop cancellation',async()=>{
 const f=fixture(),first=await f.api().ensure('position-1',f.request);
 const second=await f.api().ensure('position-1',{...f.request,stopPrice:98.1});
 assert.equal(second.status,'PROTECTED');assert.notEqual(first.clientId,second.clientId);
 const created=f.calls.findIndex(x=>x[0]==='create'&&x[1]===second.clientId),canceled=f.calls.findIndex(x=>x[0]==='cancel'&&x[1]===first.clientId);
 assert.ok(created<canceled);assert.equal(f.orders.get(first.clientId).algoStatus,'CANCELED');
});
test('failed replacement preserves the old stop',async()=>{
 const f=fixture(),first=await f.api().ensure('position-1',f.request);
 f.exchange.createStop=async()=>{throw Error('REJECTED')};
 assert.equal((await f.api().ensure('position-1',{...f.request,stopPrice:98.1})).status,'RECONCILIATION_PENDING');
 assert.equal(f.orders.get(first.clientId).algoStatus,'NEW');assert.equal(f.calls.filter(x=>x[0]==='cancel').length,0);
});
test('fill during cancel is accounted once and the replacement is cleaned up',async()=>{
 const f=fixture(),first=await f.api().ensure('position-1',f.request),cancel=f.exchange.cancelStop;
 f.exchange.cancelStop=async id=>{
  if(id===first.clientId){const o=f.orders.get(id);o.algoStatus='FINISHED';o.actualOrderId='fill-1';f.fills.set('fill-1',{exact:true,quantity:10,funds:975,fee:.4875,lastFillAt:900,status:'FILLED'});return clone(o)}
  return cancel(id);
 };
 const r=await f.api().ensure('position-1',{...f.request,stopPrice:98.1});
 assert.equal(r.status,'CLOSED');assert.equal(f.state().position.remainingQuantity,0);
 assert.equal(f.state().position.realizedPnl,-25.9875);
 await f.api().refresh('position-1');assert.equal(f.state().position.realizedPnl,-25.9875);
 assert.equal([...f.orders.values()].filter(o=>o.algoStatus==='NEW').length,0);
});
test('cumulative partial fills apply only new quantities and commissions',async()=>{
 const f=fixture(),r=await f.api().ensure('position-1',f.request),o=f.orders.get(r.clientId);
 o.algoStatus='TRIGGERED';o.actualOrderId='fill-1';
 f.fills.set('fill-1',{exact:true,quantity:4,funds:390,fee:.195,lastFillAt:900,status:'PARTIALLY_FILLED'});
 await f.api().refresh('position-1');await f.api().refresh('position-1');
 assert.equal(f.state().position.remainingQuantity,6);assert.equal(f.state().position.realizedPnl,-10.695);
 o.algoStatus='FINISHED';f.fills.set('fill-1',{exact:true,quantity:10,funds:973,fee:.4865,lastFillAt:950,status:'FILLED'});
 await f.api().refresh('position-1');assert.equal(f.state().position.remainingQuantity,0);
 assert.ok(Math.abs(f.state().position.realizedPnl-(-27.9865))<1e-10);
});
test('triggered algo without reconciled fill never marks position closed',async()=>{
 const f=fixture(),r=await f.api().ensure('position-1',f.request),o=f.orders.get(r.clientId);
 o.algoStatus='FINISHED';o.actualOrderId='fill-1';f.fills.set('fill-1',{exact:false});
 assert.equal((await f.api().ensure('position-1',f.request)).status,'RECONCILIATION_PENDING');
 assert.equal(f.state().position.remainingQuantity,10);
});
test('manual symbols and ownership drift are rejected even with an existing stop',async()=>{
 const f=fixture();await f.api().ensure('position-1',f.request);
 await assert.rejects(()=>f.api().ensure('position-1',{...f.request,manualSymbols:['FORMUSDT']}),/MANUAL_SYMBOL/);
 await assert.rejects(()=>f.api().ensure('position-1',{...f.request,exchangeQuantity:11}),/OWNERSHIP/);
 assert.equal(f.calls.filter(x=>x[0]==='create').length,1);
});
test('CAS failure prevents dispatch',async()=>{
 const f=fixture();f.store.compareAndSwap=async()=>false;
 await assert.rejects(()=>f.api().ensure('position-1',f.request),/CONCURRENT/);
 assert.equal(f.calls.filter(x=>x[0]==='create').length,0);
});
test('loop does not start on construction or overlap ticks and can stop in flight',async()=>{
 let callback,resolve,count=0;const timers={setTimeout:f=>{callback=f;return 1},clearTimeout:()=>{callback=null}};
 const loop=createProtectionLoop({timers,run:async()=>{count++;await new Promise(r=>{resolve=r})}});
 assert.equal(callback,undefined);loop.start();const running=callback();await loop.tick();assert.equal(count,1);
 loop.stop();resolve();await running;assert.equal(callback,null);
});
