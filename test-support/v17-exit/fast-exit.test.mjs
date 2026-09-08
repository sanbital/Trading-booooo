import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {POLICY} from '../../supabase/functions/_shared/leader-momentum-v17.mjs';
import {nextExitReviewed, EXIT_REVIEW_CANDIDATE} from '../../supabase/functions/_shared/leader-exit-review.mjs';
const source=readFileSync(new URL('../../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8');
const code=source.slice(source.indexOf('async function manageLeader('),source.indexOf('const leaseOwners='));
const make=(stale=false)=>{
 const events=[],now=Date.now();
 const ctx={Date,Number,Array,Error,POLICY,nextExitReviewed,EXIT_REVIEW_CANDIDATE,console,rec:x=>x??{},STRATEGY:'LEADER_MOMENTUM_V17',
  gateway:async c=>{assert.equal(c.action,'p10_quotes');events.push('quote');return [{market:'FORMUSDT',best_bid:96,best_ask:96.1,timing:{received_at_ms:now-(stale?10000:0),requested_at_ms:now-20}}]},
  closePos:async(db,p)=>{events.push('close');assert.ok(p.metadata.exitTelemetry.detectedAtMs);return {closed:true}},
  audit:async()=>{events.push('audit');throw Error('audit unavailable')}};
 vm.createContext(ctx);vm.runInContext(code+';this.manage=manageLeader;',ctx);
 return {ctx,events,p:{id:'p',symbol:'FORMUSDT',entry_price:100,original_quantity:1,entry_fee_usdt:.05,
  peak_price:100,hard_stop_price:97.5,entry_at:new Date(now-60000).toISOString(),metadata:{}}};
};
test('detected exit precedes audit and does not wait for a peak DB write',async()=>{
 const {ctx,p,events}=make();const r=await ctx.manage({from:()=>{throw Error('DB write before stop')}},p);
 assert.equal(r.result.closed,true);assert.deepEqual(events,['quote','close','audit']);
});
test('stale quote does not create an order',async()=>{
 const {ctx,p,events}=make(true);await assert.rejects(()=>ctx.manage({},p),/STALE/);
 assert.deepEqual(events,['quote']);
});
