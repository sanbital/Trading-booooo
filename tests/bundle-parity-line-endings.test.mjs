import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {spawnSync} from 'node:child_process';
test('bundle parity permits only opted-in CRLF differences and retains deployed digest',()=>{
 const root=mkdtempSync(join(tmpdir(),'bundle-parity-'));
 try{
  const download=join(root,'download'),repo=join(root,'repo'),rel='supabase/functions/example/index.ts';
  for(const base of [download,repo])mkdirSync(join(base,'supabase/functions/example'),{recursive:true});
  writeFileSync(join(download,rel),'export const value = 1;\n');
  writeFileSync(join(repo,rel),'export const value = 1;\r\n');
  const run=(...extra)=>spawnSync(process.execPath,[resolve('ops/gpt-final-review/verify-bundle-parity.mjs'),download,repo,'example',...extra],{encoding:'utf8'});
  assert.notEqual(run().status,0);
  const normalized=run('--normalize-line-endings');assert.equal(normalized.status,0,normalized.stderr);
  const evidence=JSON.parse(normalized.stdout);assert.deepEqual(evidence.lineEndingOnly,[rel]);
  writeFileSync(join(repo,rel),'export const value = 1;\n');
  assert.equal(JSON.parse(run().stdout).bundleDigest,evidence.bundleDigest);
  writeFileSync(join(repo,rel),'export const value = 2;\r\n');
  assert.notEqual(run('--normalize-line-endings').status,0);
  assert.notEqual(run('--ignore-all-differences').status,0);
 }finally{
  assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('bundle-parity-'));
  rmSync(root,{recursive:true,force:true});
 }
});
