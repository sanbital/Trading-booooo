// LE-SHADOW-1 database contract on PGlite (real Postgres semantics): dedicated role privileges,
// append-only enforcement, budget ledger caps, and full scan/outcome/link cycles executed AS
// shadow_le_writer against the real migration.
// Requires PGLITE_MODULE=<path to @electric-sql/pglite/dist/index.js>.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setupDb,addObserver,symbols,world,MIN} from './leader-emerging-shadow-helpers.mjs';
import {createGuard} from '../supabase/functions/leader-emerging-shadow/guard.mjs';
import {runScan,runOutcome,runDiagnostic,runWait} from '../supabase/functions/leader-emerging-shadow/shadow.mjs';
import {kstDayStart} from '../supabase/functions/leader-emerging-shadow/universe.mjs';

const denied=async(p,re=/permission denied|APPEND_ONLY|must be owner|violates/)=>{await assert.rejects(p,e=>re.test(e.message));};

test('writer role: INSERT/SELECT on shadow_le only; production is read-only; no UPDATE/DELETE anywhere', async()=>{
  const {pg}=await setupDb();
  await pg.exec('set role shadow_le_writer');
  // production: SELECT granted tables works (RLS bypassed for reads, no policy added)
  for(const t of ['market_regime_observations','v17_market_scan_runs','v11_cec0040_state','v11_long_regime_signals','v11_long_regime_orders',
    'v11_long_regime_positions','gpt_final_entry_reviews','gpt_final_review_daily_budget'])await pg.query(`select count(*) from public.${t}`);
  assert.equal((await pg.query('select count(*)::int n from public.v11_cec0040_state')).rows[0].n,1);
  // production writes: every one denied
  await denied(pg.query(`insert into public.v11_long_regime_signals(symbol,status) values ('XUSDT','NEW')`));
  await denied(pg.query(`update public.v11_cec0040_state set reject_run=1`));
  await denied(pg.query(`delete from public.gpt_final_entry_reviews`));
  await denied(pg.query(`insert into public.gpt_final_review_daily_budget(utc_day,calls) values (current_date,1)`));
  await denied(pg.query(`select * from public.trading_settings`));
  await denied(pg.query(`update public.trading_settings set binance_futures_allocation_usdt=150`));
  await denied(pg.query(`create table public.x(a int)`));
  await denied(pg.query(`create table shadow_le.x(a int)`));
  // shadow_le: control is operator-owned (read only for the writer); budget only through functions
  await denied(pg.query(`update shadow_le.control set enabled=false`));
  await denied(pg.query(`insert into shadow_le.budget(utc_day,kind,calls,usd) values (current_date,'RESERVE',1,0.01)`));
  await pg.exec('reset role');
});

test('append-only: UPDATE/DELETE/TRUNCATE raise for every role, including the owner', async()=>{
  const {pg}=await setupDb();
  await pg.query(`insert into shadow_le.cycles(mode,status,started_at,finished_at,patch) values ('OUTCOME','OK',now(),now(),'t')`);
  await pg.query(`select shadow_le.budget_reserve(0.01,'t')`);
  for(const t of ['cycles','budget','control_log']){
    await denied(pg.query(`update shadow_le.${t} set created_at=now()`.replace('created_at',t==='control_log'?'logged_at':'created_at')));
    await denied(pg.query(`delete from shadow_le.${t}`));
    await denied(pg.query(`truncate shadow_le.${t}`),/APPEND_ONLY|cannot truncate a table referenced/);
  }
  await denied(pg.query(`delete from shadow_le.control`));
  // control: operator UPDATE is the kill switch, and every change is logged append-only
  await pg.query(`update shadow_le.control set enabled=false, set_by='test', reason='kill'`);
  const log=(await pg.query(`select enabled from shadow_le.control_log order by log_id`)).rows.map(r=>r.enabled);
  assert.deepEqual(log,[true,false]);
  await denied(pg.query(`update shadow_le.control set enabled=false, gpt_enabled=true`),/check/);
  const hyp=(await pg.query(`select count(*)::int n from information_schema.columns where table_schema='shadow_le' and column_name='is_hypothetical'`)).rows[0].n;
  assert.equal(hyp,4);
});

test('budget ledger: 250 calls/day, 1.00 USD/day, 2 in flight, caps cannot be raised by the caller', async()=>{
  const {store,admin}=await setupDb();
  const a=await store.budgetReserve(.01,'t'),b=await store.budgetReserve(.01,'t'),c=await store.budgetReserve(.01,'t');
  assert.equal(a.ok,true);assert.equal(b.ok,true);assert.equal(c.ok,false);assert.equal(c.reason,'SHADOW_BUDGET_INFLIGHT');
  await store.budgetSettle(a.reservation_id,.003);await store.budgetSettle(b.reservation_id,.003);
  const st=await store.q('budgetState').then(r=>r[0].r);assert.equal(st.calls,2);assert.ok(Math.abs(Number(st.spend_usd)-.006)<1e-9);
  // USD cap: 0.05-USD reservations reach 1.00 after 20 settled calls
  for(let i=0;i<19;i++){const r=await store.budgetReserve(.05,'t');assert.equal(r.ok,true,JSON.stringify(r));await store.budgetSettle(r.reservation_id,.05);}
  const over=await store.budgetReserve(.05,'t');assert.equal(over.ok,false);assert.equal(over.reason,'SHADOW_BUDGET_USD');
  await assert.rejects(admin.query(`select shadow_le.budget_reserve(0.01,'x',300,1.0,2)`),/CAP_ABOVE_REGISTERED/);
  await assert.rejects(admin.query(`select shadow_le.budget_reserve(0.01,'x',250,2.0,2)`),/CAP_ABOVE_REGISTERED/);
  await assert.rejects(admin.query(`select shadow_le.budget_reserve(0.01,'x',250,1.0,5)`),/CAP_ABOVE_REGISTERED/);
});

test('budget ledger: call cap 250 per UTC day', async()=>{
  const {admin,store}=await setupDb();
  // 249 settled tiny reservations inserted directly by the owner to reach the edge fast
  await admin.query(`insert into shadow_le.budget(utc_day,kind,calls,usd,purpose) select (now() at time zone 'utc')::date,'RESERVE',1,0.0001,'seed' from generate_series(1,249)`);
  await admin.query(`insert into shadow_le.budget(utc_day,kind,reservation_id,calls,usd,purpose) select utc_day,'SETTLE',entry_id,0,0.0001,'seed' from shadow_le.budget where kind='RESERVE'`);
  const last=await store.budgetReserve(.001,'t');assert.equal(last.ok,true);await store.budgetSettle(last.reservation_id,.001);
  const over=await store.budgetReserve(.001,'t');assert.equal(over.ok,false);assert.equal(over.reason,'SHADOW_BUDGET_CALLS');
});

test('production GPT health (stand-down input) reads PRODUCTION reviews only', async()=>{
  const {admin,store}=await setupDb();
  await admin.query(`insert into public.gpt_final_entry_reviews(job_key,purpose,decision,valid,error,attempted,record) values
    ('a','PRODUCTION','ABSTAIN',false,'HTTP_429',true,'{"result":{"error_detail":{"code":"insufficient_quota"}}}'),
    ('b','PRODUCTION','BUY',true,null,true,'{}'),('c','DRYRUN','ABSTAIN',false,'HTTP_500',true,'{}')`);
  await admin.query(`insert into public.gpt_final_review_daily_budget values ((now() at time zone 'utc')::date, 19, 0.1, 0.06)`);
  const h=await store.gptHealth();
  assert.deepEqual({n:h.n_60m,err:h.n_err_60m,quota:h.n_quota_60m,calls:h.ledger_calls_today},{n:2,err:1,quota:1,calls:19});
});

/** A 520-symbol market where C000..C029 rise most today; C040 jumps from ~rank 41 to ~rank 5. */
async function market(admin,t,{jump=true}={}){
  const syms=symbols(520),dayStart=kstDayStart(t);
  const anchor=Object.fromEntries(syms.map(s=>[s,1]));
  await addObserver(admin,dayStart+5000,anchor);
  const at=(k)=>Object.fromEntries(syms.map((s,i)=>[s,1+(520-i)/1000+(jump&&s==='C040USDT'&&k===0?.035:0)]));
  for(const k of [60,30,15])await addObserver(admin,t-k*MIN,at(k));
  await addObserver(admin,t,at(0));
  return syms;
}

test('scan end-to-end AS shadow_le_writer: ranks, lanes, shortlist <=3, deterministic arms, one atomic write, weight <=100', async()=>{
  const {store,admin}=await setupDb();
  const t=Date.now()-20_000;
  // skip the post-midnight blackout: only run when >=90 min into the KST day
  if(t-kstDayStart(t)<90*MIN)return;
  const syms=await market(admin,t);
  // earlier cycles so velocity has a reference
  const w=world({exchangeSymbols:syms});
  // seed reference ranks with three prior scans at the historical snapshots
  for(const k of [60,30,15]){
    await admin.query(`insert into shadow_le.cycles(mode,status,started_at,finished_at,kst_day,observation_bucket,observed_at,rank_order,arms_active,patch)
      values ('SCAN','OK',$1,$1,$2,$3,$1,$4,'[]','seed')`,[new Date(t-k*MIN).toISOString(),new Date(kstDayStart(t)+9*3600_000).toISOString().slice(0,10),
      new Date(Math.floor((t-k*MIN)/300000)*300000+2000).toISOString(),JSON.stringify(syms)]);
  }
  const guard=createGuard({fetchFn:w.fetchFn});
  const out=await runScan({store,guard,now:Date.now});
  assert.equal(out.status,'OK',JSON.stringify(out));
  assert.equal(out.top30.length,30);
  assert.ok(out.shortlist.length<=3);
  assert.ok(out.shortlist.includes('C040USDT'),JSON.stringify(out));
  assert.ok(out.request_weight<=100,String(out.request_weight));
  assert.ok(w.calls.every(c=>c.method==='GET'&&c.host==='fapi.binance.com'));
  const n=(await admin.query(`select count(*)::int n from shadow_le.candidates`))[0].n;assert.equal(n,30);
  const d=await admin.query(`select arm, decision, hyp_entry_ask from shadow_le.decisions order by decision_id`);
  assert.ok(d.length>=2&&d.every(x=>['RULE_BASELINE','TAKE_ALL'].includes(x.arm)));
  assert.ok(d.every(x=>x.hyp_entry_ask>0));
  const em=(await admin.query(`select lane, velocity_valid, rank_60m, rank_now from shadow_le.candidates where symbol='C040USDT'`))[0];
  assert.equal(em.lane,'EMERGING');assert.equal(em.velocity_valid,true);assert.ok(em.rank_60m-em.rank_now>=20);
  // same observer bucket again: nothing written, no Binance
  const before=w.calls.length,again=await runScan({store,guard:createGuard({fetchFn:w.fetchFn}),now:Date.now});
  assert.equal(again.status,'DUPLICATE_BUCKET');assert.equal(w.calls.length,before);
  // kill switch 1: control.enabled=false -> no Binance, no write
  await admin.query(`update shadow_le.control set enabled=false, set_by='t', reason='kill'`);
  const off=await runScan({store,guard:createGuard({fetchFn:w.fetchFn}),now:Date.now});
  assert.equal(off.status,'DISABLED');assert.equal(w.calls.length,before);
  // diagnostic writes nothing
  await admin.query(`update shadow_le.control set enabled=true, set_by='t', reason='on'`);
  const rowsBefore=(await admin.query(`select (select count(*) from shadow_le.cycles)+(select count(*) from shadow_le.candidates) n`))[0].n;
  await runDiagnostic({store,guard:createGuard({fetchFn:w.fetchFn}),now:Date.now});
  const rowsAfter=(await admin.query(`select (select count(*) from shadow_le.cycles)+(select count(*) from shadow_le.candidates) n`))[0].n;
  assert.equal(Number(rowsAfter),Number(rowsBefore));
});

test('scan: a Binance 429 halts Binance for the rest of the UTC day', async()=>{
  const {store,admin}=await setupDb();
  const t=Date.now()-20_000;if(t-kstDayStart(t)<90*MIN)return;
  const syms=await market(admin,t);
  const w=world({exchangeSymbols:syms,status:429});
  const out=await runScan({store,guard:createGuard({fetchFn:w.fetchFn}),now:Date.now});
  assert.equal(out.status,'NO_ANCHOR');
  const halted=await store.haltedToday();assert.equal(halted.binance_status,'BINANCE_HTTP_429');
  const n=w.calls.length,next=await runScan({store,guard:createGuard({fetchFn:w.fetchFn}),now:Date.now});
  assert.equal(next.status,'HALTED_TODAY');assert.equal(w.calls.length,n);
});

test('scan: shared-IP used weight >= 1200 aborts the cycle before further reads', async()=>{
  const {store,admin}=await setupDb();
  const t=Date.now()-20_000;if(t-kstDayStart(t)<90*MIN)return;
  const syms=await market(admin,t);
  const w=world({exchangeSymbols:syms,usedWeight:n=>n>=2?1250:100});
  const out=await runScan({store,guard:createGuard({fetchFn:w.fetchFn}),now:Date.now});
  assert.equal(out.binance_status,'SHARED_IP_WEIGHT_HIGH');
  assert.ok(w.calls.length<=2,String(w.calls.length));
});

test('outcome: observer labels (weight 0) and production link run AS the writer', async()=>{
  const {store,admin}=await setupDb();
  const t=Date.now()-6*3600_000,day=new Date(kstDayStart(t)+9*3600_000).toISOString().slice(0,10);
  const c=await admin.query(`insert into shadow_le.cycles(mode,status,started_at,finished_at,kst_day,observation_bucket,observed_at,arms_active,patch)
    values ('SCAN','OK',$1,$1,$2,$1,$1,'["RULE_BASELINE","TAKE_ALL"]','seed') returning cycle_id`,[new Date(t).toISOString(),day]);
  await admin.query(`insert into shadow_le.candidates(cycle_id,observed_at,kst_day,symbol,lane,rank_now,velocity_valid,minutes_since_kst_midnight,first_top3_today,
    leader_reentry_60m,first_top10_today,minutes_in_top10_today,day_return_live,obs_price,shortlisted,selection_reason)
    values ($1,$2,$3,'AUSDT','CONTROL',12,false,300,false,false,false,0,0.1,100,false,'CONTROL')`,[c[0].cycle_id,new Date(t).toISOString(),day]);
  for(const m of [5,15,30,60,120,240])await addObserver(admin,t+m*MIN,{AUSDT:100*(1+m/1000)});
  await admin.query(`insert into public.v11_long_regime_signals(symbol,status,features,created_at) values ('AUSDT','ORDERED','{"v30Front":{"admitted":true}}',$1)`,[new Date(t+5*MIN).toISOString()]);
  await admin.query(`insert into public.gpt_final_entry_reviews(job_key,purpose,symbol,decision,created_at) values ('k','PRODUCTION','AUSDT','BUY',$1)`,[new Date(t+6*MIN).toISOString()]);
  const out=await runOutcome({store,guard:createGuard({fetchFn:world().fetchFn}),now:Date.now});
  assert.equal(out.observer,1);assert.equal(out.linked,1);
  const o=(await admin.query(`select hyp_fwd_60m, hyp_fwd_240m, data_complete, entry_ref from shadow_le.outcomes`))[0];
  assert.ok(Math.abs(o.hyp_fwd_60m-.06)<1e-9);assert.ok(Math.abs(o.hyp_fwd_240m-.24)<1e-9);assert.equal(o.data_complete,true);
  const l=(await admin.query(`select prod_gpt_buy, prod_v30_admitted, link_stage from shadow_le.production_link`))[0];
  assert.deepEqual(l,{prod_gpt_buy:true,prod_v30_admitted:true,link_stage:'FINAL'});
  const g=(await admin.query(`select grp from shadow_le.v_compare`)).map(r=>r.grp);
  assert.deepEqual(g,['2_CURRENT_BUY_ALT_SKIP_WAIT','2_CURRENT_BUY_ALT_SKIP_WAIT']);
  // idempotent
  const again=await runOutcome({store,guard:createGuard({fetchFn:world().fetchFn}),now:Date.now});
  assert.equal(again.observer,0);assert.equal(again.linked,0);
});

test('wait mode with no active WAIT does nothing (stage 1)', async()=>{
  const {store}=await setupDb();
  const w=world();
  const out=await runWait({store,guard:createGuard({fetchFn:w.fetchFn}),now:Date.now});
  assert.equal(out.status,'NO_ACTIVE_WAIT');assert.equal(w.calls.length,0);
});
