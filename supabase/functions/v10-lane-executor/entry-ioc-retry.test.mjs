import test from 'node:test';
import assert from 'node:assert/strict';
import {IOC_RETRY_POLICY,planAggressiveIocRetry} from './entry-ioc-retry.mjs';
const q=(asks)=>({best_bid:99.99,best_ask:100,asks});
test('retry buys only the remaining target and prices from fresh depth',()=>{
  const p=planAggressiveIocRetry({quote:q([[100.02,1],[100.05,2],[100.08,3]]),targetQuantity:4.5,filledQuantity:3,
    quantityStep:.1,priceTick:.01,minNotionalUsdt:5,minQuantity:.1,leverage:3,maxTotalMarginUsdt:151.25,currentPositionNotionalUsdt:300});
  assert.equal(p.ok,true);assert.equal(p.complete,false);assert.equal(p.remainingQuantity,1.5);
  assert.equal(p.limitPrice,100.05);assert.ok(p.expectedVwap>=100.02&&p.expectedVwap<=100.05);
});
test('retry is bounded and never chases beyond 12 bps',()=>{
  const p=planAggressiveIocRetry({quote:q([[100.02,.2],[100.20,2]]),targetQuantity:2,filledQuantity:0,
    quantityStep:.1,priceTick:.01,minNotionalUsdt:5,minQuantity:.1,leverage:3,maxTotalMarginUsdt:151.25,currentPositionNotionalUsdt:0});
  assert.equal(p.ok,false);assert.equal(p.reason,'IOC_RETRY_CHASE_BOUND');assert.equal(IOC_RETRY_POLICY.maxAttempts,2);
});
test('insufficient depth fails closed',()=>{
  const p=planAggressiveIocRetry({quote:q([[100.02,.2]]),targetQuantity:2,filledQuantity:0,
    quantityStep:.1,priceTick:.01,minNotionalUsdt:5,minQuantity:.1,leverage:3,maxTotalMarginUsdt:151.25,currentPositionNotionalUsdt:0});
  assert.deepEqual([p.ok,p.reason],[false,'IOC_RETRY_INSUFFICIENT_LIQUIDITY']);
});
test('remainder below exchange minimum ends safely instead of oversizing',()=>{
  const p=planAggressiveIocRetry({quote:q([[100.02,10]]),targetQuantity:4.5,filledQuantity:4.49,
    quantityStep:.01,priceTick:.01,minNotionalUsdt:5,minQuantity:.01,leverage:3,maxTotalMarginUsdt:151.25,currentPositionNotionalUsdt:449});
  assert.equal(p.ok,true);assert.equal(p.complete,true);assert.equal(p.underExchangeMinimum,true);
});
test('total position margin remains bounded after a partial fill',()=>{
  const p=planAggressiveIocRetry({quote:q([[100.02,10]]),targetQuantity:4.5,filledQuantity:3,
    quantityStep:.1,priceTick:.01,minNotionalUsdt:5,minQuantity:.1,leverage:3,maxTotalMarginUsdt:100,currentPositionNotionalUsdt:300});
  assert.deepEqual([p.ok,p.reason],[false,'IOC_RETRY_MARGIN_BOUND']);
});
