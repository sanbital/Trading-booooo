import assert from 'node:assert/strict';
import test from 'node:test';
import {createClient} from '@supabase/supabase-js';
import {createHostAccountScopes} from '../../supabase/functions/v10-lane-executor/account-host-scopes.mjs';
import {currentExecutionContext,executionContextHeaders} from '../../supabase/functions/v10-lane-executor/account-scope-context.mjs';

const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
const unavailable=()=>json({code:'57014',message:'DB unavailable'},503);
function harness({releases=[()=>json(true)],acquire,heartbeat=()=>json(true),onEvent,realBackoff=false}={}){
 const requests=[],events=[],delays=[];let heartbeatCallback,cleared=false,releaseIndex=0,db;
 const timers={setInterval(callback){heartbeatCallback=callback;return {unref(){}};},
  clearInterval(){cleared=true;},setTimeout(callback,ms){delays.push(ms);return setTimeout(callback,realBackoff?ms:0);}};
 db=createClient('https://lease-test.invalid','test-service-key',{auth:{persistSession:false,autoRefreshToken:false},global:{
  fetch:async(input,init)=>{
   const name=new URL(String(input)).pathname.split('/').at(-1),args=JSON.parse(init.body);
   const request={name,args,signal:init.signal,context:currentExecutionContext(db)?.kind,headers:executionContextHeaders(db)};
   requests.push(request);
   if(name==='v17_acquire_analysis_lease')return acquire?acquire(request):json({owner:args.p_owner,fence:42});
   if(name==='v17_release_analysis_lease')return releases[Math.min(releaseIndex++,releases.length-1)](request);
   if(name==='v17_heartbeat_analysis_lease')return heartbeat(request);
   throw Error('UNEXPECTED_RPC:'+name);
  }
 }});
 const scopes=createHostAccountScopes(db,{timers,onEvent:event=>{events.push(event);return onEvent?.(event);}});
 return {db,scopes,requests,events,delays,heartbeat:()=>heartbeatCallback(),cleared:()=>cleared,
  releaseRequests:()=>requests.filter(r=>r.name==='v17_release_analysis_lease')};
}
function assertScopedCleanup(h){
 const owner=h.requests[0].args.p_owner;
 for(const r of h.releaseRequests()){
  assert.equal(r.args.p_owner,owner);assert.equal(r.context,'CLEANUP');assert.deepEqual(r.headers,{});
  assert.ok(r.signal instanceof AbortSignal);
 }
}

test('a completed analysis remains successful during a DB outage; cleanup stops after three attempts',async()=>{
 const h=harness({releases:[unavailable]}),result={ok:true,entry:{entered:false}};
 assert.equal(await h.scopes.periodic(async()=>result),result);
 assert.equal(h.releaseRequests().length,3);assert.deepEqual(h.delays,[100,200]);assert.ok(h.cleared());
 assert.ok(h.releaseRequests().every(r=>r.args.p_fence===42));assertScopedCleanup(h);
 assert.equal(h.events.length,1);assert.equal(h.events[0].cleanup_warning,'V17_RELEASE_ANALYSIS_LEASE_UNAVAILABLE');
 assert.equal(h.events[0].recovery,'TTL_EXPIRY');
});

test('an account recovery failure retains its original error when cleanup also fails',async()=>{
 const h=harness({releases:[unavailable]}),original=Error('ACCOUNT_RECOVERY_STATE_UNAVAILABLE');
 await assert.rejects(h.scopes.periodic(async()=>{throw original;}),error=>error===original);
 assert.equal(h.releaseRequests().length,3);assertScopedCleanup(h);
});

test('a transient cleanup failure recovers without changing the analysis result',async()=>{
 const h=harness({releases:[unavailable,()=>json(true)]});
 assert.deepEqual(await h.scopes.periodic(async()=>({ok:true})),{ok:true});
 assert.equal(h.releaseRequests().length,2);assert.deepEqual(h.delays,[100]);
 assert.deepEqual(h.events,[{event:'ANALYSIS_LEASE_RELEASE_RECOVERED',attempts:2,fence:42}]);assertScopedCleanup(h);
});

test('lost release acknowledgement followed by a successor is safe and needs no third retry',async()=>{
 let lease={owner:null,fence:42};
 const h=harness({acquire:r=>{lease.owner=r.args.p_owner;return json({...lease});},releases:[
  r=>{assert.equal(r.args.p_owner,lease.owner);assert.equal(r.args.p_fence,lease.fence);
   lease={owner:'successor-owner',fence:43};throw TypeError('fetch failed');},
  r=>{const matches=r.args.p_owner===lease.owner&&r.args.p_fence===lease.fence;
   if(matches)lease.owner=null;return json(matches);}
 ]});
 assert.equal(await h.scopes.periodic(async()=>17),17);
 assert.equal(h.releaseRequests().length,2);assert.deepEqual(lease,{owner:'successor-owner',fence:43});
 assert.ok(h.releaseRequests().every(r=>r.args.p_fence===42));assertScopedCleanup(h);
 assert.equal(h.events[0].event,'ANALYSIS_LEASE_RELEASE_RECOVERED');
});

test('already released or expired ownership is complete without retries or warnings',async()=>{
 const h=harness({releases:[()=>json(false)]});assert.equal(await h.scopes.periodic(async()=>19),19);
 assert.equal(h.releaseRequests().length,1);assert.deepEqual(h.events,[]);assert.deepEqual(h.delays,[]);
});

test('uncertain acquisition never starts analysis and retains its failure after owner-only cleanup',async()=>{
 const h=harness({acquire:unavailable,releases:[unavailable]});let ran=false;
 await assert.rejects(h.scopes.periodic(async()=>{ran=true;}),{message:'V17_ACQUIRE_ANALYSIS_LEASE_UNAVAILABLE'});
 assert.equal(ran,false);assert.equal(h.releaseRequests().length,3);
 assert.ok(h.releaseRequests().every(r=>r.args.p_fence===null));assertScopedCleanup(h);
});

test('malformed acquisition evidence never grants analysis authority and cleans up only our owner',async()=>{
 const h=harness({acquire:()=>json({owner:'different-owner',fence:42})});let ran=false;
 await assert.rejects(h.scopes.periodic(async()=>{ran=true;}),{message:'ANALYSIS_ACQUISITION_EVIDENCE_INVALID'});
 assert.equal(ran,false);assert.equal(h.releaseRequests().length,1);assertScopedCleanup(h);
});

test('busy analysis does not execute or release another owner',async()=>{
 const h=harness({acquire:()=>json(null)});let ran=false;
 assert.deepEqual(await h.scopes.periodic(async()=>{ran=true;}),{ok:true,skipped:'PERIODIC_ANALYSIS_BUSY'});
 assert.equal(ran,false);assert.equal(h.releaseRequests().length,0);
});

test('heartbeat failure still aborts analysis and cleanup uses independent authority',async()=>{
 const h=harness({heartbeat:()=>json(false),releases:[unavailable]});
 await assert.rejects(h.scopes.periodic(async()=>{
  h.heartbeat();await new Promise(resolve=>setTimeout(resolve,5));
  currentExecutionContext(h.db).signal.throwIfAborted();
 }),{message:'ANALYSIS_HEARTBEAT_FAILED'});
 assert.equal(h.releaseRequests().length,3);assertScopedCleanup(h);
});

test('cleanup telemetry cannot overwrite results even if the logger throws or rejects',async()=>{
 for(const onEvent of [()=>{throw Error('LOGGER_FAILED');},()=>Promise.reject(Error('LOGGER_FAILED'))]){
  const h=harness({releases:[unavailable],onEvent});assert.equal(await h.scopes.periodic(async()=>23),23);
 }
});

test('the pinned Supabase client aborts hung cleanup requests within the total time budget',async()=>{
 const hang=r=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>resolve(json(true)),10_000);
  const abort=()=>{clearTimeout(timer);reject(r.signal.reason);};
  if(r.signal.aborted)abort();else r.signal.addEventListener('abort',abort,{once:true});
 });
 const h=harness({releases:[hang],realBackoff:true}),started=Date.now();
 assert.equal(await h.scopes.periodic(async()=>29),29);const elapsed=Date.now()-started;
 assert.equal(h.releaseRequests().length,3);assert.ok(elapsed>=2100&&elapsed<3500,`cleanup took ${elapsed}ms`);
 assert.ok(h.releaseRequests().every(r=>r.signal.aborted));assertScopedCleanup(h);
});
