import fs from 'node:fs';import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {parse} from 'acorn';
const baseline=JSON.parse(fs.readFileSync(new URL('./infrastructure-baseline.json',import.meta.url))),source=fs.readFileSync(new URL('../../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8'),
 functions=new Map(parse(source,{ecmaVersion:'latest',sourceType:'module'}).body.filter(x=>x.type==='FunctionDeclaration').map(x=>[x.id.name,source.slice(x.start,x.end)]));
test('41 audited lease/transport/ownership/capacity/receipt/reconciliation functions remain pinned',()=>{
 for(const [name,hash] of Object.entries(baseline.functions))assert.equal(createHash('sha256').update(functions.get(name)??'MISSING').digest('hex'),hash,name);
});
