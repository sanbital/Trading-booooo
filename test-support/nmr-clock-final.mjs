import {readFileSync} from 'node:fs';
import {FD1_ENTRY_ENGINE} from '../supabase/functions/_shared/gpt-final-decision/engine.mjs';
import {MODEL} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {validateDecision} from '../supabase/functions/_shared/gpt-final-decision/contract.mjs';
import {batchFinalDecision,batchFinalPayload} from '../supabase/functions/_shared/leader20/final.mjs';
import {FinalReviewCoordinator,MemoryReviewStore} from '../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
import {validEvent,eventExpiry} from '../supabase/functions/_shared/leader20/campaign.mjs';
import {setTestCoordinator} from '../supabase/functions/v10-lane-executor/gpt-final-review-adapter.mjs';
export const nmrOriginal=JSON.parse(readFileSync(new URL('../tests/fixtures/nmr-clock-final-buy-20260928.json',import.meta.url)));
export async function nmrClockFinal({store=new MemoryReviewStore(),afterPrepare=null,fixture=nmrOriginal}={}){
 const original=structuredClone(fixture),packet=original.packet,id=original.identity;
 let at=original.snapshot_at_ms,calls=0,payload=null;
 const s={id:id.signal_id,symbol:id.symbol,status:'NEW',features:{leader20:id.leader20,
  referenceClose:id.reference_close,rank:id.rank,exitPolicy:id.exit_policy}},db={};
 const engine={...FD1_ENTRY_ENGINE,prepare:async()=>{afterPrepare?.(packet);return {packet,captured:original.snapshot_at_ms};},
  call:async(p)=>{
   const result=await batchFinalDecision(p,{apiKey:'offline-only',now:()=>at,call:async(p,options)=>{
    calls++;payload=options.payloadFn(p);at=original.result.completed_at_ms;
    const wire=structuredClone(original.result.wire),answer=validateDecision(wire,p);
    return {...original.result,wire,answer,attempted:true,api_cost_usd:0};
   }});
   return {...result,origin:'OPENAI_API',model_requested:MODEL,raw_response:{model:MODEL,wire:result.wire},wire_profile:FD1_ENTRY_ENGINE.id};
  }};
 const c=new FinalReviewCoordinator({config:{mode:'ENFORCE',modeValid:true,approvalRef:'offline-nmr-regression',apiBudgetUsd:1,maxCalls:10,enforceApproved:true},
  store,apiKey:()=>'offline-only',now:()=>at,baseline:validEvent,expiry:eventExpiry,engine,fetchFn:()=>{throw Error('NO_NETWORK');}});
 setTestCoordinator(db,c);await c.consider(s);await Promise.all([...c.pending.values()]);const reviewed=await c.consider(s);
 return {original,packet,s,db,c,store,reviewed,ticket:c.tickets.get(s.id),now:()=>at,setNow:x=>{at=x;},calls:()=>calls,payload:()=>payload,
  quote:(ratio=1)=>({best_bid:packet.execution_ref.bid*ratio,best_ask:packet.execution_ref.ask*ratio,timing:{received_at_ms:at}})};
}
