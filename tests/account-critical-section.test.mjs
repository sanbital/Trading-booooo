import test from 'node:test';import assert from 'node:assert/strict';
import {createAccountCriticalSection} from '../supabase/functions/v10-lane-executor/account-critical-section.mjs';
import {withAnalysisContext,assertAccountWriterContext,currentAccountOwner} from '../supabase/functions/v10-lane-executor/account-execution-context.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function setup(){let held=null,fence=0,time=1000,restarts=0,heartbeatCallback;const calls=[];
 const deps={now:()=>time,timers:{setInterval(f){heartbeatCallback=f;return 1;},clearInterval(){}},
 acquire:async owner=>{calls.push('acquire');if(held)return null;held={owner,fence:++fence,generation:restarts};return {...held};},
 verify:async(owner,f)=>{calls.push('verify');if(!held||held.owner!==owner||held.fence!==f||held.generation!==restarts)throw Error('WRITER_FENCED');},
 heartbeat:async(owner,f)=>!!held&&held.owner===owner&&held.fence===f&&held.generation===restarts,
 release:async(owner,f)=>{calls.push('release');if(held?.owner===owner&&(f===null||held.fence===f))held=null;}};
 return {db:{},calls,critical:createAccountCriticalSection(deps),tick:async()=>{heartbeatCallback();await new Promise(r=>setImmediate(r));},
 restart(){restarts++;held=null;},advance(ms){time+=ms;},deps};}
test('blocked periodic analysis cannot occupy the writer; a valid BUY can enter immediately',async()=>{const f=setup(),gate=deferred(),started=deferred();let submitted=0;
 const analysis=withAnalysisContext(f.db,async()=>{started.resolve();await gate.promise;assert.equal(currentAccountOwner(f.db),null);});await started.promise;
 await f.critical(f.db,async()=>{assertAccountWriterContext(f.db);submitted++;},{deadline:2000});assert.equal(submitted,1);assert.equal(f.calls.at(-1),'release');gate.resolve();await analysis;});
test('busy writer leaves durable work deferred, without making a terminal rejection or submitting',async()=>{const f=setup(),gate=deferred(),started=deferred();const first=f.critical(f.db,async()=>{started.resolve();await gate.promise;});await started.promise;let sent=0;assert.deepEqual(await f.critical(f.db,()=>sent++),{deferred:true,reason:'ACCOUNT_WRITER_BUSY'});assert.equal(sent,0);gate.resolve();await first;});
test('original deadline expiring during acquisition blocks submission',async()=>{const f=setup();const old=f.deps.acquire;f.deps.acquire=async id=>{const v=await old(id);f.advance(1500);return v;};const critical=createAccountCriticalSection(f.deps);let sent=0;assert.deepEqual(await critical(f.db,()=>sent++,{deadline:2000}),{deferred:true,reason:'DEADLINE_EXPIRED'});assert.equal(sent,0);});
test('failed heartbeat revokes the suspended old holder before a side effect',async()=>{const f=setup(),gate=deferred(),started=deferred();let sent=0;const work=f.critical(f.db,async()=>{started.resolve();await gate.promise;assertAccountWriterContext(f.db);sent++;});await started.promise;f.restart();await f.tick();gate.resolve();await assert.rejects(work,/HEARTBEAT_FAILED/);assert.equal(sent,0);});
test('DB restart fences a completed ambiguous submission instead of retrying it',async()=>{const f=setup();let sent=0;await assert.rejects(f.critical(f.db,async()=>{sent++;f.restart();return {accepted:null};}),/WRITER_FENCED/);assert.equal(sent,1);assert.equal(f.calls.filter(x=>x==='acquire').length,1);});
test('uncertain acquisition is cleaned up without executing or inferring order absence',async()=>{const f=setup();f.deps.acquire=async()=>{throw Error('DB_ACK_TIMEOUT');};let sent=0;await assert.rejects(createAccountCriticalSection(f.deps)(f.db,()=>sent++),/DB_ACK_TIMEOUT/);assert.equal(sent,0);assert.deepEqual(f.calls,['release']);});
test('nested accounting/protection keeps the exact owner without a second acquisition',async()=>{const f=setup();await f.critical(f.db,()=>f.critical(f.db,async()=>assertAccountWriterContext(f.db)));assert.equal(f.calls.filter(x=>x==='acquire').length,1);});
