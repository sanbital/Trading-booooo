import {finalFields} from '../../../test-support/arbitration-fixtures.mjs';
// CEC0040 is GPT evidence, GPT is the final entry decision (2026-09-24 operator architecture).
// Scenarios A-J of the release brief; K-M are tests/entry-continuation-compat.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FinalReviewCoordinator,MemoryReviewStore} from '../../../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
import {baselineAllowedLive,v30FrontDecision,V30_FRONT_LIVE_VERSION} from '../../../supabase/functions/_shared/gpt-final-review/contract.mjs';
import {FD1_ENTRY_ENGINE} from '../../../supabase/functions/_shared/gpt-final-decision/engine.mjs';
import {gptFilterExecutable,gptFinalCheck,setTestCoordinator} from '../../../supabase/functions/v10-lane-executor/gpt-final-review-adapter.mjs';
import {candidate,T} from '../../gpt-final-review/tests/helpers.mjs';
import {klines,entryWire} from './fixtures.mjs';
const MIN=60000;
function world(answer){
  const calls={openai:0};
  const fetchFn=async(url,init)=>{
    const u=new URL(url);
    if(u.hostname==='api.openai.com'){calls.openai++;const input=JSON.parse(JSON.parse(init.body).input[1].content);
      if(answer==='TIMEOUT')return new Promise(()=>{});
      if(answer==='ERROR')return new Response(JSON.stringify({error:{type:'server_error'}}),{status:500,headers:{'x-request-id':'r'}});
      const w={BUY:{d:'BUY',reasons:[],support:['return_5m','taker_buy_ratio_5m'],n:'상승 지속'},SKIP:{d:'SKIP',reasons:[],support:[],n:'건너뜀'},
        ABSTAIN:{d:'ABSTAIN',reasons:[],support:[],n:'판단 불가'}}[answer];
      const raw={model:'gpt-5.4-mini-2026-03-17',status:'completed',usage:{input_tokens:3000,output_tokens:80,input_tokens_details:{cached_tokens:0}},
        output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(entryWire({t:'ENTRY',c:input.candidate_id,...w,...(input.independent_reviews?{arbitration:finalFields(input)}:{})}))}]}]};
      return new Response(JSON.stringify(raw),{status:200,headers:{'x-request-id':'req'}});}
    const p=u.pathname,at=Number(u.searchParams.get('endTime')??T)+1;
    if(p==='/fapi/v1/klines')return Response.json(klines(Number(u.searchParams.get('limit')),u.searchParams.get('interval')==='5m'?5*MIN:MIN,at,{step:u.searchParams.get('symbol')==='BTCUSDT'?.0001:.001}));
    if(p==='/futures/data/openInterestHist')return Response.json(Array.from({length:13},(_,i)=>({timestamp:Math.floor(T/300000)*300000-(12-i)*300000,sumOpenInterest:1000+i,sumOpenInterestValue:5e6})));
    if(p==='/fapi/v1/premiumIndexKlines')return Response.json([[T-MIN,'0','0','0','0.0002','0',T-1]]);
    if(p==='/fapi/v1/premiumIndex')return Response.json({lastFundingRate:'0.0001'});
    if(p==='/fapi/v1/depth')return Response.json({bids:[[1.199,2000],[1.198,2000]],asks:[[1.2,2000],[1.201,2000]]});
    return new Response('no',{status:404});
  };
  return {fetchFn,calls};
}
/** A V30-admitted trigger (B06133 REJECT kept as evidence) with a chosen CEC0040 stamp. */
function v30Candidate(action,cecPatch={}){
  const s=candidate('sig-'+action);const b=s.features.b06133;
  b.allowed=false;b.result=false;b.branch=null;b.reason='B06133_REJECT';
  b.factors={...b.factors,fresh5over15:true,volumeTails:false};
  s.features.referenceClose=1;
  s.features.v30Front=v30FrontDecision(b,V30_FRONT_LIVE_VERSION);
  s.features.cec0040={...s.features.cec0040,action,modelAllowed:action!=='REJECT',effectiveAllowed:action!=='REJECT',
    enforcementEnabled:true,predictionUsdt:action==='REJECT'?-3.67:0.4,trainingCount:125,...cecPatch};
  return s;
}
const ENFORCE={mode:'ENFORCE',modeValid:true,approvalRef:'t',apiBudgetUsd:3,maxCalls:300,enforceApproved:true,source:'TEST'};
function production(answer,{mode='ENFORCE',clock}={}){
  const w=world(answer),now=clock??(()=>T+1500);
  const c=new FinalReviewCoordinator({config:{...ENFORCE,mode},store:new MemoryReviewStore(),apiKey:()=>'k',now,fetchFn:w.fetchFn,
    engine:FD1_ENTRY_ENGINE,baseline:baselineAllowedLive,schedule:()=>{}});
  const db={};setTestCoordinator(db,c);return {db,c,w};
}
async function decide(db,c,s){const r=await gptFilterExecutable(db,[s]);await Promise.all([...c.pending.values()]);
  const r2=await gptFilterExecutable(db,[s]);return {first:r,second:r2,check:gptFinalCheck(db,s)};}

for(const action of ['ADMIT','PROBE','REJECT'])
test(`${action==='ADMIT'?'A':action==='PROBE'?'B':'C'}. CEC ${action} + GPT BUY -> entry candidate kept; CEC stamp unchanged`,async()=>{
  const {db,c}=production('BUY'),s=v30Candidate(action),before=JSON.stringify(s.features.cec0040);
  const out=await decide(db,c,s);
  assert.equal(out.second.candidates.length,1);assert.equal(out.check.allowed,true);assert.equal(out.check.review.decision,'BUY');
  assert.equal(JSON.stringify(s.features.cec0040),before);
  // GPT is shown the CEC judgment as evidence, including a REJECT.
  const row=[...c.store.rows.values()][0];assert.equal(row.record.packet.model_judgments.cec0040.action,action);
});
for(const [id,answer] of [['D','SKIP'],['E','ABSTAIN'],['F1','TIMEOUT'],['F2','ERROR']])
test(`${id}. CEC REJECT + GPT ${answer} -> no entry`,async()=>{
  const {db,c}=production(answer),s=v30Candidate('REJECT');
  const out=await decide(db,c,s);assert.equal(out.second.candidates.length,0);assert.equal(out.check.allowed,false);
});
test('F3. CEC ADMIT never substitutes for a missing GPT answer (pending/invalid)',async()=>{
  const {db,c}=production('TIMEOUT'),s=v30Candidate('ADMIT');
  const r=await gptFilterExecutable(db,[s]);assert.equal(r.candidates.length,0);assert.equal(gptFinalCheck(db,s).allowed,false);
});
for(const mode of ['OFF','SHADOW'])
test(`${mode==='OFF'?'G':'H'}. GPT ${mode} -> no new live entry, even with CEC ADMIT`,async()=>{
  const {db,c,w}=production('BUY',{mode}),s=v30Candidate('ADMIT');
  const r=await gptFilterExecutable(db,[s]);assert.deepEqual(r.candidates,[]);
  assert.equal(gptFinalCheck(db,s).allowed,false);if(mode==='OFF')assert.equal(w.calls.openai,0);
});
test('I. an expired GPT BUY cannot be used for an order',async()=>{
  let now=T+1500;const {db,c}=production('BUY',{clock:()=>now}),s=v30Candidate('REJECT');
  const out=await decide(db,c,s);assert.equal(out.check.allowed,true);
  now=T+58000;assert.equal(gptFinalCheck(db,s).allowed,false);
});
for(const [name,patch] of [['not ready',{ready:false}],['malformed action',{action:'MAYBE'}],['timestamp mismatch',{decisionAt:T+60000}],['wrong version',{version:'X'}]])
test(`J. CEC ${name} -> no GPT call and no entry`,async()=>{
  const {db,c,w}=production('BUY'),s=v30Candidate('REJECT',patch);
  const out=await decide(db,c,s);assert.equal(out.second.candidates.length,0);assert.equal(out.check.allowed,false);assert.equal(w.calls.openai,0);
});
test('executor: CEC REJECT is not terminal, openBull does not re-veto it, GPT BUY is required, every ready CEC decision is target-tracked',()=>{
  const src=readFileSync(new URL('../../../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8').replace(/\r\n/g,'\n');
  const cec=src.slice(src.indexOf('async function applyCec0040Selection'),src.indexOf('async function registerCec0040Target'));
  assert.ok(!/patch\.status="REJECTED"/.test(cec),'no terminal REJECTED from CEC');
  assert.match(cec,/return \{allowed:stamp\.ready,row:write\.data,stamp\}/);
  const open=src.slice(src.indexOf('async function openBull'),src.indexOf('const gptEntryCheck=gptFinalCheck(db,s,null,null,{allowAged:true});'));
  assert.ok(!/effectiveAllowed|modelAllowed/.test(open),'no CEC admission re-check before the GPT check');
  // allowAged only lets an aged BUY reach the forced FINAL RECHECK; it never dispatches on it.
  assert.match(src,/const gptEntryCheck=gptFinalCheck\(db,s,null,null,\{allowAged:true\}\);\nif\(!gptEntryCheck\.allowed\)return\{entered:false/);
  assert.match(src,/const gptDispatchCheck=gptFinalCheck\(db,s,attempt\.finalRecheck\);/);
  const reg=src.slice(src.indexOf('async function registerCec0040Target'),src.indexOf('async function fetchCec0040Public'));
  assert.ok(!/modelAllowed|effectiveAllowed/.test(reg));assert.match(reg,/\["ADMIT","PROBE","REJECT"\]\.includes\(cec\.action\)/);
  assert.ok(src.includes('entry_gpt_decision:attempt.gptFinalReview??null')&&src.includes('gptEntryDecision:intent.request_payload?.entry_gpt_decision??null'));
  // Only one order-opening path, and it is behind both GPT checks.
  assert.equal(src.split('openBull(db,').length-1,2,'definition + the single queue call');
  assert.equal(src.split('intent:"OPEN_LONG"').length-1,1,'one OPEN_LONG intent writer (inside openBull, after both GPT checks)');
});
test('SQL: CEC target registration/repair/lag accept REJECT decisions, never rewrite the decision',()=>{
  const sql=readFileSync(new URL('../../../supabase/migrations/20260924052022_cec0040_track_gpt_bought_rejects.sql',import.meta.url),'utf8');
  assert.match(sql,/model_action in \('ADMIT','PROBE','REJECT'\)/);
  assert.ok(!/update public\.v11_cec0040_decisions/i.test(sql));
});
