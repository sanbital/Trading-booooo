import test from 'node:test';import assert from 'node:assert/strict';
import {harness,position} from '../test-support/v18-ops/harness.mjs';
import {currentAccountOwner,currentExecutionContext} from '../supabase/functions/v10-lane-executor/account-execution-context.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
test('actual periodic analysis releases the writer while another account mutation proceeds',async()=>{
 const h=harness({shortWriter:true,signal:false}),started=deferred(),release=deferred();await h.ctx.enableShort();
 const managing=h.ctx.periodic(async()=>{assert.equal(currentAccountOwner(h.db),null);assert.equal(h.state.leaseOwner,null);started.resolve();await release.promise;return {action:'HOLD'};});await started.promise;
 let mutations=0;await h.ctx.mutate(async()=>{assert.equal(currentExecutionContext(h.db).kind,'WRITER');assert.equal(h.state.leaseOwner,currentAccountOwner(h.db));mutations++;});
 assert.equal(mutations,1);assert.equal(h.state.leaseOwner,null);release.resolve();const result=await managing;assert.equal(result.action,'HOLD');assert.equal(h.state.leaseOwner,null);assert.equal(h.state.tables.v17_analysis_lease[0].owner,null);
});
test('actual ordinary cycle performs analysis without retaining account lease',async()=>{
 const h=harness({shortWriter:true,signal:false});await h.ctx.enableShort();const result=await h.ctx.actualShortCycle();assert.equal(result.ok,true);assert.equal(h.state.leaseOwner,null);assert.equal(h.state.tables.v17_analysis_lease[0].owner,null);
 assert.ok(!h.state.calls.some(c=>c.action==='create_order'));
});
test('actual close path uses writer and releases it after exchange settlement',async()=>{
 const p=position('MAGMAUSDT',100,.26761),h=harness({shortWriter:true,positions:[p],signal:false});await h.ctx.enableShort();
 h.state.createOrder=(cmd,state)=>{assert.equal(currentExecutionContext(h.db).kind,'WRITER');assert.equal(currentAccountOwner(h.db),state.leaseOwner);state.exchange=[];const price=p.entry_price*.99,t=Date.now();return {order:{exchange_order_id:'close-1',client_order_id:cmd.order.identifier,market:p.symbol,side:'SELL',position_side:'BOTH',reduce_only:true,requested_volume:cmd.order.quantity,executed_volume:cmd.order.quantity,raw_status:'FILLED',status:'FILLED',average_price:price,raw:{orderId:'close-1',clientOrderId:cmd.order.identifier,symbol:p.symbol,side:'SELL',positionSide:'BOTH',reduceOnly:true,origQty:String(cmd.order.quantity),executedQty:String(cmd.order.quantity),status:'FILLED',updateTime:t,fills:[{tradeId:'close-trade',qty:String(cmd.order.quantity),price:String(price),commission:'.05',commissionAsset:'USDT',time:t}]}}};};
 const proof={authority:h.ctx.ENGINE,positionId:String(p.id),generation:h.ctx.positionGeneration(p),at:Date.now(),input:{}};
 const result=await h.ctx.periodic(()=>h.ctx.close(p,1,'V17_RISK_CUT',{finalApproval:proof,revalidateExit:async()=>({allowed:true,proof:{...proof,at:Date.now()}})}));assert.equal(result.closed,true);assert.equal(h.state.calls.filter(c=>c.action==='create_order').length,1);assert.equal(h.state.leaseOwner,null);
});

test('actual software cancel is a fenced writer mutation and never enters analysis read sharing',async()=>{
 const h=harness({shortWriter:true,signal:false});await h.ctx.enableShort();
 await assert.rejects(h.ctx.periodic(()=>h.ctx.fencedGateway({action:'cancel_order',identifier:'known-original-order'})),/ACCOUNT_WRITER_CONTEXT_REQUIRED/);
 await h.ctx.mutate(()=>h.ctx.fencedGateway({action:'cancel_order',identifier:'known-original-order'}));
 const c=h.state.calls.find(x=>x.action==='cancel_order');assert.ok(c.writer);assert.equal(c.writer.account_key,'binance_futures:futures');assert.ok(c.writer.fence>0);assert.equal(h.state.leaseOwner,null);
});
