import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {stageEngine} from '../../gateway/stage-engine.mjs';
import {RETIRED_PRODUCTION_SUITES,assertRetirementManifest} from './retired-production-suites.mjs';
stageEngine();
const roots=['collectors/doa-capture','development/gpt-final-decision','development/gpt-final-review','development/self-evolution',
 'supabase/functions/_shared','supabase/functions/v10-lane-executor','test-support','tests','gateway'];
function walk(p){return readdirSync(p,{withFileTypes:true}).flatMap(x=>x.name==='node_modules'?[]:x.isDirectory()?walk(join(p,x.name)):x.name.endsWith('.test.mjs')?[join(p,x.name)]:[]);}
const discovered=[...new Set(roots.flatMap(walk))];
assertRetirementManifest(discovered);
const files=discovered.filter(file=>!(file in RETIRED_PRODUCTION_SUITES));
console.log(JSON.stringify({activeSuites:files.length,retiredHistoricalSuites:Object.keys(RETIRED_PRODUCTION_SUITES).length}));
const r=spawnSync(process.execPath,['--test','--test-concurrency=1','--test-reporter=tap',...files],{stdio:'inherit'});
if(r.error)throw r.error;process.exit(r.status??1);
