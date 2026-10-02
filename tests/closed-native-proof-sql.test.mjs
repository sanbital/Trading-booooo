import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
async function fixture(t){
 const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href),db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table v11_long_regime_positions(id uuid primary key,symbol text,state text,remaining_quantity numeric,original_quantity numeric,metadata jsonb,updated_at timestamptz);
 create table proof_lease(singleton boolean primary key,owner uuid,expires_at timestamptz,fenced boolean default false);
 insert into proof_lease values(true,null,'-infinity',false);
 create function v17_acquire_execution_lease(p_owner uuid) returns boolean language plpgsql as $$declare n int;begin update proof_lease set owner=p_owner,expires_at=clock_timestamp()+interval '150 seconds' where expires_at<clock_timestamp() or owner=p_owner;get diagnostics n=row_count;return n=1;end$$;
 create function v17_verify_execution_lease(p_owner uuid) returns boolean language sql as $$select exists(select 1 from proof_lease where owner=p_owner and expires_at>clock_timestamp()+interval '30 seconds' and not fenced)$$;
 create function v17_release_execution_lease(p_owner uuid) returns boolean language plpgsql as $$declare n int;begin update proof_lease set owner=null,expires_at='-infinity' where owner=p_owner;get diagnostics n=row_count;return n=1;end$$;`);
 const dir=new URL('../supabase/migrations/',import.meta.url),files=(await readdir(dir)).filter(f=>f.endsWith('_closed_native_absence_reconciliation.sql'));assert.equal(files.length,1);
 await db.exec(await readFile(new URL(files[0],dir),'utf8'));
 const position=crypto.randomUUID(),owner=crypto.randomUUID(),receipt=crypto.randomUUID(),now=Date.now(),client='tb-v17s-'+'a'.repeat(27);
 const receipts={[receipt]:{quantity:10,accountedQuantity:10,detailsComplete:true,status:'FILLED',funds:1000,fee:.5,tradeIds:['1']}},params={symbol:'ABCUSDT',clientAlgoId:client,side:'SELL',positionSide:'BOTH',type:'STOP_MARKET',reduceOnly:'true',quantity:10,triggerPrice:97};
 const proof={position_id:position,client_id:client,symbol:'ABCUSDT',version:'CLOSED_NATIVE_ABSENCE_1',kind:'CLOSED_ABSENT_WITH_COMPLETE_ACCOUNTING',
  exact_negative_lookup:true,complete_history:true,account_flat:true,observed_at_ms:now,coverage_start_ms:now-3605000,coverage_end_ms:now-1,submitted_at_ms:now-3600000,
  expected_receipts:receipts,spec:params,original_quantity:10,quantity:10,funds:1000,fee:.5,trade_count:1,trade_ids:['1'],receipt_ids:[receipt]};
 const metadata={executionMode:'LEADER_MOMENTUM_V17',v18Exits:receipts,exitAccountingPending:false,
  preserved:{capture:'original'},exitProtection:{version:3,health:'RECONCILIATION_PENDING',orders:[{clientId:client,submittedAt:proof.submitted_at_ms,status:'CANCEL_PENDING',terminal:false,spec:{params},submitError:'The signal has been aborted',lastQueryError:'GW_400:Order does not exist.'}]}};
 await db.query(`insert into v11_long_regime_positions values($1,'ABCUSDT','CLOSED',0,10,$2,statement_timestamp())`,[position,metadata]);
 const started=(await db.query('select pg_postmaster_start_time() t')).rows[0].t;
 return {db,proof,position,owner,started,metadata,call:(proofs=[proof],start=started)=>db.query('select v18_reconcile_closed_native_absence($1,$2,$3) result',[owner,start,proofs])};
}
test('fenced closed reconciliation preserves accounting/capture and releases the short lease; duplicate is idempotent',async t=>{
 const f=await fixture(t);assert.equal((await f.call()).rows[0].result.resolved,1);
 const p=(await f.db.query('select metadata from v11_long_regime_positions')).rows[0].metadata;
 assert.deepEqual(p.v18Exits,f.metadata.v18Exits);assert.deepEqual(p.preserved,f.metadata.preserved);
 assert.equal(p.exitProtection.orders[0].status,'RECONCILED');assert.equal(p.exitProtection.orders[0].terminal,true);assert.equal(p.exitProtection.orders[0].terminalResolution.historicalSubmission,'NOT_INFERRED');
 assert.equal(p.exitProtection.health,'POSITION_CLOSED');assert.equal((await f.db.query('select owner from proof_lease')).rows[0].owner,null);
 assert.equal((await f.call()).rows[0].result.already_terminal,1);
 assert.equal((await f.db.query('select count(*)::int n from v18_closed_native_proof_events')).rows[0].n,1);
});
for(const [name,change,message]of [
 ['missing proof fields',f=>{delete f.proof.observed_at_ms},'FIELDS_INVALID'],
 ['stale proof',f=>{f.proof.observed_at_ms-=10000},'INVALID_OR_STALE'],
 ['receipt drift',f=>{f.proof.expected_receipts={}},'ACCOUNTING_CHANGED'],
 ['wrong quantity',f=>{f.proof.quantity=11},'AMOUNTS_MISMATCH'],
 ['wrong native parameters',f=>{f.proof.spec.triggerPrice=90},'SUBMISSION_CHANGED'],
])test(`DB rejects ${name} without changing the position or holding the lease`,async t=>{
 const f=await fixture(t);change(f);await assert.rejects(f.call(),new RegExp(message));
 assert.equal((await f.db.query('select metadata from v11_long_regime_positions')).rows[0].metadata.exitProtection.orders[0].terminal,false);
 assert.equal((await f.db.query('select owner from proof_lease')).rows[0].owner,null);
});
test('postmaster change invalidates pre-restart proof',async t=>{
 const f=await fixture(t);await assert.rejects(f.call([f.proof],new Date(new Date(f.started).getTime()-1000)),/POSTMASTER_CHANGED/);
 assert.equal((await f.db.query('select owner from proof_lease')).rows[0].owner,null);
});
test('another account holder and a failed fencing check prevent state changes',async t=>{
 const f=await fixture(t);await f.db.query("update proof_lease set owner=$1,expires_at=clock_timestamp()+interval '150 seconds'",[crypto.randomUUID()]);
 await assert.rejects(f.call(),/LEASE_BUSY/);
 await f.db.exec("update proof_lease set owner=null,expires_at='-infinity',fenced=true");await assert.rejects(f.call(),/LEASE_FENCED/);
 assert.equal((await f.db.query('select metadata from v11_long_regime_positions')).rows[0].metadata.exitProtection.orders[0].terminal,false);
});
test('a failed second proof rolls back the entire batch and proof audit',async t=>{
 const f=await fixture(t),bad={...f.proof,position_id:crypto.randomUUID()};await assert.rejects(f.call([f.proof,bad]),/POSITION_OR_ACCOUNTING_CHANGED/);
 assert.equal((await f.db.query('select metadata from v11_long_regime_positions')).rows[0].metadata.exitProtection.orders[0].terminal,false);
 assert.equal((await f.db.query('select count(*)::int n from v18_closed_native_proof_events')).rows[0].n,0);
});
