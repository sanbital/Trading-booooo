// Execute the full host at its IO boundary; residual orders require terminal proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,position} from '../v18-ops/harness.mjs';
test('executor records terminal partial execution then closes only the residual with a distinct ID',async()=>{
 const p=position('TESTUSDT',100,1),h=harness({positions:[p],signal:false}),ids=[];
 h.state.createOrder=(cmd,state)=>{ids.push(cmd.order.identifier);const q=ids.length===1?30:70;
  const held=state.exchange[0];held.quantity-=q;state.exchange=state.exchange.filter(x=>x.quantity>0);
  return{order:{orderId:String(ids.length),clientOrderId:cmd.order.identifier,symbol:p.symbol,side:'SELL',positionSide:'BOTH',reduceOnly:true,
   origQty:String(cmd.order.quantity),executedQty:String(q),avgPrice:'.99',status:ids.length===1?'EXPIRED':'FILLED',updateTime:state.now,
   fills:[{id:String(ids.length),qty:String(q),price:'.99',commission:'.01',commissionAsset:'USDT',time:state.now}]}};};
 const partial=await h.ctx.close(p,1,'RISK_CUT');assert.equal(partial.closed,false);assert.equal(partial.position.remaining_quantity,70);
 const final=await h.ctx.close(partial.position,1,'RISK_CUT');assert.equal(final.closed,true);assert.notEqual(ids[0],ids[1]);
 assert.equal(h.state.calls.filter(c=>c.action==='create_order')[1].order.quantity,70);
});
