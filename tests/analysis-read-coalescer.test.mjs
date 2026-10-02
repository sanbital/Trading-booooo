import test from 'node:test';import assert from 'node:assert/strict';import {createAnalysisReadCoalescer}from'../supabase/functions/v10-lane-executor/analysis-read-coalescer.mjs';
test('six simultaneous analyses share only one actual account read, never its later cached response',async()=>{
 const read=createAnalysisReadCoalescer();let calls=0,release;const gate=new Promise(r=>release=r),send=async()=>{calls++;await gate;return{observed_at_ms:123,positions:[{qty:1}]};};
 const requests=Array.from({length:6},()=>read({action:'p10_portfolio'},send,{kind:'ANALYSIS'}));await new Promise(r=>setImmediate(r));assert.equal(calls,1);release();const results=await Promise.all(requests);assert.ok(results.every(x=>x.observed_at_ms===123));results[0].positions[0].qty=9;assert.equal(results[1].positions[0].qty,1);
 await read({action:'p10_portfolio'},send,{kind:'ANALYSIS'});assert.equal(calls,2);
});
test('writer latest reads, quotes and all mutations are independent; rejected read never poisons later recovery',async()=>{
 const read=createAnalysisReadCoalescer();let sent=0;const send=async()=>++sent;
 await Promise.all(Array.from({length:3},()=>read({action:'p10_portfolio'},send,{kind:'WRITER'})));assert.equal(sent,3);
 await Promise.all(Array.from({length:3},()=>read({action:'create_order'},send,{kind:'ANALYSIS'})));assert.equal(sent,6);
 await assert.rejects(read({action:'v18_open_orders'},()=>{throw Error('HTTP_503');},{kind:'ANALYSIS'}),/503/);
 assert.equal(await read({action:'v18_open_orders'},send,{kind:'ANALYSIS'}),7);
});
