import test from 'node:test';import assert from 'node:assert/strict';
import {protectNewLeaderPosition} from '../supabase/functions/_shared/leader-entry-protection.mjs';
const position={id:'p',symbol:'BTCUSDT',state:'OPEN',side:'LONG',remaining_quantity:1,updated_at:'old'};
const portfolio=async()=>({positions_complete:true,positions:[{market:'BTCUSDT',side:'LONG',quantity:1}]});
test('acknowledged native protection precedes a stalled AI manager and uses the fresh CAS row',async()=>{
 let resolve,started;const begun=new Promise(r=>started=r),gate=new Promise(r=>resolve=r),events=[];
 const pending=protectNewLeaderPosition({enabled:true,position,readPortfolio:portfolio,
  installNative:async()=>{events.push('native-ack');return {status:'PROTECTED',position:{...position,updated_at:'new'}};},
  manage:async ctx=>{assert.equal(ctx.positionSnapshot.updated_at,'new');events.push('model-start');started();await gate;return {action:'HOLD',nativeStop:{status:'PROTECTED'}};}});
 await begun;assert.deepEqual(events,['native-ack','model-start']);resolve();assert.equal((await pending).status,'PROTECTED');
});
test('AI failure cannot erase an already acknowledged native stop',async()=>{const r=await protectNewLeaderPosition({enabled:true,position,readPortfolio:portfolio,installNative:async()=>({status:'PROTECTED',position}),manage:async()=>{throw Error('MODEL_TIMEOUT');}});assert.equal(r.status,'PROTECTED');assert.equal(r.managementStatus,'FAILED');assert.equal(r.softwareMonitorRequired,true);assert.equal(r.error,'MODEL_TIMEOUT');});
test('native failure preserves the existing software manager instead of abandoning a filled position',async()=>{let managed=0;const r=await protectNewLeaderPosition({enabled:true,position,readPortfolio:portfolio,installNative:async()=>{throw Error('NATIVE_DEPENDENCY_TIMEOUT');},manage:async()=>{managed++;return {action:'CLOSE',result:{closed:true}};}});assert.equal(managed,1);assert.equal(r.status,'CLOSED');});
test('a native fill closing the position is not sent to the AI manager or reopened',async()=>{let managed=0;const r=await protectNewLeaderPosition({enabled:true,position,readPortfolio:portfolio,installNative:async()=>({status:'CLOSED',position:{...position,state:'CLOSED'}}),manage:async()=>managed++});assert.equal(managed,0);assert.equal(r.status,'CLOSED');});
test('disabled native protection and ambiguous ownership cannot install or invoke models',async()=>{for(const opts of [{enabled:false},{enabled:true,readPortfolio:async()=>({positions_complete:true,positions:[]})}]){let mutations=0;const r=await protectNewLeaderPosition({position,readPortfolio:portfolio,...opts,installNative:async()=>mutations++,manage:async()=>mutations++});assert.equal(mutations,0);assert.ok(['DISABLED','RECONCILIATION_PENDING'].includes(r.status));}});
