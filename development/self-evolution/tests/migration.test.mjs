import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {pathToFileURL} from 'node:url';
import {baselinePolicy} from '../../../supabase/functions/_shared/self-evolution/policy.mjs';
const mod=process.env.PGLITE_MODULE;if(!mod)throw Error('PGLITE_MODULE required; migration tests must not silently skip');
const {PGlite}=await import(mod.startsWith('file:')?mod:pathToFileURL(mod).href);
const sql=await fs.readFile(new URL('../../../supabase/migrations/20260926171719_autonomous_decision_evolution.sql',import.meta.url),'utf8');
test('additive migration, role isolation, claim fencing, scope and immutable baseline',async()=>{const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema doa_capture;
 create table public.gpt_final_entry_reviews(job_key text primary key,record jsonb,purpose text,state text,symbol text,snapshot_at timestamptz,created_at timestamptz);
 create table public.v11_long_regime_positions(id uuid,signal_id uuid,symbol text,state text,entry_at timestamptz,closed_at timestamptz,realized_pnl_usdt numeric);
 create table doa_capture.live_micro(kind text,symbol text,at timestamptz,received_at timestamptz,payload jsonb);`);
 await db.exec(sql);const p={...baselinePolicy(),policy_version:'POLICY_BASELINE_V104',parent_version:null};
 assert.equal((await db.query('select public.evolution_scope_valid($1::jsonb) ok',[JSON.stringify(p)])).rows[0].ok,true);
 for(const key of ['margin','leverage','withdrawal']){assert.equal((await db.query('select public.evolution_scope_valid($1::jsonb) ok',[JSON.stringify({...p,[key]:2})])).rows[0].ok,false);}
 for(const change of [q=>q.stages.ENTRY.feature_weights=[{feature:'acceleration',weight:null}],q=>q.calibration=[{provider:'gpt',stage:'ENTRY',regime:'BREAKOUT',n:null,correct:0,accuracy:0,lower:0,upper:1,as_of_ms:0,metric:'NET_DIRECTION_60S'}],q=>q.stages.ENTRY.gpt_rubric=null]){const q=structuredClone(p);change(q);assert.equal((await db.query('select evolution_scope_valid($1::jsonb) ok',[JSON.stringify(q)])).rows[0].ok,false);}
 await db.query("insert into evolution_policy_bundles(version,bundle,sha256,source_manifest,data_cutoff)values($1,$2,$3,'{}',now())",[p.policy_version,JSON.stringify(p),'a'.repeat(64)]);
 assert.equal((await db.query('select evolution_bootstrap($1) ok',[p.policy_version])).rows[0].ok,true);
 assert.equal((await db.query('select evolution_bootstrap($1) ok',[p.policy_version])).rows[0].ok,false);
 await assert.rejects(()=>db.exec("update evolution_policy_bundles set sha256=repeat('b',64)"),/IMMUTABLE/);
 await db.exec("insert into evolution_control(singleton,capital_manifest,baseline_source)values(true,'{}','{}');insert into evolution_jobs(dedupe_key,kind)values('one','MONITOR');");
 const job=(await db.query('select evolution_claim_job() j')).rows[0].j;assert.equal(job.state,'RUNNING');assert.equal((await db.query('select evolution_claim_job() j')).rows[0].j,null);
 assert.equal((await db.query('select evolution_finish_job($1,$2,$3) ok',[job.id,'00000000-0000-0000-0000-000000000000','{}'])).rows[0].ok,false);
 assert.equal((await db.query('select evolution_finish_job($1,$2,$3) ok',[job.id,job.owner,'{}'])).rows[0].ok,true);
 await db.exec('set role anon');await assert.rejects(()=>db.query('select evolution_active_policy()'),/permission/);await db.exec('reset role');
 await db.exec('set role service_role');await assert.rejects(()=>db.exec("update evolution_private.active_policy set generation=99"),/permission/);await db.exec('reset role');
 await assert.rejects(()=>db.query('select evolution_promote($1,$2)',['fake',p.policy_version]),/INTEGRITY/);

 const next=structuredClone(p);next.policy_version='POLICY_TEST';next.parent_version=p.policy_version;
 await db.query("insert into evolution_policy_bundles(version,parent_version,bundle,sha256,source_manifest,data_cutoff,created_at)values($1,$2,$3,$4,'{}',now()-interval '31 days',now()-interval '30 days')",[next.policy_version,p.policy_version,JSON.stringify(next),'b'.repeat(64)]);
 await db.query("insert into evolution_policy_states(version,state)values($1,'QUALIFIED')",[next.policy_version]);
 const base={n:100,expectancy:1,net_usdt:100,max_drawdown:5,worst_loss:-2,tail_loss:-1},good={champion:base,challenger:{...base,expectancy:1.2,net_usdt:120},bootstrap:{lower:.1},max_symbol_profit_share:.1,max_day_profit_share:.1,positive_regime_fraction:1,winner_retention_ratio:1};
 const report={scope_valid:true,integrity_valid:true,execution_parity:true,counterfactual_costs:true,market_wide:true,future_leakage:false,split_overlap:false,holdout_complete:true,actual_trade_replay:true,universe_coverage:1,complete_lifecycle_coverage:1,days:21,symbols:25,regimes:3,holdout_uses:1,discovery_end:0,validation_start:Date.now()-29*86400000,validation_end:Date.now()-15*86400000,holdout_start:Date.now()-14*86400000,validation:good,holdout:good};
 for(const split of ['VALIDATION','HOLDOUT','ACTUAL_VALIDATION','ACTUAL_HOLDOUT'])for(const arm of ['champion','challenger'])await db.query("insert into evolution_portfolios(id,policy_version,split,arm,state)values($1,$2,$3,$4,$5)",[split+arm,next.policy_version,split,arm,JSON.stringify({trades:Array(100).fill({net_usdt:1})})]);
 for(const [id,r] of [['nullmetric',{...report,holdout:{...good,challenger:{...good.challenger,worst_loss:null}}}],['missingflag',{...report,holdout_complete:null}],['good',report]])await db.query("insert into evolution_evaluations(id,policy_version,champion_version,policy_hash,champion_hash,dataset_hash,report,qualified)values($1,$2,$3,$4,$5,'dataset',$6,true)",[id,next.policy_version,p.policy_version,'b'.repeat(64),'a'.repeat(64),JSON.stringify(r)]);
 await assert.rejects(()=>db.query('select evolution_promote($1,$2)',['nullmetric',p.policy_version]),/METRIC_MISSING/);
 await assert.rejects(()=>db.query('select evolution_promote($1,$2)',['missingflag',p.policy_version]),/QUALIFICATION/);
 const promoted=(await db.query('select evolution_promote($1,$2) p',['good',p.policy_version])).rows[0].p;assert.equal(promoted.state,'PROMOTING');
 assert.equal((await db.query('select evolution_policy_health() h')).rows[0].h.state,'PROMOTING');
 await assert.rejects(()=>db.query("select evolution_rollback($1,'MODEL_DISLIKES_IT','{}')",[next.policy_version]),/ROLLBACK_REASON/);
 const rolled=(await db.query("select evolution_rollback($1,'POLICY_INTEGRITY','{}') r",[next.policy_version])).rows[0].r;assert.equal(rolled.active,p.policy_version);
 assert.equal((await db.query("select count(*)::int n from evolution_jobs where kind='FULL_REVIEW'")).rows[0].n,1);
 const capital=(await db.query('select capital_manifest from evolution_control')).rows[0].capital_manifest;
 await db.exec(await fs.readFile(new URL('../../../supabase/migrations/20260926173042_evolution_v105_baseline.sql',import.meta.url),'utf8'));
 const rebased=(await db.query('select evolution_active_policy() a')).rows[0].a;
 assert.equal(rebased.bundle.policy_version,'POLICY_BASELINE_V105');
 assert.equal(rebased.bundle.parent_version,'POLICY_BASELINE_V104');
 assert.deepEqual((await db.query('select capital_manifest from evolution_control')).rows[0].capital_manifest,capital);
 assert.equal((await db.query("select count(*)::int n from evolution_policy_bundles where version='POLICY_BASELINE_V104'")).rows[0].n,1);
 await assert.rejects(()=>db.exec("update evolution_policy_bundles set sha256=repeat('c',64) where version='POLICY_BASELINE_V105'"),/IMMUTABLE/);
 await db.exec(await fs.readFile(new URL('../../../supabase/migrations/20260926174101_evolution_scope_and_recovery.sql',import.meta.url),'utf8'));
 const candidate={...baselinePolicy(),policy_version:'POLICY_ATOMIC',parent_version:'POLICY_BASELINE_V105'};
 candidate.stages.RECHECK.deepseek_rubric=['Recheck must re-prove fresh marginal demand.'];
 assert.equal((await db.query('select evolution_scope_valid($1::jsonb) ok',[JSON.stringify(candidate)])).rows[0].ok,true);
 for(const forbidden of ['increase margin','change leverage','position size doubled','withdraw funds','relax hard stop','eval(code)']){const bad=structuredClone(candidate);bad.stages.ENTRY.gpt_rubric=[forbidden];assert.equal((await db.query('select evolution_scope_valid($1::jsonb) ok',[JSON.stringify(bad)])).rows[0].ok,false);}
 const hypothesis={id:'HYP_ATOMIC',description:'Evidence interpretation',proposal:{},critique:{},supporting_patterns:[],policy_version:candidate.policy_version};
 const registered=(await db.query('select evolution_register_candidate($1,$2,$3) r',[JSON.stringify(hypothesis),JSON.stringify(candidate),'d'.repeat(64)])).rows[0].r;assert.equal(registered.state,'SIMULATING');
 assert.equal((await db.query('select evolution_register_candidate($1,$2,$3) r',[JSON.stringify(hypothesis),JSON.stringify(candidate),'d'.repeat(64)])).rows[0].r.duplicate,true);
 await assert.rejects(()=>db.query('select evolution_register_candidate($1,$2,$3)',[JSON.stringify(hypothesis),JSON.stringify(candidate),'e'.repeat(64)]),/IMMUTABLE_CONFLICT/);
 assert.equal((await db.query("select count(*)::int n from evolution_jobs where dedupe_key='simulate:POLICY_ATOMIC'")).rows[0].n,1);
 assert.equal((await db.query('select evolution_active_policy() a')).rows[0].a.bundle.policy_version,'POLICY_BASELINE_V105','registration cannot promote');
 }finally{await db.close();}});

test('historical capture is causal at its cutoff, without live heartbeat dependence',async()=>{
 const db=new PGlite();try{
  await db.exec(`create table public.evolution_market_frames(kind text,symbol text,at timestamptz,received_at timestamptz,payload jsonb);
   create table public.v11_long_regime_positions(id uuid,symbol text,state text);`);
  await db.exec(await fs.readFile(new URL('../../../supabase/migrations/20260926180102_evolution_replay_receipt_cutoff.sql',import.meta.url),'utf8'));
  const end=Date.parse('2020-01-01T00:10:00Z'),iso=n=>new Date(n).toISOString();
  function payload(t){const candle=Math.floor(t/60000)*60000;return {interval_start:iso(t-5000),interval_end:iso(t),interval_ms:5000,
   bucket_complete:true,book_complete:true,trade_sequence_complete:true,coverage_25:true,flow_causal:true,trade_count:0,
   mid:100,exchange_at:iso(t-20),received_at:iso(t-10),spread_bps:1,buy_quote_5s:600,sell_quote_5s:400,
   ask_25_usdt:10000,bid_25_usdt:11000,buy_vwap_450:100.01,sell_vwap_450:99.99,
   btc_candle_complete:true,btc_return_1m:0.001,btc_candle_at:iso(candle-60000),btc_candle_end_ms:candle,
   btc_candle_exchange_ms:candle-1,btc_candle_received_ms:candle,best_bid:99.99,best_ask:100.01,
   observed_bid_depth_usdt:11000,observed_ask_depth_usdt:10000,depth_bid_coverage_bps:25,depth_ask_coverage_bps:25,
   depth_coverage_complete:true,depth_bid_boundary:99.75,depth_ask_boundary:100.25};}
  async function put(t,received){await db.query("insert into evolution_market_frames values('micro','BTCUSDT',$1,$2,$3)",[iso(t),iso(received),JSON.stringify(payload(t))]);}
  const context=async(cut=end+1000)=>(await db.query('select evolution_capture_context($1,$2,null) c,evolution_market_sensor($1,$2) s',['BTCUSDT',iso(cut)])).rows[0];
  for(let i=24;i>=0;i--)await put(end-i*5000,end-i*5000+200);
  let r=await context();assert.equal(r.c.status,'AVAILABLE');assert.equal(r.s.status,'AVAILABLE');assert.equal(r.c.trajectory.length,24);assert.equal(r.s.market_sensor_trajectory.length,24);
  assert.ok(r.c.trajectory.every(p=>p.received_at_ms<=end+1000));
  await put(end+500,end+2000);r=await context();assert.equal(r.c.status,'AVAILABLE','late-arriving frame cannot poison a past snapshot');assert.equal(r.s.status,'AVAILABLE');
  await db.query('delete from evolution_market_frames where at>$1',[iso(end)]);
  await put(end+5000,end+500);r=await context();assert.equal(r.c.reason,'FUTURE_BUCKET');assert.equal(r.s.reason,'FUTURE_BUCKET');
  await db.query('delete from evolution_market_frames where at>$1',[iso(end)]);
  r=await context(end+30000);assert.equal(r.c.reason,'STALE_BUCKET');assert.equal(r.s.reason,'STALE_BUCKET');
  r=await context(Date.now()+60000);assert.equal(r.c.reason,'STALE_OR_FUTURE');assert.equal(r.s.reason,'STALE_OR_FUTURE');
  await db.query('delete from evolution_market_frames where at=$1',[iso(end-60000)]);r=await context();assert.notEqual(r.c.status,'AVAILABLE');assert.notEqual(r.s.status,'AVAILABLE');
 }finally{await db.close();}
});

