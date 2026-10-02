import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {MemoryReviewStore} from '../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
import {runFinalRecheck,preDispatchSnapshot,detectChange,RECHECK_POLICY} from '../supabase/functions/_shared/gpt-final-decision/recheck.mjs';
import {paidTransport} from '../supabase/functions/_shared/leader20/paid-transport.mjs';
import {src} from '../development/gpt-final-decision/tests/fixtures.mjs';
import {validCapture} from '../test-support/dynamic-fixtures.mjs';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');

test('actual FINAL RECHECK persists its bounded deadline and passes the production SQL dispatch fence',async t=>{
 const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href),db=new PGlite();t.after(()=>db.close());
 await db.exec(await read('test-support/leader20-ledger-schema.sql'));
 await db.exec(await read('supabase/migrations/20260928012054_leader20_batch_provider_ledger.sql'));
 await db.exec(await read('supabase/migrations/20260928035300_leader20_owned_provider_reservation.sql'));
 await db.exec('create schema if not exists trading_internal');
 await db.exec(await read('supabase/migrations/20260930142500_durable_ai_provider_receipts.sql'));
 await db.exec('update ai_provider_limits set enabled=true,monthly_usd=100,daily_usd=50');
 const rpcErrors=[];
 const rpc={async rpc(name,args){try{return {data:(await db.query(`select public.${name}(${Object.keys(args).map((k,i)=>`${k} => $${i+1}`).join(',')}) r`,Object.values(args))).rows[0].r};}catch(e){rpcErrors.push({name,code:e.code,message:e.message});return {error:{code:e.code,message:e.message}};}}};
 for(const version of ['20260928035826_recover_expired_gpt_review_pre_dispatch','20260928041107_gpt_final_recheck_dispatch_fence']){
 const migration=await read(`supabase/migrations/${version}.sql`);
 await db.exec(migration.match(/create or replace function public\.ai_call_transition[\s\S]*?\nend \$\$;/)[0]);
 for(const fence of ['LIVE','EXPIRED','TERMINAL'])await t.test(`${version}:${fence}`,async()=>{
  const at=Date.now(),store=new MemoryReviewStore();let calls=0,claimedRecord;
  const claim=store.claim.bind(store);store.claim=async(key,record,config)=>{
   const r=await claim(key,record,config);claimedRecord=structuredClone(record);
   if(r.created)await db.query("insert into gpt_final_entry_reviews(job_key,owner,state,record,provider_ledger) values($1,$2,'RUNNING',$3,true)",[key,r.row.owner,JSON.stringify(record)]);
   return r;
  };
  store.snapshot=async(key,owner,record)=>{await db.query('update gpt_final_entry_reviews set record=$2 where job_key=$1',[key,JSON.stringify(record)]);};
  store.transport=async key=>paidTransport(rpc,{parentKey:key,purpose:'RECHECK',fetchFn:async()=>{calls++;return Response.json({id:'offline',usage:{input_tokens:100,output_tokens:5}});}});
  const ticket={expires:at+60000,snapshotHash:version+fence,identityJson:'{}',initial:{facts:{},support:[]}},
   preDispatch=preDispatchSnapshot({at,rawQuote:{best_bid:1,best_ask:1.001},e1:null});
  const result=await runFinalRecheck({signal:{id:fence,symbol:'SOONUSDT',features:{referenceClose:1}},ticket,preDispatch,
   detection:detectChange(ticket.initial,preDispatch),store,config:{mode:'ENFORCE',modeValid:true,enforceApproved:true,approvalRef:'fixture',apiBudgetUsd:100,maxCalls:100},apiKey:'offline',now:()=>at,
   readFresh:async()=>({src:{...src(at),captureContext:validCapture(at)},errors:{}}),
   review:async(packet,{fetchFn})=>{
    const key=[...store.rows.keys()][0];
    if(fence==='EXPIRED')await db.query("update gpt_final_entry_reviews set record=jsonb_set(record,'{expires_at_ms}',to_jsonb($2::bigint)) where job_key=$1",[key,at-1]);
    if(fence==='TERMINAL')await db.query("update gpt_final_entry_reviews set state='DONE' where job_key=$1",[key]);
    await fetchFn('https://api.openai.com/v1/responses',{body:JSON.stringify({model:'gpt-5.4-mini-2026-03-17',max_output_tokens:50,input:[]})});
    return {valid:true,decision:'BUY',attempted:true,completed_at_ms:at};
   }});
  if(fence==='LIVE'){
   assert.equal(result.valid,true,JSON.stringify({error:result.error,rpcErrors}));assert.equal(result.decision,'BUY');assert.equal(calls,1);
   assert.equal(claimedRecord.expires_at_ms,ticket.expires-RECHECK_POLICY.executionReserveMs);
   assert.equal((await db.query('select state from ai_call_ledger where parent_key=$1',[result.job_key])).rows[0].state,'SETTLED');
  }else{assert.equal(result.valid,false);assert.equal(calls,0,'expired/terminal parent never sends provider HTTP');}
 });
 }
});
