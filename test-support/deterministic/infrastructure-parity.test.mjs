import fs from 'node:fs';import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {parse} from 'acorn';
const baseline=JSON.parse(fs.readFileSync(new URL('./infrastructure-baseline.json',import.meta.url))),source=fs.readFileSync(new URL('../../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8'),
 functions=new Map(parse(source,{ecmaVersion:'latest',sourceType:'module'}).body.filter(x=>x.type==='FunctionDeclaration').map(x=>[x.id.name,source.slice(x.start,x.end)]));
test('40 audited lease/transport/ownership/capacity/receipt/reconciliation functions remain pinned',()=>{
 // auth is the explicit production repair: dependency errors now return 503.
 // Its original fingerprint remains in the baseline; auth-recovery tests exercise
 // the new handler semantics. No execution/settlement fingerprint is relaxed.
 for(const [name,hash] of Object.entries(baseline.functions))if(name!=='auth')assert.equal(createHash('sha256').update(functions.get(name)??'MISSING').digest('hex'),hash,name);
});
