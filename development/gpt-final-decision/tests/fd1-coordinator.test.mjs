import test from 'node:test';
import assert from 'node:assert/strict';
import {FinalReviewCoordinator,MemoryReviewStore} from '../../../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
import {FD1_ENTRY_ENGINE} from '../../../supabase/functions/_shared/gpt-final-decision/engine.mjs';
import {klines} from './fixtures.mjs';
const MIN=60000;
function world(decide,{now}){
  return async(url,init)=>{
    const u=new URL(url);
    if(u.hostname==='api.openai.com'){const body=JSON.parse(init.body),input=JSON.parse(body.input[1].content);
      const raw={model:'gpt-5.4-mini-2026-03-17',status:'completed',usage:{input_tokens:3000,output_tokens:90,input_tokens_details:{cached_tokens:2000}},
        output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(decide(input,body))}]}]};
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
function coord(decide,now=()=>trig+1500){return new FinalReviewCoordinator({config:cfg,store:new MemoryReviewStore(),apiKey:()=>'k',now,
  fetchFn:world(decide,{now}),engine:FD1_ENTRY_ENGINE,baseline:()=>true});}
test('FD1 entry: valid BUY yields an entry ticket; the ticket is bound to the identity',async()=>{
  const c=coord(i=>({t:'ENTRY',c:i.candidate_id,d:'BUY',reasons:[],support:['return_5m','taker_buy_ratio_5m'],n:'상승 지속'}));
  const s=sig();let r=await c.consider(s);assert.equal(r.reason,'GPT_REVIEW_PENDING');await Promise.all([...c.pending.values()]);
  r=await c.consider(s);assert.equal(r.decision,'BUY');assert.equal(r.allowed,true);assert.equal(c.check(s).allowed,true);
  const t=sig();t.features.rank=9;assert.equal(c.check(t).allowed,false,'changed evidence invalidates the ticket');
});
for(const [name,decide] of [['SKIP',i=>({t:'ENTRY',c:i.candidate_id,d:'SKIP',reasons:[],support:[],n:'x'})],
  ['ABSTAIN',i=>({t:'ENTRY',c:i.candidate_id,d:'ABSTAIN',reasons:[],support:[],n:'판단 불가'})],
  ['BUY without support (invalid)',i=>({t:'ENTRY',c:i.candidate_id,d:'BUY',reasons:[],support:[],n:'x'})],
  ['wrong candidate id',i=>({t:'ENTRY',c:'zzz',d:'BUY',reasons:[],support:['return_5m','taker_buy_ratio_5m'],n:'x'})]])
test('FD1 entry: '+name+' never places an order',async()=>{
  const c=coord(decide),s=sig();await c.consider(s);await Promise.all([...c.pending.values()]);const r=await c.consider(s);
  assert.equal(r.allowed,false);assert.equal(c.check(s).allowed,false);
});
test('FD1 entry: an expired review cannot be used for an order',async()=>{
  let clock=trig+1500;const c=coord(i=>({t:'ENTRY',c:i.candidate_id,d:'BUY',reasons:[],support:['return_5m','taker_buy_ratio_5m'],n:'x'}),()=>clock);
  const s=sig();await c.consider(s);await Promise.all([...c.pending.values()]);assert.equal((await c.consider(s)).allowed,true);
  clock=trig+58000;assert.equal(c.check(s).allowed,false);
});
