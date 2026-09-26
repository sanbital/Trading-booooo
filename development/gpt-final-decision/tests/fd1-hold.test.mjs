import {finalFields} from '../../../test-support/arbitration-fixtures.mjs';
import {dualEntryDecision} from '../../../supabase/functions/_shared/gpt-final-decision/dual.mjs';
import {buildDecisionPacket,MODEL} from '../../../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {computeFacts} from '../../../supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {src as marketSource} from './fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {holdStep,initialHoldState,nextEvent,HOLD_POLICY} from '../../../supabase/functions/_shared/gpt-final-decision/hold.mjs';
import {fd1HoldTick,setFd1HoldTestHooks} from '../../../supabase/functions/v10-lane-executor/gpt-final-decision-adapter.mjs';
import {MemoryReviewStore} from '../../../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
const T=1_800_000_000_000,MIN=60000;
const cfg={mode:'ENFORCE',modeValid:true,approvalRef:'test',apiBudgetUsd:3,maxCalls:300,enforceApproved:true,source:'TEST'};
function harness(decision,{valid=true,config=cfg}={}){
  const store=new MemoryReviewStore(),tasks=[];
  setFd1HoldTestHooks({store,apiKey:'k',config,schedule:t=>tasks.push(t),
    review:async({position})=>{
      const now=Date.now(),packet=await buildDecisionPacket({task:'HOLD',subjectId:'hold-test',symbol:'ABCUSDT',dataMode:'LIVE',facts:computeFacts(marketSource(now),{asOf:now}),position:{event:'REVIEW',positionId:position.id,generation:position.generation}});
      const result=await dualEntryDecision(packet,{apiKey:'k',fetchFn:async(url,init)=>{
        const input=JSON.parse(JSON.parse(init.body).input[1].content),wire={t:'HOLD',c:input.candidate_id,d:decision,reasons:decision==='EXIT'?[{r:'GPT_JUDGMENT',e:['return_5m']}]:[],support:['return_5m'],n:'Evidence review',...(input.independent_reviews?{arbitration:finalFields(input)}:{})};
        return Response.json({model:MODEL,status:'completed',usage:{input_tokens:100,output_tokens:100},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(wire)}]}]});
      }});return {packet,result:{...result,valid:valid&&result.valid}};
    }});
  return {store,tasks,flush:()=>Promise.all(tasks)};
}
const pos={id:'pos-1',signal_id:'s1',symbol:'ABCUSDT',entry_price:1,entry_at:new Date(T-3600000).toISOString()};
const st=(peak=1.05)=>({peakPrice:peak,stopPrice:.99,lastHighAt:T-50*MIN,protectionStage:'RISK_CUT'});
async function tick(meta,now,{time='V17_MOMENTUM_STALE',bid=1.03,peak=1.05}={}){return fd1HoldTick({},pos,{meta,state:st(peak),bid,now,timeCandidate:time});}

test('time candidate: waits for GPT, valid HOLD defers for the TTL, then asks again',async()=>{
  const h=harness('HOLD');let meta={};
  let r=await tick(meta,Date.now());assert.equal(r.close,false);assert.equal(r.reason,'FD1_AWAITING_GPT');meta.fd1Hold=r.state;
  await h.flush();r=await tick(meta,Date.now()+1000);assert.equal(r.close,false);assert.equal(r.reason,'FD1_GPT_HOLD');meta.fd1Hold=r.state;
  r=await tick(meta,Date.now()+60_000);assert.equal(r.close,false);assert.equal(r.reason,'FD1_GPT_HOLD');
  r=await tick(meta,Date.now()+HOLD_POLICY.holdTtlMs+2000);assert.equal(r.close,false);assert.equal(r.reason,'FD1_AWAITING_GPT');assert.equal(r.state.reviews,2);
});
for(const [d,valid,expect] of [['EXIT',true,'FD1_GPT_EXIT'],['ABSTAIN',true,'FD1_FINAL_UNAVAILABLE'],['HOLD',false,'FD1_FINAL_UNAVAILABLE']])
test(`time candidate with ${d}${valid?'':' (invalid)'} closes (${expect??'deterministic fallback'})`,async()=>{
  const h=harness(d,{valid});let meta={};let r=await tick(meta,Date.now());meta.fd1Hold=r.state;await h.flush();
  r=await tick(meta,Date.now()+1000);assert.equal(r.close,d==='EXIT'&&valid);assert.equal(r.reason,expect);
});
test('no final answer within wait window -> protected retry',async()=>{
  harness('HOLD');setFd1HoldTestHooks({store:new MemoryReviewStore(),apiKey:'k',config:cfg,schedule:()=>{},review:()=>new Promise(()=>{})});
  let meta={};let r=await tick(meta,T);meta.fd1Hold=r.state;
  r=await tick(meta,T+HOLD_POLICY.timeAnswerWaitMs+1);assert.equal(r.close,false);assert.ok(r.state.retryAfter);
});
test('GPT unavailable / budget exhausted keeps protection when no validated emergency reviewer exists',async()=>{
  harness('HOLD',{config:{...cfg,mode:'SHADOW'}});let r=await tick({},T);assert.equal(r.close,false);assert.ok(r.state.retryAfter);
  const store=new MemoryReviewStore();store.claim=async()=>{throw Error('API_BUDGET_EXHAUSTED');};
  setFd1HoldTestHooks({store,apiKey:'k',config:cfg,schedule:()=>{},review:async()=>({})});
  r=await tick({},T);assert.equal(r.close,false);assert.equal(r.state.last.decision,'BUDGET_EXHAUSTED');
  r=await fd1HoldTick({},pos,{meta:{},state:st(),bid:1.03,now:T,timeCandidate:null});assert.equal(r.close,false);
});
test('GPT budget exhaustion promotes only a fresh validated DeepSeek HOLD reviewer for existing positions',async()=>{
  const store=new MemoryReviewStore();store.claim=async()=>{throw Error('API_BUDGET_EXHAUSTED');};
  const ds=(decision)=>({result:{arbitration:{deepseek:{valid:true,answer:{decision_preference:decision,recommended_action:decision},
    completed_at_ms:T,snapshot_at_ms:T,snapshot_hash:'d'.repeat(64)}}}});
  setFd1HoldTestHooks({store,apiKey:'k',deepseekKey:'ds',config:cfg,schedule:()=>{},review:async()=>ds('EXIT')});
  let r=await tick({},T);assert.equal(r.close,true);assert.equal(r.reason,'FD1_DEEPSEEK_EXIT');assert.equal(r.fallback,true);
  assert.equal(r.approval.authority,'DEEPSEEK_EMERGENCY_EXIT_ONLY');
  setFd1HoldTestHooks({store,apiKey:'k',deepseekKey:'ds',config:cfg,schedule:()=>{},review:async()=>ds('PROTECT')});
  r=await tick({},T);assert.equal(r.close,false);assert.equal(r.reason,'FD1_DEEPSEEK_PROTECT');assert.ok(r.state.protectLevel>0);
});
test('events: deterioration and big moves start a review; GPT EXIT closes only when fresh; spacing respected',async()=>{
  const h=harness('EXIT');let meta={};
  let r=await fd1HoldTick({},pos,{meta,state:st(1.01),bid:1.005,now:Date.now(),timeCandidate:null});assert.equal(r.start,undefined);
  r=await fd1HoldTick({},pos,{meta,state:st(1.05),bid:1.03,now:Date.now(),timeCandidate:null});assert.equal(r.start.event,'MOMENTUM_DETERIORATION');meta.fd1Hold=r.state;
  await h.flush();r=await fd1HoldTick({},pos,{meta,state:st(1.05),bid:1.03,now:Date.now()+1000,timeCandidate:null});assert.equal(r.close,true);assert.equal(r.reason,'FD1_GPT_EXIT');
  const s=nextEvent({...initialHoldState(1),lastReviewAt:T,lastReviewPrice:1},{now:T+MIN,price:1.1,peak:1.1});assert.equal(s.event,null,'min gap');
  const u=nextEvent({...initialHoldState(1),lastReviewAt:T,lastReviewPrice:1},{now:T+6*MIN,price:1.03,peak:1.03});assert.equal(u.event,'SIGNIFICANT_PRICE_CHANGE');
});
test('a stale EXIT answer (older than exitMaxAgeMs) is not executed',async()=>{
  const s0={...initialHoldState(1),pending:{key:'k',event:'MOMENTUM_DETERIORATION',at:T}};
  const r=await holdStep(s0,{now:T+HOLD_POLICY.exitMaxAgeMs+5000,price:1,peak:1.05,timeCandidate:null,positionId:'p',
    answerOf:async()=>({state:'DONE',decision:'EXIT',valid:true,completed_at_ms:T})});
  assert.equal(r.close,false);
});
test('executor: hard safety precedes AI; soft candidates reach canonical FINAL; new positions stamped',()=>{
 const src=readFileSync(new URL('../../../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8');
 const manager=src.slice(src.indexOf('async function manageLeader('));
 assert.ok(manager.indexOf('if(hardBefore.hardHit)')<manager.indexOf('await fd1HoldTick'));
 assert.match(manager,/softTrigger:soft,exitContext:aiExitContext/);
 assert.match(manager,/state.stopPrice=hard.hardFloor/);
 assert.match(manager,/assertExitAuthority\(fd1.reason,p,fd1.approval/);
 assert.ok(src.includes('fd1HoldPolicyVersion:FD1_HOLD_POLICY_VERSION,'));
});
