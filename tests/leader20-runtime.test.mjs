import test from 'node:test';
import assert from 'node:assert/strict';
import {leaderControl,requireEntryAuthority,generateLeader20} from '../supabase/functions/_shared/leader20/runtime.mjs';
import {LEADER20} from '../supabase/functions/_shared/leader20/universe.mjs';
import {rawCapture} from '../test-support/dynamic-fixtures.mjs';
import {baselinePolicy,validatePolicy} from '../supabase/functions/_shared/self-evolution/policy.mjs';
const T=1800000000200;
function controlDb(result){return {from:()=>({select(){return this;},eq(){return this;},async maybeSingle(){return result;}})};}
test('missing migration preserves legacy; every other control failure fails closed',async()=>{
 assert.equal((await leaderControl(controlDb({error:{code:'42P01'}}))).active_strategy,'LEGACY');
 await assert.rejects(leaderControl(controlDb({error:{code:'57014'}})),/UNAVAILABLE/);
 await assert.rejects(leaderControl(controlDb({data:null})),/UNAVAILABLE/);
});
test('authority rejects stale generation and a lost RPC response, never caches an approval',async()=>{
 const db=controlDb({data:{active_strategy:LEADER20}}),row={id:'s',features:{leader20:{version:LEADER20}}};
 let allowed=true,n=0;db.rpc=async()=>{n++;return {data:{allowed,reason:'GENERATION_CHANGED'}};};
 await requireEntryAuthority(db,row);allowed=false;
 await assert.rejects(requireEntryAuthority(db,row),/GENERATION_CHANGED/);assert.equal(n,2);
 db.rpc=async()=>({error:{code:'TIMEOUT'}});await assert.rejects(requireEntryAuthority(db,row),/AUTHORITY_UNAVAILABLE/);
 await assert.rejects(requireEntryAuthority(db,{id:'legacy'}),/AUTHORITY_UNAVAILABLE/);
});
test('all twenty leaders materialize through the existing route without a legacy signal/model or invented ATR',async()=>{
 const ctl={epoch_id:'e',generation:1,active_strategy:LEADER20,observation_enabled:true},writes=[];
 const events=Array.from({length:20},(_,i)=>({id:'e'+i,epoch_id:'e',generation:1,symbol:`C${i}USDT`}));
 const db={from(table){return {select(){return this;},eq(){return this;},order(){return this;},
   async single(){return {data:table==='leader20_epochs'?{next_refresh_at:new Date(T+100000).toISOString()}:{rank:20,price_change_percent:-1}};},
   async limit(){return {data:events};}};},async rpc(name,args){
   if(name==='leader20_schedule')return {data:{requests:20}};
   if(name==='doa_context_for_role_v1')return {data:rawCapture(T)};
   if(name==='leader20_materialize_event'){writes.push(args);return {data:{created:true,signal_id:'s'+writes.length}};}
   throw Error('Unexpected side effect: '+name);
 }};
 const r=await generateLeader20(db,ctl,{now:()=>T,fetchFn:()=>{throw Error('epoch must stay fixed');}});
 assert.equal(r.inserted,20);assert.equal(writes.length,20);
 for(const w of writes){const f=w.p_features;assert.equal(f.routeAuthority,LEADER20);assert.equal(f.rankBasis,'ROLLING_24H');
   assert.equal(f.atr,null);assert.equal(f.targetMarginUsdt,150);assert.equal(f.leverage,3);
   for(const k of ['v17Setup','b06133','v30Front','cec0040'])assert.equal(Object.hasOwn(f,k),false);}
});
test('self-evolution cannot alter universe, epoch, bucket count or old-model authority',()=>{
 for(const text of ['Change universe','Change bucket count','Use V17 admission','Change rolling24h','Change generation']){
   const p=baselinePolicy();p.stages.ENTRY.gpt_rubric=[text];assert.throws(()=>validatePolicy(p),/SCOPE/);
 }
});
