import test from 'node:test';import assert from 'node:assert/strict';
import {evaluateModule,mockDb} from './harness.mjs';
import {applyExitReceipt} from '../../supabase/functions/_shared/leader-exit-settlement.mjs';
const portfolio=(quantity=0)=>({exchange:'binance_futures',account_scope:'futures',positions_complete:true,
 positions:quantity?[{market:'TESTUSDT',quantity,side:'LONG'}]:[],
 observation:{id:crypto.randomUUID(),source:'BINANCE_ACCOUNT_REST',requested_at_ms:Date.now(),received_at_ms:Date.now()}});
test('actual IOC partial settlement preserves quantity, price hardstop, fees and idempotent exit PnL',async()=>{
 let position=null;const signal={id:'signal',symbol:'TESTUSDT',features:{strategy:'LEADER_MOMENTUM_V17',exitPolicy:{stopPct:.025}}},
 intent={id:'intent',signal_id:signal.id,symbol:signal.symbol,requested_quantity:4.5,client_order_id:'entry',request_payload:{order:{side:'BUY',position_effect:'OPEN'}}};
 const {db,writes}=mockDb(q=>{
  if(q.table==='v11_long_regime_signals')return {data:signal};
  if(q.table==='v11_long_regime_positions'){
   if(q.op==='insert')position={...q.patch,id:'position',updated_at:new Date().toISOString()};
   if(q.op==='update')position={...position,...q.patch};return {data:position};
  }return {data:true};
 }),h=await evaluateModule();h.ctx.verifyExecutionLease=async()=>{};h.ctx.manualPositionAllowances=async()=>[];
 const at=Date.now(),raw={orderId:'123',clientOrderId:'entry',symbol:signal.symbol,side:'BUY',reduceOnly:false,positionSide:'BOTH',
  status:'EXPIRED',origQty:'4.5',executedQty:'2',avgPrice:'100',updateTime:at,
  fills:[{id:1,qty:2,price:100,commission:.1,commissionAsset:'USDT',time:at}]};
 await h.ctx.settleKnownEntry(db,intent,raw,async()=>portfolio(2));
 assert.equal(position.original_quantity,2);assert.equal(position.hard_stop_price,97.5);assert.equal(position.entry_fee_usdt,.1);
 assert.equal(position.realized_pnl_usdt,-.1);assert.equal(writes.find(x=>x.table==='v11_long_regime_orders').patch.state,'PARTIALLY_FILLED_CANCELED');
 await h.ctx.settleKnownEntry(db,intent,raw,async()=>portfolio(2));assert.equal(position.realized_pnl_usdt,-.1);
 assert.equal(writes.filter(x=>x.table==='v11_long_regime_positions'&&x.op==='insert').length,1);
 const exit={id:'exit',symbol:signal.symbol,requested_quantity:2,client_order_id:'exit',reason:'DETERMINISTIC_RESIDENT_STOP'},
  receipt=q=>({orderId:'456',clientOrderId:'exit',symbol:signal.symbol,side:'SELL',reduceOnly:true,positionSide:'BOTH',
   status:'EXPIRED',origQty:2,executedQty:q,avgPrice:105,updateTime:at,
   fills:[{id:2,qty:q,price:105,commission:q*.0525,commissionAsset:'USDT',time:at}]}),options={verifyLease:async()=>{}};
 await applyExitReceipt(db,position,exit,receipt(1),portfolio(1),options);assert.equal(position.state,'OPEN');assert.equal(position.remaining_quantity,1);
 assert.ok(Math.abs(position.realized_pnl_usdt-4.8475)<1e-9);
 await applyExitReceipt(db,position,exit,receipt(1),portfolio(1),options);assert.ok(Math.abs(position.realized_pnl_usdt-4.8475)<1e-9);
 await applyExitReceipt(db,position,exit,{...receipt(2),status:'FILLED'},portfolio(),options);
 assert.equal(position.state,'CLOSED');assert.equal(position.remaining_quantity,0);assert.ok(Math.abs(position.realized_pnl_usdt-9.795)<1e-9);
});
test('terminal no-fill settlement releases the reservation; an unresolved receipt retains it',async()=>{
 for(const uncertain of [false,true]){
  const {db,writes}=mockDb(q=>q.rpc==='deterministic_reserve_entry_slot'?{data:{reserved:true,id:'reservation'}}:{data:true}),h=await evaluateModule();
  h.ctx.requireEntryAuthority=async()=>({allowed:true});h.ctx.requireLeaderEntryControls=async()=>{};h.ctx.verifyExecutionLease=async()=>{};
  h.ctx.withAccountMutation=async(db,operation)=>operation();h.ctx.opsGateway=()=>async()=>({best_ask:100});
  h.ctx.readOpsPair=async()=>({pf:portfolio(),manual:[],positions:[]});h.ctx.opsControls=async()=>({});h.ctx.currentMarket=async()=>({});
  h.ctx.gatewayTakerFeeRate=()=>.0005;h.ctx.supportedFuturesMode=()=>true;h.ctx.symbolFilters=()=>({quantityStep:.1});
  h.ctx.sizeEntry=()=>({amount:4.5,limitPrice:100,sizedMargin:150});h.ctx.decideEntryWith=()=>({allowed:true});h.ctx.persistDecisionRisk=async()=>{};
  h.ctx.validatePreparedOrder=()=>({allowed:true});h.ctx.planAggressiveIocRetry=()=>({ok:false});
  h.ctx.dispatchEntryIocAttempt=async(db,s,gw,options)=>{options.attempt.dispatched=true;return {oi:{id:'intent'},receipt:{status:'EXPIRED'},settledRaw:{}};};
  h.ctx.settleKnownEntry=async()=>{if(uncertain)throw Error('ENTRY_POSITION_RECONCILIATION_STALE');return null;};
  const s={id:'signal',symbol:'TESTUSDT',features:{sizingContractVersion:h.value('SLOT_SIZING_CONTRACT.version'),targetMarginUsdt:150,leverage:3,
   exitPolicy:{stopPct:.025},deterministic:{decision:{capture_end_ms:Date.now()}}}},attempt={dispatched:false};
  if(uncertain)await assert.rejects(()=>h.ctx.openBull(db,s,[],[],attempt),/RECONCILIATION_STALE/);
  else assert.equal((await h.ctx.openBull(db,s,[],[],attempt)).reason,'IOC_NO_FILL');
  assert.equal(writes.find(x=>x.table==='leader20_entry_reservations').patch.state,uncertain?'ORDER_PENDING':'RELEASED');
 }
});
