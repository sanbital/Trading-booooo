// The executor module must EVALUATE, not merely parse.
//
// A deploy of a parse-clean, unit-tested executor took production down for three
// minutes with an open position: `const NATIVE_STOP_ENABLED=env("V17_NATIVE_STOP")`
// sat three lines above `const env=...`, so every request died at module load with
// "Cannot access 'env' before initialization". `node --check` passes on a temporal
// dead zone, and the other suites here slice out one function and run it in a vm, so
// the module's top level was never executed by any test.
//
// This test executes the whole top level with Deno stubbed. It costs one vm run and
// covers the entire class: TDZ, a call to a not-yet-defined const, a throwing
// initializer -- anything that makes the function 500 on its first request.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as momentum from '../../supabase/functions/_shared/leader-momentum-v17.mjs';
import * as review from '../../supabase/functions/_shared/leader-exit-review.mjs';
import * as adapter from '../../supabase/functions/_shared/leader-protection-adapter.mjs';

const path = new URL('../../supabase/functions/v10-lane-executor/index.ts', import.meta.url);
const source = readFileSync(path, 'utf8');

// Strip the ES imports; their bindings are injected below. Everything else runs.
const body = source.split('\n')
  .map((l) => (/^import[\s{]/.test(l) ? '' : l))
  .join('\n');

function evaluateModule(envVars = {}) {
  const served = [];
  const ctx = {
    console, Response, Request, Headers, URL, crypto, fetch: async () => {
      throw Error('no network during module evaluation');
    },
    TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout, Date, Math, JSON, Number,
    Deno: {
      env: { get: (n) => envVars[n] },
      serve: (h) => { served.push(h); },
    },
    // injected import bindings
    createClient: () => ({}),
    ...momentum,
    leaderPortfolioMatches: momentum.portfolioMatches,
    ...review,
    ...adapter,
  };
  vm.createContext(ctx);
  // A top-level `const` is not a property of the vm global, so hand it out explicitly.
  vm.runInContext(body + '\n;this.__nativeStopEnabled=NATIVE_STOP_ENABLED;', ctx,
    { filename: 'index.ts' });
  return { ctx, served, nativeStopEnabled: ctx.__nativeStopEnabled };
}

test('the module evaluates end to end; a load-time error would 500 every request', () => {
  const { served } = evaluateModule();
  assert.equal(served.length, 1, 'the request handler must be registered at load');
});

test('with no operator setting the native stop is off in the evaluated module', () => {
  assert.equal(evaluateModule().nativeStopEnabled, false,
    'deploying must never by itself start submitting STOP_MARKET orders');
});

test('the native stop turns on only for the exact string "true"', () => {
  assert.equal(evaluateModule({ V17_NATIVE_STOP: 'true' }).nativeStopEnabled, true);
  for (const v of ['TRUE', '1', 'yes', 'false', '']) {
    assert.equal(evaluateModule({ V17_NATIVE_STOP: v }).nativeStopEnabled, false,
      `${JSON.stringify(v)} must not enable live stop orders`);
  }
});

test('every top-level env() call sits below the env declaration', () => {
  // The specific ordering bug that caused the outage, pinned directly: a grep-level
  // guard that stays readable even if the evaluation harness above ever drifts.
  const lines = source.split('\n');
  const declared = lines.findIndex((l) => /^const env=/.test(l));
  assert.ok(declared >= 0, 'the env helper declaration must be findable');
  lines.slice(0, declared).forEach((l, i) => {
    assert.ok(!/\benv\(/.test(l), `line ${i + 1} calls env() before it is initialised: ${l.slice(0, 80)}`);
  });
});
