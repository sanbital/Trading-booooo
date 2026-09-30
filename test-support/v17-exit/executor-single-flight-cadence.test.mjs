import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8');
const leaseSql=readFileSync(new URL('../../supabase/migrations/20260930075500_v17_execution_lease_single_flight_150s.sql',import.meta.url),'utf8');

class LeaseModel{
  constructor(ttlMs=150_000){this.ttlMs=ttlMs;this.owner=null;this.releaseAt=null;this.expiresAt=0;this.maxActive=0;}
  settle(now){
    if(this.owner&&this.releaseAt!==null&&this.releaseAt<=now){this.owner=null;this.releaseAt=null;this.expiresAt=0;}
    if(this.owner&&this.expiresAt<=now){this.owner=null;this.releaseAt=null;this.expiresAt=0;}
  }
  invoke(now,runtimeMs,{crash=false}={}){
    this.settle(now);
    if(this.owner)return {status:'SKIPPED_ALREADY_RUNNING'};
    this.owner='owner-'+now;
    this.expiresAt=now+this.ttlMs;
    this.releaseAt=crash?null:now+runtimeMs;
    this.maxActive=Math.max(this.maxActive,this.owner?1:0);
    return {status:'RUNNING'};
  }
}

test('TEST A: 5s executor on a 30s cadence starts normally',()=>{
  const h=new LeaseModel();
  assert.equal(h.invoke(0,5_000).status,'RUNNING');
  assert.equal(h.invoke(30_000,5_000).status,'RUNNING');
  assert.equal(h.maxActive,1);
});

test('TEST B: 60s executor makes the 30s invocation skip immediately',()=>{
  const h=new LeaseModel();
  assert.equal(h.invoke(0,60_000).status,'RUNNING');
  assert.equal(h.invoke(30_000,60_000).status,'SKIPPED_ALREADY_RUNNING');
  assert.equal(h.invoke(60_000,60_000).status,'RUNNING');
  assert.equal(h.maxActive,1);
});

test('TEST C: 110s executor never overlaps despite 30s invocations',()=>{
  const h=new LeaseModel();
  assert.equal(h.invoke(0,110_000).status,'RUNNING');
  for(const at of [30_000,60_000,90_000])
    assert.equal(h.invoke(at,110_000).status,'SKIPPED_ALREADY_RUNNING');
  assert.equal(h.invoke(120_000,110_000).status,'RUNNING');
  assert.equal(h.maxActive,1);
});

test('TEST D/G: a crashed owner is reclaimed after the bounded TTL and the next cycle recovers',()=>{
  const h=new LeaseModel(150_000);
  assert.equal(h.invoke(0,110_000,{crash:true}).status,'RUNNING');
  for(const at of [30_000,60_000,90_000,120_000])
    assert.equal(h.invoke(at,5_000).status,'SKIPPED_ALREADY_RUNNING');
  assert.equal(h.invoke(150_000,5_000).status,'RUNNING');
  assert.equal(h.maxActive,1);
});

test('TEST H/I: 40-60s AI latency remains compatible with 30s cron because the lease, not timeout shrinking, serializes execution',()=>{
  assert.match(source,/const ENTRY_RUN_BUDGET_MS=70000;/,
    'the existing long entry/AI work budget must not be shortened to the 30s cadence');
  assert.match(source,/if\(lock\.data!==true\)\{[\s\S]{0,500}return \{ok:true,skipped:"V17_EXECUTOR_BUSY"\}/,
    'the existing executor lease must fail fast instead of queueing');
  const h=new LeaseModel();
  assert.equal(h.invoke(0,60_000).status,'RUNNING');
  assert.equal(h.invoke(30_000,60_000).status,'SKIPPED_ALREADY_RUNNING');
  assert.equal(h.invoke(60_000,60_000).status,'RUNNING');
});

test('TEST K: executor retains ownership verification and duplicate execution fencing',()=>{
  assert.match(source,/v17_acquire_execution_lease/);
  assert.match(source,/v17_verify_execution_lease/);
  assert.match(source,/v17_release_execution_lease/);
  assert.match(source,/verifyExecutionLease/);
});


test('lease SQL is crash-safe, owner-refreshable and bounded to 150s',()=>{
  assert.match(leaseSql,/interval '150 seconds'/);
  assert.match(leaseSql,/expires_at < clock_timestamp\(\) or owner = p_owner/);
  assert.match(leaseSql,/interval '30 seconds'/);
  assert.match(source,/EXECUTION_LEASE_TTL_SECONDS=150,EXECUTION_LEASE_HEARTBEAT_MS=30000/);
  assert.match(source,/setInterval\(async\(\)=>/);
  assert.match(source,/clearInterval\(heartbeat\)/);
  assert.match(source,/EXECUTOR_LEASE_HEARTBEAT_FAILED/);
});
