import test from 'node:test';import assert from 'node:assert/strict';
import {createFastProtectionHost} from './v18-fast-protection-host.mjs';
function timers(){let id=0;const tasks=new Map();return {tasks,setTimeout(fn,ms){tasks.set(++id,{fn,ms});return id;},clearTimeout(id){tasks.delete(id);}};}
test('fast host has no IO before start, never requests an entry, and serializes slow work',async()=>{
 const t=timers();let release,calls=0;const h=createFastProtectionHost({timers:t,invoke:async body=>{calls++;assert.deepEqual(body,{mode:'protect'});return new Promise(r=>release=r);}});
 assert.equal(t.tasks.size,0);h.start();const first=h.tick();await h.tick();assert.equal(calls,1);release({ok:true});await first;assert.equal(h.status().runs,1);h.stop();
});
test('timeouts back off, and stop never invokes exchange cleanup',async()=>{
 const t=timers(),h=createFastProtectionHost({timers:t,invoke:async()=>{throw Error('unavailable');}});h.start();await h.tick();assert.equal(h.status().failures,1);assert.ok([...t.tasks.values()].some(x=>x.ms===4000));h.stop();await h.tick();assert.equal(h.status().failures,1);
});
test('stopping an in-flight pass discards its late success and aborts the request',async()=>{
 const t=timers();let release,signal;const h=createFastProtectionHost({timers:t,invoke:async(_,s)=>{signal=s;return new Promise(r=>release=r);}});h.start();const pending=h.tick();h.stop();assert.equal(signal.aborted,true);release({ok:true});await pending;assert.equal(h.status().lastSuccessAt,null);
});
test('lease contention is not reported as a successful observation',async()=>{
 const h=createFastProtectionHost({timers:timers(),invoke:async()=>({ok:true,skipped:'V17_EXECUTOR_BUSY'})});h.start();await h.tick();assert.equal(h.status().lastSuccessAt,null);h.stop();
});

test('restart during a slow pass waits for its completion and then schedules a fresh observation',async()=>{
 const t=timers();let finish,calls=0;const h=createFastProtectionHost({timers:t,invoke:async()=>{calls++;return new Promise(r=>finish=r);}});
 h.start();const old=h.tick();h.stop();h.start();await h.tick();assert.equal(calls,1);
 finish({ok:true});await old;assert.equal(h.status().lastSuccessAt,null);
 assert.ok([...t.tasks.values()].some(x=>x.ms===0));const fresh=h.tick();assert.equal(calls,2);finish({ok:true});await fresh;assert.equal(h.status().runs,1);h.stop();
});
test('deadline aborts the observer request and recovery uses backoff',async()=>{
 const t=timers();let aborted=false;const h=createFastProtectionHost({timers:t,timeoutMs:1000,invoke:async(_,s)=>new Promise((_,reject)=>s.addEventListener('abort',()=>{aborted=true;reject(Error('ABORT'));}))});
 h.start();const work=h.tick();[...t.tasks.values()].find(x=>x.ms===1000).fn();await work;
 assert.equal(aborted,true);assert.equal(h.status().failures,1);assert.equal(h.status().lastSuccessAt,null);h.stop();
});
