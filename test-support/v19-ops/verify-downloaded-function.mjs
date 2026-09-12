import assert from 'node:assert/strict';
import {readdirSync,readFileSync,statSync} from 'node:fs';
import {join,relative,resolve,sep} from 'node:path';

const downloadRoot=resolve(process.argv[2]??'');
const repositoryRoot=resolve(process.argv[3]??'.');
assert.ok(process.argv[2], 'download root is required');

const expected=[
  'functions/v10-lane-executor/index.ts',
  'functions/_shared/leader-momentum-v17.mjs',
  'functions/_shared/leader-exit-review.mjs',
  'functions/_shared/leader-entry-protection.mjs',
  'functions/_shared/leader-protection-adapter.mjs',
  'functions/_shared/leader-ops-isolation.mjs',
  'functions/_shared/leader-native-protection.mjs',
  'functions/_shared/leader-entry-settlement.mjs',
  'functions/_shared/leader-exit-settlement.mjs',
  'functions/_shared/leader-db-only-reconciliation.mjs',
  'functions/_shared/leader-entry-control.mjs',
  'functions/_shared/leader-fill-evidence.mjs',
  'functions/_shared/leader-qv3-runtime.mjs',
  'functions/_shared/leader-qv3-rules.mjs'
];

const files=[];
function walk(dir){
  for(const name of readdirSync(dir)){
    const path=join(dir,name),stat=statSync(path);
    if(stat.isDirectory())walk(path);else if(stat.isFile())files.push(path);
  }
}
walk(downloadRoot);

const compared=[];
for(const suffix of expected){
  const normalized=suffix.split('/').join(sep),matches=files.filter(path=>path.endsWith(normalized));
  assert.equal(matches.length,1,`expected one downloaded ${suffix}, got ${matches.length}`);
  const local=join(repositoryRoot,'supabase',suffix);
  assert.deepEqual(readFileSync(matches[0]),readFileSync(local),`production source mismatch: ${suffix}`);
  compared.push({source:suffix,downloaded:relative(downloadRoot,matches[0])});
}
console.log(JSON.stringify({verified:true,fileCount:compared.length,files:compared},null,2));
