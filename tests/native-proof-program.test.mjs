import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../ops/execution-infra/native-stop-proof.mjs',import.meta.url),'utf8');
test('generated signed-read program parses as JavaScript with Unicode identity checks and GET-only exchange methods',()=>{
 const template=source.match(/const script=`([\s\S]*?)`;\n \/\/ Shell quoting/)[1];
 const context={evidence:{ledger:[]},Buffer};vm.createContext(context);
 vm.runInContext('this.script=`'+template+'`;',context);assert.doesNotThrow(()=>new vm.Script(context.script));
 assert.ok(context.script.includes('\\p{L}'));
 assert.ok(context.script.includes("method:'GET'"));
 assert.equal(/method:\s*['"](?:POST|PUT|DELETE|PATCH)['"]/.test(context.script),false);
 assert.ok(context.script.includes('RETENTION_WINDOW_TOO_LARGE'));
 assert.ok(context.script.includes('observed_at_ms'));
});
test('mutation mode is guarded and incomplete recovery cannot silently succeed',()=>{
 assert.ok(source.includes("process.env.GITHUB_REF!=='refs/heads/main'"));
 assert.ok(source.includes("NATIVE_PROOF_VERSION!=='CLOSED_NATIVE_ABSENCE_1'"));
 assert.ok(source.includes('RECONCILIATION_BACKLOG_REMAINS'));
 assert.ok(source.includes('process.exitCode=2'));
 assert.ok(source.includes('p_postmaster:evidence.readiness[0].postmaster'));
});
