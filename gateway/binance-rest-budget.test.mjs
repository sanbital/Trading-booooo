import test from 'node:test';import assert from 'node:assert/strict';
import {createBinanceRestBudget,requestWeight} from './binance-rest-budget.mjs';
test('weighted account-wide reads cannot fit through a count-only 12/s limiter',()=>{
 let t=120000;const b=createBinanceRestBudget({now:()=>t,limit:2400,reserve:300});
 for(let n=0;n<60;n++){const p=b.admit('/fapi/v1/openOrders');b.finish(p);}
 assert.throws(()=>b.admit('/fapi/v1/openOrders'),e=>e.code==='BINANCE_WEIGHT_BUDGET');
 t+=60001;assert.doesNotThrow(()=>b.admit('/fapi/v1/openOrders'));
 assert.equal(requestWeight('/fapi/v1/commissionRate'),20);assert.equal(requestWeight('/fapi/v1/positionSide/dual'),30);
});
test('response weight includes traffic outside this process and leaves risk read headroom',()=>{
 const b=createBinanceRestBudget({now:()=>120000});const p=b.admit('/fapi/v1/depth',{limit:100});
 b.observe(new Response('{}',{headers:{'x-mbx-used-weight-1m':'2110'}}),p);
 assert.throws(()=>b.admit('/fapi/v1/depth',{limit:100}),e=>e.code==='BINANCE_WEIGHT_BUDGET');
 assert.doesNotThrow(()=>b.admit('/fapi/v2/account'));
});
test('429 blocks all subsequent REST until Retry-After; 418 body extends the exact ban',()=>{
 let t=120000;const b=createBinanceRestBudget({now:()=>t});const p=b.admit('/fapi/v2/account');
 b.observe(new Response('{}',{status:429,headers:{'retry-after':'60'}}),p);
 assert.throws(()=>b.admit('/fapi/v1/order',{},'POST'),e=>e.code==='BINANCE_RATE_LIMITED');
 b.banFromBody(Error('IP banned until 1791075179872'));t=1791075179871;
 assert.throws(()=>b.admit('/fapi/v2/account'),e=>e.retryAtMs===1791075179872);
 t++;assert.doesNotThrow(()=>b.admit('/fapi/v2/account'));
});
test('in-flight requests reserve weight before responses and startup retains an existing ban',()=>{
 const b=createBinanceRestBudget({now:()=>120000,limit:100,reserve:0});
 b.admit('/fapi/v1/openOrders');b.admit('/fapi/v1/openOrders');
 assert.throws(()=>b.admit('/fapi/v1/openOrders'));
 const restored=createBinanceRestBudget({now:()=>120000,blockedUntil:180000});
 assert.throws(()=>restored.admit('/fapi/v2/account'),e=>e.code==='STARTUP_EXCHANGE_COOLDOWN');
 assert.equal(restored.snapshot().endpoints['/fapi/v2/account'],undefined);
});
