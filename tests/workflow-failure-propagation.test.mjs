import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const wf=p=>readFileSync(new URL('../.github/workflows/'+p,import.meta.url),'utf8');

// Every workflow that judges production must be incapable of reporting a green job while its
// probe failed. Run 1 of the collector watchdog did exactly that: the JSON carried
// "error":"SUPABASE_QUERY_544" and GitHub showed success, because `node ... | tee` returns
// tee's status and the step had no pipefail.
const JUDGING=['collector-watchdog.yml','collector-production-evidence.yml'];

test('a failing probe can never be reported as a successful job',async t=>{
 for(const name of JUDGING)await t.test(name+' preserves the node exit status',()=>{
  const s=wf(name);
  const piped=[...s.matchAll(/^\s*node .*\|.*$/gm)].map(m=>m[0]);
  if(piped.length){
   assert.ok(/set -euo pipefail|set -o pipefail/.test(s),
    name+' pipes node output but never enables pipefail, so tee would mask the exit code');
   assert.ok(/shell: bash/.test(s),
    name+' needs an explicit bash shell for pipefail to be honoured');
   // The pipefail must be in the same run: block as the pipe, not merely somewhere in the file.
   for(const line of piped){
    const before=s.slice(0,s.indexOf(line));
    const block=before.lastIndexOf('run: |');
    assert.ok(block>=0&&/pipefail/.test(s.slice(block,s.indexOf(line))),
     name+' pipes node in a run: block that does not set pipefail: '+line.trim());
   }
  }
 });
 await t.test('bash actually masks the exit code without pipefail, and preserves it with',()=>{
  // Prove the property itself rather than trusting the claim about it.
  const masked=spawnSync('bash',['-e','-c','node -e "process.exit(1)" | tee /dev/null'],{encoding:'utf8'});
  assert.equal(masked.status,0,'without pipefail a failing node is hidden by tee');
  const preserved=spawnSync('bash',['-e','-o','pipefail','-c','node -e "process.exit(1)" | tee /dev/null'],{encoding:'utf8'});
  assert.notEqual(preserved.status,0,'with pipefail the failing node fails the step');
 });
 await t.test('the watchdog exits non-zero on every refusal path it can report',()=>{
  const src=readFileSync(new URL('../ops/leader20/collector-watchdog.mjs',import.meta.url),'utf8');
  assert.ok(/const fail=m=>\{[^}]*process\.exit\(1\)/.test(src),'fail() must exit non-zero');
  for(const reason of ['CONTROL_UNREADABLE_ON_EVERY_PATH','INGEST_DB_PATH_UNAVAILABLE',
   'COLLECTOR_DID_NOT_RESUME','EXPECTED_ONE_COLLECTOR_FOUND_'])
   assert.ok(src.includes(reason),'a refusal path must be reportable: '+reason);
  // A silent `return` after a failed read would be the false-green bug in JS form.
  assert.equal(/catch\(\)=>\{\}/.test(src),false,'no swallowed errors');
 });
});

test('collector recovery never burns restarts into an Edge-to-DB outage',async t=>{
 const wd=readFileSync(new URL('../ops/leader20/collector-watchdog.mjs',import.meta.url),'utf8');
 const ev=readFileSync(new URL('../ops/leader20/production-evidence.mjs',import.meta.url),'utf8');
 await t.test('the readiness probe exercises DB token lookup rather than only the gateway',()=>{
  for(const src of [wd,ev]){
   assert.ok(src.includes("'x-doa-capture-token':'0'.repeat(64)"),
    'probe must force the Edge function to read its expected token from Postgres');
   assert.ok(src.includes('r.status===401'),
    '401 is the healthy result: DB lookup completed before the deliberate token mismatch');
   assert.ok(src.includes('r.status===503'),
    '503 must be classified as the same Edge-to-DB failure the worker sees');
  }
 });
 await t.test('scheduled watchdog gates machine mutation on DB readiness',()=>{
  const gate=wd.indexOf('else if(!out.ingest_db_path.ready)');
  const mutation=wd.indexOf("await machines(`/${m.id}/${m.state==='started'?'restart':'start'}`");
  assert.ok(gate>=0&&mutation>gate,'START/RESTART must be unreachable until ingest DB readiness passes');
  assert.ok(wd.includes("fail('INGEST_DB_PATH_UNAVAILABLE')"),
   'DB-path outage must fail loudly instead of being reported healthy');
 });
 await t.test('manual recovery requires both a readable control row and healthy ingest DB path',()=>{
  const recover=ev.indexOf("if(MODE==='recover')");
  const noControl=ev.indexOf('else if(!control)',recover);
  const dbGate=ev.indexOf('else if(!ingestDb.ready)',recover);
  const start=ev.indexOf("ev.actions.push('START')",recover);
  assert.ok(recover>=0&&noControl>recover&&dbGate>noControl&&start>dbGate,
   'manual START must come only after control and Edge-to-DB gates');
  assert.ok(ev.includes('RECOVERY_REFUSED_CONTROL_UNREADABLE'));
  assert.ok(ev.includes('RECOVERY_REFUSED_INGEST_DB_PATH_UNAVAILABLE'));
 });
});

test('the evidence job is read-only unless recovery is explicitly requested',async t=>{
 const src=readFileSync(new URL('../ops/leader20/production-evidence.mjs',import.meta.url),'utf8');
 await t.test('observe mode issues no start, restart or config write',()=>{
  const recover=src.slice(src.indexOf("if(MODE==='recover')"));
  for(const mutation of ["/start'","/restart'"])
   assert.ok(recover.includes(mutation)&&src.indexOf(mutation)>=src.indexOf("if(MODE==='recover')"),
    'machine mutation '+mutation+' must live only inside the recover branch');
  assert.equal(/config:\{/.test(src),false,'this job never rewrites machine configuration');
 });
 await t.test('recovery refuses to fight the operator',()=>{
  assert.ok(src.includes('SKIPPED_COLLECTOR_DISABLED_BY_OPERATOR'));
  assert.ok(src.includes('SKIPPED_CAPTURE_WINDOW_ENDED'));
 });
 await t.test('it touches no trading state',()=>{
  for(const forbidden of ['leader20_batch_capacity','leader20_reserve_entry_slot','v11_long_regime_orders',
   'entry_capture_slot_ms','leader20_batch_claim','decision_reserve_ms','expires_at_ms'])
   assert.equal(src.includes(forbidden),false,'must not reference '+forbidden);
 });
 await t.test('psql stderr is never recorded, because it can echo the DSN',()=>{
  assert.ok(/never recorded|never record/i.test(src));
  assert.equal(/reason:\s*String\(r\.stderr/.test(src),false);
 });
});
