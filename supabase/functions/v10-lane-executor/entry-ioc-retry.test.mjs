import test from 'node:test';
import assert from 'node:assert/strict';
import {IOC_RETRY_POLICY,planAggressiveIocRetry} from './entry-ioc-retry.mjs';
const q=(asks)=>({best_bid:99.99,best_ask:100,asks});
const validInput=()=>({quote:q([[100.02,10]]),targetQuantity:4.5,filledQuantity:3,
  quantityStep:.1,priceTick:.01,leverage:3,maxTotalMarginUsdt:151.25,currentPositionNotionalUsdt:300});
test('unknown or non-finite position cost cannot bypass the total margin ceiling',()=>{
  for(const cost of ['invalid',NaN,Infinity,-1,0]){
    const p=planAggressiveIocRetry({...validInput(),currentPositionNotionalUsdt:cost});
    assert.deepEqual([p.ok,p.reason],[false,'IOC_RETRY_INPUT_INVALID']);
  }
});
test('non-finite sizing and policy bounds fail closed',()=>{
  for(const key of ['targetQuantity','filledQuantity','quantityStep','priceTick','leverage','maxTotalMarginUsdt']){
    const p=planAggressiveIocRetry({...validInput(),[key]:Infinity});
    assert.deepEqual([p.ok,p.reason],[false,'IOC_RETRY_INPUT_INVALID'],key);
  }
  for(const key of ['maxChaseBps','catastrophicSpreadBps']){
    const p=planAggressiveIocRetry(validInput(),{...IOC_RETRY_POLICY,[key]:NaN});
    assert.deepEqual([p.ok,p.reason],[false,'IOC_RETRY_INPUT_INVALID'],key);
  }
});
test('crossed, unsorted, duplicate or malformed ask depth fails closed',()=>{
  for(const asks of [[[90,10]],[[100.05,1],[100.02,10]],[[100.02,1],[100.02,10]],
    [[100.02,-1],[100.03,10]],[[100.02,'invalid'],[100.03,10]],[[Infinity,10]]]){
    const p=planAggressiveIocRetry({...validInput(),quote:q(asks)});
    assert.deepEqual([p.ok,p.reason],[false,'IOC_RETRY_BOOK_INVALID']);
  }
});
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
