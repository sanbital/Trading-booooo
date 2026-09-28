import test from 'node:test';
import assert from 'node:assert/strict';
import {nmrClockFinal} from '../test-support/nmr-clock-final.mjs';
import {clockReviewDiagnostics} from '../supabase/functions/v10-lane-executor/gpt-final-review-adapter.mjs';

test('durably validated clock BUY wakes before unrelated reads or slow lifecycle callback',async()=>{
 const f=await nmrClockFinal(),c=f.c,[key,tracked]=[...c.tracked][0],get=c.store.get.bind(c.store),scheduled=[];
 c.tracked=new Map([['unrelated',{...tracked,s:{...f.s,id:'other'}}],[key,tracked]]);
 c.readyHints.set(key,{signalId:f.s.id,validUntil:f.ticket.validUntil,clock:true});
 c.tickets.clear();c.store.get=async k=>{assert.notEqual(k,'unrelated');return get(k);};
 let finish;const slow=new Promise(resolve=>{finish=resolve;});
 c.onResolved=async()=>slow;c.schedule=p=>scheduled.push(p);
 assert.equal(await c.waitReady(),true);assert.equal(c.check(f.s).allowed,true);
 assert.equal(c.clockWakeAt.get(f.s.id),f.now());assert.equal(scheduled.length,1);
 finish();await Promise.all(scheduled);
});

test('clock wake hints never admit a tampered durable BUY',async()=>{
 const f=await nmrClockFinal(),c=f.c,key=[...c.tracked.keys()][0];
 c.readyHints.set(key,{signalId:f.s.id,validUntil:f.ticket.validUntil,clock:true});
 [...f.store.rows.values()][0].record.packet.snapshot_hash='tampered';c.tickets.clear();
 assert.equal(await c.waitReady(),false);assert.equal(c.check(f.s).allowed,false);
 assert.equal(c.clockWakeAt.has(f.s.id),false);
});

test('non-BUY diagnostics stay attached to request but do not block a clock BUY candidate',async()=>{
 const f=await nmrClockFinal(),scheduled=[];f.c.schedule=p=>scheduled.push(p);
 let finish,done=false;const blocked=new Promise(resolve=>{finish=resolve;});
 await clockReviewDiagnostics(f.db,{candidates:[f.s]},async()=>{await blocked;done=true;});
 assert.equal(done,false);assert.equal(scheduled.length,1);finish();await Promise.all(scheduled);assert.equal(done,true);
});
