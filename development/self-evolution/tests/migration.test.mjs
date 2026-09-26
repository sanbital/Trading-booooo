import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {pathToFileURL} from 'node:url';
import {baselinePolicy} from '../../../supabase/functions/_shared/self-evolution/policy.mjs';
const mod=process.env.PGLITE_MODULE;if(!mod)throw Error('PGLITE_MODULE required; migration tests must not silently skip');
const {PGlite}=await import(mod.startsWith('file:')?mod:pathToFileURL(mod).href);
const sql=await fs.readFile(new URL('../../../supabase/migrations/20260926162403_autonomous_decision_evolution.sql',import.meta.url),'utf8');
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
 await db.exec(await fs.readFile(new URL('../../../supabase/migrations/20260926172019_evolution_v105_baseline.sql',import.meta.url),'utf8'));
 const rebased=(await db.query('select evolution_active_policy() a')).rows[0].a;
 assert.equal(rebased.bundle.policy_version,'POLICY_BASELINE_V105');
 assert.equal(rebased.bundle.parent_version,'POLICY_BASELINE_V104');
 assert.deepEqual((await db.query('select capital_manifest from evolution_control')).rows[0].capital_manifest,capital);
 assert.equal((await db.query("select count(*)::int n from evolution_policy_bundles where version='POLICY_BASELINE_V104'")).rows[0].n,1);
 await assert.rejects(()=>db.exec("update evolution_policy_bundles set sha256=repeat('c',64) where version='POLICY_BASELINE_V105'"),/IMMUTABLE/);
 }finally{await db.close();}});
