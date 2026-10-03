import fs from 'node:fs';import {spawnSync} from 'node:child_process';
import {createHash,createCipheriv,publicEncrypt,randomBytes} from 'node:crypto';
import {readVenue,reconcileHoldings,reconcileTrades} from './preflight-read.mjs';
import {readReadiness} from './readiness-read.mjs';
import {GATEWAY_APPS,expectedGatewayCommit} from './gateway-source.mjs';
import {ENGINE,assertAccountProof,assertActivation,assertResume,protectedSettings} from './release-policy.mjs';
import {serviceSourceRoot} from './service-source.mjs';
import {serviceIdentity,assertLatencySource} from './service-identity.mjs';
const project='etaajwpernzrcdrifdnw',sha=process.env.GITHUB_SHA,operation=process.env.CUTOVER_OPERATION;
if(process.env.GITHUB_REPOSITORY!=='sanbital/Trading-booooo'||process.env.GITHUB_REF!=='refs/heads/main'||sha!==process.env.EXPECTED_COMMIT||!/^[a-f0-9]{40}$/.test(sha??'')||!['stage','repair-capture','repair-entry','repair-latency','verify','verify-resume','activate'].includes(operation))throw Error('EXACT_MAIN_RELEASE_REQUIRED');
if(operation==='repair-entry'&&process.env.ENTRY_REPAIR_CONFIRMATION!=='PLANNED_ENTRY_REPAIR_1')throw Error('ENTRY_REPAIR_EXACT_BASELINE_REQUIRED');
if(operation==='repair-latency'&&process.env.LATENCY_REPAIR_CONFIRMATION!=='EXECUTOR_LATENCY_REPAIR_1')throw Error('LATENCY_REPAIR_EXACT_BASELINE_REQUIRED');
const request=JSON.parse(fs.readFileSync('ops/deterministic/release-request.json','utf8'));
const sourceSha=request.staged_source_commit??sha;
fs.mkdirSync('infra-evidence',{recursive:true});const evidence={source_commit:sha,operation,started_at:new Date().toISOString(),stages:[],order_commands:0};
function save(){const key=randomBytes(32),iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([c.update(JSON.stringify(evidence)),c.final()]);
 fs.writeFileSync('infra-evidence/deterministic-release.encrypted.json',JSON.stringify({version:1,key:publicEncrypt({key:fs.readFileSync('ops/execution-infra/evidence-public.pem'),oaepHash:'sha256'},key).toString('base64'),iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),data:data.toString('base64')}));}
function note(stage,detail={}){const s={stage,utc:new Date().toISOString(),...detail};evidence.stages.push(s);save();console.log(JSON.stringify(s));}
async function query(query){const r=await fetch(`https://api.supabase.com/v1/projects/${project}/database/query`,{method:'POST',headers:{authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN,'content-type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('RELEASE_DB_HTTP_'+r.status);return r.json();}
const value=async q=>(await query(q))[0]?.evidence;
const run=(cmd,args,options={})=>{const r=spawnSync(cmd,args,{encoding:'utf8',maxBuffer:16*1024*1024,...options});if(r.status!==0)throw Error('RELEASE_COMMAND_FAILED_'+cmd.replaceAll('-','_'));return r.stdout;};
const pauseSQL="begin;set local lock_timeout='750ms';update public.trading_settings set pause_new_entries=true where id=1;commit;";
const stateSQL=`select jsonb_build_object('utc',clock_timestamp(),'postmaster',pg_postmaster_start_time(),
 'runtime',(select to_jsonb(r) from v11_long_regime_runtime r where singleton),
 'settings',(select to_jsonb(s) from trading_settings s where id=1),
 'operator',(select to_jsonb(c) from v17_operator_control c where singleton),
 'leader20',(select to_jsonb(c) from leader20_control c where singleton),
 'batch',(select to_jsonb(c) from leader20_batch_control c where singleton),
 'gpt',(select to_jsonb(c) from gpt_final_review_control c where singleton),
 'scheduler',(select to_jsonb(c) from trading_scheduler_control c where scheduler_key='trading-production'),
 'jobs',(select jsonb_agg(to_jsonb(j)) from trading_scheduler_jobs j where scheduler_key='trading-production'),
 'positions',(select coalesce(jsonb_agg(to_jsonb(p)),'[]') from v11_long_regime_positions p where state='OPEN' or remaining_quantity>0),
 'orders',(select coalesce(jsonb_agg(to_jsonb(o)-'request_payload'-'response_payload'),'[]') from v11_long_regime_orders o where state in ('PLANNED','DISPATCHED','SUBMITTING','PARTIALLY_FILLED','UNKNOWN','RECONCILIATION_PENDING','RECONCILIATION_FAILED')),
 'fills',(select coalesce(jsonb_agg(to_jsonb(f)-'raw_response'),'[]') from exchange_trade_fills f where exchange='binance_futures' and account_scope='futures' and executed_at>=now()-interval '24 hours'),
 'snapshot',(select jsonb_build_object('captured_at',captured_at,'equity',total_equity_quote,'available',available_quote) from trading_account_snapshots where exchange='binance_futures' order by captured_at desc limit 1),
 'drain',jsonb_build_object('writers',(select count(*) from v17_execution_lease where owner is not null and expires_at>clock_timestamp()),'analyses',(select count(*) from v17_analysis_lease where owner is not null and expires_at>clock_timestamp()),
 'provider_requests',(select count(*) from ai_call_ledger where state in ('RESERVED','RUNNING','DISPATCHED') and created_at>now()-interval '15 minutes'),
 'strategy_ticks',(select count(*) from trading_scheduler_ticks t join trading_scheduler_jobs j using(scheduler_key,job_key) where j.target->>'endpoint' in ('v10-lane-executor','v10-lane-signal-generator') and t.finished_at is null and t.started_at>now()-interval '110 seconds')),
 'installed',to_regclass('public.deterministic_control') is not null) evidence`;
async function venueConfig(){const app=process.env.FLY_BINANCE_APP_NAME;if(!['trading-booooo','trading-booooo-sanbital-gateway'].includes(app))throw Error('RELEASE_VENUE_APP');
 for(const appName of GATEWAY_APPS){const r=await fetch(`https://${appName}.fly.dev/health`,{signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('GATEWAY_HEALTH_UNAVAILABLE');const h=await r.json();
  if(h.deployment_commit!==expectedGatewayCommit(request,appName)||h.order_writer?.required!==true)throw Error('GATEWAY_SOURCE_OR_FENCE_CHANGED');
  evidence['gateway_'+appName]=h;
 }
 return {app,commit:expectedGatewayCommit(request,app),token:process.env.LEARNING_ACCESS_TOKEN};
}
async function signedProof(s){const config=await venueConfig(),[portfolio,openOrders,mode]=await Promise.all(['p10_portfolio','v18_open_orders','futures_position_mode'].map(action=>readVenue({...config,command:{action}})));
 const holdings=reconcileHoldings({db:s,portfolio,openOrders,mode}),symbols=[...new Set([...s.fills.map(f=>f.market),...s.positions.map(p=>p.symbol),...portfolio.positions.map(p=>p.market)])];if(symbols.length>30)throw Error('HISTORY_SCOPE_TOO_LARGE');
 const history={};for(const market of symbols)history[market]=await readVenue({...config,command:{action:'trade_history',market,limit:1000}});
 const trades=reconcileTrades(s.fills,history,Date.parse(s.utc)-86400000),snapshot=s.snapshot;
 const balance=!!snapshot&&Date.parse(s.utc)-Date.parse(snapshot.captured_at)<=120000&&Math.abs(Number(snapshot.equity)-Number(portfolio.total_equity_quote))<=.01&&Math.abs(Number(snapshot.available)-Number(portfolio.available_quote))<=.01;
 evidence.account={holdings,trades,balance,portfolio,openOrders,mode,history};save();assertAccountProof(holdings,trades,balance);note('SIGNED_ACCOUNT_PASSED',{holdings,trades,balance_reconciled:balance});
}
async function functionList(){return JSON.parse(run('supabase',['functions','list','--project-ref',project,'--output','json']));}
async function endpoint(slug,body){
 // Existing internal endpoint authentication, confined to this exact main release
 // runner. No token/key is logged, exported, or persisted in evidence.
 const token=run('psql',[process.env.SUPABASE_DB_URL,'-XAt','--set=ON_ERROR_STOP=1','-c',`select token from public.edge_internal_tokens where name='${slug}'`]).trim();if(!token)throw Error('INTERNAL_ENDPOINT_TOKEN_MISSING');
 const result=await readReadiness({project,slug,token,body,region:request.runtime_region});
 note('PRODUCTION_REGION_READINESS_OBSERVED',{slug,mode:body.mode,region:request.runtime_region});return result;
}
async function stage(){
 const before=await value(stateSQL);evidence.before=before;save();
 if(before.installed||before.settings.pause_new_entries!==true||before.runtime.incident_generation!==148||before.leader20.active_strategy!=='LEADER20_DYNAMIC_1')throw Error('OBSERVED_BASELINE_CHANGED');
 const list=await functionList(),rows=list.functions??list;
 for(const [slug,version] of Object.entries(request.expected_versions)){const f=rows.find(x=>x.slug===slug);if(f?.version!==version||f.verify_jwt!==false||f.status!=='ACTIVE')throw Error('CONCURRENT_FUNCTION_DEPLOY');}
 await signedProof(before);
 const baseline=process.env.RUNNER_TEMP+'/deterministic-production-baseline';run('git',['worktree','add','--detach',baseline,request.baseline_main]);
 for(const slug of Object.keys(request.expected_versions)){const out=process.env.RUNNER_TEMP+'/before-'+slug;fs.mkdirSync(out,{recursive:true});run('supabase',['functions','download',slug,'--project-ref',project,'--use-api','--workdir',out]);evidence['before_'+slug]=JSON.parse(run('node',['ops/gpt-final-review/verify-bundle-parity.mjs',out,baseline,slug]));}save();
 await query(fs.readFileSync('ops/deterministic/stage-paused.sql','utf8'));note('LEGACY_ENTRY_RETIRED_WITH_OPERATOR_PAUSED');
 let drained;
 for(let i=0;i<30;i++){const s=await value(stateSQL);if(s.postmaster!==before.postmaster)throw Error('POSTMASTER_CHANGED_DURING_STAGE');if(Object.values(s.drain).every(x=>x===0)){drained=s;break;}await new Promise(r=>setTimeout(r,5000));}
 if(!drained)throw Error('CURRENT_HOLDERS_NOT_DRAINED');await signedProof(drained);
 const migration=fs.readFileSync('supabase/migrations/20261002102500_deterministic_dynamic_state.sql','utf8');if(createHash('sha256').update(migration).digest('hex')!==request.migration_sha256)throw Error('MIGRATION_HASH_CHANGED');
 const history=run('psql',[process.env.SUPABASE_DB_URL,'-XAt','--set=ON_ERROR_STOP=1','-c',"select count(*) from supabase_migrations.schema_migrations where version='20261002123820'"]).trim();if(history!=='1')throw Error('LATEST_PREREQUISITE_MISSING');
 const path=process.env.RUNNER_TEMP+'/deterministic-exact-install.sql';fs.writeFileSync(path,`set local lock_timeout='750ms';set local statement_timeout='20000ms';\n${migration}\ninsert into supabase_migrations.schema_migrations(version,name,statements) values('20261002102500','deterministic_dynamic_state',ARRAY['reviewed sha256 ${request.migration_sha256}']);`);
 run('psql',[process.env.SUPABASE_DB_URL,'-X','--set=ON_ERROR_STOP=1','--single-transaction','-f',path]);note('EXACT_MIGRATION_APPLIED',{version:'20261002102500',sha256:request.migration_sha256});
 for(const slug of Object.keys(request.expected_versions)){run('supabase',['functions','deploy',slug,'--project-ref',project,'--no-verify-jwt','--use-api']);const out=process.env.RUNNER_TEMP+'/after-'+slug;fs.mkdirSync(out,{recursive:true});run('supabase',['functions','download',slug,'--project-ref',project,'--use-api','--workdir',out]);const parity=JSON.parse(run('node',['ops/gpt-final-review/verify-bundle-parity.mjs',out,'.',slug]));evidence[slug]=parity;note('EXACT_SERVICE_PARITY',{slug,file_count:parity.fileCount,bundle_digest:parity.bundleDigest});}
 const s=await value(stateSQL);if(s.postmaster!==before.postmaster||JSON.stringify(protectedSettings(s))!==JSON.stringify(protectedSettings(before)))throw Error('PROTECTED_STATE_CHANGED');
 const recovered=await endpoint('v10-lane-executor',{mode:'account-recovery'});if(recovered.ready!==true)throw Error('RECOVERY_PREREQUISITE_INCOMPLETE');
 await query(`update public.deterministic_control set source_commit='${sha}',updated_at=clock_timestamp() where singleton and not enabled;`);
 await query(fs.readFileSync('ops/deterministic/bind-paused.sql','utf8'));note('SINGLE_CLOCK_BOUND_ENTRIES_DISABLED');
 const manifest={source_commit:sha,staged_at:new Date().toISOString(),functions:await functionList(),migration_sha256:request.migration_sha256,gateway_commits:Object.fromEntries(GATEWAY_APPS.map(app=>[app,expectedGatewayCommit(request,app)])),protected_settings_sha256:createHash('sha256').update(JSON.stringify(protectedSettings(before))).digest('hex')};
 evidence.manifest=manifest;fs.writeFileSync('infra-evidence/deterministic-stage-manifest.json',JSON.stringify(manifest,null,2));save();
}
async function verify({serviceSourceCommit=null,versions=null}={}){
 const s=await value(stateSQL);evidence.current=s;if(!s.installed)throw Error('DETERMINISTIC_NOT_INSTALLED');await signedProof(s);
 const ctl=await value('select to_jsonb(c) evidence from deterministic_control c where singleton'),identity=serviceIdentity(request,serviceSourceCommit??ctl.source_commit);
 serviceSourceCommit=identity.sourceCommit;versions??=identity.versions;
 const listed=await functionList(),rows=listed.functions??listed;
 for(const [slug,version] of Object.entries(versions)){const f=rows.find(x=>x.slug===slug);if(f?.version!==version||f.verify_jwt!==false||f.status!=='ACTIVE')throw Error('STAGED_FUNCTION_CHANGED');}
 for(const slug of Object.keys(request.expected_versions)){const sourceRoot=serviceSourceRoot(identity.sources[slug]),out=process.env.RUNNER_TEMP+'/verify-'+slug;fs.mkdirSync(out,{recursive:true});run('supabase',['functions','download',slug,'--project-ref',project,'--use-api','--workdir',out]);evidence[slug]=JSON.parse(run('node',['ops/gpt-final-review/verify-bundle-parity.mjs',out,sourceRoot,slug]));note('EXACT_PINNED_SERVICE_PARITY',{slug,version:versions[slug],source_commit:identity.sources[slug],bundle_digest:evidence[slug].bundleDigest,file_count:evidence[slug].fileCount});}
 const readiness=await endpoint('v10-lane-executor',{mode:'ops-readiness'}),diagnostic=await endpoint('v10-lane-signal-generator',{mode:'diagnostic'});evidence.diagnostic=diagnostic;evidence.readiness=readiness;save();
 // The diagnostic is the last endpoint observation. These independent final DB
 // reads do not consume its unchanged ten-second capture deadline serially.
 const [detail,after]=await Promise.all([
 value(`with cutoff as materialized(select clock_timestamp() at) select jsonb_build_object('control',(select to_jsonb(c) from deterministic_control c where singleton),'captures',(select jsonb_agg(jsonb_build_object('symbol',symbol,'status',capture->>'status','buckets',(capture->>'buckets')::int,'reason',capture->>'reason')) from (select m.symbol,deterministic_capture_raw(m.symbol,cutoff.at,null,cutoff.at) capture from leader20_members m join leader20_control c on m.epoch_id=c.epoch_id where c.singleton) contexts),'marketSensor',doa_market_sensor_context_v1('BTCUSDT',cutoff.at),'marketSensorAsOf',floor(extract(epoch from cutoff.at)*1000)::bigint,'unresolvedIncidents',(select count(*)::int from v18_ops_incidents where exchange='binance_futures' and account_scope='futures' and resolved_at is null and status in ('OPEN','VERIFYING')),'providerCalls',(select count(*)::int from ai_call_ledger where created_at>=(select updated_at from deterministic_control where singleton) and purpose in ('ENTRY','EXIT'))) evidence from cutoff`),value(stateSQL)]);
 if(after.postmaster!==s.postmaster||JSON.stringify(s.positions)!==JSON.stringify(after.positions)||JSON.stringify(s.orders)!==JSON.stringify(after.orders))throw Error('EXECUTION_TRUTH_CHANGED_DURING_VERIFY');
 const validation={...after,...detail,diagnostic,readiness,sourceCommit:serviceSourceCommit};evidence.validation=validation;save();
 // Emit only the existing non-secret diagnostic projection before validation:
 // a failed gate needs the exact observed symbol and watermark, not a guess.
 note('PRE_ACTIVATION_EVIDENCE',{source_commit:serviceSourceCommit,release_runner_commit:sha,diagnostic_version:diagnostic.version,diagnostic_members:diagnostic.members,diagnostic_observed_at:diagnostic.observed_at,captures:detail.captures,btc_sensor:{status:detail.marketSensor.status,buckets:detail.marketSensor.buckets,contract:detail.marketSensor.contract,depth_semantics:detail.marketSensor.depth_semantics},provider_calls:detail.providerCalls,phases:diagnostic.results.map(r=>({symbol:r.symbol,phase:r.phase,setup:r.setup,trigger:r.trigger,confirmation:r.confirmation,decision:r.decision,technical:r.technical,capture_end_ms:r.capture_end_ms,reasons:r.reasons,timing:r.timing})),runtime_cycle:after.runtime.last_cycle_completed_at});
 if(['verify-resume','repair-entry','repair-latency'].includes(operation)){assertResume(validation);note('PRE_RESUME_GATES_PASSED',{source_commit:serviceSourceCommit,release_runner_commit:sha,generation:validation.control.generation,entry_paused:validation.settings.pause_new_entries});}
 else {assertActivation(validation);note('PRE_ACTIVATION_GATES_PASSED',{source_commit:sourceSha,release_runner_commit:sha});}return validation;
}
async function repairEntry(){
 if(process.env.ENTRY_REPAIR_CONFIRMATION!=='PLANNED_ENTRY_REPAIR_1'||sourceSha===sha||
   request.expected_staged_versions?.['v10-lane-executor']!==191||request.expected_staged_versions?.['v10-lane-signal-generator']!==53)throw Error('ENTRY_REPAIR_EXACT_BASELINE_REQUIRED');
 // Verify old deployed bytes against their immutable source, rather than the
 // runner's newly reviewed repair. Every signed account/data/authority gate holds.
 const before=await verify();
 const protectedBefore=JSON.stringify(protectedSettings(before));
 let drained;
 for(let i=0;i<120;i++){
  const s=await value(stateSQL);
  if(s.postmaster!==before.postmaster||s.settings.pause_new_entries!==true||s.positions.some(p=>p.state==='OPEN')||s.orders.length||
    s.runtime.circuit_open||JSON.stringify(protectedSettings(s))!==protectedBefore)throw Error('ENTRY_REPAIR_TRUTH_CHANGED');
  if(Object.values(s.drain).every(x=>x===0)){drained=s;break;}
  await new Promise(r=>setTimeout(r,500));
 }
 if(!drained)throw Error('ENTRY_REPAIR_HOLDERS_NOT_DRAINED');
 await signedProof(drained);
 const migration=await value("select jsonb_build_object('dynamic',(select count(*) from supabase_migrations.schema_migrations where version='20261002102500'),'capture',(select count(*) from supabase_migrations.schema_migrations where version='20261003001800')) evidence");
 if(migration.dynamic!==1||migration.capture!==1)throw Error('ENTRY_REPAIR_MIGRATION_BASELINE_CHANGED');
 const list=await functionList(),rows=list.functions??list;
 for(const [slug,version] of Object.entries(request.expected_staged_versions)){
  const f=rows.find(x=>x.slug===slug);if(f?.version!==version||f.status!=='ACTIVE'||f.verify_jwt!==false)throw Error('ENTRY_REPAIR_CONCURRENT_DEPLOY');
 }
 note('ENTRY_REPAIR_DRAINED_PAUSED',{postmaster:drained.postmaster,positions:0,unresolved_orders:0,generation:before.control.generation});
 run('supabase',['functions','deploy','v10-lane-executor','--project-ref',project,'--no-verify-jwt','--use-api']);
 note('ENTRY_REPAIR_EXECUTOR_DEPLOYED',{source_commit:sha,entries_paused:true});
 const expected={...request.expected_staged_versions,'v10-lane-executor':192};
 const deployed=await functionList(),deployedRows=deployed.functions??deployed;
 for(const [slug,version] of Object.entries(expected)){
  const f=deployedRows.find(x=>x.slug===slug);if(f?.version!==version||f.status!=='ACTIVE'||f.verify_jwt!==false)throw Error('ENTRY_REPAIR_DEPLOY_VERSION_UNPROVEN');
  const out=process.env.RUNNER_TEMP+'/entry-repair-'+slug;fs.mkdirSync(out,{recursive:true});
  run('supabase',['functions','download',slug,'--project-ref',project,'--use-api','--workdir',out]);
  const parity=JSON.parse(run('node',['ops/gpt-final-review/verify-bundle-parity.mjs',out,'.',slug]));evidence[slug]=parity;
  note('ENTRY_REPAIR_COMPLETE_BUNDLE_PARITY',{slug,version,file_count:parity.fileCount,bundle_digest:parity.bundleDigest,source_commit:sha});
 }
 const after=await value(stateSQL);
 if(after.postmaster!==before.postmaster||after.settings.pause_new_entries!==true||JSON.stringify(protectedSettings(after))!==protectedBefore)throw Error('ENTRY_REPAIR_PROTECTED_STATE_CHANGED');
 await signedProof(after);
 // Metadata follows the successfully downloaded service, without a new authority
 // generation, scheduler change, entry unpause, incident reset or financial write.
 await query(`begin;set local lock_timeout='750ms';set local statement_timeout='5000ms';
 lock table deterministic_control,trading_settings,leader20_control,leader20_batch_control,gpt_final_review_control,v11_long_regime_runtime,v11_long_regime_positions,v11_long_regime_orders,v18_ops_incidents,trading_scheduler_control in share row exclusive mode;
 do $$ begin
 if not exists(select 1 from deterministic_control where singleton and enabled and generation=2 and source_commit='${sourceSha}')
 or not exists(select 1 from trading_settings where id=1 and pause_new_entries and not emergency_liquidation and not manual_intervention_required)
 or not exists(select 1 from leader20_control where singleton and active_strategy='${ENGINE}' and watch_limit=20)
 or exists(select 1 from leader20_batch_control where singleton and enabled)
 or exists(select 1 from gpt_final_review_control where singleton and mode<>'OFF')
 or not exists(select 1 from v11_long_regime_runtime where singleton and not circuit_open and protection_health='FLAT')
 or exists(select 1 from v11_long_regime_positions where state='OPEN')
 or exists(select 1 from v11_long_regime_orders where state in ('PLANNED','DISPATCHED','SUBMITTING','PARTIALLY_FILLED','UNKNOWN','RECONCILIATION_PENDING','RECONCILIATION_FAILED'))
 or exists(select 1 from v18_ops_incidents where exchange='binance_futures' and account_scope='futures' and resolved_at is null and status in ('OPEN','VERIFYING'))
 or pg_postmaster_start_time()<>'${before.postmaster}'::timestamptz
 or not exists(select 1 from trading_scheduler_control where scheduler_key='trading-production' and enabled and recovery_complete and recovered_postmaster_at=pg_postmaster_start_time() and heartbeat_at>clock_timestamp()-interval '10 seconds' and expires_at>clock_timestamp())
 then raise exception 'ENTRY_REPAIR_SOURCE_CAS_FAILED';end if;
 end $$;
 update deterministic_control set source_commit='${sha}',updated_at=clock_timestamp() where singleton;
 commit;`);
 note('ENTRY_REPAIR_SOURCE_RECORDED_ENTRIES_PAUSED',{source_commit:sha,generation:2,expected_versions:expected});
 await verify({serviceSourceCommit:sha,versions:expected});
 fs.writeFileSync('infra-evidence/deterministic-entry-repair-manifest.json',JSON.stringify({source_commit:sha,expected_staged_versions:expected,entries_paused:true,generation:2,utc:new Date().toISOString()},null,2));
}
async function repairCapture(){
 const s=await value(stateSQL),ctl=await value("select to_jsonb(c) evidence from deterministic_control c where singleton");evidence.current=s;save();
 if(!s.installed||ctl.enabled||ctl.source_commit!==sourceSha||s.leader20.active_strategy!=='PAUSED'||s.batch.enabled||s.gpt.mode!=='OFF')throw Error('DISABLED_STAGED_RELEASE_REQUIRED');
 await signedProof(s);
 const contract=await value("select jsonb_build_object('md5',md5(pg_get_functiondef('public.doa_capture_rpc(text,jsonb)'::regprocedure)),'installed',(select count(*) from supabase_migrations.schema_migrations where version='20261003001800'),'prerequisite',(select count(*) from supabase_migrations.schema_migrations where version='20261002102500')) evidence");
 if(contract.md5!==request.capture_repair.expected_rpc_md5||contract.installed!==0||contract.prerequisite!==1)throw Error('CAPTURE_REPAIR_BASELINE_CHANGED');
 const migration=fs.readFileSync('supabase/migrations/20261003001800_deterministic_capture_symbol_admission.sql','utf8');
 if(createHash('sha256').update(migration).digest('hex')!==request.capture_repair.migration_sha256)throw Error('CAPTURE_REPAIR_HASH_CHANGED');
 const path=process.env.RUNNER_TEMP+'/deterministic-capture-repair.sql';fs.writeFileSync(path,`set local lock_timeout='750ms';set local statement_timeout='20000ms';\n${migration}\ninsert into supabase_migrations.schema_migrations(version,name,statements) values('20261003001800','deterministic_capture_symbol_admission',ARRAY['reviewed sha256 ${request.capture_repair.migration_sha256}']);`);
 run('psql',[process.env.SUPABASE_DB_URL,'-X','--set=ON_ERROR_STOP=1','--single-transaction','-f',path]);
 const after=await value(stateSQL),identity=await value("select jsonb_build_object('disabled',(select not enabled from deterministic_control where singleton),'definition_md5',md5(pg_get_functiondef('public.doa_capture_rpc(text,jsonb)'::regprocedure))) evidence");
 if(after.postmaster!==s.postmaster||identity.disabled!==true||identity.definition_md5!==request.capture_repair.expected_repaired_rpc_md5||JSON.stringify(protectedSettings(after))!==JSON.stringify(protectedSettings(s)))throw Error('CAPTURE_REPAIR_PROTECTED_STATE_CHANGED');
 note('CAPTURE_ADMISSION_REPAIRED_ENTRIES_DISABLED',{version:'20261003001800',migration_sha256:request.capture_repair.migration_sha256,definition_md5:identity.definition_md5,service_source_commit:sourceSha,release_runner_commit:sha});
}
async function activate(v){
 // The normal runtime, not an operator SQL reset, has resolved the exact account
 // incident. This transaction grants one new authority and changes no sizing.
 const sql=`begin;set local lock_timeout='750ms';set local statement_timeout='5000ms';
 lock table public.deterministic_control,public.leader20_control,public.leader20_batch_control,public.gpt_final_review_control,public.v11_long_regime_runtime,public.v18_ops_incidents,public.trading_settings,public.trading_scheduler_jobs,public.trading_scheduler_control in share row exclusive mode;
 do $$ begin
 if not exists(select 1 from deterministic_control where singleton and not enabled and source_commit='${sourceSha}' and generation=${v.control.generation})
 or not exists(select 1 from v11_long_regime_runtime where singleton and not circuit_open and incident_generation=148 and protection_health='FLAT')
 or not exists(select 1 from leader20_control where singleton and active_strategy='PAUSED' and watch_limit=20)
 or exists(select 1 from leader20_batch_control where singleton and enabled)
 or exists(select 1 from gpt_final_review_control where singleton and mode<>'OFF')
 or exists(select 1 from v18_ops_incidents where exchange='binance_futures' and account_scope='futures' and resolved_at is null and status in ('OPEN','VERIFYING'))
 or pg_postmaster_start_time()<>'${v.postmaster}'::timestamptz
 or exists(select 1 from trading_settings where id=1 and (pause_new_entries or manual_intervention_required or emergency_liquidation))
 then raise exception 'AUTHORITY_ACTIVATION_CAS_FAILED';end if;
 end $$;
 update leader20_control set active_strategy='${ENGINE}',generation=generation+1,updated_at=clock_timestamp() where singleton;
 update deterministic_control set enabled=true,generation=generation+1,source_commit='${sourceSha}',updated_at=clock_timestamp() where singleton;
 commit;`;
 await query(sql);note('DETERMINISTIC_AUTHORITY_ENABLED',{source_commit:sourceSha,release_runner_commit:sha});
}
async function repairLatency(){
 const repair=request.executor_latency_repair;
 if(process.env.LATENCY_REPAIR_CONFIRMATION!=='EXECUTOR_LATENCY_REPAIR_1'||repair?.baseline_source_commit!==sourceSha||
   JSON.stringify(repair.baseline_versions)!==JSON.stringify(request.expected_staged_versions))throw Error('LATENCY_REPAIR_EXACT_BASELINE_REQUIRED');
 const sourceRoot=serviceSourceRoot(repair.source_commit),identity=assertLatencySource(request,sourceRoot);
 const before=await verify();
 if(before.control.source_commit!==repair.baseline_source_commit)throw Error('LATENCY_REPAIR_ALREADY_APPLIED_OR_SOURCE_CHANGED');
 const protectedBefore=JSON.stringify(protectedSettings(before));let drained;
 for(let i=0;i<120;i++){
  const s=await value(stateSQL);
  if(s.postmaster!==before.postmaster||s.settings.pause_new_entries!==true||s.positions.some(p=>p.state==='OPEN')||s.orders.length||
     s.runtime.circuit_open||JSON.stringify(protectedSettings(s))!==protectedBefore)throw Error('LATENCY_REPAIR_TRUTH_CHANGED');
  if(Object.values(s.drain).every(x=>x===0)){drained=s;break;}
  await new Promise(r=>setTimeout(r,500));
 }
 if(!drained)throw Error('LATENCY_REPAIR_HOLDERS_NOT_DRAINED');
 await signedProof(drained);
 const list=await functionList(),rows=list.functions??list;
 for(const [slug,version] of Object.entries(repair.baseline_versions)){
  const f=rows.find(x=>x.slug===slug);if(f?.version!==version||f.status!=='ACTIVE'||f.verify_jwt!==false)throw Error('LATENCY_REPAIR_CONCURRENT_DEPLOY');
 }
 note('LATENCY_REPAIR_DRAINED_PAUSED',{postmaster:drained.postmaster,positions:0,unresolved_orders:0,generation:before.control.generation,source_commit:identity.sourceCommit,release_runner_commit:sha});
 // Deploy only the immutable single-file repair based on the existing production
 // source. Later main strategy changes cannot enter this release dependency graph.
 run('supabase',['functions','deploy','v10-lane-executor','--project-ref',project,'--no-verify-jwt','--use-api'],{cwd:sourceRoot});
 note('LATENCY_REPAIR_EXECUTOR_DEPLOYED',{source_commit:identity.sourceCommit,entries_paused:true});
 const deployed=await functionList(),deployedRows=deployed.functions??deployed;
 for(const [slug,version] of Object.entries(identity.versions)){
  const f=deployedRows.find(x=>x.slug===slug);if(f?.version!==version||f.status!=='ACTIVE'||f.verify_jwt!==false)throw Error('LATENCY_REPAIR_DEPLOY_VERSION_UNPROVEN');
  const out=process.env.RUNNER_TEMP+'/latency-repair-'+slug;fs.mkdirSync(out,{recursive:true});
  run('supabase',['functions','download',slug,'--project-ref',project,'--use-api','--workdir',out]);
  const root=serviceSourceRoot(identity.sources[slug]),parity=JSON.parse(run('node',['ops/gpt-final-review/verify-bundle-parity.mjs',out,root,slug]));evidence[slug]=parity;
  note('LATENCY_REPAIR_COMPLETE_BUNDLE_PARITY',{slug,version,source_commit:identity.sources[slug],file_count:parity.fileCount,bundle_digest:parity.bundleDigest});
 }
 const after=await value(stateSQL);
 if(after.postmaster!==before.postmaster||after.settings.pause_new_entries!==true||JSON.stringify(protectedSettings(after))!==protectedBefore)throw Error('LATENCY_REPAIR_PROTECTED_STATE_CHANGED');
 await signedProof(after);
 await query(`begin;set local lock_timeout='750ms';set local statement_timeout='5000ms';
 lock table deterministic_control,trading_settings,leader20_control,leader20_batch_control,gpt_final_review_control,v11_long_regime_runtime,v11_long_regime_positions,v11_long_regime_orders,v18_ops_incidents,trading_scheduler_control in share row exclusive mode;
 do $$ begin
 if not exists(select 1 from deterministic_control where singleton and enabled and generation=2 and source_commit='${repair.baseline_source_commit}')
 or not exists(select 1 from trading_settings where id=1 and pause_new_entries and not emergency_liquidation and not manual_intervention_required)
 or not exists(select 1 from leader20_control where singleton and active_strategy='${ENGINE}' and watch_limit=20)
 or exists(select 1 from leader20_batch_control where singleton and enabled)
 or exists(select 1 from gpt_final_review_control where singleton and mode<>'OFF')
 or not exists(select 1 from v11_long_regime_runtime where singleton and not circuit_open and protection_health='FLAT')
 or exists(select 1 from v11_long_regime_positions where state='OPEN')
 or exists(select 1 from v11_long_regime_orders where state in ('PLANNED','DISPATCHED','SUBMITTING','PARTIALLY_FILLED','UNKNOWN','RECONCILIATION_PENDING','RECONCILIATION_FAILED'))
 or exists(select 1 from v18_ops_incidents where exchange='binance_futures' and account_scope='futures' and resolved_at is null and status in ('OPEN','VERIFYING'))
 or pg_postmaster_start_time()<>'${before.postmaster}'::timestamptz
 or not exists(select 1 from trading_scheduler_control where scheduler_key='trading-production' and enabled and recovery_complete and recovered_postmaster_at=pg_postmaster_start_time() and heartbeat_at>clock_timestamp()-interval '10 seconds' and expires_at>clock_timestamp())
 then raise exception 'LATENCY_REPAIR_SOURCE_CAS_FAILED';end if;
 end $$;
 update deterministic_control set source_commit='${identity.sourceCommit}',updated_at=clock_timestamp() where singleton;
 commit;`);
 note('LATENCY_REPAIR_SOURCE_RECORDED_ENTRIES_PAUSED',{source_commit:identity.sourceCommit,generation:2,expected_versions:identity.versions});
 await verify();
 fs.writeFileSync('infra-evidence/deterministic-latency-repair-manifest.json',JSON.stringify({source_commit:identity.sourceCommit,release_runner_commit:sha,functions:identity,entries_paused:true,generation:2,utc:new Date().toISOString()},null,2));
}
try{save();if(operation==='stage')await stage();else if(operation==='repair-capture')await repairCapture();else if(operation==='repair-entry')await repairEntry();else if(operation==='repair-latency')await repairLatency();else{const v=await verify();if(operation==='activate')await activate(v);}note('OPERATION_COMPLETED',{operation});}
catch(e){evidence.error=/^[A-Z0-9_]+$/.test(e.message)?e.message:'RELEASE_FAILED';save();
 // Never restore AI authority or roll a migrated execution proof backward.
 if(!['verify','verify-resume'].includes(operation)){try{await query(pauseSQL);if(!['repair-entry','repair-latency'].includes(operation)&&(await value(stateSQL)).installed)await query('update deterministic_control set enabled=false,updated_at=clock_timestamp() where singleton;');note('ENTRY_PAUSED_AFTER_FAILURE',{management_authority_preserved:['repair-entry','repair-latency'].includes(operation)});}catch{note('PAUSE_WRITE_UNCONFIRMED');}}
 console.error(JSON.stringify({error:evidence.error,entry_activation_completed:false,order_commands:0}));process.exitCode=1;}
