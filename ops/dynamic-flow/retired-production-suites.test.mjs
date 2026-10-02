import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {RETIRED_PRODUCTION_SUITES,assertRetirementManifest} from './retired-production-suites.mjs';

test('historical strategy suites remain present, documented and outside current deterministic coverage',()=>{
 const files=Object.keys(RETIRED_PRODUCTION_SUITES);
 assertRetirementManifest(files);
 assert.ok(files.length>0);
 for(const [file,replacement] of Object.entries(RETIRED_PRODUCTION_SUITES)){
  assert.equal(existsSync(file),true,file);
  assert.ok(replacement.includes('.test.mjs'),file);
  assert.ok(!replacement.includes('gpt-final'),file);
 }
});

test('the active regression runner filters only the explicit immutable manifest',()=>{
 const source=readFileSync(new URL('./run-tests.mjs',import.meta.url),'utf8');
 assert.ok(source.includes('file in RETIRED_PRODUCTION_SUITES'));
 assert.ok(!source.includes('includes("gpt")'));
 assert.ok(!source.includes("startsWith('development/')"));
});
