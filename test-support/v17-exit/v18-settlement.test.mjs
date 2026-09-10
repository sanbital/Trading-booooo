import test from 'node:test';import assert from 'node:assert/strict';
import {readExecutionReceipt,exitExecutionPatch,recoverExecutionJournal} from '../../supabase/functions/_shared/leader-settlement.mjs';
import {executionPending,recentLeaderExit} from '../../supabase/functions/_shared/leader-operations.mjs';
import {memoryDb} from './memory-db.mjs';import {executorHarness} from './executor-harness.mjs';
const strategy='LEADER_MOMENTUM_V17',at='2026-09-10T01:00:00.000Z';
const position=()=>({id:'p',signal_id:'s',symbol:'TESTUSDT',side:'LONG',state:'OPEN',entry_at:at,updated_at:at,
 entry_price:100,entry_fee_usdt:1,realized_pnl_usdt:-1,original_quantity:10,remaining_quantity:10,metadata:{executionMode:strategy,knownExitPnlUsdt:0}});
const order=()=>({id:'o',position_id:'p',signal_id:'s',symbol:'TESTUSDT',intent:'CLOSE_LONG',reason:'V17_MOMENTUM_STALE',client_order_id:'client',exchange_order_id:'exchange',state:'RECONCILIATION_FAILED',updated_at:at});
const receipt=({qty=10,price=101,fee=1,status='FILLED',id='exchange'}={})=>({order:{orderId:id,status,executedQty:qty,avgPrice:price},fill:{executedVolume:qty,averagePrice:price,paidFee:fee}});
function dbFor(p=position(),o=order()){return memoryDb({v11_long_regime_positions:[p],v11_long_regime_orders:[o],v11_long_regime_signals:[{id:'s',status:'FILLED',features:{strategy}}]});}

test('empty indexed fills cannot turn a gateway zero fee into an actual zero commission',()=>{
 const raw={order:{raw_status:'FILLED',executed_volume:10,average_price:101,paid_fee:0,raw:{fills:[]}}};
 const z=readExecutionReceipt(raw);assert.equal(z.fee,null);assert.equal(z.feeKnown,false);assert.equal(z.qty,10);
 const p=exitExecutionPatch(position(),order(),z);assert.equal(p.state,'CLOSED');assert.equal(p.realized_pnl_usdt,null);assert.equal(p.metadata.pendingExitAccounting.length,1);
});
test('duplicate fills, wrong commission assets and incomplete quantity stay unknown',()=>{
 const base={id:1,qty:10,commission:.5,commissionAsset:'USDT',time:Date.parse(at)};
 for(const fills of [[base,base],[{...base,commissionAsset:'BNB'}],[{...base,qty:9}]]){
  const z=readExecutionReceipt({order:{raw_status:'FILLED',executed_volume:10,average_price:101,raw:{fills}}});assert.equal(z.feeKnown,false);
 }
 const z=readExecutionReceipt({order:{raw_status:'FILLED',executed_volume:10,average_price:101,raw:{fills:[base]}}});assert.equal(z.fee,.5);
});
test('terminal partial exits book only executed quantity; nonterminal receipts stay uncertain',()=>{
 const p=exitExecutionPatch(position(),order(),readExecutionReceipt(receipt({qty:4,status:'EXPIRED'})));
 assert.equal(p.state,'OPEN');assert.equal(p.remaining_quantity,6);assert.equal(p.realized_pnl_usdt,2);
 assert.throws(()=>exitExecutionPatch(position(),order(),readExecutionReceipt(receipt({qty:4,status:'PARTIALLY_FILLED'}))),/UNCONFIRMED/);
 assert.equal(executionPending({state:'RECONCILIATION_PENDING',response_payload:receipt({status:'PARTIALLY_FILLED'})}),true);
 assert.equal(executionPending({state:'RECONCILIATION_PENDING',response_payload:receipt()}),false);
});
test('crash after quantity commit recovers order and signal without applying a second close',async()=>{
 const p=position(),o=order(),raw=receipt();Object.assign(p,exitExecutionPatch(p,o,readExecutionReceipt(raw)));
 const db=dbFor(p,o),calls=[];
 const recover=()=>recoverExecutionJournal({db,gateway:async c=>{calls.push(c.action);return raw;},recordEntry:()=>{throw Error('NO_BUY');}});
 await recover();await recover();assert.deepEqual(calls,['get_order']);
 assert.equal(db.tables.v11_long_regime_positions[0].realized_pnl_usdt,8);
 assert.equal(db.tables.v11_long_regime_orders[0].state,'FILLED');assert.equal(db.tables.v11_long_regime_signals[0].status,'CLOSED');
});
test('missing exit money reconciles once and preserves the software reason and actual fill clock',async()=>{
 const p=position(),o=order(),z=readExecutionReceipt(receipt({price:0,fee:null}));z.lastFillAt=Date.parse(at)+10000;
 Object.assign(p,exitExecutionPatch(p,o,z));const db=dbFor(p,o);
 await recoverExecutionJournal({db,gateway:async()=>receipt(),recordEntry:()=>{}});
 await recoverExecutionJournal({db,gateway:async()=>{throw Error('ALREADY_SETTLED');},recordEntry:()=>{}});
 const row=db.tables.v11_long_regime_positions[0];assert.equal(row.remaining_quantity,0);assert.equal(row.realized_pnl_usdt,8);
 assert.equal(row.exit_reason,'V17_MOMENTUM_STALE');assert.equal(row.closed_at,'2026-09-10T01:00:10.000Z');assert.equal(row.metadata.pendingExitAccounting.length,0);
});
test('unknown entry fee survives a confirmed exit and later reconstructs the exact net',async()=>{
 const p=position();p.entry_fee_usdt=null;p.realized_pnl_usdt=null;p.metadata.entryAccountingPending=true;
 const o=order();Object.assign(p,exitExecutionPatch(p,o,readExecutionReceipt(receipt())));
 const db=dbFor(p,{...order(),id:'entry',intent:'OPEN_LONG',state:'FILLED'});
 await recoverExecutionJournal({db,gateway:async()=>receipt({price:100,fee:2}),recordEntry:()=>{}});
 assert.equal(db.tables.v11_long_regime_positions[0].realized_pnl_usdt,7);assert.equal(db.tables.v11_long_regime_positions[0].entry_fee_usdt,2);
});
test('wrong receipt identity never repairs pending money or writes a fake realized net',async()=>{
 const p=position();p.entry_fee_usdt=null;p.realized_pnl_usdt=null;p.metadata.entryAccountingPending=true;
 const db=dbFor(p,{...order(),intent:'OPEN_LONG',state:'FILLED'});
 await recoverExecutionJournal({db,gateway:async()=>receipt({id:'unrelated'}),recordEntry:()=>{}});
 assert.equal(db.tables.v11_long_regime_positions[0].entry_fee_usdt,null);
});
test('terminal zero fill releases the signal only after an identified exchange receipt',async()=>{
 const db=dbFor(position(),{...order(),intent:'OPEN_LONG',position_id:null});let buys=0;
 await recoverExecutionJournal({db,gateway:async()=>receipt({qty:0,status:'EXPIRED'}),recordEntry:()=>{buys++;}});
 assert.equal(buys,0);assert.equal(db.tables.v11_long_regime_signals[0].status,'REJECTED');
});
test('entry fee recovery respects a missing execution lease',async()=>{
 const db=dbFor(),before=structuredClone(db.tables);
 await assert.rejects(()=>recoverExecutionJournal({db,gateway:async()=>receipt(),recordEntry:()=>{},verifyLease:async()=>{throw Error('LEASE_EXPIRED');}}),/LEASE_EXPIRED/);
 assert.deepEqual(db.tables,before);
});
test('timed out dispatch is read by the same client ID, with exactly one create request',async()=>{
 const calls=[],h=executorHarness({env:{BINANCE_FUTURES_ORDER_GATEWAY_URL:'https://gateway.invalid',BINANCE_FUTURES_GATEWAY_SHARED_SECRET:'test-only'},fetch:async(_,r)=>{
  const c=JSON.parse(r.body);calls.push(c);if(c.action==='create_order')throw Error('timeout after exchange fill');
  return new Response(JSON.stringify({ok:true,result:receipt()}));
 }});
 const raw=await h.gateway({action:'create_order',order:{market:'TESTUSDT',identifier:'client'}});
 assert.equal(readExecutionReceipt(raw).qty,10);assert.deepEqual(calls.map(x=>x.action),['create_order','get_order']);assert.equal(calls[1].identifier,'client');
});
test('protection credential rejects default entry mode and disabled runtime performs no reconciliation',async()=>{
 const db=memoryDb({edge_internal_tokens:[{name:'v10-lane-executor',token:'test-only'}],v11_long_regime_runtime:[{singleton:true,revision:'V11-LONG-REGIME-1.0.1',live_enabled:false}]});db.rpc=async()=>({data:true});
 const h=executorHarness({gateway:async()=>{throw Error('NO_EXCHANGE_IO');}});h.db=db;
 const denied=await h.handle(new Request('https://executor.invalid',{method:'POST',headers:{'x-v18-protection-token':'test-only'},body:'{}'}));assert.equal(denied.status,403);
 const stopped=await h.runWithLease(db,'protect');assert.equal(stopped.skipped,'RUNTIME_DISABLED');
});
test('recent symbol loss context uses actual closed time and keeps unconfirmed net unknown',async()=>{
 const p=position();p.state='CLOSED';p.closed_at='2026-09-10T03:00:00Z';p.realized_pnl_usdt=null;
 const db=dbFor(p);const recent=await recentLeaderExit(db,p.symbol);assert.equal(recent.closedAt,p.closed_at);assert.equal(recent.loss,null);
});
