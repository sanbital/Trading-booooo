import test from 'node:test';import assert from 'node:assert/strict';
import {runDispatchAnalysisBatch} from '../supabase/functions/v10-lane-executor/dispatch-analysis-batch.mjs';
import {withAnalysisContext,currentExecutionContext,currentAccountOwner} from '../supabase/functions/v10-lane-executor/account-execution-context.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
test('four BUY analyses begin independently before slow model completes, with immutable request contexts',async()=>{
 const db={},gate=deferred(),allStarted=deferred();let held=false,claims=0,started=0;
 const work=runDispatchAnalysisBatch({limit:10,recover:async()=>true,
  critical:async f=>{held=true;try{return await f();}finally{held=false;}},
  claim:async()=>++claims<=4?{claimed:true,row:{signal_id:String(claims),claim_owner:String(claims)}}:{claimed:false},
  execute:async({row})=>withAnalysisContext(db,async()=>{
   assert.equal(held,false);assert.equal(currentAccountOwner(db),null);if(++started===4)allStarted.resolve();await gate.promise;
   assert.equal(currentExecutionContext(db).claim.signalId,row.signal_id);return row.signal_id;
  },{owner:row.claim_owner,capabilities:{claim:{signalId:row.signal_id}}})});
 await allStarted.promise;assert.equal(started,4);gate.resolve();const r=await work;assert.equal(r.ok,true);assert.equal(r.executionDispatchBatch.length,4);
});
test('one model failure does not discard another claimed BUY and uncertain recovery never claims',async()=>{
 let claims=0,ran=0;const base={limit:2,critical:f=>f(),claim:async()=>({claimed:true,row:{signal_id:String(++claims)}}),execute:async({row})=>{ran++;if(row.signal_id==='1')throw Error('HTTP_503');return'PASS';}};
 const r=await runDispatchAnalysisBatch({...base,recover:async()=>true});assert.equal(r.ok,false);assert.equal(ran,2);assert.equal(r.executionDispatchBatch[1].result,'PASS');
 claims=0;assert.equal((await runDispatchAnalysisBatch({...base,recover:async()=>false})).skipped,'RECONCILIATION_FIRST_ENTRY_FROZEN');assert.equal(claims,0);
 await assert.rejects(runDispatchAnalysisBatch({...base,critical:async()=>{throw Error('DB_TIMEOUT');},recover:async()=>true}),/DB_TIMEOUT/);assert.equal(claims,0);
});
