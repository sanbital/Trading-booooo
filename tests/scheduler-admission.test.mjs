import test from 'node:test';
import assert from 'node:assert/strict';
import {admitSchedulerRequest} from '../supabase/functions/_shared/scheduler-admission.mjs';
test('endpoint admission binds exact target body and strips only scheduler/cursor metadata',async()=>{
  let args;
  const body={mode:'execute-ready-any',scheduler:{key:'production'},recovery_cursor:{last:1},catchup_limit:10};
  const result=await admitSchedulerRequest({endpoint:'v10-lane-executor',body,
    rpc:async(name,p)=>{assert.equal(name,'trading_scheduler_admit');args=p;return{data:'ACCEPTED'};}});
  assert.equal(result.allowed,true);assert.deepEqual(args.p_body,{mode:'execute-ready-any'});
  assert.deepEqual(args.p_envelope,{key:'production'});
});
test('fenced, stale, wrong target and overlapping cron invocation are skipped',async()=>{
  for(const data of ['DUPLICATE_OR_FENCED','STALE_TICK_BLOCKED','TICK_TARGET_MISMATCH','EXTERNAL_SCHEDULER_REQUIRED']) {
    assert.equal((await admitSchedulerRequest({endpoint:'market-v2-signal',body:{},rpc:async()=>({data})})).allowed,false);
  }
});
test('DB admission failure never authorizes an endpoint',async()=>{
  await assert.rejects(admitSchedulerRequest({endpoint:'market-v2-signal',body:{},
    rpc:async()=>({error:{message:'secret-bearing DB body must not escape'}})}),/SCHEDULER_ADMISSION_DB_UNAVAILABLE/);
});
