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
  // The depth-required level (100.05) is the floor; the retry uplift raises the cap to
  // ask+8 bps. The expected VWAP is still the book's, not the cap.
  assert.equal(p.depthLimitPrice,100.05);assert.equal(p.limitPrice,100.08);assert.equal(p.upliftBps,8);
  assert.ok(p.expectedVwap>=100.02&&p.expectedVwap<=100.05);
});
test('the retry uplift never crosses the chase bound, even after tick rounding',()=>{
  // tick 0.05 on a 100 ask: ask+8 bps rounds up to 100.10 (10 bps), still inside 12.
  let p=planAggressiveIocRetry({quote:q([[100.05,10]]),targetQuantity:1,filledQuantity:0,quantityStep:.1,priceTick:.05,
    minNotionalUsdt:5,minQuantity:.1,leverage:3,maxTotalMarginUsdt:151.25,currentPositionNotionalUsdt:0});
  assert.equal(p.ok,true);assert.equal(p.limitPrice,100.1);assert.ok(p.chaseBps<=IOC_RETRY_POLICY.maxChaseBps);
  // tick 0.1: ask+8 bps would round to 100.10, ask+12 bps floors to 100.10 -> kept at the bound.
  p=planAggressiveIocRetry({quote:q([[100.1,10]]),targetQuantity:1,filledQuantity:0,quantityStep:.1,priceTick:.1,
    minNotionalUsdt:5,minQuantity:.1,leverage:3,maxTotalMarginUsdt:151.25,currentPositionNotionalUsdt:0});
  assert.equal(p.ok,true);assert.ok(p.chaseBps<=IOC_RETRY_POLICY.maxChaseBps+1e-9);
  // An uplift policy above the chase bound is invalid input, not a wider chase.
  p=planAggressiveIocRetry(validInput(),{...IOC_RETRY_POLICY,retryUpliftBps:20});
  assert.deepEqual([p.ok,p.reason],[false,'IOC_RETRY_INPUT_INVALID']);
});
test('a remainder one lot over the ceiling at the retry limit is cut to fit, never over',()=>{
  // 4.5 lots at a 100.08 cap = 450.36 notional = 150.12 margin > 150: cut to 4.4 lots.
  const p=planAggressiveIocRetry({quote:q([[100,10]]),targetQuantity:4.5,filledQuantity:0,quantityStep:.1,priceTick:.01,
    minNotionalUsdt:5,minQuantity:.1,leverage:3,maxTotalMarginUsdt:150,currentPositionNotionalUsdt:0});
  assert.equal(p.ok,true);assert.equal(p.budgetShrunk,true);assert.equal(p.requestedRemainingQuantity,4.5);
  assert.equal(p.remainingQuantity,4.4);assert.ok(p.totalWorstMargin<=150+1e-9);
  // The same cut after a partial fill counts the filled notional first.
  const q2=planAggressiveIocRetry({quote:q([[100,10]]),targetQuantity:4.5,filledQuantity:3,quantityStep:.1,priceTick:.01,
    minNotionalUsdt:5,minQuantity:.1,leverage:3,maxTotalMarginUsdt:150,currentPositionNotionalUsdt:300.3});
  assert.equal(q2.ok,true);assert.ok(q2.totalWorstMargin<=150+1e-9);assert.ok(q2.remainingQuantity<1.5);
  // Below the exchange minimum after the cut: refused, not placed.
  const q3=planAggressiveIocRetry({quote:q([[100,10]]),targetQuantity:4.5,filledQuantity:0,quantityStep:.1,priceTick:.01,
    minNotionalUsdt:445,minQuantity:.1,leverage:3,maxTotalMarginUsdt:150,currentPositionNotionalUsdt:0});
  assert.deepEqual([q3.ok,q3.reason],[false,'IOC_RETRY_MARGIN_BOUND']);
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
