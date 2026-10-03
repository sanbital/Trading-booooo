import test from 'node:test';import assert from 'node:assert/strict';
import {validateReadCommand} from '../ops/deterministic/preflight-read.mjs';
import {quoteIntegrity,settledBalanceProof,executionIdentity,nativeAckMatches} from '../ops/deterministic/runtime-proof-read.mjs';
test('runtime evidence accepts only exact read-only command schemas',()=>{
 for(const command of [{action:'quote',market:'QUSDT'},{action:'v17_query_stop',symbol:'QUSDT',clientAlgoId:'tb-v17s-'+'a'.repeat(27)},{action:'trade_history',market:'QUSDT',limit:1000}])assert.doesNotThrow(()=>validateReadCommand(command));
 for(const command of [{action:'v17_create_stop'},{action:'quote',market:'QUSDT',quantity:1},{action:'v17_query_stop',symbol:'QUSDT',clientAlgoId:'foreign'},{action:'p10_portfolio',market:'QUSDT'},{action:'trade_history',market:'QUSDT',limit:2000}])assert.throws(()=>validateReadCommand(command));
});
test('signed quote evidence distinguishes mixed REST tops and finite depth',()=>{
 const now=Date.now(),quote={best_bid:100,best_ask:100.01,bids:[[100,20],[99.9,20]],asks:[[100.01,20],[100.1,20]],timing:{requested_at_ms:now-30,received_at_ms:now-10}};
 assert(quoteIntegrity(quote,now).health.bookHealthy);assert.equal(quoteIntegrity(quote,now).bid_25bp_covered,false);
 const mismatch=quoteIntegrity({...quote,best_bid:99.99},now);assert.equal(mismatch.health.bookHealthy,false);assert(mismatch.health.reasons.includes('BID_TOP_MISMATCH'));
});
test('held-position wallet proof does not equate mark-price equity with settled cash',()=>{
 const now=Date.now(),snapshot={captured_at:new Date(now-1000).toISOString(),positions_complete:true,balances:[{currency:'USDT',balance:80,locked:150}]};
 assert.equal(settledBalanceProof(snapshot,{settled_quote:230,total_equity_quote:235,available_quote:85},now).matched,true);
 assert.equal(settledBalanceProof(snapshot,{settled_quote:229.5},now).matched,false);assert.equal(settledBalanceProof({...snapshot,positions_complete:false},{settled_quote:230},now).matched,false);
 assert.equal(settledBalanceProof({...snapshot,captured_at:new Date(now-121000).toISOString()},{settled_quote:230},now).matched,false);
});
test('economic and protection identity blocks a quantity/stop/restart race, allows telemetry updates',()=>{
 const a={postmaster:'one',positions:[{id:'p',state:'OPEN',symbol:'QUSDT',side:'LONG',remaining_quantity:5,metadata:{last_eval:1,exitProtection:{orders:[]}}}],orders:[]};
 const b=structuredClone(a);b.positions[0].metadata.last_eval=2;assert.equal(executionIdentity(a),executionIdentity(b));
 b.positions[0].remaining_quantity=4;assert.notEqual(executionIdentity(a),executionIdentity(b));b.positions[0].remaining_quantity=5;b.postmaster='two';assert.notEqual(executionIdentity(a),executionIdentity(b));
});
test('native history requires venue identity, exact requested quantity and preserved hard floor',()=>{
 const p={symbol:'QUSDT',entry_price:100},o={clientId:'stop',algoId:123,spec:{params:{quantity:5,triggerPrice:97.5}}},ack={clientAlgoId:'stop',algoId:123,symbol:'QUSDT',side:'SELL',positionSide:'BOTH',reduceOnly:true,orderType:'STOP_MARKET',algoStatus:'CANCELED',quantity:5,triggerPrice:97.5};
 assert(nativeAckMatches(p,o,ack));for(const patch of [{quantity:4},{reduceOnly:false},{triggerPrice:97},{symbol:'OTHERUSDT'},{algoStatus:'REJECTED'}])assert.equal(nativeAckMatches(p,o,{...ack,...patch}),false);
});
