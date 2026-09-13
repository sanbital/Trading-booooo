// The old polling helper is replaced by durable, cycle-bounded receipt reconciliation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {exitReceipt} from '../../supabase/functions/_shared/leader-exit-settlement.mjs';
const intent={symbol:'MAGMAUSDT',client_order_id:'known',requested_quantity:449};
const raw={orderId:'1474132504',clientOrderId:'known',symbol:'MAGMAUSDT',side:'SELL',positionSide:'BOTH',reduceOnly:true,origQty:'449',executedQty:'449',status:'FILLED',avgPrice:'0',fills:[]};
test('FILLED with no details proves only order quantity, never fabricated fee/price',()=>{
 const r=exitReceipt(raw,intent);assert.equal(r.q,449);assert.equal(r.exact,false);assert.equal(r.fee,null);assert.equal(r.funds,null);
});
test('wrong order identity is rejected even when status says FILLED',()=>{
 assert.throws(()=>exitReceipt({...raw,clientOrderId:'other'},intent),/IDENTITY/);
});
test('duplicate trade IDs cannot produce exact accounting',()=>{
 const t={id:1,qty:224.5,price:.26888,commission:.03,commissionAsset:'USDT',time:1};
 assert.equal(exitReceipt({...raw,fills:[t,t]},intent).exact,false);
});
