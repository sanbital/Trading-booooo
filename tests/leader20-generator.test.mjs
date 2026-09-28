import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../supabase/functions/v10-lane-signal-generator/index.ts',import.meta.url),'utf8')
 .replace(/^import .*;\r?\n/gm,'').replace('export async function generate','async function generate').split('Deno.serve')[0];
function harness(control) {
 const calls={scan:0,leader:0};
 const scope={leaderControl:async()=>control,
  generateLeader20:async()=>{calls.leader++;return {ok:true,state:'OBSERVATION_ONLY'};},
  scanMarket:async()=>{calls.scan++;return {legacy:true};},STRATEGY:'legacy'};
 vm.runInNewContext(source+';globalThis.generate=generate;',scope);
 return {calls,run:options=>scope.generate({},options)};
}
test('20-second observer tick only runs Leader20 work and never starts a legacy market scan',async()=>{
 const h=harness({observation_enabled:true,active_strategy:'LEGACY'});
 const r=await h.run({leader20Only:true});
 assert.equal(r.state,'OBSERVATION_ONLY');assert.deepEqual(h.calls,{scan:0,leader:1});
});
test('disabled observation cannot fall through into a legacy scan or materialization',async()=>{
 const h=harness({observation_enabled:false,active_strategy:'LEGACY'});
 const r=await h.run({leader20Only:true});
 assert.equal(r.skipped,'LEADER20_OBSERVATION_DISABLED');assert.deepEqual(h.calls,{scan:0,leader:0});
});

test('legacy five-minute tick yields to the single one-minute Top10 observer',async()=>{
 const h=harness({observation_enabled:true,active_strategy:'LEADER20_DYNAMIC_1'});
 const r=await h.run({});assert.equal(r.skipped,'LEADER20_OBSERVER_OWNS_SCHEDULE');
 assert.deepEqual(h.calls,{scan:0,leader:0});
});
test('existing legacy diagnostic retains its normal scan route',async()=>{
 const h=harness({observation_enabled:false,active_strategy:'LEGACY'});
 const r=await h.run({diagnostic:true});assert.equal(r.legacy,true);assert.deepEqual(h.calls,{scan:1,leader:0});
});
