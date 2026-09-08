import test from 'node:test';
import assert from 'node:assert/strict';
import {newR4Journal,createR4Coordinator} from '../../supabase/functions/_shared/leader-exit-r4-coordinator.mjs';
const copy=x=>structuredClone(x);
const position={positionId:'test-position',symbol:'TESTUSDT',strategy:'LEADER_MOMENTUM_V17',side:'LONG',
 entryPrice:100,entryAt:0,quantity:100,remainingQuantity:100,quantityStep:1,entryFee:5};
function fixture(){
 let saved=newR4Journal(position),now=0;const receipts=new Map(),submitted=[];
 const store={fail:false,async load(){return copy(saved);},async compareAndSwap(revision,next){
   if(this.fail||saved.revision!==revision)return false;saved=copy(next);return true;}};
 const broker={kind:'SIMULATION',manualSymbols:[],loseAck:false,partial:false,noProtection:false,
  async snapshot(){return {complete:true,oneWay:true,manualComplete:true,capturedAt:now,symbol:position.symbol,side:'LONG',manualSymbols:this.manualSymbols,
   quantity:100-[...receipts.values()].reduce((s,x)=>s+x.filledQuantity,0),orders:[...receipts.values()].map(copy)};},
  async ensureProtection(x){return {active:!this.noProtection,quantity:x.quantity,triggerPrice:x.triggerPrice,clientIds:['stop-owned']};},
  async submitReduceOnly(x){assert.equal(saved.outbox.find(o=>o.clientId===x.clientId).status,'SUBMITTING');
   submitted.push(copy(x));const partial=this.partial&&submitted.length===1,q=partial?x.quantity/2:x.quantity;
   const r={clientId:x.clientId,symbol:x.symbol,side:'SELL',reduceOnly:true,requestedQuantity:x.quantity,
    filledQuantity:q,cumulativeQuote:q*98,commissionQuote:q*.049,commissionComplete:true,exact:true,status:partial?'CANCELED':'FILLED'};
   receipts.set(x.clientId,r);if(this.loseAck&&submitted.length===1)throw Error('LOST_ACK');return copy(r);}
 };
 const make=()=>createR4Coordinator({store,broker,verifyLease:async()=>{},clock:()=>now});
 const c=make();
 return {c,make,store,broker,receipts,submitted,get saved(){return saved;},setNow:n=>{now=n;},
  async signal(){await c.onEvent({type:'tick',price:100,at:0,sequence:1});now=300000;
   await c.onEvent({type:'tick',price:98.9,at:now,sequence:2});}};
}
test('decision completion is not position completion; both intents are durable',async()=>{
 const f=fixture();await f.signal();assert.equal(f.saved.outbox.length,2);assert.equal(f.saved.state,'OPEN');
 assert.equal(f.saved.remainingQuantity,100);assert.equal((await f.c.status()).decisionComplete,true);
});
test('two-leg simulated lifecycle closes only after exact fills and accounts fees',async()=>{
 const f=fixture();await f.signal();await f.c.dispatchNext();assert.equal(f.saved.remainingQuantity,50);
 await f.c.dispatchNext();assert.equal(f.saved.state,'CLOSED');assert.equal(f.submitted.length,2);
 assert.ok(Math.abs(f.saved.realizedPnl-(-209.9))<1e-8);
 assert.equal(f.submitted.reduce((s,x)=>s+x.quantity,0),100);
});
test('partial terminal fill retries only residual with a distinct stable id',async()=>{
 const f=fixture();f.broker.partial=true;await f.signal();
 for(let n=0;n<3;n++)await f.c.dispatchNext();
 assert.equal(f.saved.state,'CLOSED');assert.equal(f.submitted.length,3);
 assert.equal(new Set(f.submitted.map(x=>x.clientId)).size,3);assert.equal(f.submitted.at(-1).quantity,25);
});
test('restart after lost ACK queries the same order and never resubmits it',async()=>{
 const f=fixture();f.broker.loseAck=true;await f.signal();
 assert.equal((await f.c.dispatchNext()).status,'RECONCILIATION_PENDING');
 const restarted=f.make();await restarted.dispatchNext();
 assert.equal(f.submitted.length,2);assert.equal(new Set(f.submitted.map(x=>x.clientId)).size,2);assert.equal(f.saved.state,'CLOSED');
});
test('unknown submission stays pending; not-found is not treated as non-submission',async()=>{
 const f=fixture();f.broker.submitReduceOnly=async()=>{throw Error('UNKNOWN');};await f.signal();await f.c.dispatchNext();
 const rev=f.saved.revision;assert.equal((await f.make().dispatchNext()).status,'RECONCILIATION_PENDING');
 assert.ok(f.saved.revision>rev);assert.equal(f.saved.outbox[0].status,'SUBMITTING');
});
test('CAS conflict prevents external submission and preserves durable state',async()=>{
 const f=fixture();await f.signal();f.store.fail=true;
 await assert.rejects(f.c.dispatchNext(),/CAS_CONFLICT/);assert.equal(f.submitted.length,0);assert.equal(f.saved.remainingQuantity,100);
});
test('manual-symbol conflict and unconfirmed native protection prevent dispatch',async()=>{
 const f=fixture();await f.signal();f.broker.manualSymbols=['TESTUSDT'];
 await assert.rejects(f.c.dispatchNext(),/OWNERSHIP/);f.broker.manualSymbols=[];f.broker.noProtection=true;
 await assert.rejects(f.c.dispatchNext(),/PROTECTION_UNCONFIRMED/);assert.equal(f.submitted.length,0);
});
test('incomplete commissions do not erase the unresolved order or mutate accounting',async()=>{
 const f=fixture();await f.signal();const submit=f.broker.submitReduceOnly.bind(f.broker);
 f.broker.submitReduceOnly=async x=>({...await submit(x),commissionComplete:false});
 await assert.rejects(f.c.dispatchNext(),/ACCOUNTING_INCOMPLETE/);assert.equal(f.saved.remainingQuantity,100);
 assert.equal(f.saved.outbox[0].status,'SUBMITTING');
});
test('duplicate cumulative receipts do not double-count position or PnL',async()=>{
 const f=fixture();await f.signal();await f.c.dispatchNext();const before=copy(f.saved);
 await f.c.reconcile({orders:[...f.receipts.values()]});assert.equal(f.saved.remainingQuantity,before.remainingQuantity);
 assert.equal(f.saved.realizedPnl,before.realizedPnl);
});
test('native fill racing with an active risk order allocates to unreserved runner first',async()=>{
 const f=fixture();await f.signal();f.broker.submitReduceOnly=async x=>{
   const r={clientId:x.clientId,symbol:x.symbol,side:'SELL',reduceOnly:true,requestedQuantity:x.quantity,
    filledQuantity:0,cumulativeQuote:0,commissionQuote:0,commissionComplete:true,exact:true,status:'NEW'};
   f.receipts.set(x.clientId,r);return r;};await f.c.dispatchNext();
 const fill={clientId:'stop-owned',tradeId:'native-1',symbol:'TESTUSDT',side:'SELL',reduceOnly:true,
   exact:true,quantity:50,quote:4800,commissionQuote:2.4};
 await f.c.reconcile({nativeFills:[fill]});assert.equal(f.saved.legs.runner.filled,50);assert.equal(f.saved.legs.risk.filled,0);
 await f.c.reconcile({nativeFills:[fill]});assert.equal(f.saved.remainingQuantity,50);
 const ack={...[...f.receipts.values()][0],filledQuantity:50,cumulativeQuote:4900,commissionQuote:2.45,status:'FILLED'};
 await f.c.reconcile({orders:[ack]});assert.equal(f.saved.state,'CLOSED');assert.equal(f.saved.remainingQuantity,0);
});
test('ownership and existing partial positions cannot be silently adopted',()=>{
 assert.throws(()=>newR4Journal({...position,manual:true}),/EXCLUSIVELY/);
 assert.throws(()=>newR4Journal({...position,remainingQuantity:50}),/UNREDUCED/);
});

test('complete cursor backfill restores progress and cannot invent past fills',async()=>{
 const f=fixture();await f.c.onEvent({type:'tick',price:100,at:0,sequence:1});await f.c.flush();
 f.setNow(2000);const restarted=f.make();
 const restored=await restarted.recoverMarketWindow({complete:true,latestSequence:2,asOf:2000,
  events:[{type:'tick',price:101,at:1000,sequence:2}]});
 assert.equal(restored.engine.peak,101);assert.equal(restored.engine.coverageBroken,false);
 assert.equal(restored.remainingQuantity,100);assert.equal(f.submitted.length,0);
});
test('recovery refuses missing sequence coverage instead of clearing the gap flag',async()=>{
 const f=fixture();await f.c.onEvent({type:'tick',price:100,at:0,sequence:1});await f.c.flush();
 f.setNow(2000);await assert.rejects(f.make().recoverMarketWindow({complete:true,latestSequence:3,asOf:2000,
  events:[{type:'tick',price:101,at:1000,sequence:3}]}),/RECOVERY_TICK_GAP/);
});
