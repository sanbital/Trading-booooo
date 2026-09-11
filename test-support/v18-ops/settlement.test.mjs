import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,position,nativeFill} from './harness.mjs';
function receipt(p,cmd,{exact=true,quantity=cmd.order.quantity}={}){
 const id='software-'+p.id,price=p.entry_price*.99,t=Date.now();
 const raw={orderId:id,clientOrderId:cmd.order.identifier,symbol:p.symbol,side:'SELL',positionSide:'BOTH',reduceOnly:true,
   origQty:String(cmd.order.quantity),executedQty:String(quantity),status:'FILLED',updateTime:t,
   fills:exact?[{tradeId:'software-trade',qty:String(quantity),price:String(price),commission:'.05',commissionAsset:'USDT',time:t}]:[]};
 return {order:{exchange_order_id:id,client_order_id:cmd.order.identifier,market:p.symbol,side:'SELL',position_side:'BOTH',reduce_only:true,
   requested_volume:cmd.order.quantity,executed_volume:quantity,raw_status:'FILLED',status:'FILLED',average_price:exact?price:0,raw}};
}
function setup({exact=true,quantity=449,partial=.0,timeout=false}={}){
 const p=position('MAGMAUSDT',quantity,.26761),h=harness({positions:[p],signal:false});
 h.state.createOrder=(cmd,state)=>{
  const q=partial||cmd.order.quantity,stateRow=state.exchange.find(x=>x.market===p.symbol);
  stateRow.quantity=Math.max(0,stateRow.quantity-q);state.exchange=state.exchange.filter(x=>x.quantity>0);
  const r=receipt(p,cmd,{exact,quantity:q});state.software[cmd.order.identifier]=r;
  if(timeout)throw Error('GW_408:execution status unknown');return r;
 };return{h,p};
}
test('08 MAGMA FILLED/fills delayed: exposure zero, null PnL, no second close, late settlement exact',async()=>{
 const {h,p}=setup({exact:false});const out=await h.ctx.close(p,1,'V17_RISK_CUT');
 assert.equal(out.closed,true);assert.equal(out.position.remaining_quantity,0);assert.equal(out.realizedPnlUsdt,null);
 const order=h.state.tables.v11_long_regime_orders.find(o=>o.intent==='CLOSE_LONG');
 const cmd=h.state.calls.find(c=>c.action==='create_order');h.state.software[cmd.order.identifier]=receipt(p,cmd,{exact:true});
 h.advance(120000);await h.ctx.runCycle();
 const current=h.state.tables.v11_long_regime_positions[0];assert.equal(current.metadata.exitAccountingPending,false);
 assert.ok(Number.isFinite(current.realized_pnl_usdt));assert.equal(h.state.calls.filter(c=>c.action==='create_order').length,1);
 assert.equal(order.state,'FILLED');
});
test('09 timeout but order succeeded: query original client ID, never dispatch replacement ID',async()=>{
 const {h,p}=setup({timeout:true});await assert.rejects(()=>h.ctx.close(p,1,'V17_RISK_CUT'),/408/);
 const original=h.state.calls.find(c=>c.action==='create_order').order.identifier;
 h.advance();await h.ctx.runCycle();
 assert.equal(h.state.calls.filter(c=>c.action==='create_order').length,1);
 assert.ok(h.state.calls.some(c=>c.action==='get_order'&&c.identifier===original));
 assert.equal(h.state.tables.v11_long_regime_positions[0].remaining_quantity,0);
});
test('10 native stop before software dispatch: exact fill recorded without a second SELL',async()=>{
 const p=position('CKBUSDT',101139,.0011868),h=harness({positions:[p],signal:false});
 h.state.exchange=[];h.state.stopFills[p.symbol]=nativeFill(p);
 const r=await h.ctx.close(p,1,'V17_RISK_CUT');assert.equal(r.closed,true);assert.equal(r.nativeReconciled,true);
 assert.ok(!h.state.calls.some(c=>c.action==='create_order'));
 const pnl=h.state.tables.v11_long_regime_positions[0].realized_pnl_usdt;
 await h.ctx.close(p,1,'STALE_CALLER');assert.equal(h.state.tables.v11_long_regime_positions[0].realized_pnl_usdt,pnl);
});
test('11 EDGE requested 196 / filled 93: protection and full exit use actual 93',async()=>{
 const p=position('EDGEUSDT',93,.61),h=harness({positions:[p],signal:false});h.state.tables.v11_long_regime_orders[0].requested_quantity=196;
 await h.ctx.runCycle();
 assert.ok(h.state.calls.filter(c=>c.action==='v17_create_stop').every(c=>c.params.quantity===93));
 h.state.createOrder=(cmd,state)=>{assert.equal(cmd.order.quantity,93);state.exchange=[];return receipt(p,cmd);};
 h.ctx.setLease();await h.ctx.close(h.state.tables.v11_long_regime_positions[0],1,'V17_RISK_CUT');
 assert.equal(h.state.tables.v11_long_regime_positions[0].remaining_quantity,0);
});
test('12 terminal partial FILLED with no details leaves residual OPEN and protected',async()=>{
 const {h,p}=setup({exact:false,quantity:100});const r=await h.ctx.close(p,.3,'BULL_T1');
 assert.equal(r.closed,false);assert.equal(r.position.remaining_quantity,70);assert.equal(r.position.state,'OPEN');
 assert.equal(r.realizedPnlUsdt,null);assert.equal(h.state.exchange[0].quantity,70);
});
test('13 duplicate receipts / restart-like repeated cycle apply economics once',async()=>{
 const {h,p}=setup({exact:false});await h.ctx.close(p,1,'V17_RISK_CUT');
 const cmd=h.state.calls.find(c=>c.action==='create_order');h.state.software[cmd.order.identifier]=receipt(p,cmd);
 h.advance();await h.ctx.runCycle();const first=h.state.tables.v11_long_regime_positions[0].realized_pnl_usdt;
 h.advance();await h.ctx.runCycle();assert.equal(h.state.tables.v11_long_regime_positions[0].realized_pnl_usdt,first);
 assert.equal(h.state.calls.filter(c=>c.action==='create_order').length,1);
});
test('14 CAS conflict after exchange fill retains intent, retry queries the same order',async()=>{
 const {h,p}=setup();let once=true;
 h.state.hook=({type,table,patch,state})=>{if(once&&type==='db'&&table==='v11_long_regime_positions'&&patch?.metadata?.v18Exits){once=false;state.tables[table][0].updated_at='2026-09-10T16:16:00.001Z';}};
 await assert.rejects(()=>h.ctx.close(p,1,'V17_RISK_CUT'),/CAS/);h.advance();await h.ctx.runCycle();
 assert.equal(h.state.calls.filter(c=>c.action==='create_order').length,1);assert.equal(h.state.tables.v11_long_regime_positions[0].state,'CLOSED');
});

test('11 actual openBull requested 196, fills 93 with fee delayed: owns/protects only 93',async()=>{
 const h=harness(),s=h.state.tables.v11_long_regime_signals[0];s.symbol='EDGEUSDT';s.features.referenceClose=.613;s.features.atr=.01;
 h.state.entryQuote={best_bid:.6129,best_ask:.613};
 h.state.createOrder=(cmd,state)=>{
  assert.equal(cmd.order.side,'BUY');assert.equal(cmd.order.quantity,196);
  state.exchange=[{market:'EDGEUSDT',side:'LONG',quantity:93}];
  return{order:{orderId:'edge-entry',clientOrderId:cmd.order.identifier,symbol:'EDGEUSDT',side:'BUY',positionSide:'BOTH',reduceOnly:false,
   origQty:'196',executedQty:'93',status:'EXPIRED',avgPrice:'.613',updateTime:state.now,fills:[]}};
 };
 const out=await h.ctx.runCycle();assert.equal(out.entry.entered,true);
 const p=h.state.tables.v11_long_regime_positions[0];assert.equal(p.original_quantity,93);assert.equal(p.remaining_quantity,93);
 assert.equal(p.realized_pnl_usdt,null);assert.equal(p.entry_fee_usdt,null);
 const stops=h.state.calls.filter(c=>c.action==='v17_create_stop');assert.equal(stops.length,1);assert.equal(stops[0].params.quantity,93);
});
test('09 entry timeout: successful existing ID is recovered and protected; terminal zero stays flat',async()=>{
 for(const executed of [0,93]){
  const h=harness(),s=h.state.tables.v11_long_regime_signals[0];s.symbol='EDGEUSDT';s.features.referenceClose=.613;s.features.atr=.01;
  h.state.entryQuote={best_bid:.6129,best_ask:.613};
  h.state.createOrder=(cmd,state)=>{
   state.exchange=executed?[{market:'EDGEUSDT',side:'LONG',quantity:executed}]:[];
   state.software[cmd.order.identifier]={order:{orderId:'known-entry',clientOrderId:cmd.order.identifier,symbol:'EDGEUSDT',side:'BUY',positionSide:'BOTH',reduceOnly:false,origQty:'196',executedQty:String(executed),status:'EXPIRED',avgPrice:'.613',updateTime:state.now,fills:[]}};
   throw Error('GW_408:execution status unknown');
  };
  await assert.rejects(()=>h.ctx.runCycle(),/408/);h.advance();await h.ctx.runCycle();
  assert.equal(h.state.calls.filter(c=>c.action==='create_order').length,1);
  assert.equal(h.state.tables.v11_long_regime_positions.length,executed?1:0);
  if(executed)assert.ok(h.state.calls.some(c=>c.action==='v17_create_stop'&&c.params.quantity===93));
  else assert.equal(h.state.tables.v11_long_regime_orders[0].state,'REJECTED');
 }
});
test('13 process restart loads durable receipt, settles late fees exactly once',async()=>{
 const {h,p}=setup({exact:false});await h.ctx.close(p,1,'V17_RISK_CUT');
 const cmd=h.state.calls.find(c=>c.action==='create_order');
 const restart=harness({signal:false,now:h.state.now+120000});restart.state.tables=structuredClone(h.state.tables);
 restart.state.exchange=[];restart.state.software[cmd.order.identifier]=receipt(p,cmd);
 await restart.ctx.runCycle();const once=restart.state.tables.v11_long_regime_positions[0].realized_pnl_usdt;
 restart.advance();await restart.ctx.runCycle();assert.equal(restart.state.tables.v11_long_regime_positions[0].realized_pnl_usdt,once);
 assert.ok(Number.isFinite(once));assert.ok(!restart.state.calls.some(c=>c.action==='create_order'));
});
