import test from 'node:test';
import assert from 'node:assert/strict';
import {createV17StopCommands} from '../../gateway/v17-stop-commands.mjs';
const clientAlgoId='tb-v17s-'+'a'.repeat(27),symbol='FORMUSDT';
test('cancel cannot touch an unbound symbol or a manual client ID',async()=>{
 const calls=[];const handle=createV17StopCommands({assertVersion:()=>{},positionSideDual:async()=>false,
  request:async(m,p,q)=>{calls.push(m);return {symbol:'MAGMAUSDT',clientAlgoId}}});
 await assert.rejects(()=>handle('v17_cancel_stop',{symbol,clientAlgoId}),/IDENTITY_MISMATCH/);
 await assert.rejects(()=>handle('v17_cancel_stop',{symbol,clientAlgoId:'manual'}),/INVALID/);
 assert.deepEqual(calls,['GET']);
});
test('fill accounting requires complete exchange trades, with actual fees',async()=>{
 let qty='2';const handle=createV17StopCommands({assertVersion:()=>{},positionSideDual:async()=>false,
  request:async(m,p)=>p.endsWith('algoOrder')?{symbol,clientAlgoId,actualOrderId:1}:p.endsWith('/order')?
   {executedQty:'2',cumQuote:'194',status:'FILLED'}:[{id:1,orderId:1,symbol,side:'SELL',qty,price:'97',commission:'.097',commissionAsset:'USDT',time:100}]});
 assert.equal((await handle('v17_stop_fill',{symbol,clientAlgoId,actualOrderId:1})).exact,true);
 qty='1';assert.equal((await handle('v17_stop_fill',{symbol,clientAlgoId,actualOrderId:1})).exact,false);
});
test('create rejects hedge mode and buy or close-all orders without dispatch',async()=>{
 let sends=0;const handle=createV17StopCommands({assertVersion:()=>{},positionSideDual:async()=>false,request:async()=>{sends++}});
 await assert.rejects(()=>handle('v17_create_stop',{params:{symbol,clientAlgoId,side:'BUY'}}),/SPEC_INVALID/);
 assert.equal(sends,0);
});
