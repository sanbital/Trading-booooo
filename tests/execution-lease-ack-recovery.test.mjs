import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const src=fs.readFileSync(new URL('../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8');
const body=src.slice(src.indexOf('async function runWithLease('),src.indexOf('Deno.serve(async req=>'));
function harness({lost=false,throws=false,competing=false,cleanupFailures=0}={}){
 let held=competing?'another-owner':null,owner,operations=0,releases=0;const errors=[];
 const db={rpc:async(name,args)=>{
  if(name==='v17_acquire_execution_lease'){
   owner=args.p_owner;if(!competing)held=owner;
   if(throws)throw Error('timeout');
   if(lost)return {error:{message:'request aborted'}};
   return {data:!competing};
  }
  assert.equal(name,'v17_release_execution_lease');assert.equal(args.p_owner,owner);releases++;
  if(releases<=cleanupFailures)return {error:{code:'55P03'}};
  const same=held===args.p_owner;if(same)held=null;return {data:same};
 }};
 const leaseOwners=new WeakMap(),cycleBudgets=new WeakMap();
 const run=async()=>{operations++;return {ok:true};};
 const fn=new Function('run','leaseOwners','cycleBudgets','createBudget','console','EXECUTION_LEASE_TTL_SECONDS',body+';return runWithLease;')
  (run,leaseOwners,cycleBudgets,()=>({remaining:()=>1}),{error:e=>errors.push(e),log:()=>{}},150);
 return {db,fn,stats:()=>({held,operations,releases,errors,tracked:leaseOwners.has(db),budget:cycleBudgets.has(db)})};
}
for(const throws of [false,true])test(`uncertain ${throws?'thrown':'returned'} acquisition releases its own unstarted lease`,async()=>{
 const h=harness({lost:true,throws});await assert.rejects(h.fn(h.db),/V17_LEASE_UNAVAILABLE/);
 assert.deepEqual(h.stats(),{held:null,operations:0,releases:1,errors:[],tracked:false,budget:false});
});
test('uncertain acquisition cannot release a competing owner',async()=>{
 const h=harness({lost:true,competing:true});await assert.rejects(h.fn(h.db),/V17_LEASE_UNAVAILABLE/);
 assert.equal(h.stats().held,'another-owner');assert.equal(h.stats().operations,0);
});
test('cleanup retries are bounded and unresolved cleanup stays explicit',async()=>{
 const h=harness({lost:true,cleanupFailures:3});await assert.rejects(h.fn(h.db),/V17_LEASE_UNAVAILABLE/);
 assert.equal(h.stats().releases,3);assert.equal(h.stats().operations,0);
 assert.deepEqual(h.stats().errors,['V17_UNCERTAIN_LEASE_CLEANUP_FAILED']);assert.ok(h.stats().held);
});
test('a successful retry releases once and never runs the failed operation',async()=>{
 const h=harness({lost:true,cleanupFailures:1});await assert.rejects(h.fn(h.db),/V17_LEASE_UNAVAILABLE/);
 assert.equal(h.stats().releases,2);assert.equal(h.stats().held,null);assert.equal(h.stats().operations,0);
});
test('acknowledged lease runs once and still releases through finally',async()=>{
 const h=harness();assert.deepEqual(await h.fn(h.db),{ok:true});
 assert.deepEqual(h.stats(),{held:null,operations:1,releases:1,errors:[],tracked:false,budget:false});
});
test('ordinary busy lease has no cleanup or execution',async()=>{
 const h=harness({competing:true});assert.equal((await h.fn(h.db)).skipped,'V17_EXECUTOR_BUSY');
 assert.equal(h.stats().operations,0);assert.equal(h.stats().releases,0);assert.equal(h.stats().held,'another-owner');
});
