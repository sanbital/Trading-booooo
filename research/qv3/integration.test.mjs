import test from 'node:test';import assert from 'node:assert/strict';
import {harness,position,nativeFill} from '../../test-support/v18-ops/harness.mjs';
import {qv3Stamp} from '../../supabase/functions/_shared/leader-qv3-runtime.mjs';
const base=Date.parse('2026-09-10T16:10:00Z'),now=base+180000;
const b=(t,o,c)=>[t,o,Math.max(o,c)+.1,Math.min(o,c)-.1,c,1,t+59999];
const bars=[b(base,100,100.5),b(base+60000,100.5,100.4),b(base+120000,100.4,100.3)];
function pos(){const p=position('SAGAUSDT',1,100);p.entry_at=new Date(base).toISOString();p.metadata.qv3=qv3Stamp(base,base);return p;}
const data=async()=>new Response(JSON.stringify(bars),{status:200});
function fillOrder(h){h.state.createOrder=(cmd,state)=>{
 const p=state.tables.v11_long_regime_positions.find(x=>x.symbol===cmd.order.market),quantity=cmd.order.quantity,price=state.quotes[p.symbol]??p.entry_price;
 state.exchange=[];
 const raw={orderId:'software-'+p.id,clientOrderId:cmd.order.identifier,symbol:p.symbol,side:'SELL',positionSide:'BOTH',reduceOnly:true,origQty:String(quantity),executedQty:String(quantity),status:'FILLED',updateTime:state.now,
  fills:[{tradeId:'qv3-exit',qty:String(quantity),price:String(price),commission:'.05',commissionAsset:'USDT',time:state.now}]};
 const result={order:{exchange_order_id:raw.orderId,client_order_id:raw.clientOrderId,market:p.symbol,side:'SELL',position_side:'BOTH',reduce_only:true,requested_volume:quantity,executed_volume:quantity,raw_status:'FILLED',status:'FILLED',average_price:price,raw}};
 state.software[cmd.order.identifier]=result;return result;
};}
test('explicit null harness override adds no market requests or QV3 orders',async()=>{
 const h=harness({positions:[pos()],now,signal:false,qv3Fetch:()=>{throw Error('MUST_NOT_CALL')}});
 const r=await h.ctx.runCycle();assert.equal(r.qv3Runtime.active,false);assert.equal(r.managed[0].action.action,'HOLD');assert.equal(h.state.calls.filter(x=>x.action==='create_order').length,0);
});
test('actual manage/close/settlement integration of two bearish candles; no duplicate close',async()=>{
 const h=harness({positions:[pos()],now,signal:false,qv3Cutover:base,qv3Fetch:data});h.state.quotes.SAGAUSDT=100.3;fillOrder(h);
 const r=await h.ctx.runCycle();assert.equal(r.qv3Runtime.active,true);assert.equal(r.managed[0].action.reason,'QV3_TWO_BEARISH_CLOSED');
 assert.equal(h.state.tables.v11_long_regime_positions[0].state,'CLOSED');
 const audit=h.state.tables.v11_long_regime_decisions.find(row=>row.reason==='QV3_TWO_BEARISH_CLOSED');
 assert.equal(audit.details.executorPatch,'V20-QV3-EVIDENCE-1');assert.equal(audit.details.qv3.inputEvidence.status,'CAPTURED');
 assert.deepEqual(audit.details.qv3.inputEvidence.tail.map(row=>row.openTimeMs),[base+60000,base+120000]);
 assert.equal(Object.hasOwn(h.state.tables.v11_long_regime_positions[0].metadata.qv3State,'inputEvidence'),false);
 await h.ctx.runCycle();assert.equal(h.state.calls.filter(x=>x.action==='create_order'&&x.order.side==='SELL').length,1);
});
test('existing unstamped positions keep baseline even with prospective cutover',async()=>{
 const p=pos();delete p.metadata.qv3;const h=harness({positions:[p],now,signal:false,qv3Cutover:base,qv3Fetch:()=>{throw Error('MUST_NOT_CALL')}});
 assert.equal((await h.ctx.runCycle()).managed[0].action.action,'HOLD');
});
test('existing hard stop precedes QV3 network read and signals',async()=>{
 const h=harness({positions:[pos()],now,signal:false,qv3Cutover:base,qv3Fetch:()=>{throw Error('MUST_NOT_CALL')}});h.state.quotes.SAGAUSDT=96;fillOrder(h);
 const r=await h.ctx.runCycle();assert.equal(r.managed[0].action.action,'CLOSE');assert.notEqual(r.managed[0].action.reason,'QV3_TWO_BEARISH_CLOSED');
});
test('missing QV3 candle keeps already durable baseline protection during entry block',async()=>{
 const h=harness({positions:[pos()],now,signal:false,circuit:true,qv3Cutover:base,qv3Fetch:async()=>new Response(JSON.stringify(bars.slice(1)))});
 const r=await h.ctx.runCycle();assert.equal(r.managed[0].action.action,'HOLD');assert.equal(r.managed[0].action.nativeStop.status,'PROTECTED');
 assert.equal(h.state.calls.filter(x=>x.action==='create_order').length,0);
});
test('QV3 state persists while retaining protection and quantity metadata',async()=>{
 const safe=[b(base,100,100.5),b(base+60000,100.5,100.6),b(base+120000,100.6,100.7)];
 const h=harness({positions:[pos()],now,signal:false,qv3Cutover:base,qv3Fetch:async()=>new Response(JSON.stringify(safe))});
 await h.ctx.runCycle();const p=h.state.tables.v11_long_regime_positions[0];assert.ok(p.metadata.qv3State.favorableCandle);assert.ok(p.metadata.exitProtection);assert.equal(p.remaining_quantity,1);assert.equal(p.t1_completed,false);assert.ok(p.hard_stop_price>=97.5);
});
test('state CAS loss prevents candidate order and does not resurrect a native close',async()=>{
 let read=false;const h=harness({positions:[pos()],now,signal:false,qv3Cutover:base,qv3Fetch:async()=>{read=true;return data();},
 hook:({type,table,patch,state})=>{if(read&&type==='db'&&table==='v11_long_regime_positions'&&patch?.metadata?.qv3State){state.tables[table][0].state='CLOSED';state.tables[table][0].remaining_quantity=0;}}});
 await h.ctx.runCycle();assert.equal(h.state.calls.filter(x=>x.action==='create_order').length,0);assert.equal(h.state.tables.v11_long_regime_positions[0].state,'CLOSED');
});
test('lost lease after candle read prevents all candidate writes and orders',async()=>{
 let h;h=harness({positions:[pos()],now,signal:false,qv3Cutover:base,qv3Fetch:async()=>{h.state.lease=false;return data();}});
 await assert.rejects(h.ctx.runCycle(),/LEASE|FENCED/);assert.equal(h.state.calls.filter(x=>x.action==='create_order').length,0);
});
test('actual entry path defers exact weakening before any order intent',async()=>{
 const weak=structuredClone(bars);weak[0][2]=101;const h=harness({now,qv3Cutover:base,qv3Fetch:async()=>new Response(JSON.stringify(weak))});
 const r=await h.ctx.runCycle();assert.equal(r.entry.reason,'QV3_ENTRY_WEAKENING');assert.equal(h.state.tables.v11_long_regime_orders.length,0);assert.equal(h.state.calls.filter(x=>x.action==='create_order').length,0);
});
test('actual entry missing candles defer while preserving original signal',async()=>{
 const h=harness({now,qv3Cutover:base,qv3Fetch:async()=>new Response('[]')});
 const r=await h.ctx.runCycle();assert.equal(r.entry.reason,'CANDLE_MISSING');assert.equal(h.state.tables.v11_long_regime_signals[0].status,'NEW');assert.equal(h.state.tables.v11_long_regime_orders.length,0);
});
test('QV3 candidate timeout after exchange execution retains one intent and reconciles',async()=>{
 const h=harness({positions:[pos()],now,signal:false,qv3Cutover:base,qv3Fetch:data});h.state.quotes.SAGAUSDT=100.3;fillOrder(h);
 const actual=h.state.createOrder;h.state.createOrder=(cmd,state)=>{actual(cmd,state);throw Error('GW_408:execution status unknown');};
 const first=await h.ctx.runCycle();assert.match(first.managed[0].error,/408/);
 h.advance();await h.ctx.runCycle();assert.equal(h.state.tables.v11_long_regime_positions[0].state,'CLOSED');
 assert.equal(h.state.calls.filter(x=>x.action==='create_order'&&x.order.side==='SELL').length,1);
});
test('partial entry and delayed receipt preserve QV3 activation stamp and actual protection quantity',async()=>{
 const rising=[b(base,100,100.1),b(base+60000,100.1,100.2),b(base+120000,100.2,100.3)];
 const h=harness({now,qv3Cutover:base,qv3Fetch:async()=>new Response(JSON.stringify(rising))}),s=h.state.tables.v11_long_regime_signals[0];
 s.symbol='EDGEUSDT';s.features.referenceClose=.613;s.features.atr=.01;h.state.entryQuote={best_bid:.6129,best_ask:.613};
 h.state.createOrder=(cmd,state)=>{state.exchange=[{market:'EDGEUSDT',side:'LONG',quantity:93}];
  return {order:{orderId:'edge-entry',clientOrderId:cmd.order.identifier,symbol:'EDGEUSDT',side:'BUY',positionSide:'BOTH',reduceOnly:false,origQty:'196',executedQty:'93',status:'EXPIRED',avgPrice:'.613',updateTime:state.now,fills:[]}};
 };
 const r=await h.ctx.runCycle();assert.equal(r.entry.entered,true);const p=h.state.tables.v11_long_regime_positions[0];
 assert.equal(p.metadata.qv3.activation,base);assert.equal(p.metadata.qv3.entryAt,now);assert.equal(p.remaining_quantity,93);
 assert.equal(p.metadata.qv3.basis,'OPERATOR_OVERRIDE_PROTOCOL_DEFER_20260911');
 assert.equal(h.state.tables.v11_long_regime_orders.find(o=>o.intent==='OPEN_LONG').request_payload.qv3.basis,'OPERATOR_OVERRIDE_PROTOCOL_DEFER_20260911');
 assert.ok(h.state.calls.some(x=>x.action==='v17_create_stop'&&x.params.quantity===93));
});
test('native fill racing after candidate state persistence never submits an extra exit',async()=>{
 let h;h=harness({positions:[pos()],now,signal:false,qv3Cutover:base,qv3Fetch:data,
 hook:({type,table,patch,state})=>{if(type==='db'&&table==='v11_long_regime_positions'&&patch?.metadata?.qv3State){const p=state.tables[table][0];state.exchange=[];state.stopFills[p.symbol]=nativeFill(p);}}});
 await h.ctx.runCycle();assert.equal(h.state.calls.filter(x=>x.action==='create_order').length,0);assert.equal(h.state.tables.v11_long_regime_positions[0].state,'CLOSED');
});
