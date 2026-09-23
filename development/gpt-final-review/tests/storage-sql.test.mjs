// Review-journal SQL contract, executed on PGlite (real Postgres semantics, in-process).
// Requires PGLITE_MODULE=<path to @electric-sql/pglite/dist/index.js>.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const dependency=process.env.PGLITE_MODULE;
if(!dependency)throw Error('Set PGLITE_MODULE to the installed @electric-sql/pglite/dist/index.js');
const {PGlite}=await import(pathToFileURL(dependency).href);
const base=readFileSync(new URL('../sql/gpt_final_review_storage_no_trading_activation.APPLIED_20260923124239.sql',import.meta.url),'utf8');
const hardening=readFileSync(new URL('../sql/gpt_final_review_production_hardening.sql',import.meta.url),'utf8');
const key=i=>String(i).padStart(64,'a');
async function setup({cec=true}={}){
  const pg=new PGlite();
  await pg.exec(`create role anon; create role authenticated; create role service_role;`);
  if(cec)await pg.exec(`create table public.v11_cec0040_state(singleton boolean primary key,reject_run int);
    insert into public.v11_cec0040_state values(true,0);
    create table public.v11_cec0040_decisions(signal_id uuid primary key,decision_at timestamptz);
    create function public.v11_cec0040_decide(p_signal_id uuid,p_decision_at timestamptz,p_symbol text,p_branch text,p_bootstrap boolean default false)
    returns jsonb language plpgsql set search_path='' as $$ declare s public.v11_cec0040_state; begin
      if p_symbol='BADUSDT' then raise exception 'CEC0040_DECISION_TIME_REGRESSION'; end if;
      select * into s from public.v11_cec0040_state where singleton for update;
      insert into public.v11_cec0040_decisions values(p_signal_id,p_decision_at);
      update public.v11_cec0040_state set reject_run=reject_run+1 where singleton;
      return jsonb_build_object('ready',true,'action',case when s.reject_run+1>=3 then 'PROBE' else 'REJECT' end,'rejectRunBefore',s.reject_run);
    end $$;`);
  await pg.exec('begin;'+base+'commit;');
  await pg.exec('begin;'+hardening+'commit;');
  return pg;
}
const record=(extra={})=>({version:'V',identity:{signal_id:'sig-1',symbol:'TESTUSDT'},purpose:'VERIFICATION',...extra});
async function claim(pg,k,{cap=1,max=10,reserve=.1,rec=record()}={}){
  return (await pg.query('select public.gpt_final_review_claim($1,$2,$3,$4,$5) r',[k,rec,cap,max,reserve])).rows[0].r;
}
function done(result){return {version:'V',prompt_hash:'p'.repeat(64),schema_hash:'s'.repeat(64),source_commit:'c'.repeat(40),snapshot_at_ms:1790000000000,
  packet:{candidate_id:'c_1',snapshot_hash:'h'.repeat(64)},result:{origin:'OPENAI_API',model_requested:'gpt-5.4-mini-2026-03-17',decision:'PASS',valid:true,error:null,
    attempted:true,request_id:'req_1',usage:{input_tokens:3000,output_tokens:200,input_tokens_details:{cached_tokens:1024}},api_cost_usd:.0031,
    cost_basis:'DOCUMENTED_TOKEN_RATE_ESTIMATE_USD_NOT_USDT',latency_ms:2100,started_at_ms:1790000001000,completed_at_ms:1790000003100,...result}};}
const budget=async pg=>(await pg.query('select calls,reserved_usd::float8 reserved,settled_usd::float8 settled,cap_usd::float8 cap,max_calls from public.gpt_final_review_daily_budget')).rows[0];

test('control row is installed OFF with zero budget and RLS',async()=>{
  const pg=await setup();
  const c=(await pg.query('select mode,daily_cap_usd::float8 cap,max_calls_per_day calls,enforce_approved from public.gpt_final_review_control')).rows[0];
  assert.deepEqual(c,{mode:'OFF',cap:0,calls:0,enforce_approved:false});
  const rls=(await pg.query(`select relname,relrowsecurity from pg_class where relname in ('gpt_final_review_control','gpt_final_entry_reviews','gpt_final_review_daily_budget') order by 1`)).rows;
  assert.ok(rls.every(r=>r.relrowsecurity===true));
});
test('control constraints refuse an active mode without approval and finite budget',async()=>{
  const pg=await setup();
  await assert.rejects(pg.query(`update public.gpt_final_review_control set mode='SHADOW'`),/gpt_control_active_requires_budget/);
  await assert.rejects(pg.query(`update public.gpt_final_review_control set mode='ENFORCE',approval_ref='x',daily_cap_usd=1,max_calls_per_day=5`),/gpt_control_enforce_requires_approval/);
  await assert.rejects(pg.query(`update public.gpt_final_review_control set daily_cap_usd=100`),/check/i);
  await pg.query(`update public.gpt_final_review_control set mode='SHADOW',approval_ref='ok',daily_cap_usd=1,max_calls_per_day=5`);
});
test('anon and authenticated have no table or function access; service_role only reads control',async()=>{
  const pg=await setup();
  const q=async(role,sql)=>{await pg.exec(`set role ${role}`);try{return await pg.query(sql);}finally{await pg.exec('reset role');}};
  for(const role of ['anon','authenticated']){
    await assert.rejects(q(role,'select * from public.gpt_final_entry_reviews'),/permission denied/);
    await assert.rejects(q(role,'select * from public.gpt_final_review_daily_budget'),/permission denied/);
    await assert.rejects(q(role,'select * from public.gpt_final_review_control'),/permission denied/);
    await assert.rejects(q(role,`select public.gpt_final_review_claim('${key(1)}','{}',1,1,.1)`),/permission denied/);
    await assert.rejects(q(role,`select public.gpt_final_review_complete('${key(1)}',gen_random_uuid(),'{}')`),/permission denied/);
    await assert.rejects(q(role,`select public.v11_cec0040_preview_readonly(gen_random_uuid(),now(),'BTCUSDT','R62')`),/permission denied/);
  }
  await assert.rejects(q('service_role',`update public.gpt_final_review_control set mode='OFF'`),/permission denied/);
});
test('same job key is claimed and billed once',async()=>{
  const pg=await setup();
  assert.equal((await claim(pg,key(1))).created,true);
  assert.equal((await claim(pg,key(1))).created,false);
  const b=await budget(pg);assert.equal(b.calls,1);assert.ok(Math.abs(b.reserved-.1)<1e-12);
  const row=(await pg.query(`select purpose,signal_id,symbol,reserved_usd::float8 r,budget_day is not null has_day from public.gpt_final_entry_reviews`)).rows[0];
  assert.deepEqual(row,{purpose:'VERIFICATION',signal_id:'sig-1',symbol:'TESTUSDT',r:.1,has_day:true});
});
test('budget and call cap stop further distinct calls and roll back the refused row',async()=>{
  const pg=await setup();
  await claim(pg,key(1),{cap:.2,max:5});await claim(pg,key(2),{cap:.2,max:5});
  await assert.rejects(claim(pg,key(3),{cap:.2,max:5}),/API_BUDGET_EXHAUSTED/);
  assert.equal((await pg.query('select count(*)::int n from public.gpt_final_entry_reviews')).rows[0].n,2);
  const pg2=await setup();await claim(pg2,key(1),{cap:5,max:1});
  await assert.rejects(claim(pg2,key(2),{cap:5,max:1}),/API_BUDGET_EXHAUSTED/);
});
test('unapproved budget is refused before any row exists',async()=>{
  const pg=await setup();
  for(const [cap,max,res] of [[0,1,.1],[1,0,.1],[1,1,.01],[null,1,.1]])await assert.rejects(claim(pg,key(9),{cap,max,reserve:res}),/APPROVED_API_BUDGET_REQUIRED/);
  assert.equal((await pg.query('select count(*)::int n from public.gpt_final_entry_reviews')).rows[0].n,0);
});
test('complete is owner-CAS, once only, projects telemetry and settles known cost',async()=>{
  const pg=await setup();
  const c=await claim(pg,key(1));const owner=c.row.owner;
  await assert.rejects(pg.query('select public.gpt_final_review_complete($1,gen_random_uuid(),$2)',[key(1),done()]),/REVIEW_RESULT_CAS/);
  await pg.query('select public.gpt_final_review_complete($1,$2,$3)',[key(1),owner,done()]);
  await assert.rejects(pg.query('select public.gpt_final_review_complete($1,$2,$3)',[key(1),owner,done()]),/REVIEW_RESULT_CAS/);
  const r=(await pg.query(`select state,decision,valid,request_id,input_tokens,cached_input_tokens,output_tokens,api_cost_usd::float8 cost,settled_usd::float8 settled,latency_ms,model,prompt_hash,schema_hash,source_commit,candidate_id,snapshot_hash,api_started_at is not null s,api_completed_at is not null e,snapshot_at is not null sn,completed_at is not null c from public.gpt_final_entry_reviews`)).rows[0];
  assert.equal(r.state,'DONE');assert.equal(r.decision,'PASS');assert.equal(r.valid,true);assert.equal(r.request_id,'req_1');
  assert.deepEqual([r.input_tokens,r.cached_input_tokens,r.output_tokens,r.latency_ms],[3000,1024,200,2100]);
  assert.equal(r.cost,.0031);assert.equal(r.settled,.0031);assert.equal(r.model,'gpt-5.4-mini-2026-03-17');
  assert.ok(r.prompt_hash&&r.schema_hash&&r.source_commit&&r.candidate_id&&r.snapshot_hash&&r.s&&r.e&&r.sn&&r.c);
  const b=await budget(pg);assert.ok(Math.abs(b.reserved-.0031)<1e-12);assert.ok(Math.abs(b.settled-.0031)<1e-12);
});
test('timeout keeps the full reservation; unattempted local failure releases it',async()=>{
  const pg=await setup();
  const a=await claim(pg,key(1)),b=await claim(pg,key(2));
  await pg.query('select public.gpt_final_review_complete($1,$2,$3)',[key(1),a.row.owner,done({decision:'ABSTAIN',valid:false,error:'API_TIMEOUT',usage:null,api_cost_usd:null,request_id:null})]);
  await pg.query('select public.gpt_final_review_complete($1,$2,$3)',[key(2),b.row.owner,done({origin:'LOCAL_DATA_ERROR',decision:'ABSTAIN',valid:false,error:'REVIEW_PREPARATION_FAILED',attempted:false,usage:null,api_cost_usd:0,request_id:null})]);
  const x=await budget(pg);assert.equal(x.calls,2);assert.ok(Math.abs(x.reserved-.1)<1e-12,'timeout reserve kept, local failure released');
  const rows=(await pg.query('select error,settled_usd::float8 s from public.gpt_final_entry_reviews order by job_key')).rows;
  assert.deepEqual(rows,[{error:'API_TIMEOUT',s:null},{error:'REVIEW_PREPARATION_FAILED',s:0}]);
});
test('RUNNING row is never re-claimed as a new paid call',async()=>{
  const pg=await setup();await claim(pg,key(1));
  const again=await claim(pg,key(1));assert.equal(again.created,false);assert.equal(again.row.state,'RUNNING');
  assert.equal((await budget(pg)).calls,1);
});
test('CEC preview returns the decision but persists nothing',async()=>{
  const pg=await setup();
  const r=(await pg.query(`select public.v11_cec0040_preview_readonly(gen_random_uuid(),now(),'BTCUSDT','R62') r`)).rows[0].r;
  assert.equal(r.ready,true);assert.equal(r.preview,true);assert.equal(r.persisted,false);assert.equal(r.action,'REJECT');
  assert.equal((await pg.query('select count(*)::int n from public.v11_cec0040_decisions')).rows[0].n,0);
  assert.equal((await pg.query('select reject_run from public.v11_cec0040_state')).rows[0].reject_run,0);
  const e=(await pg.query(`select public.v11_cec0040_preview_readonly(gen_random_uuid(),now(),'BADUSDT','R62') r`)).rows[0].r;
  assert.equal(e.ready,false);assert.match(e.reason,/TIME_REGRESSION/);
});
