import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const roots=['collectors/doa-capture','development/gpt-final-decision','development/gpt-final-review','development/self-evolution',
 'supabase/functions/_shared','supabase/functions/v10-lane-executor','test-support','tests','gateway'];
function walk(p){return readdirSync(p,{withFileTypes:true}).flatMap(x=>x.name==='node_modules'?[]:x.isDirectory()?walk(join(p,x.name)):x.name.endsWith('.test.mjs')?[join(p,x.name)]:[]);}
const files=[...new Set(roots.flatMap(walk))];
const r=spawnSync(process.execPath,['--test','--test-reporter=tap',...files],{stdio:'inherit'});
if(r.error)throw r.error;process.exit(r.status??1);
