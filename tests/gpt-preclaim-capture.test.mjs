import test from 'node:test';
import assert from 'node:assert/strict';
import {FinalReviewCoordinator,MemoryReviewStore} from '../supabase/functions/_shared/gpt-final-review/coordinator.mjs';

test('a stalled capture cannot leave a RUNNING review or reserve an API call',async()=>{
  const now=Date.now(),store=new MemoryReviewStore();store.deferClaimUntilPrepared=true;
  let release;
  const capture=new Promise(resolve=>{release=resolve;});
  const tasks=[];
  const engine={id:'CAPTURE_PREFLIGHT_TEST',model:'test',promptText:'test',schema:{},allow:'BUY',
    identity:s=>({signal_id:s.id,symbol:s.symbol,trigger_at_ms:now}),
    async prepare(){await capture;throw Error('DYNAMIC_INFERENCE_CAPTURE_NOT_READY');},
    async packetHash(){return 'unused';},async call(){throw Error('MUST_NOT_CALL_PROVIDER');}};
  const coordinator=new FinalReviewCoordinator({config:{mode:'ENFORCE',modeValid:true,approvalRef:'test',apiBudgetUsd:100,
    maxCalls:100,enforceApproved:true},store,engine,apiKey:()=> 'test',now:()=>now,
    baseline:()=>true,expiry:()=>now+90_000,schedule:p=>tasks.push(p)});
  const decision=await coordinator.consider({id:'s1',symbol:'TESTUSDT'});
  assert.equal(decision.reason,'GPT_REVIEW_PENDING');
  assert.equal(store.rows.size,0);
  assert.equal(store.reserved,0);
  release();await Promise.all(tasks);
  assert.equal(store.rows.size,1);
  assert.equal([...store.rows.values()][0].state,'DONE');
  assert.equal([...store.rows.values()][0].record.result.error,'DYNAMIC_INFERENCE_CAPTURE_NOT_READY');
});
