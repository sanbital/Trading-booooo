export const ENGINE='DETERMINISTIC_DYNAMIC_STATE_1';
export const RETIRED_JOBS=['leader20-execution-outbox-sweeper','gpt-review-expire','gpt-final-review-durable-recovery','bounded-clock-telemetry'];
export function protectedSettings(s){
 const names=['binance_futures_allocation_usdt','binance_futures_leverage','binance_futures_margin_mode','binance_futures_position_mode','max_open_positions_per_exchange','scalp_max_slots','mode','withdrawal_mode','manual_intervention_required','scalp_kill_switch','emergency_liquidation','pause_lock_reason'];
 return {settings:Object.fromEntries(names.filter(k=>Object.hasOwn(s.settings,k)).map(k=>[k,s.settings[k]])),operator:{entry_enabled:s.operator.entry_enabled,legacy_entries_retired:s.operator.legacy_entries_retired}};
}
export function assertAccountProof(holdings,trades,balance){
 if(holdings.failures.length||trades.failures.length||!balance)throw Error('SIGNED_ACCOUNT_GATE_FAILED');
 // This observed cutover is flat. A changed holding requires a reviewed handoff,
 // never a release-script liquidation or an untested protection replacement.
 if(holdings.exchange_positions||holdings.db_positions||holdings.ordinary_orders||holdings.protective_orders)throw Error('FLAT_CUTOVER_BASELINE_CHANGED');
}
export function assertActivation({control,leader20,batch,gpt,runtime,settings,operator,scheduler,jobs,captures,diagnostic,readiness,providerCalls,sourceCommit,postmaster}){
 if(control.enabled||control.version!==ENGINE||control.source_commit!==sourceCommit)throw Error('DETERMINISTIC_RELEASE_IDENTITY');
 if(readiness.authority!==ENGINE||readiness.entry_enabled!==false||readiness.native_stop_enabled!==true||readiness.hard_stop_pct!==.025||readiness.maxSlots!==10||readiness.sizingContract?.targetMarginUsdt!==150||readiness.sizingContract?.leverage!==3||readiness.position_mode?.supported!==true||readiness.position_mode?.mode!=='ONE_WAY')throw Error('LIVE_SAFETY_OR_SIZING_CONTRACT');
 if(leader20.active_strategy!=='PAUSED'||leader20.watch_limit!==20||batch.enabled||gpt.mode!=='OFF')throw Error('LEGACY_AUTHORITY_NOT_RETIRED');
 if(runtime.circuit_open||runtime.protection_health!=='FLAT'||!runtime.last_cycle_completed_at||Date.now()-Date.parse(runtime.last_cycle_completed_at)>30000)throw Error('ACCOUNT_SAFETY_NOT_READY');
 if(!operator.entry_enabled||!operator.legacy_entries_retired||settings.pause_new_entries||settings.emergency_liquidation||settings.manual_intervention_required||settings.scalp_kill_switch||settings.withdrawal_mode||settings.pause_lock_reason)throw Error('OPERATOR_ENTRY_PERMISSION_UNAVAILABLE');
 if(!scheduler.enabled||!scheduler.recovery_complete||scheduler.recovered_postmaster_at!==postmaster||!scheduler.heartbeat_at||Date.now()-Date.parse(scheduler.heartbeat_at)>10000||Date.parse(scheduler.expires_at)<=Date.now())throw Error('SCHEDULER_RECOVERY_NOT_READY');
 for(const [name,endpoint] of [['v11-long-regime-executor','v10-lane-executor'],['leader20-observer-tick','v10-lane-signal-generator']]){
  const j=jobs.find(j=>j.job_key===name);
  if(!j?.enabled||j.period_ms!==5000||j.target.endpoint!==endpoint||j.target.body?.mode!=='run'||!j.last_success||Date.now()-Date.parse(j.last_success)>30000)throw Error('SINGLE_CLOCK_NOT_READY');
 }
 if(jobs.some(j=>RETIRED_JOBS.includes(j.job_key)&&j.enabled)||jobs.filter(j=>j.enabled&&['v10-lane-executor','v10-lane-signal-generator'].includes(j.target?.endpoint)).length!==2)throw Error('DUPLICATE_STRATEGY_AUTHORITY');
 const expected=new Set([...diagnostic.results.map(r=>r.symbol),'BTCUSDT']);
 if(captures.length!==expected.size||captures.some(c=>!expected.has(c.symbol)||c.status!=='AVAILABLE'||c.buckets!==24)||new Set(captures.map(c=>c.symbol)).size!==expected.size)throw Error('TOP20_CONTINUOUS_CAPTURE_NOT_READY');
 if(diagnostic.version!==ENGINE||diagnostic.members!==20||diagnostic.results.length!==20||diagnostic.results.some(r=>!r.technical||!r.capture_end_ms||Date.now()-r.capture_end_ms>25000))throw Error('TOP20_FEATURES_NOT_READY');
 if(providerCalls!==0)throw Error('POST_DEPLOY_PROVIDER_CALLS');
}
