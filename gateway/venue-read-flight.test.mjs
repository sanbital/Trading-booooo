import test from 'node:test';import assert from 'node:assert/strict';import {createInFlightRead}from'./venue-read-flight.mjs';
test('simultaneous exchangeInfo consumers share one original request without a TTL cache or cross-venue mixing',async()=>{
 const read=createInFlightRead();let calls=0;const loader=async()=>{calls++;await new Promise(r=>setImmediate(r));return{symbols:['BTCUSDT','ETHUSDT']};};
 const results=await Promise.all(Array.from({length:10},()=>read('futures',loader)));assert.equal(calls,1);results[0].symbols.pop();assert.equal(results[1].symbols.length,2);
 await read('futures',loader);assert.equal(calls,2);await Promise.all([read('futures',loader),read('spot',loader)]);assert.equal(calls,4);
});
