import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../supabase/functions/v10-lane-signal-generator/index.ts',import.meta.url),'utf8')
 .replace(/^import .*;\r?\n/gm,'').replace('export async function generate','async function generate').split('Deno.serve')[0];
function harness(){
 const calls={refresh:0,scan:[]},scope={};vm.runInNewContext(source+';globalThis.generate=generate;',scope);
 const refresh=async()=>{calls.refresh++;return {generation:1};};
 const scan=async(_db,options)=>{calls.scan.push(options??null);return {ok:true,state:'OBSERVATION_ONLY'};};
 return {calls,run:options=>scope.generate({}, {...options,refresh,scan}),
  failing:()=>scope.generate({}, {refresh:async()=>{calls.refresh++;throw Error('UNIVERSE_DOWN');},scan})};
}

test('every normal tick refreshes the Top20 lease and then observes it',async()=>{
 const h=harness(),r=await h.run();
 assert.equal(r.state,'OBSERVATION_ONLY');assert.equal(r.universe_refresh_error,null);
 assert.deepEqual(h.calls,{refresh:1,scan:[null]});
});

test('a refresh failure preserves observation but is explicit and cannot mint authority',async()=>{
 const h=harness(),r=await h.failing();
 assert.equal(r.state,'OBSERVATION_ONLY');assert.equal(r.universe_refresh_error,'UNIVERSE_DOWN');
 assert.deepEqual(h.calls,{refresh:1,scan:[null]});
});

test('diagnostic mode reads diagnostics without refreshing membership',async()=>{
 const h=harness(),r=await h.run({diagnostic:true});
 assert.equal(r.state,'OBSERVATION_ONLY');assert.equal(h.calls.refresh,0);assert.equal(h.calls.scan.length,1);assert.equal(h.calls.scan[0].diagnostic,true);
});
