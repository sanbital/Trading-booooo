import test from 'node:test';
import assert from 'node:assert/strict';
import {EXIT_AUTHORITY_VERSION} from '../../supabase/functions/_shared/deterministic/exit-authority.mjs';
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
test('definitive pre-send rejection is terminal and can never become a stale stop',async()=>{
 const f=fixture();f.exchange.createStop=async()=>{f.calls.push(['create']);throw Error('V18_STOP_OWNERSHIP_CHANGED')};
 const result=await f.api().ensure('position-1',f.request),order=f.state().protection.orders[0];
 assert.equal(result.status,'REJECTED');assert.equal(order.status,'REJECTED');assert.equal(order.terminal,true);
 assert.equal(order.terminalResolution.kind,'DEFINITIVE_CREATE_REJECTION');
 assert.equal(f.state().protection.health,'REJECTED');
});
test('legacy rejected submission is retired without treating a generic missing lookup as proof',async()=>{
 const f=fixture();f.exchange.createStop=async()=>{f.calls.push(['create']);throw Error('TIMEOUT')};
 await f.api().ensure('position-1',f.request);
 const before=await f.store.load('position-1'),legacy=clone(before),order=legacy.protection.orders[0];
 legacy.position.state='CLOSED';legacy.position.remainingQuantity=0;
 order.status='CANCEL_PENDING';order.submitError='GW_400:Order would immediately trigger.';
 order.lastQueryError='GW_400:Order does not exist.';
 assert.equal(await f.store.compareAndSwap('position-1',before.version,legacy),true);
 f.calls.length=0;await f.api().refresh('position-1');
 const retired=f.state().protection.orders[0];
 assert.equal(retired.status,'REJECTED');assert.equal(retired.terminal,true);
 assert.equal(retired.terminalResolution.lookupError,'GW_400:Order does not exist.');
 assert.equal(retired.lastQueryError,null);assert.equal(f.calls.filter(x=>x[0]==='query').length,0);
 assert.equal(f.state().protection.health,'POSITION_CLOSED');
});
test('definitive replacement rejection keeps the acknowledged older stop protective',async()=>{
 const f=fixture(),first=await f.api().ensure('position-1',f.request);
 f.exchange.createStop=async()=>{throw Error('GW_400:Order would immediately trigger.')};
 const result=await f.api().ensure('position-1',{...f.request,stopPrice:98.1});
 assert.equal(result.status,'REJECTED');assert.equal(f.orders.get(first.clientId).algoStatus,'NEW');
 assert.equal(f.state().protection.health,'PROTECTED');assert.equal(f.calls.filter(x=>x[0]==='cancel').length,0);
});
test('replacement is acknowledged before old stop cancellation',async()=>{
 const f=fixture(),first=await f.api().ensure('position-1',f.request);
 const second=await f.api().ensure('position-1',{...f.request,stopPrice:98.1});
 assert.equal(second.status,'PROTECTED');assert.notEqual(first.clientId,second.clientId);
 const created=f.calls.findIndex(x=>x[0]==='create'&&x[1]===second.clientId),canceled=f.calls.findIndex(x=>x[0]==='cancel'&&x[1]===first.clientId);
 assert.ok(created<canceled);assert.equal(f.orders.get(first.clientId).algoStatus,'CANCELED');
});
test('resident soft profit stop keeps its reason and cannot be downgraded',async()=>{
 const f=fixture(),soft={...f.request,stopPrice:101,lastPrice:102,exitClass:'SOFT_PROTECTION',
   authorityVersion:EXIT_AUTHORITY_VERSION,protectionReason:'V17_PROFIT_LOCK'};
 const first=await f.api().ensure('position-1',soft),state=f.state(),order=state.protection.orders.find(x=>x.clientId===first.clientId);
 assert.equal(first.status,'PROTECTED');assert.equal(order.protectionReason,'V17_PROFIT_LOCK');assert.equal(order.spec.params.triggerPrice,101);
 const again=await f.api().ensure('position-1',{...soft,stopPrice:100});
 assert.equal(again.status,'PROTECTED');assert.equal(again.clientId,first.clientId);
 assert.equal(f.calls.filter(x=>x[0]==='create').length,1,'a lower requested floor must never replace the stronger resident stop');
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
test('terminal rejection replaces a stale PROTECTED label with REJECTED',async()=>{
 const f=fixture(),r=await f.api().ensure('position-1',f.request),o=f.orders.get(r.clientId);
 o.algoStatus='REJECTED';await f.api().refresh('position-1');
 assert.equal(f.state().protection.orders[0].terminal,true);assert.equal(f.state().protection.health,'REJECTED');
 assert.equal(f.state().position.state,'OPEN');
});
test('a stop executing after its source lifecycle closed is quarantined, never charged to that source',async()=>{
 const f=fixture(),r=await f.api().ensure('position-1',f.request),before=await f.store.load('position-1');
 const closed=structuredClone(before);closed.position.state='CLOSED';closed.position.remainingQuantity=0;closed.position.realizedPnl=-3;
 assert.equal(await f.store.compareAndSwap('position-1',before.version,closed),true);
 const o=f.orders.get(r.clientId);o.algoStatus='FINISHED';o.actualOrderId='late-fill';o.quantity=7;
 f.fills.set('late-fill',{exact:true,quantity:7,funds:679,fee:.35,lastFillAt:2000,status:'FILLED',tradeIds:['late-1']});
 await f.api().refresh('position-1');const state=f.state(),journal=state.protection.orders[0];
 assert.equal(state.position.realizedPnl,-3);assert.equal(journal.crossLifecycleExecution,true);
 assert.equal(journal.accountingAppliedToSource,false);assert.equal(state.protection.health,'CROSS_LIFECYCLE_EXECUTION');
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

test('T28 hard protection cannot be downgraded through legacy soft retirement',async()=>{
 const f=fixture(),hard={...f.request,exitClass:'HARD_SAFETY',authorityVersion:EXIT_AUTHORITY_VERSION};
 const first=await f.api().ensure('position-1',hard);
 await assert.rejects(()=>f.api().ensure('position-1',{...hard,stopPrice:96,legacySoftOrderIds:[first.clientId]}),/HARD_FLOOR_RETIREMENT_FORBIDDEN/);
 assert.equal(f.orders.get(first.clientId).algoStatus,'NEW');
});
test('T28 legacy soft replacement failure never cancels prior resident protection',async()=>{
 const f=fixture(),first=await f.api().ensure('position-1',{...f.request,stopPrice:102,lastPrice:104});
 f.exchange.createStop=async()=>{throw Error('TIMEOUT')};
 const r=await f.api().ensure('position-1',{...f.request,exitClass:'HARD_SAFETY',authorityVersion:EXIT_AUTHORITY_VERSION,legacySoftOrderIds:[first.clientId]});
 assert.equal(r.status,'PROTECTED');assert.equal(f.calls.filter(x=>x[0]==='create').length,1);assert.equal(f.calls.filter(x=>x[0]==='cancel').length,0);
 assert.equal(f.orders.get(first.clientId).algoStatus,'NEW');
});

for(const [label,requested,legacy] of [['O',97.5,false],['P',98,true]])
test(`${label} acknowledged profit floor 101 survives lower hard request${legacy?' and legacy soft label':''}`,async()=>{
 const f=fixture(),first=await f.api().ensure('position-1',{...f.request,stopPrice:101,lastPrice:104,
   exitClass:'SOFT_PROTECTION',authorityVersion:EXIT_AUTHORITY_VERSION,protectionReason:'V17_PROFIT_LOCK'});
 const result=await f.api().ensure('position-1',{...f.request,stopPrice:requested,lastPrice:104,
   exitClass:'HARD_SAFETY',authorityVersion:EXIT_AUTHORITY_VERSION,legacySoftOrderIds:legacy?[first.clientId]:[]});
 assert.equal(result.status,'PROTECTED');assert.equal(result.clientId,first.clientId);
 const resident=f.state().protection.orders.find(x=>x.clientId===first.clientId);
 assert.equal(resident.spec.params.triggerPrice,101);assert.equal(resident.status,'ACTIVE');
 assert.equal(resident.protectionReason,'V17_PROFIT_LOCK');
 assert.equal(f.calls.filter(x=>x[0]==='create').length,1);assert.equal(f.calls.filter(x=>x[0]==='cancel').length,0);
});

test('Q 101 to 102 waits for actual new ACK and durable ACTIVE before canceling 101',async()=>{
 const f=fixture(),request={...f.request,stopPrice:101,lastPrice:104,exitClass:'SOFT_PROTECTION',
   authorityVersion:EXIT_AUTHORITY_VERSION,protectionReason:'V17_PROFIT_LOCK'};
 const first=await f.api().ensure('position-1',request),create=f.exchange.createStop,cancel=f.exchange.cancelStop;
 let release,submitted,acked=false;
 const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{submitted=resolve;});
 f.exchange.createStop=async params=>{submitted();await gate;const ack=await create(params);acked=true;return ack;};
 f.exchange.cancelStop=async id=>{
   assert.equal(acked,true,'create call alone is not an ACK');
   const replacement=f.state().protection.orders.find(x=>x.clientId!==first.clientId);
   assert.equal(replacement.status,'ACTIVE');assert.equal(replacement.spec.params.triggerPrice,102);
   return cancel(id);
 };
 const pending=f.api().ensure('position-1',{...request,stopPrice:102});
 await started;
 try{assert.equal(f.orders.get(first.clientId).algoStatus,'NEW');assert.equal(f.calls.filter(x=>x[0]==='cancel').length,0);}
 finally{release();}
 const second=await pending;
 assert.equal(second.status,'PROTECTED');assert.notEqual(second.clientId,first.clientId);
 assert.equal(f.orders.get(second.clientId).algoStatus,'NEW');assert.equal(f.orders.get(first.clientId).algoStatus,'CANCELED');
});

for(const error of ['TIMEOUT','GW_400:Order would immediately trigger.'])
test(`R failed 102 replacement keeps 101 ACTIVE: ${error}`,async()=>{
 const f=fixture(),request={...f.request,stopPrice:101,lastPrice:104,exitClass:'SOFT_PROTECTION',
   authorityVersion:EXIT_AUTHORITY_VERSION,protectionReason:'V17_PROFIT_LOCK'};
 const first=await f.api().ensure('position-1',request);
 f.exchange.createStop=async()=>{throw Error(error);};
 await f.api().ensure('position-1',{...request,stopPrice:102});
 const resident=f.state().protection.orders.find(x=>x.clientId===first.clientId);
 assert.equal(resident.status,'ACTIVE');assert.equal(resident.spec.params.triggerPrice,101);
 assert.equal(f.orders.get(first.clientId).algoStatus,'NEW');assert.equal(f.calls.filter(x=>x[0]==='cancel').length,0);
});

for(const error of ['V18_API_BUDGET_EXHAUSTED','V17_EXECUTION_LEASE_EXPIRED','The signal has been aborted']) {
 test(`explicit pre-transport ${error} terminates without querying or resubmitting`,async()=>{
  const f=fixture();f.exchange.createStop=async()=>{throw Object.assign(Error(error),{exchangeSubmissionAttempted:false,submissionPhase:'PRE_SEND'})};
  const r=await f.api().ensure('position-1',f.request),o=r.state.protection.orders[0];
  assert.equal(o.terminal,true);assert.equal(o.submissionEvidence.phase,'NOT_SENT');
  const before=await f.store.load('position-1'),closed=clone(before);closed.position.state='CLOSED';closed.position.remainingQuantity=0;
  await f.store.compareAndSwap('position-1',before.version,closed);f.calls.length=0;
  const after=await f.api().ensure('position-1',f.request);
  assert.equal(after.state.protection.health,'POSITION_CLOSED');assert.deepEqual(f.calls,[]);
 });
 test(`unmarked or post-transport ${error} remains ambiguous even with negative lookup`,async()=>{
  const f=fixture();f.exchange.createStop=async()=>{throw Error(error)};
  await f.api().ensure('position-1',f.request);const before=await f.store.load('position-1'),closed=clone(before);
  closed.position.state='CLOSED';closed.position.remainingQuantity=0;closed.protection.orders[0].status='CANCEL_PENDING';
  await f.store.compareAndSwap('position-1',before.version,closed);
  const state=await f.api().refresh('position-1');assert.equal(state.protection.orders[0].terminal,false);
  assert.equal(state.protection.health,'RECONCILIATION_PENDING');
 });
}
test('acceptance followed by budget failure recovers the same client ID without a second POST',async()=>{
 const f=fixture(),create=f.exchange.createStop;
 f.exchange.createStop=async p=>{await create(p);throw Error('V18_API_BUDGET_EXHAUSTED')};
 assert.equal((await f.api().ensure('position-1',f.request)).status,'RECONCILIATION_PENDING');
 assert.equal((await f.api().ensure('position-1',f.request)).status,'PROTECTED');
 assert.equal(f.calls.filter(x=>x[0]==='create').length,1);
});
