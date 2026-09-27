import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {protectiveStopSpec} from '../supabase/functions/_shared/leader-exit-review.mjs';
import {createV17StopCommands} from '../gateway/v17-stop-commands.mjs';
import {entryReceipt} from '../supabase/functions/_shared/leader-entry-settlement.mjs';
import {exitReceipt} from '../supabase/functions/_shared/leader-exit-settlement.mjs';
const source=readFileSync(new URL('../gateway/server.mjs',import.meta.url),'utf8');
const symbol='WUSDT',clientAlgoId='tb-v17s-'+'a'.repeat(27);
test('venue existence, product/status and filters remain separate from symbol format',async()=>{
 const ctx={publicBinanceFutures:async()=>({symbols:ctx.rows}),FUTURES_MAX_LEVERAGE:3};vm.createContext(ctx);
 vm.runInContext(source.match(/function validateBinanceSymbol\(symbol\) \{[\s\S]*?\n\}/)[0]+source.match(/async function binanceFuturesExchangeInfo\(symbol\) \{[\s\S]*?\n\}/)[0],ctx);
 ctx.rows=[];await assert.rejects(()=>ctx.binanceFuturesExchangeInfo('NOTLISTEDUSDT'),/not an active perpetual/);
 const listed={symbol,status:'TRADING',contractType:'PERPETUAL',baseAsset:'W',quoteAsset:'USDT',filters:[
  {filterType:'PRICE_FILTER',tickSize:'.000001'},{filterType:'LOT_SIZE',stepSize:'1',minQty:'1',maxQty:'100000'},
  {filterType:'MARKET_LOT_SIZE',maxQty:'10000'},{filterType:'MIN_NOTIONAL',notional:'5'}]};
 ctx.rows=[listed];const info=await ctx.binanceFuturesExchangeInfo(symbol);assert.equal(info.quantity_step,1);assert.equal(info.price_tick,.000001);assert.equal(info.min_notional,5);assert.equal(info.market_max_quantity,10000);
 for(const extra of [{status:'BREAK'},{contractType:'CURRENT_QUARTER'}]){ctx.rows=[{...listed,...extra}];await assert.rejects(()=>ctx.binanceFuturesExchangeInfo(symbol),/not an active perpetual/)}
});
test('W entry receipt, reduceOnly protection creation/query and exit accounting',async()=>{
 const intent={symbol,client_order_id:'entry',requested_quantity:1000};
 const fill={id:1,qty:1000,price:.0137,commission:.01,commissionAsset:'USDT',time:1790478421000};
 const raw={symbol,orderId:'1',clientOrderId:'entry',side:'BUY',reduceOnly:false,positionSide:'BOTH',origQty:'1000',executedQty:'1000',avgPrice:'.0137',status:'FILLED',fills:[fill]};
 const entry=entryReceipt(raw,intent);assert.equal(entry.exact,true);assert.equal(entry.quantity,1000);assert.equal(entry.fee,.01);
 const spec=protectiveStopSpec({symbol,positionId:'p',ownedQuantity:1000,exchangeQuantity:1000,positionMode:'ONE_WAY',stopPrice:.013,priceTick:.000001,quantityStep:1,clientAlgoId});
 const calls=[];const command=createV17StopCommands({assertVersion:()=>{},positionSideDual:async()=>false,request:async(method,path,params)=>{calls.push({method,path,params});return {symbol,clientAlgoId}}});
 await command('v17_create_stop',{params:spec.params});await command('v17_query_stop',{symbol,clientAlgoId});
 assert.equal(calls[0].params.reduceOnly,'true');assert.equal(calls[0].params.symbol,symbol);assert.equal(calls[0].params.side,'SELL');
 const exit=exitReceipt({...raw,clientOrderId:'exit',side:'SELL',reduceOnly:true,fills:[{...fill,side:'SELL'}]}, {...intent,client_order_id:'exit'});
 assert.equal(exit.exact,true);assert.equal(exit.q,1000);assert.equal(exit.fee,.01);
 assert.throws(()=>entryReceipt({...raw,symbol:'TUSDT'},intent),/EVIDENCE_PENDING/);
 assert.throws(()=>exitReceipt({...raw,side:'SELL',reduceOnly:false},intent),/IDENTITY/);
});
