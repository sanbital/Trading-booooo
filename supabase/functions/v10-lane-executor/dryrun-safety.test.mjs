// Static guarantees for the order-free operator modes added to the executor.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const src=readFileSync(new URL('./index.ts',import.meta.url),'utf8');
const body=(start,end)=>{const a=src.indexOf(start),b=src.indexOf(end,a+1);assert.ok(a>0&&b>a,start);return src.slice(a,b);};
const dry=body('async function gptDryRun(','async function runWithLease(');
const ready=body('async function opsReadiness(','// ORDER-FREE end-to-end GPT dry run');
const forbidden=[/create_order/,/v17_create_stop/,/v17_cancel_stop/,/\.insert\(/,/\.upsert\(/,/\.update\(/,/\.delete\(/,/persistDecisionRisk/,/recordMismatch/,/\bincident\(/,/\bcircuit\(/,/\baudit\(/,/recordBooVerdict/,/recordV24/,/openBull\(/,/runEntryQueue\(/,/v11_cec0040_decide/,/status:"CLAIMED"/];
test('gpt-dryrun cannot reach any order, intent, claim, incident or audit write',()=>{for(const re of forbidden)assert.ok(!re.test(dry),'dry run contains '+re);});
test('ops-readiness is read-only and lease-free',()=>{for(const re of forbidden)assert.ok(!re.test(ready),'readiness contains '+re);assert.ok(!/runWithLease|opsGateway/.test(ready));});
test('dry run uses the rollback-only CEC preview and an isolated coordinator',()=>{
  assert.match(dry,/v11_cec0040_preview_readonly/);assert.match(dry,/dryRunCoordinator\(/);assert.ok(!/gptCoordinatorFor|coordinatorFor\(/.test(dry));
  assert.match(dry,/stoppedBeforeOrderEndpoint:true,orderCalls:0/);
});
test('modes are routed only behind the executor token check',()=>{
  const serve=src.slice(src.indexOf('Deno.serve('));const authAt=serve.indexOf('if(!(await auth(db,req)))');
  assert.ok(authAt>0&&serve.indexOf('mode==="gpt-dryrun"')>authAt&&serve.indexOf('mode==="ops-readiness"')>authAt);
  assert.ok(serve.indexOf('mode==="fd1-timeout-probe"')>authAt);
  assert.ok(serve.indexOf('mode==="fd1-recheck-timeout-probe"')>authAt);
});

test('injected timeout probe remains an isolated order-free DRYRUN',()=>{
  const source=readFileSync(new URL('./gpt-final-decision-adapter.mjs',import.meta.url),'utf8');
  const probe=source.slice(source.indexOf('export async function fd1Probe('));
  for(const re of forbidden)assert.ok(!re.test(probe),'FD1 probe contains '+re);
  assert.match(probe,/purpose:'DRYRUN'/);assert.match(probe,/ORDER_FREE_TIMEOUT_FIXTURE/);
  assert.match(probe,/if\(simulateEntryTimeout\)return/);
  const recheck=readFileSync(new URL('./gpt-final-recheck-adapter.mjs',import.meta.url),'utf8');
  const retryProbe=recheck.slice(recheck.indexOf('export async function finalRecheckProbe('));
  for(const re of forbidden)assert.ok(!re.test(retryProbe),'RECHECK probe contains '+re);
  assert.match(retryProbe,/purpose:'DRYRUN'/);assert.match(retryProbe,/resumeReviewTimeouts/);
});
test('recovery lock timeout is retryable and all other recovery errors stay fatal',()=>{
  const fn=body('async function attemptOpsRecovery(','function x1TopObservation(');
  assert.match(fn,/lock timeout\|55P03/);assert.match(fn,/RECOVERY_LOCK_BUSY/);assert.match(fn,/if\(r\.error\)throw Error\(`RECOVERY_CAS:/);
});
test('frozen sizing/slot constants remain in the executor',()=>{
  assert.match(src,/const MAX_SLOTS=10,/);assert.match(src,/const SETUP_MAX_CONCURRENT=MAX_SLOTS;/);
  assert.match(src,/const MARGIN=SLOT_SIZING_CONTRACT\.targetMarginUsdt,LEV=SLOT_SIZING_CONTRACT\.leverage/);
});
test('live probe module cannot reach orders, intents, signals or the live coordinator',()=>{
  const mod=readFileSync(new URL('./gpt-final-review-dryrun.mjs',import.meta.url),'utf8');
  for(const re of [/create_order/,/v17_create_stop/,/\.insert\(/,/\.upsert\(/,/\.update\(/,/\.delete\(/,/v11_long_regime/,/gateway/i,/coordinatorFor/])assert.ok(!re.test(mod),'probe contains '+re);
  assert.match(mod,/purpose:'DRYRUN'/);
  const route=src.slice(src.indexOf('mode==="gpt-live-probe"'),src.indexOf('mode==="cec-bootstrap"'));assert.match(route,/orderCalls:0/);assert.ok(!/runWithLease|opsGateway|openBull/.test(route));
});
