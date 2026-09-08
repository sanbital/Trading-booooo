import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {exitAttemptId,classifyExitResponse} from '../../supabase/functions/_shared/leader-exit-review.mjs';
test('patched executor records terminal partial fill, then sends a distinct residual close',async()=>{
 const src=readFileSync(new URL('../../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8');
 const a=src.indexOf('async function closePos('),b=src.indexOf('async function ',a+20);
 const code=src.slice(a,b);
 let p={id:'b9501639-d5b1-4d4d-8478-d432f8f862ca',symbol:'FORMUSDT',remaining_quantity:10,entry_price:100,realized_pnl_usdt:0,metadata:{},peak_price:101};
 let createCount=0,intentCount=0;const submitted=[],savedOrders=[];
 const db={from(table){let patch,operation='';return {
  insert(data){operation='insert';patch=data;return this},update(data){operation='update';patch=data;return this},
  eq(){return this},select(){return this},
  async single(){if(table==='v11_long_regime_orders')return {data:{id:'intent-'+(++intentCount),...patch}};
   if(table==='v11_long_regime_positions'){p={...p,...patch};return {data:p}};throw Error('unexpected table')},
  then(resolve,reject){if(table==='v11_long_regime_orders'&&operation==='update')savedOrders.push(patch);return Promise.resolve({data:null}).then(resolve,reject)}
 }}};
 const ctx={crypto,Date,Number,Math,Error,Promise,exitAttemptId,classifyExitResponse,
  N:(v,d=0)=>Number.isFinite(+v)?+v:d,rec:v=>v??{},floorStep:(q,s)=>Math.floor(q/s)*s,
  active:pf=>pf.positions,sym:x=>x.symbol,
  portfolioMatches:(ps,pf)=>({ok:ps[0].remaining_quantity===pf.positions[0].quantity,reason:'OK'}),
  circuit:async()=>{throw Error('unexpected circuit')},verifyExecutionLease:async()=>{},REVISION:'test',PATCH:'test',
  fill:r=>r,
  gateway:async cmd=>{
   if(cmd.action==='p10_portfolio')return {positions:[{symbol:p.symbol,quantity:p.remaining_quantity}]};
   if(cmd.action==='symbol_info')return {quantity_step:1};
   if(cmd.action==='create_order'){submitted.push(cmd);createCount++;return {qty:createCount===1?4:cmd.order.quantity,avg:99,fee:0,status:createCount===1?'EXPIRED':'FILLED',exchangeOrderId:'exchange-'+createCount};}
   throw Error('unexpected command');
  }};
 vm.createContext(ctx);vm.runInContext(code+'\nthis.runClose=closePos;',ctx);
 const first=await ctx.runClose(db,p,1,'V17_HARD_STOP');
 assert.equal(first.closed,false);assert.equal(p.remaining_quantity,6);assert.equal(savedOrders[0].state,'PARTIALLY_FILLED');
 const second=await ctx.runClose(db,p,1,'V17_HARD_STOP');
 assert.equal(second.closed,true);assert.equal(p.remaining_quantity,0);assert.equal(savedOrders[1].state,'FILLED');
 assert.notEqual(submitted[0].order.identifier,submitted[1].order.identifier);
 assert.equal(submitted[1].order.quantity,6);assert.equal(p.realized_pnl_usdt,-10);
 p={...p,remaining_quantity:10,state:'OPEN',realized_pnl_usdt:0};
 const partialTarget=await ctx.runClose(db,p,.5,'BULL_T1');
 assert.equal(partialTarget.closed,false);assert.equal(p.remaining_quantity,5);
 assert.equal(savedOrders[2].state,'FILLED');assert.equal(p.t1_completed,true);
});
