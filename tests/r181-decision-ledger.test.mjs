// R181 follow-up: GPT decision -> signal ledger consistency, on real Postgres (PGlite).
//
// Production code under test runs unmodified: FinalReviewCoordinator + FD1_ENTRY_ENGINE (real
// prompt/contract/validation, OpenAI and Binance mocked at fetch), SupabaseReviewStore with the
// applied review-journal SQL (claim/complete RPCs), gpt-terminal-settlement.mjs, the lifecycle
// helpers and the SELECT-only invariant auditor ops/r181/lineage_invariants.sql.
// Requires PGLITE_MODULE=<path to @electric-sql/pglite/dist/index.js>.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {pgRest} from './support/pg-rest.mjs';
import {FinalReviewCoordinator} from '../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
import {SupabaseReviewStore} from '../supabase/functions/_shared/gpt-final-review/supabase-store.mjs';
import {FD1_ENTRY_ENGINE} from '../supabase/functions/_shared/gpt-final-decision/engine.mjs';
import {klines,entryWire} from '../development/gpt-final-decision/tests/fixtures.mjs';
import {settleGptTerminal,lifecycleTerminalReason,readStoredGptOutcome} from '../supabase/functions/v10-lane-executor/gpt-terminal-settlement.mjs';
import {lifecycleNote,expiredTriggerReason,terminalClassOf,gptTerminalReason,storedTerminalReason,gptDecisionSource,
  signalTransitionAllowed,SIGNAL_ACTIVE,SIGNAL_TERMINAL} from '../supabase/functions/v10-lane-executor/entry-lifecycle.mjs';
import {decomposeWindowChange,tradeStats} from '../ops/r181/pnl-window.mjs';

const dependency=process.env.PGLITE_MODULE;
if(!dependency)throw Error('Set PGLITE_MODULE to @electric-sql/pglite/dist/index.js');
const {PGlite}=await import(pathToFileURL(dependency).href);
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const journalBase=read('../development/gpt-final-review/sql/gpt_final_review_storage_no_trading_activation.APPLIED_20260923124239.sql');
const journalHardening=read('../development/gpt-final-review/sql/gpt_final_review_production_hardening.sql');
const lifecycleSql=read('../supabase/migrations/20260925003050_fd1_entry_lifecycle_journal.sql');
const terminalClassSql=lifecycleSql.slice(lifecycleSql.indexOf('create or replace function public.entry_terminal_class'),
  lifecycleSql.indexOf('$$;',lifecycleSql.indexOf('create or replace function public.entry_terminal_class'))+3);
const auditSql=read('../ops/r181/lineage_invariants.sql');

const MIN=60_000;
// JELLYJELLYUSDT, production 2026-09-26 (R181): trigger 09:06:00, window closes 09:07:00, GPT asked
// at 09:06:06.544, valid SKIP stored 09:06:09.616, signal left NEW, sweep at 09:07:11 wrote
// STALE:GPT_REVIEW_PENDING. Market data is synthetic (fixtures.klines); ids, times, rank and day
// return are the production values.
const JELLY={id:'f773c534-8636-41ce-879b-ee47178699d7',symbol:'JELLYJELLYUSDT',trig:1790413560000,rank:5,dayReturn:.1603213412504365};
const cfg={mode:'ENFORCE',modeValid:true,approvalRef:'r181-test',apiBudgetUsd:3,maxCalls:300,enforceApproved:true,source:'TEST'};
const SKIP_WIRE=i=>entryWire({t:'ENTRY',c:i.candidate_id,d:'SKIP',reasons:[{r:'GPT_JUDGMENT',e:['return_60m']}],support:[],n:'추진력 소진'});
const BUY_WIRE=i=>entryWire({t:'ENTRY',c:i.candidate_id,d:'BUY',reasons:[],support:['return_5m','taker_buy_ratio_5m'],n:'상승 지속'});
const ABSTAIN_WIRE=i=>entryWire({t:'ENTRY',c:i.candidate_id,d:'ABSTAIN',reasons:[],support:[],n:'판단 불가'});

/** Binance public data + OpenAI Responses API at the fetch boundary. `openai` decides the reply. */
function world(openai,{now,calls}){
  return async(url,init)=>{
    const u=new URL(url);
    if(u.hostname==='api.openai.com'){
      calls.push({at:now(),body:init.body});
      const r=await openai(JSON.parse(JSON.parse(init.body).input[1].content));
      if(r instanceof Response)return r;
      const raw={model:'gpt-5.4-mini-2026-03-17',status:'completed',usage:{input_tokens:3000,output_tokens:90,input_tokens_details:{cached_tokens:2000}},
        output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(r)}]}]};
      return new Response(JSON.stringify(raw),{status:200,headers:{'x-request-id':'req_r181_'+calls.length}});
    }
    const p=u.pathname,at=Number(u.searchParams.get('endTime')??now())+1;
    if(p==='/fapi/v1/klines')return Response.json(klines(Number(u.searchParams.get('limit')),u.searchParams.get('interval')==='5m'?5*MIN:MIN,at,{step:.001}));
    if(p==='/futures/data/openInterestHist')return Response.json(Array.from({length:13},(_,i)=>({timestamp:Math.floor(now()/300000)*300000-(12-i)*300000,sumOpenInterest:1000+i,sumOpenInterestValue:5e6})));
    if(p==='/fapi/v1/premiumIndexKlines')return Response.json([[Math.floor(now()/MIN)*MIN-MIN,'0','0','0','0.0002','0',Math.floor(now()/MIN)*MIN-1]]);
    if(p==='/fapi/v1/premiumIndex')return Response.json({lastFundingRate:'0.0001'});
    if(p==='/fapi/v1/depth')return Response.json({bids:[[1.199,2000],[1.198,2000]],asks:[[1.2,2000],[1.201,2000]]});
    return new Response('no',{status:404});
  };
}

async function database(){
  const pg=new PGlite();
  await pg.exec(`create role anon; create role authenticated; create role service_role;
    create table public.v11_cec0040_state(singleton boolean primary key,reject_run int);
    create table public.v11_cec0040_decisions(signal_id uuid primary key,decision_at timestamptz);
    create function public.v11_cec0040_decide(p_signal_id uuid,p_decision_at timestamptz,p_symbol text,p_branch text,p_bootstrap boolean default false)
      returns jsonb language sql as $$ select '{}'::jsonb $$;`);
  await pg.exec('begin;'+journalBase+'commit;');
  await pg.exec('begin;'+journalHardening+'commit;');
  await pg.exec(terminalClassSql);
  // Production column sets (information_schema, 2026-09-26) for the ledger tables the audit joins.
  await pg.exec(`
    create table public.v11_long_regime_signals(id uuid primary key,revision text default 'V11-LONG-REGIME-1.0.1',lane text default 'BULL',
      symbol text,side text default 'LONG',signal_bar_at timestamptz,entry_bar_at timestamptz,features jsonb,status text,reject_reason text,
      position_id uuid,created_at timestamptz default now(),updated_at timestamptz default now());
    create table public.v11_long_regime_decisions(id bigserial primary key,revision text,position_id uuid,decided_at timestamptz default now(),
      observed_regime text,active_lane_before text,active_lane_after text,action text,reason text,details jsonb);
    create table public.v11_long_regime_orders(id uuid primary key,revision text,signal_id uuid,position_id uuid,symbol text,intent text,reason text,
      client_order_id text,requested_quantity numeric,state text,exchange_order_id text,request_payload jsonb,response_payload jsonb,
      reject_reason text,created_at timestamptz default now(),updated_at timestamptz default now());
    create table public.v11_long_regime_positions(id uuid primary key,signal_id uuid unique,symbol text,side text default 'LONG',
      original_quantity numeric,remaining_quantity numeric,entry_price numeric,entry_at timestamptz,state text,realized_pnl_usdt numeric,
      entry_fee_usdt numeric,exit_price numeric,exit_reason text,closed_at timestamptz,created_at timestamptz default now());
    create table public.exchange_trade_fills(id uuid primary key default gen_random_uuid(),exchange text default 'binance_futures',
      account_scope text default 'futures',market text,exchange_trade_id bigint,exchange_order_id text,side text,price numeric,quantity numeric,
      quote_amount numeric,fee_asset text,fee_amount numeric,fee_quote_amount numeric,source text default 'AUTOMATED',
      v17_order_id uuid,v17_position_id uuid,executed_at timestamptz);
    create table public.missed_opportunity_journal(signal_id uuid primary key,created_at timestamptz default now(),terminal_class text,reject_reason text);`);
  return {pg,db:pgRest(pg)};
}
function signalRow(s,{status='NEW'}={}){
  return {id:s.id,symbol:s.symbol,status,signal_bar_at:new Date(s.trig-6*MIN).toISOString(),entry_bar_at:new Date(s.trig-MIN).toISOString(),
    features:{strategy:'LEADER_MOMENTUM_V17',referenceClose:1,dayReturn:s.dayReturn,rank:s.rank,exitPolicy:{stopPct:.025},
      v17Setup:{state:'TRIGGERED',triggerAt:s.trig,triggerExpiresAt:s.trig+MIN}}};
}
/** One executor process: its own coordinator over the shared database, like one edge invocation. */
function worker(db,{openai,clock,settle=true,calls=[]}){
  const audit=(reason,details)=>db.from('v11_long_regime_decisions').insert({revision:'V11-LONG-REGIME-1.0.1',action:'ENTRY_REJECT',reason,details});
  const c=new FinalReviewCoordinator({config:cfg,store:new SupabaseReviewStore(db),apiKey:()=>'k',now:clock,
    fetchFn:world(openai,{now:clock,calls}),engine:FD1_ENTRY_ENGINE,baseline:()=>true,
    onTerminal:settle?record=>settleGptTerminal(db,record,{audit,now:clock}):null});
  return {c,calls};
}
const drain=c=>Promise.all([...c.pending.values()]);
const signal=async(db,id)=>(await db.from('v11_long_regime_signals').select('*').eq('id',id).single()).data;
async function seed(db,s,opt){
  const row=signalRow(s,opt);
  const w=await db.from('v11_long_regime_signals').insert(row);assert.equal(w.error,null);
  return (await db.from('v11_long_regime_signals').select('*').eq('id',s.id).single()).data;
}
async function invariants(pg){
  const rows=(await pg.query(auditSql)).rows.filter(r=>r.label==='7d');
  return Object.fromEntries(rows.map(r=>[r.inv.split(' ')[0],Number(r.n)]));
}
const sid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const at=(s,ms)=>({...s,trig:s.trig+ms});
// Fresh identities for the non-JELLY cases, anchored near now so the auditor's windows include them.
const fresh=(n,extra={})=>({id:sid(n),symbol:'ABCUSDT',trig:Math.floor(Date.now()/MIN)*MIN-2*MIN,rank:2,dayReturn:.2,...extra});

test('T16 JELLYJELLY regression: before the fix a stored SKIP leaves the signal NEW and the sweep labels it STALE',async()=>{
  const {pg,db}=await database(),clock=()=>JELLY.trig+6544;
  const row=await seed(db,JELLY);
  const {c}=worker(db,{openai:SKIP_WIRE,clock,settle:false});   // settle:false == executor v97 behaviour
  const r=await c.consider(row);assert.equal(r.reason,'GPT_REVIEW_PENDING','the asking cycle only sees PENDING');
  const note=lifecycleNote({at:clock(),stage:'GPT_REVIEW',reason:r.reason});
  await drain(c);
  const stored=(await pg.query(`select state,decision,valid from public.gpt_final_entry_reviews where signal_id=$1`,[JELLY.id])).rows;
  assert.deepEqual(stored,[{state:'DONE',decision:'SKIP',valid:true}]);
  assert.equal((await signal(db,JELLY.id)).status,'NEW','v97: a final SKIP on record, signal still NEW');
  // v97 sweep once the 60 s window closed: the note is all it reads.
  assert.equal(expiredTriggerReason(note),'STALE:GPT_REVIEW_PENDING','exact production reject_reason reproduced');
  assert.equal(terminalClassOf('STALE:GPT_REVIEW_PENDING'),'STALE','...which the journal counts as STALE, not GPT_REJECTED');
});

test('T16 JELLYJELLY regression: after the fix the SKIP is terminal at completion and the sweep reads the stored answer',async()=>{
  const {pg,db}=await database(),clock=()=>JELLY.trig+6544;
  const row=await seed(db,JELLY);
  const {c}=worker(db,{openai:SKIP_WIRE,clock});
  assert.equal((await c.consider(row)).reason,'GPT_REVIEW_PENDING');
  await drain(c);
  const s=await signal(db,JELLY.id);
  assert.equal(s.status,'REJECTED');assert.match(s.reject_reason,/^GPT_SKIP(:|$)/);
  assert.equal(terminalClassOf(s.reject_reason),'GPT_REJECTED');
  const audit=(await pg.query(`select reason,details->>'stage' stage,details->'gpt'->>'source' src from public.v11_long_regime_decisions`)).rows;
  assert.deepEqual(audit.map(a=>[a.stage,a.src]),[['GPT_FINAL_ENTRY_SETTLED','GPT_VALID']]);
  // Fallback: had the completion write never happened, the sweep reads the same durable answer.
  const {db:db2}=await database(),row2=await seed(db2,JELLY);
  const w2=worker(db2,{openai:SKIP_WIRE,clock,settle:false});await w2.c.consider(row2);await drain(w2.c);
  const sweepRow={id:JELLY.id,setup_state:'TRIGGERED',trigger_at:String(JELLY.trig),note:lifecycleNote({at:clock(),stage:'GPT_REVIEW',reason:'GPT_REVIEW_PENDING'})};
  const reason=await lifecycleTerminalReason(db2,sweepRow,{windowClosed:true});
  assert.match(reason,/^GPT_SKIP(:|$)/);assert.equal(reason,s.reject_reason,'both paths write the same reason');
  const inv=await invariants(pg);
  assert.equal(inv['INV-01c'],0);assert.equal(inv['INV-01d'],0);assert.equal(inv['INV-02'],0);
});

test('T01 valid BUY: one approved decision, the signal stays claimable and nothing is settled',async()=>{
  const {pg,db}=await database(),s=fresh(1),clock=()=>s.trig+1500,row=await seed(db,s);
  const {c}=worker(db,{openai:BUY_WIRE,clock});
  await c.consider(row);await drain(c);
  const r=await c.consider(row);assert.equal(r.decision,'BUY');assert.equal(r.allowed,true);assert.equal(c.check(row).allowed,true);
  assert.equal((await signal(db,s.id)).status,'NEW','a BUY is admitted by the entry loop, never settled');
  assert.equal((await pg.query(`select count(*)::int n from public.gpt_final_entry_reviews where signal_id=$1`,[s.id])).rows[0].n,1);
  assert.deepEqual(await readStoredGptOutcome(db,s.id,s.trig),{decision:'BUY'});
});

for(const [name,openai,expect,source] of [
  ['T02 SKIP',SKIP_WIRE,/^GPT_SKIP(:|$)/,'GPT_VALID'],
  ['T03 valid ABSTAIN',ABSTAIN_WIRE,/^GPT_ABSTAIN(:|$)/,'GPT_VALID'],
  ['T04 provider timeout',()=>{throw Error('API_TIMEOUT');},/^GPT_TIMEOUT$/,'TIMEOUT'],
  ['T05 provider quota failure (HTTP 429)',()=>new Response(JSON.stringify({error:{type:'insufficient_quota',code:'rate_limit_exceeded'}}),{status:429}),
    /^GPT_NO_VALID_API_RESPONSE:PROVIDER_ERROR:HTTP_429$/,'PROVIDER_ERROR'],
])test(name+' -> terminal, no executable opportunity, source kept separate from GPT judgment',async()=>{
  const {pg,db}=await database(),s=fresh(2),clock=()=>s.trig+1500,row=await seed(db,s);
  const {c}=worker(db,{openai,clock});
  await c.consider(row);await drain(c);
  const r=await c.consider(row);
  assert.equal(r.allowed,false);assert.equal(c.check(row).allowed,false,'no entry ticket');
  const sg=await signal(db,s.id);assert.equal(sg.status,'REJECTED');assert.match(sg.reject_reason,expect);
  assert.equal(terminalClassOf(sg.reject_reason),'GPT_REJECTED');
  assert.doesNotMatch(source==='GPT_VALID'?'':sg.reject_reason,/^GPT_ABSTAIN/,'a failure is never labelled a GPT ABSTAIN');
  const rec=(await pg.query(`select record from public.gpt_final_entry_reviews where signal_id=$1`,[s.id])).rows[0].record;
  assert.equal(gptDecisionSource(rec.result),source);
  // The same in-cycle path (a later consider inside the window) yields the same label.
  assert.equal(gptTerminalReason(r),sg.reject_reason);
});

test('T06 single attempt per identity: a timed-out request is the canonical answer; no second request can be issued',async()=>{
  // FD1 never retries a decision identity (coordinator: RUNNING/DONE rows are never re-called), so a
  // "retry B" cannot exist. What must hold is that a second worker neither re-asks nor out-votes A.
  const {db}=await database(),s=fresh(3),clock=()=>s.trig+1500,row=await seed(db,s),calls=[];
  const A=worker(db,{openai:()=>{throw Error('API_TIMEOUT');},clock,calls});
  const B=worker(db,{openai:BUY_WIRE,clock,calls});
  await A.c.consider(row);await drain(A.c);
  const rb=await B.c.consider(row);await drain(B.c);
  assert.equal(calls.length,1,'exactly one API request for the identity');
  assert.equal(rb.allowed,false);assert.equal(B.c.check(row).allowed,false);
  assert.equal((await signal(db,s.id)).reject_reason,'GPT_TIMEOUT');
});

test('T07 late duplicate completion (A after B accepted) is rejected by the journal CAS and changes nothing',async()=>{
  const {pg,db}=await database(),s=fresh(4),clock=()=>s.trig+1500,row=await seed(db,s);
  const {c}=worker(db,{openai:SKIP_WIRE,clock});
  await c.consider(row);await drain(c);
  const k=(await pg.query(`select job_key,owner,record from public.gpt_final_entry_reviews where signal_id=$1`,[s.id])).rows[0];
  const late={...k.record,result:{...k.record.result,decision:'BUY',answer:{...k.record.result.answer,decision:'BUY'}}};
  const store=new SupabaseReviewStore(db);
  await assert.rejects(store.complete(k.job_key,k.owner,late),/REVIEW_RESULT_CAS/,'owner cannot complete twice');
  await assert.rejects(store.complete(k.job_key,'11111111-1111-4111-8111-111111111111',late),/REVIEW_RESULT_CAS/,'a foreign owner cannot complete');
  const after=(await pg.query(`select decision from public.gpt_final_entry_reviews where job_key=$1`,[k.job_key])).rows[0];
  assert.equal(after.decision,'SKIP');assert.equal((await signal(db,s.id)).status,'REJECTED');
  // A BUY that completes after its own validity is refused for dispatch (late response).
  const {db:db2}=await database(),row2=await seed(db2,s);let t=s.trig+1500;
  const w=worker(db2,{openai:BUY_WIRE,clock:()=>t});await w.c.consider(row2);await drain(w.c);
  t=s.trig+45_000;await w.c.consider(row2);assert.equal(w.c.check(row2).allowed,false,'aged BUY never dispatches without a recheck');
});

test('T08 duplicate response: one decision row per identity, one settlement, one terminal audit',async()=>{
  const {pg,db}=await database(),s=fresh(5),clock=()=>s.trig+1500,row=await seed(db,s);
  const {c}=worker(db,{openai:SKIP_WIRE,clock});
  await Promise.all([c.consider(row),c.consider(row)]);await drain(c);
  assert.equal((await pg.query(`select count(*)::int n from public.gpt_final_entry_reviews where signal_id=$1`,[s.id])).rows[0].n,1);
  const rec=(await pg.query(`select record from public.gpt_final_entry_reviews where signal_id=$1`,[s.id])).rows[0].record;
  const again=await settleGptTerminal(db,rec,{audit:()=>assert.fail('no second audit')});
  assert.deepEqual(again,{settled:false,reason:again.reason,cas:'NOT_NEW'});
  assert.equal((await pg.query(`select count(*)::int n from public.v11_long_regime_decisions`)).rows[0].n,1);
});

test('T09 stale response for an old signal/trigger cannot label or admit a new one',async()=>{
  const {db}=await database(),old=fresh(6),neu=fresh(7,{symbol:'ABCUSDT'}),clock=()=>old.trig+1500;
  const oldRow=await seed(db,old),newRow=await seed(db,neu);
  const {c}=worker(db,{openai:SKIP_WIRE,clock});await c.consider(oldRow);await drain(c);
  const rec=(await db.from('gpt_final_entry_reviews').select('record').eq('signal_id',old.id).single()).data.record;
  assert.equal(storedTerminalReason(rec,{signalId:neu.id}),null,'bound to its own signal id');
  assert.equal(storedTerminalReason(rec,{signalId:old.id,triggerAtMs:old.trig+MIN}),null,'bound to its own trigger');
  assert.equal(await readStoredGptOutcome(db,neu.id,neu.trig),null);
  assert.equal((await signal(db,neu.id)).status,'NEW','the new signal is untouched');
  assert.equal(c.check(newRow).allowed,false,'no ticket carries over');
});

test('T10 terminal SKIPPED can never become NEW/CLAIMED; guarded REJECTED writes never overwrite FILLED',async()=>{
  const {db}=await database(),s=fresh(8),clock=()=>s.trig+1500,row=await seed(db,s);
  const {c}=worker(db,{openai:SKIP_WIRE,clock});await c.consider(row);await drain(c);
  // The executor's own claim and release statements (index.ts), verbatim in shape.
  const claim=await db.from('v11_long_regime_signals').update({status:'CLAIMED'}).eq('id',s.id).eq('status','NEW').select('*').maybeSingle();
  assert.equal(claim.data,null,'CLAIM CAS finds no NEW row');
  const release=await db.from('v11_long_regime_signals').update({status:'NEW'}).eq('id',s.id).eq('status','CLAIMED').select('id');
  assert.deepEqual(release.data,[]);
  assert.equal((await signal(db,s.id)).status,'REJECTED');
  const f=fresh(9);await seed(db,f,{status:'FILLED'});
  const w=await db.from('v11_long_regime_signals').update({status:'REJECTED',reject_reason:'ORDER_NEVER_PLACED:X'}).eq('id',f.id).in('status',SIGNAL_ACTIVE).select('id');
  assert.deepEqual(w.data,[]);assert.equal((await signal(db,f.id)).status,'FILLED');
  for(const t of SIGNAL_TERMINAL)for(const a of SIGNAL_ACTIVE)assert.equal(signalTransitionAllowed(t,a),false,`${t}->${a}`);
  assert.equal(signalTransitionAllowed('FILLED','CLOSED'),true);assert.equal(signalTransitionAllowed('FILLED','REJECTED'),false);
});

test('T10 source guard: every REJECTED write in the executor is a compare-and-set on an active status',()=>{
  const src=readFileSync(new URL('../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8');
  const writes=[...src.matchAll(/from\("v11_long_regime_signals"\)\.update\(\{status:"REJECTED"[\s\S]*?;/g)].map(m=>m[0]);
  assert.equal(writes.length,14,'every REJECTED write site is covered (update this count when adding one)');
  for(const w of writes)assert.match(w,/\.eq\("status","(NEW|CLAIMED)"\)|\.in\("status",SIGNAL_ACTIVE\)/,w.slice(0,160));
});

test('T11 duplicate workers on the same signal: one request, one decision, one terminal write',async()=>{
  const {pg,db}=await database(),s=fresh(10),clock=()=>s.trig+1500,row=await seed(db,s),calls=[];
  const A=worker(db,{openai:SKIP_WIRE,clock,calls}),B=worker(db,{openai:SKIP_WIRE,clock,calls});
  const [ra,rb]=await Promise.all([A.c.consider(row),B.c.consider(row)]);
  assert.deepEqual([ra.reason,rb.reason],['GPT_REVIEW_PENDING','GPT_REVIEW_PENDING']);
  await Promise.all([drain(A.c),drain(B.c)]);
  assert.equal(calls.length,1);
  assert.equal((await pg.query(`select count(*)::int n from public.gpt_final_entry_reviews`)).rows[0].n,1);
  assert.equal((await pg.query(`select count(*)::int n from public.v11_long_regime_decisions`)).rows[0].n,1);
  assert.equal((await signal(db,s.id)).status,'REJECTED');
});

// ---- Ledger auditor (ops/r181/lineage_invariants.sql) on a fixture ledger -------------------
async function ledger(pg,{signalId,orderId,positionId,buys,sells,original,fee=true}){
  const now=Date.now(),iso=ms=>new Date(ms).toISOString();
  await pg.query(`insert into public.v11_long_regime_signals(id,symbol,status,features,created_at,updated_at,position_id) values($1,'ABCUSDT','CLOSED','{}',$2,$2,$3)`,[signalId,iso(now-3600e3),positionId]);
  await pg.query(`insert into public.gpt_final_entry_reviews(job_key,state,record,purpose,budget_day,reserved_usd,signal_id,symbol,decision,valid,completed_at,created_at)
    values($1,'DONE',$2,'PRODUCTION',current_date,0.1,$3,'ABCUSDT','BUY',true,$4,$4)`,
    [signalId.replace(/-/g,'').padEnd(64,'0'),{identity:{signal_id:signalId},result:{origin:'OPENAI_API',valid:true,decision:'BUY'},
      valid_until_ms:now-3590e3,expires_at_ms:now-3540e3},signalId,iso(now-3598e3)]);
  await pg.query(`insert into public.v11_long_regime_orders(id,signal_id,symbol,intent,state,exchange_order_id,requested_quantity,request_payload,created_at)
    values($1,$2,'ABCUSDT','OPEN_LONG','FILLED','ex-1',$3,'{"entry_ioc_attempt":1}',$4)`,[orderId,signalId,original,iso(now-3595e3)]);
  await pg.query(`insert into public.v11_long_regime_positions(id,signal_id,symbol,original_quantity,remaining_quantity,entry_price,entry_at,state,closed_at,created_at)
    values($1,$2,'ABCUSDT',$3,0,1,$4,'CLOSED',$5,$4)`,[positionId,signalId,original,iso(now-3594e3),iso(now-1800e3)]);
  let n=0;
  for(const [side,rows] of [['BUY',buys],['SELL',sells]])for(const [q,px,tid] of rows)
    await pg.query(`insert into public.exchange_trade_fills(market,exchange_trade_id,side,price,quantity,quote_amount,fee_asset,fee_amount,fee_quote_amount,v17_order_id,v17_position_id,executed_at)
      values('ABCUSDT',$1,$2,$3,$4,$5,'USDT',$6,$7,$8,$9,$10)`,
      [tid??++n+Number(positionId.slice(-4)),side,px,q,px*q,fee?px*q*.0005:null,fee?px*q*.0005:null,side==='BUY'?orderId:null,positionId,iso(now-(side==='BUY'?3593e3:1800e3))]);
}
test('T12 partial fills: exact position quantity attribution (and a mismatch is detected)',async()=>{
  const {pg}=await database();
  await ledger(pg,{signalId:sid(21),orderId:sid(22),positionId:sid(23),original:5,buys:[[3,1],[2,1.001]],sells:[[5,1.02]]});
  let inv=await invariants(pg);assert.equal(inv['INV-09a'],0);assert.equal(inv['INV-09b'],0);assert.equal(inv['INV-07a'],0);assert.equal(inv['INV-07c'],0);
  await ledger(pg,{signalId:sid(31),orderId:sid(32),positionId:sid(33),original:5,buys:[[3,1]],sells:[[5,1.02]]});
  inv=await invariants(pg);assert.equal(inv['INV-09a'],1,'SUM(BUY fills)=3 != position 5');assert.equal(inv['INV-09b'],0);
});
test('T13 duplicate exchange_trade_id is detected',async()=>{
  const {pg}=await database();
  await ledger(pg,{signalId:sid(41),orderId:sid(42),positionId:sid(43),original:5,buys:[[3,1,9001],[2,1,9001]],sells:[[5,1.02,9002]]});
  const inv=await invariants(pg);assert.equal(inv['INV-08'],1);
});
test('T14 fee accounting: exact arithmetic, and a missing fee is detected',async()=>{
  const {pg}=await database();
  await ledger(pg,{signalId:sid(51),orderId:sid(52),positionId:sid(53),original:5,buys:[[5,1.2]],sells:[[5,1.26]]});
  let inv=await invariants(pg);assert.equal(inv['INV-09c'],0);assert.equal(inv['INV-09d'],0);
  const f=(await pg.query(`select side,quote_amount::float8 q,fee_amount::float8 fee from public.exchange_trade_fills order by side`)).rows;
  const net=f.find(x=>x.side==='SELL').q-f.find(x=>x.side==='BUY').q-f.reduce((a,x)=>a+x.fee,0);
  assert.ok(Math.abs(net-(6.3-6-(6+6.3)*.0005))<1e-12,'fee-complete net = proceeds - cost - fees');
  await ledger(pg,{signalId:sid(61),orderId:sid(62),positionId:sid(63),original:1,buys:[[1,1]],sells:[[1,1]],fee:false});
  inv=await invariants(pg);assert.equal(inv['INV-09c'],2,'both fee-less fills are flagged');
});
test('T15 rolling-window change: new trades, aged-out trades and accounting adjustments are separated exactly',()=>{
  const H=3600e3,t0=100*H,t1=t0+2*H,W=24*H;
  const previous=[{id:'a',closedAt:t0-23.5*H,net:2.10},{id:'b',closedAt:t0-22.9*H,net:1.60},{id:'c',closedAt:t0-3*H,net:-0.50},{id:'d',closedAt:t0-1*H,net:0.40}];
  const current=[...previous.filter(x=>x.id!=='d'),{id:'d',closedAt:t0-1*H,net:0.35},{id:'e',closedAt:t0+H,net:0.01}];
  const r=decomposeWindowChange({previous,current,prevAsOfMs:t0,asOfMs:t1,windowMs:W});
  assert.equal(r.previousTotal,3.6);assert.equal(r.currentTotal,-0.14);assert.equal(r.delta,-3.74);
  assert.deepEqual(r.agedOut,{count:2,net:3.7,ids:['a','b']});
  assert.deepEqual(r.newClosed,{count:1,net:0.01,ids:['e']});
  assert.equal(r.adjustment.net,-0.05);assert.deepEqual(r.adjustment.trades,[{id:'d',before:.4,after:.35,change:-0.05}]);
  const s=tradeStats(current.filter(x=>x.closedAt>t1-W));assert.equal(s.trades,3);assert.equal(s.maxDrawdown,0.5);
});
test('INV-10 journal: a provider failure labelled GPT_ABSTAIN is flagged; a valid ABSTAIN and a source-labelled failure are not',async()=>{
  const {pg}=await database();
  for(const [id,valid,error,label] of [[sid(71),false,'HTTP_429','GPT_ABSTAIN'],[sid(72),true,null,'GPT_ABSTAIN'],
    [sid(73),false,'HTTP_429','GPT_NO_VALID_API_RESPONSE:PROVIDER_ERROR:HTTP_429']]){
    await pg.query(`insert into public.v11_long_regime_signals(id,symbol,status,features) values($1,'ABCUSDT','REJECTED','{}')`,[id]);
    await pg.query(`insert into public.gpt_final_entry_reviews(job_key,state,record,purpose,budget_day,reserved_usd,signal_id,symbol,decision,valid,error,completed_at,created_at)
      values($1,'DONE',$2,'PRODUCTION',current_date,0.1,$3,'ABCUSDT','ABSTAIN',$4,$5,now(),now())`,
      [id.replace(/-/g,'').padEnd(64,'0'),{identity:{signal_id:id},result:{origin:'OPENAI_API',valid,error,decision:'ABSTAIN'}},id,valid,error]);
    await pg.query(`insert into public.missed_opportunity_journal(signal_id,terminal_class,reject_reason) values($1,'GPT_REJECTED',$2)`,[id,label]);
  }
  assert.equal((await invariants(pg))['INV-10'],1);
});
test('lineage summary query runs and splits provider failures from GPT judgments',async()=>{
  const {pg,db}=await database(),s=fresh(81),clock=()=>s.trig+1500,row=await seed(db,s);
  const {c}=worker(db,{openai:()=>new Response('{"error":{}}',{status:429}),clock});await c.consider(row);await drain(c);
  const rows=(await pg.query(read('../ops/r181/lineage_summary.sql'))).rows;
  assert.deepEqual(rows.map(r=>r.label),['24h','48h','7d']);
  const d=rows[2];assert.equal(Number(d.provider_error),1);assert.equal(Number(d.valid_abstain),0);assert.equal(Number(d.gpt_nonbuy_mislabelled),0);
});
