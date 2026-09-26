import {finalFields} from '../../../test-support/arbitration-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {FinalReviewCoordinator,MemoryReviewStore,AGED_RECHECK_MIN_MS} from '../../../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
import {FD1_ENTRY_ENGINE} from '../../../supabase/functions/_shared/gpt-final-decision/engine.mjs';
import {klines,entryWire} from './fixtures.mjs';
const MIN=60000;
function world(decide,{now}){
  return async(url,init)=>{
    const u=new URL(url);
    if(u.hostname==='api.openai.com'){const body=JSON.parse(init.body),input=JSON.parse(body.input[1].content);
      const raw={model:'gpt-5.4-mini-2026-03-17',status:'completed',usage:{input_tokens:3000,output_tokens:90,input_tokens_details:{cached_tokens:2000}},
        output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({...decide(input,body),...(input.independent_reviews?{arbitration:finalFields(input)}:{})})}]}]};
      return new Response(JSON.stringify(raw),{status:200,headers:{'x-request-id':'req_x'}});}
    const p=u.pathname,at=Number(u.searchParams.get('endTime')??now())+1;
    if(p==='/fapi/v1/klines'){const iv=u.searchParams.get('interval')==='5m'?5*MIN:MIN;return Response.json(klines(Number(u.searchParams.get('limit')),iv,at,{step:u.searchParams.get('symbol')==='BTCUSDT'?.0001:.001}));}
    if(p==='/futures/data/openInterestHist')return Response.json(Array.from({length:13},(_,i)=>({timestamp:Math.floor(now()/300000)*300000-(12-i)*300000,sumOpenInterest:1000+i,sumOpenInterestValue:5e6})));
    if(p==='/fapi/v1/premiumIndexKlines')return Response.json([[Math.floor(now()/MIN)*MIN-MIN,'0','0','0','0.0002','0',Math.floor(now()/MIN)*MIN-1]]);
    if(p==='/fapi/v1/premiumIndex')return Response.json({lastFundingRate:'0.0001'});
    if(p==='/fapi/v1/depth')return Response.json({bids:[[1.199,2000],[1.198,2000]],asks:[[1.2,2000],[1.201,2000]]});
    return new Response('no',{status:404});
  };
}
const trig=Math.floor(Date.now()/MIN)*MIN;
const sig=()=>({id:'sig-fd1',symbol:'ABCUSDT',status:'NEW',features:{strategy:'LEADER_MOMENTUM_V17',referenceClose:1,dayReturn:.2,rank:2,v17Setup:{state:'TRIGGERED',triggerAt:trig},exitPolicy:{stopPct:.01}}});
const cfg={mode:'ENFORCE',modeValid:true,approvalRef:'t',apiBudgetUsd:3,maxCalls:300,enforceApproved:true,source:'TEST'};
function coord(decide,now=()=>trig+1500,engine=FD1_ENTRY_ENGINE){return new FinalReviewCoordinator({config:cfg,store:new MemoryReviewStore(),apiKey:()=>'k',now,
  fetchFn:world(decide,{now}),engine,baseline:()=>true});}
test('FD1 entry: valid BUY yields an entry ticket; the ticket is bound to the identity',async()=>{
  const c=coord(i=>(entryWire({t:'ENTRY',c:i.candidate_id,d:'BUY',reasons:[],support:['return_5m','taker_buy_ratio_5m'],n:'상승 지속'})));
  const s=sig();let r=await c.consider(s);assert.equal(r.reason,'GPT_REVIEW_PENDING');await Promise.all([...c.pending.values()]);
  r=await c.consider(s);assert.equal(r.decision,'BUY');assert.equal(r.allowed,true);assert.equal(c.check(s).allowed,true);
  const t=sig();t.features.rank=9;assert.equal(c.check(t).allowed,false,'changed evidence invalidates the ticket');
});
for(const [name,decide] of [['SKIP',i=>(entryWire({t:'ENTRY',c:i.candidate_id,d:'SKIP',reasons:[],support:[],n:'x'}))],
  ['ABSTAIN',i=>(entryWire({t:'ENTRY',c:i.candidate_id,d:'ABSTAIN',reasons:[],support:[],n:'판단 불가'}))],
  ['BUY without support (invalid)',i=>(entryWire({t:'ENTRY',c:i.candidate_id,d:'BUY',reasons:[],support:[],n:'x'}))],
  ['wrong candidate id',i=>(entryWire({t:'ENTRY',c:'zzz',d:'BUY',reasons:[],support:['return_5m','taker_buy_ratio_5m'],n:'x'}))]])
test('FD1 entry: '+name+' never places an order',async()=>{
  const c=coord(decide),s=sig();await c.consider(s);await Promise.all([...c.pending.values()]);const r=await c.consider(s);
  assert.equal(r.allowed,false);assert.equal(c.check(s).allowed,false);
});
test('FD1 entry: an expired review cannot be used for an order',async()=>{
  let clock=trig+1500;const c=coord(i=>(entryWire({t:'ENTRY',c:i.candidate_id,d:'BUY',reasons:[],support:['return_5m','taker_buy_ratio_5m'],n:'x'})),()=>clock);
  const s=sig();await c.consider(s);await Promise.all([...c.pending.values()]);assert.equal((await c.consider(s)).allowed,true);
  clock=trig+58000;assert.equal(c.check(s).allowed,false);
});

const BUY=i=>entryWire({t:'ENTRY',c:i.candidate_id,d:'BUY',support:['return_5m','taker_buy_ratio_5m'],n:'상승 지속'});
test('AGED GPT BUY: admitted to the order path only to be rechecked; never dispatched on the aged answer',async()=>{
  let clock=trig+1500;const c=coord(BUY,()=>clock),s=sig();
  await c.consider(s);await Promise.all([...c.pending.values()]);assert.equal((await c.consider(s)).allowed,true);
  const validUntil=c.tickets.get('sig-fd1').validUntil,expires=trig+60000;
  clock=validUntil+2000;                       // past the 15 s answer validity, trigger still live
  const aged=await c.consider(s);
  assert.equal(aged.allowed,true);assert.equal(aged.aged,true);assert.equal(aged.reason,'GPT_BUY_AGED');
  assert.equal(c.check(s).allowed,false,'no dispatch on an aged answer');assert.equal(c.check(s).reason,'GPT_REVIEW_EXPIRED');
  const entry=c.check(s,{allowAged:true});
  assert.equal(entry.allowed,true);assert.equal(entry.aged,true);assert.equal(entry.review.aged,true);
  assert.equal(entry.reason,'GPT_BUY_AGED_RECHECK_REQUIRED');
  assert.equal(c.check(s,{supersededBy:'rc-job'}).allowed,true,'a FINAL RECHECK BUY supersedes the answer age');
  clock=expires-3000;assert.equal(c.check(s,{supersededBy:'rc-job'}).allowed,false,'never the trigger expiry');
  clock=expires-3000-AGED_RECHECK_MIN_MS;     // too late for a recheck: refused exactly as before
  const late=await c.consider(s);assert.equal(late.allowed,false);assert.equal(late.reason,'GPT_STALE_OR_FUTURE_REVIEW');
  assert.equal(late.storedDecision,'BUY','the stored decision is kept for the lifecycle label');
  assert.equal(c.check(s,{allowAged:true}).allowed,false);
});
test('AGED answers without an agedRecheck engine are refused as before; an aged SKIP stays a SKIP',async()=>{
  let clock=trig+1500;const legacy=coord(BUY,()=>clock,{...FD1_ENTRY_ENGINE,agedRecheck:false}),s=sig();
  await legacy.consider(s);await Promise.all([...legacy.pending.values()]);assert.equal((await legacy.consider(s)).allowed,true);
  clock=legacy.tickets.get('sig-fd1').validUntil+2000;
  assert.equal((await legacy.consider(s)).reason,'GPT_STALE_OR_FUTURE_REVIEW');
  let t2=trig+1500;const skip=coord(i=>entryWire({t:'ENTRY',c:i.candidate_id,d:'SKIP',reasons:[{r:'EV_UNFAVORABLE',e:['accel_5m_vs_15m','accel_15m_vs_60m']}],
    bearish:['accel_5m_vs_15m','accel_15m_vs_60m'],n:'기대값 불리'}),()=>t2);
  await skip.consider(s);await Promise.all([...skip.pending.values()]);
  const fresh=await skip.consider(s);
  assert.equal(fresh.decision,'SKIP');assert.equal(fresh.detail,'EV_UNFAVORABLE');assert.equal(fresh.allowed,false);
  t2=skip.tickets.get('sig-fd1').validUntil+2000;const a=await skip.consider(s);
  assert.equal(a.allowed,false);assert.equal(a.reason,'GPT_SKIP_AGED');
  assert.equal(skip.check(s,{allowAged:true}).allowed,false,'allowAged admits only a BUY');
});
test('follow-up arming: one-shot, only while a remaining BUY can still be rechecked',()=>{
  let clock=trig+20000;const c=coord(BUY,()=>clock),s=sig();
  assert.equal(c.armFollowUp([s]),true);assert.equal(c.consumeReadyYield(),true);assert.equal(c.consumeReadyYield(),false,'one-shot');
  clock=trig+60000-3000-AGED_RECHECK_MIN_MS;assert.equal(c.armFollowUp([s]),false,'too late for its window');
  assert.equal(c.armFollowUp([]),false);
});
