import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root=new URL('../',import.meta.url);
const manifest=JSON.parse(readFileSync(new URL('deployment-evidence/signal-generator-v51-baseline.json',root)));
const hash=value=>createHash('sha256').update(value).digest('hex');
test('signal generator retains all 15 production v51 dependencies byte for byte',()=>{
  assert.equal(manifest.production_version,51);
  assert.equal(Object.keys(manifest.files).length,15);
  for(const [path,entry] of Object.entries(manifest.files)){
    assert.ok(path.startsWith('supabase/functions/v10-lane-signal-generator/_production-v51/_shared/'));
    assert.equal(hash(readFileSync(new URL(path,root))),entry.sha256,path);
  }
});
test('archived v51 entrypoint hash proves the old graph without constraining its replacement',()=>{
  const entry=readFileSync(new URL(manifest.entrypoint.path,root),'utf8');
  assert.notEqual(hash(entry),manifest.entrypoint.original_sha256);
  assert.ok(entry.includes("../_shared/deterministic/universe.mjs"));
  assert.ok(entry.includes("../_shared/deterministic/runtime.mjs"));
  assert.ok(entry.includes("../_shared/scheduler-admission.mjs"));
  assert.ok(entry.includes("endpoint:'v10-lane-signal-generator'"));
  assert.ok(!entry.includes('_production-v51'));
  assert.ok(!/(openai|deepseek|gpt-final)/i.test(entry));
});
test('relative imports in the frozen graph cannot escape into the executor shared graph',()=>{
  const files=new Set(Object.keys(manifest.files).map(path=>new URL(path,root).href));
  for(const path of Object.keys(manifest.files)){
    const url=new URL(path,root),source=readFileSync(url,'utf8');
    for(const match of source.matchAll(/(?:from\s*|import\s*\()(['"])(\.[^'"]+)\1/g)){
      const target=new URL(match[2],url);
      assert.ok(files.has(target.href),`${path}: ${match[2]}`);
    }
  }
});
