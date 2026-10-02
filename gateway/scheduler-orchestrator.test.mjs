import test from 'node:test';
import assert from 'node:assert/strict';
import {createSchedulerOrchestrator,dependencyFailure,retryDelayMs} from './scheduler-orchestrator.mjs';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({runJob=async()=>({ok:true}),recover=async()=>true,jobs,onEvent}={}) {
  let current=0,dbDown=false;
  const calls=[],seen=new Set(),timeouts=new Map();let timerId=0;
  const repository={
    lead:async(key,owner)=>{if(dbDown)throw Error('ECONNREFUSED');return{scheduler_key:key,owner,fence:1};},
    heartbeat:async()=>{if(dbDown)throw Error('ECONNRESET');return true;},
    jobs:async()=>jobs??[{job_key:'new-signal',enabled:true,period_ms:5000,timeout_ms:1000,
      requires_recovery:true,recovery_mode:'CURRENT_ONLY'}],
    claim:async(l,id)=>{
      const tick=Math.floor(current/5000),key=`${id}:${tick}`;
      if(seen.has(key))return null;seen.add(key);calls.push(key);
      return{job_key:id,tick,idempotency_key:key,...l};
    },
    finish:async(l,claim,result)=>{calls.push(`${claim.job_key}:${result.state}:${result.result}`);return true;},
  };
  let retryAt=0,failures=0;
  const breaker={suppressed:n=>n<retryAt,open:n=>{failures++;retryAt=n+retryDelayMs(failures,{random:()=>1});},
    clear:()=>{failures=0;retryAt=0;}};
  const timers={setInterval:()=>0,clearInterval:()=>{},setTimeout:fn=>{timeouts.set(++timerId,fn);return timerId;},
    clearTimeout:id=>timeouts.delete(id)};
  const scheduler=createSchedulerOrchestrator({repository,runJob,recover,breaker,now:()=>current,timers,random:()=>1,onEvent});
  scheduler.start();
  const tick=async()=>{await scheduler.tick();await flush();await flush();};
  return{scheduler,calls,seen,timeouts,tick,advance:ms=>{current+=ms;},db:(down)=>{dbDown=down;},repository};
}
test('connection refused/reset, DNS, DB timeout and 502/503/504 are retryable; permanent 4xx are not',()=>{
  for(const message of ['ECONNREFUSED','ECONNRESET','EAI_AGAIN','ENOTFOUND','DNS timeout','DB timeout','fetch failed']) {
    assert.equal(dependencyFailure(Error(message)).retryable,true,message);
  }
  for(const status of [502,503,504])assert.equal(dependencyFailure({status}).retryable,true);
  for(const status of [400,401,403,404])assert.equal(dependencyFailure({status}).permanent,true);
  assert.equal(dependencyFailure({status:429}).retryable,true);
  for(const failures of [1,2,50])for(const random of [()=>0,()=>1]) {
    const delay=retryDelayMs(failures,{random});assert.ok(delay>=15000&&delay<=60000);
  }
});
test('duplicate ticks and scheduler clock changes never replay historical ticks',async()=>{
  let runs=0;const f=fixture({runJob:async()=>{runs++;return{};}});
  await f.tick();await f.tick();assert.equal(runs,1);
  f.advance(180000);await f.tick();assert.equal(runs,2);
  assert.ok(f.calls.includes('new-signal:36'));assert.equal(f.seen.size,2);
  f.advance(-120000);await f.tick();assert.equal(runs,2);
  await f.scheduler.stop();
});
test('DB unavailable for 1-3 minutes keeps process heartbeat, suppresses new entries, then recovers',async()=>{
  for(const outage of [60000,120000,180000]) {
    let runs=0;const f=fixture({runJob:async()=>{runs++;return{};}});f.db(true);
    await f.tick();assert.equal(runs,0);assert.ok(f.scheduler.state.processHeartbeatAt);
    f.advance(outage);await f.tick();assert.equal(runs,0);
    f.db(false);f.advance(60000);await f.tick();await f.tick();assert.equal(runs,1);
    assert.equal(f.scheduler.state.leader,true);await f.scheduler.stop();
  }
});
test('slow recovery does not block leader heartbeat; entry remains frozen until complete',async()=>{
  let finish,runs=0;const f=fixture({recover:()=>new Promise(resolve=>{finish=resolve;}),
    runJob:async()=>{runs++;return{};}});
  let heartbeats=0;f.repository.heartbeat=async()=>{heartbeats++;return true;};
  await f.tick();assert.equal(runs,0);
  f.advance(4000);await f.tick();assert.equal(heartbeats,1);assert.equal(runs,0);
  finish(true);await flush();await f.tick();assert.equal(runs,1);
  await f.scheduler.stop();
});
test('one 5xx job leaves other jobs operational; job timeout retains its own bulkhead',async()=>{
  const jobs=['hung','good','failure'].map(job_key=>({job_key,enabled:true,period_ms:5000,timeout_ms:1000,requires_recovery:false}));
  let finish,good=0,hung=0;
  const f=fixture({jobs,runJob:async job=>{
    if(job.job_key==='hung'){hung++;return new Promise(resolve=>{finish=resolve;});}
    if(job.job_key==='failure')throw Object.assign(Error('edge unavailable'),{status:503});
    good++;return{};
  }});
  await f.tick();assert.equal(good,1);assert.equal(hung,1);
  for(const timeout of [...f.timeouts.values()])timeout();await flush();
  f.advance(5000);await f.tick();assert.equal(good,2);assert.equal(hung,1);
  assert.ok(f.scheduler.activeJobs().includes('hung'));
  finish({});await flush();await f.scheduler.stop();
});
test('permanent 4xx requests are marked for durable job disablement',async()=>{
  const f=fixture({runJob:async()=>{throw Object.assign(Error('bad request'),{status:400});}});
  let permanent;
  f.repository.finish=async(l,c,r)=>{permanent=r.permanent;return true;};
  await f.tick();await f.tick();assert.equal(permanent,true);await f.scheduler.stop();
});
test('HTTP 200 with failed endpoint outcome never advances the success clock or cursor',async()=>{
  const f=fixture({runJob:async()=>({ok:false,error:'DB_TIMEOUT',cursor:'UNCOMMITTED'})});
  let finished;
  f.repository.finish=async(l,c,r)=>{finished=r;return true;};
  await f.tick();await f.tick();assert.equal(finished.state,'FAILED');assert.equal(finished.cursor,undefined);
  assert.equal(f.scheduler.state.jobs['new-signal'].lastSuccess,undefined);
  await f.scheduler.stop();
});
for(const [name,onEvent]of [['throw',()=>{throw Error('telemetry sink unavailable');}],
  ['reject',async()=>{throw Error('telemetry sink unavailable');}]]) {
  test(`telemetry ${name} cannot kill jobs or the scheduler process`,async()=>{
    let runs=0;
    const f=fixture({onEvent,runJob:async()=>{runs++;return{ok:true};}});
    await f.tick();await f.tick();assert.equal(runs,1);
    assert.equal(f.scheduler.state.jobs['new-signal'].result,'SUCCEEDED');
    assert.equal(f.scheduler.activeJobs().length,0);
    f.advance(5000);await f.tick();assert.equal(runs,2);
    await f.scheduler.stop();
  });
}

test('incomplete recovery backs off independently of successful leader heartbeats',async()=>{
  let attempts=0,runs=0,ready=false;
  const f=fixture({recover:async()=>{attempts++;return ready;},runJob:async()=>{runs++;return{};}});
  await f.tick();assert.equal(attempts,1);assert.equal(runs,0);
  for(let i=0;i<9;i++){f.advance(3000);await f.tick();}
  assert.equal(attempts,1);assert.equal(f.scheduler.state.leader,true);
  assert.equal(f.scheduler.state.recovery.result,'RECOVERY_INCOMPLETE');
  assert.equal(f.scheduler.state.recovery.failures,1);
  ready=true;f.advance(3000);await f.tick();await f.tick();
  assert.equal(attempts,2);assert.equal(runs,1);
  assert.equal(f.scheduler.state.recovery.result,'SUCCEEDED');
  await f.scheduler.stop();
});
test('permanent recovery 4xx freezes entries without repeating the failed request',async()=>{
  let attempts=0,runs=0;
  const f=fixture({recover:async()=>{attempts++;throw Object.assign(Error('unauthorized'),{status:401});},
    runJob:async()=>{runs++;return{};}});
  await f.tick();f.advance(180000);await f.tick();await f.tick();
  assert.equal(attempts,1);assert.equal(runs,0);
  assert.equal(f.scheduler.state.recovery.permanent,true);
  assert.equal(f.scheduler.state.recovery.result,'HTTP_401');
  assert.equal(f.scheduler.state.leader,true);
  await f.scheduler.stop();
});
test('recovery timeout retains its bulkhead while maintenance and heartbeats continue',async()=>{
  let finish,attempts=0,maintenance=0,entry=0,aborted;
  const jobs=[{job_key:'maintenance',enabled:true,period_ms:5000,timeout_ms:1000,requires_recovery:false},
    {job_key:'entry',enabled:true,period_ms:5000,timeout_ms:1000,requires_recovery:true}];
  const f=fixture({jobs,recover:(_,{signal})=>{attempts++;aborted=signal;return new Promise(resolve=>{finish=resolve;});},
    runJob:async j=>{if(j.job_key==='entry')entry++;else maintenance++;return{};}});
  await f.tick();assert.equal(attempts,1);assert.equal(maintenance,1);assert.equal(entry,0);
  for(const timeout of [...f.timeouts.values()])timeout();await flush();await flush();
  assert.equal(aborted.aborted,true);assert.equal(f.scheduler.state.recovery.result,'DEPENDENCY_UNAVAILABLE');
  f.advance(60000);await f.tick();assert.equal(attempts,1);assert.equal(maintenance,2);assert.equal(entry,0);
  assert.equal(f.scheduler.state.leader,true);
  finish(true);await flush();await flush();f.advance(3000);await f.tick();
  assert.equal(attempts,2);assert.equal(entry,0);
  await f.scheduler.stop();finish(false);await flush();
});
