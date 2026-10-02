// These suites assert production strategies and host hooks that were explicitly
// retired by DETERMINISTIC_DYNAMIC_STATE_1. They remain in the repository as
// historical evidence, but cannot be a release gate for the replacement engine.
//
// Every exclusion names its active replacement so removing a strategy does not
// silently remove its execution, protection, accounting, or fencing coverage.
const deterministic='test-support/deterministic/*.test.mjs';
const native='test-support/v17-exit/native-protection.test.mjs + tests/entry-native-before-model.test.mjs + test-support/v17-exit/exit-settle.test.mjs + test-support/v17-exit/native-fill-reconcile.test.mjs';
const account='tests/account-critical-section.test.mjs + tests/account-execution-context.test.mjs + tests/account-analysis-sql.test.mjs + gateway/order-writer-fence.test.mjs';

export const RETIRED_PRODUCTION_SUITES=Object.freeze({
 'development/gpt-final-decision/tests/cec-evidence-final-entry.test.mjs':deterministic,
 'development/gpt-final-decision/tests/fd1-hold.test.mjs':deterministic,
 'development/gpt-final-review/tests/latency-v3.test.mjs':deterministic,
 'development/gpt-final-review/tests/v30-live.test.mjs':deterministic,
 'supabase/functions/_shared/leader-b06133-entry.test.mjs':deterministic,
 'supabase/functions/_shared/leader-cec0040.test.mjs':deterministic,
 'supabase/functions/_shared/leader-live-chase.test.mjs':deterministic,
 'supabase/functions/v10-lane-executor/dryrun-safety.test.mjs':deterministic,
 'supabase/functions/v10-lane-executor/entry-capacity.test.mjs':deterministic,
 'supabase/functions/v10-lane-executor/entry-evidence.test.mjs':deterministic,
 'supabase/functions/v10-lane-executor/entry-lifecycle.test.mjs':deterministic,
 'test-support/v17-entry/boo-observe-independence.test.mjs':deterministic,
 'test-support/v17-entry/dispatch-latency.test.mjs':deterministic,
 'test-support/v17-exit/entry-margin-skip.test.mjs':deterministic,
 'test-support/v17-exit/entry-queue.test.mjs':deterministic,
 'test-support/v17-exit/executor.test.mjs':native,
 'test-support/v17-entry/never-placed-settlement.test.mjs':deterministic,
 'test-support/v17-entry/partial-retry-reconciliation.test.mjs':deterministic,
 'test-support/v17-entry/qv3-shadow-cutover.test.mjs':deterministic,
 'test-support/v17-entry/stale-queue-replay.test.mjs':deterministic,
 'test-support/v17-exit/activation.test.mjs':native,
 'test-support/v17-exit/executor-single-flight-cadence.test.mjs':account,
 'test-support/v17-exit/fast-exit.test.mjs':native,
 'test-support/v17-exit/module-load.test.mjs':deterministic,
 'test-support/v17-exit/native-stop-wiring.test.mjs':native,
 'test-support/v17-exit/quote-retry.test.mjs':native,
 'test-support/v18-ops/run-race.test.mjs':native,
 'test-support/v18-ops/runtime-observability.test.mjs':deterministic,
 'test-support/v18-ops/settlement.test.mjs':native,
 'test-support/v19-ops/scope-aware-entry-control.test.mjs':deterministic,
 'test-support/v23-override/e1-x1-live.test.mjs':deterministic,
 'tests/account-host-integration.test.mjs':account,
 'tests/clock-execution-quote.test.mjs':deterministic,
 'tests/clock-final-authority.test.mjs':deterministic,
 'tests/dynamic-capture-recovery-scope.test.mjs':deterministic,
 'tests/execution-infrastructure.test.mjs':deterministic,
 'tests/execution-lease-ack-recovery.test.mjs':account,
 'tests/fd1-exit-authority-v2.test.mjs':native,
 'tests/fd1-final-recheck.test.mjs':deterministic,
 'tests/fd1-protection-arbitration.test.mjs':native,
 'tests/hold-thesis-protection.test.mjs':deterministic,
 'tests/leader20-campaign-lifecycle.test.mjs':deterministic,
 'tests/wusdt-control-flow.test.mjs':deterministic,
});

export function assertRetirementManifest(files){
 const set=new Set(files);
 for(const [file,replacement] of Object.entries(RETIRED_PRODUCTION_SUITES)){
  if(!set.has(file))throw Error('RETIRED_SUITE_MISSING:'+file);
  if(!replacement)throw Error('RETIRED_SUITE_WITHOUT_REPLACEMENT:'+file);
  if(file.startsWith('test-support/deterministic/'))throw Error('CURRENT_SUITE_RETIRED:'+file);
 }
}
