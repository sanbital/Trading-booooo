import test from 'node:test';
import assert from 'node:assert/strict';
import {holdStep,initialHoldState,nextEvent,HOLD_POLICY,runHoldReview} from '../supabase/functions/_shared/gpt-final-decision/hold.mjs';
import {computeFacts} from '../supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {buildDecisionPacket} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {recordHoldShadow,shadowJobKey,holdShadowEnabled,flashCostCeiling} from '../supabase/functions/_shared/gpt-final-decision/hold-shadow.mjs';
import {fd1HoldTick,setFd1HoldTestHooks} from '../supabase/functions/v10-lane-executor/gpt-final-decision-adapter.mjs';
import {MemoryReviewStore} from '../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
import {T,src} from '../development/gpt-final-decision/tests/fixtures.mjs';
const config={mode:'ENFORCE',modeValid:true,approvalRef:'test',apiBudgetUsd:3,maxCalls:300,enforceApproved:true};
test('approved shadow default can be killed; usage ceiling never assumes missing usage is free',()=>{
  assert.equal(holdShadowEnabled(''),true);assert.equal(holdShadowEnabled('true'),true);
  assert.equal(holdShadowEnabled('false'),false);assert.equal(holdShadowEnabled('typo'),false);
  assert.equal(flashCostCeiling({model:'deepseek-flash',usage:{prompt_tokens:1000,completion_tokens:100}}),.00042);
  for(const r of [{},{model:'wrong',usage:{prompt_tokens:1,completion_tokens:1}},
    {model:'deepseek-flash',usage:{prompt_tokens:-1,completion_tokens:100}}])assert.equal(flashCostCeiling(r),null);
});
test('adverse crossing bypasses ordinary 5m gap but keeps 1m gap, arming, pending and cap',()=>{
  const s={...initialHoldState(100),reviews:1,lastReviewAt:T-60000,lastReviewPrice:103,lastPeak:103};
  const args={now:T,price:101.4,peak:103};
  const r=nextEvent(s,args);assert.equal(r.event,'MOMENTUM_DETERIORATION');assert.equal(r.state.ddArmed,false);
  for(const st of [{...s,lastReviewAt:T-59999},{...s,ddArmed:false},{...s,reviews:30},{...s,pending:{key:'k'}}])
    assert.equal(nextEvent(st,args).event,null);
  assert.equal(nextEvent(s,{...args,price:106,peak:106}).event,null,'ordinary rise still spaced');
});
for(const [name,completed,at] of [['old',T-600000,T-660000],['future',T+1,T-1000],['null',null,T-1000],
  ['nan',NaN,T-1000],['before-request',T-2000,T-1000],['late-completion',T-1000,T-30000]])
test(`invalid HOLD timestamp: ${name} falls back instead of extending`,async()=>{
  const r=await holdStep({...initialHoldState(100),pending:{key:'k',event:'TIME_EXIT_CANDIDATE:V17_MAX_HOLD',at}},
    {now:T,price:100,peak:100,timeCandidate:'V17_MAX_HOLD',positionId:'p',
      answerOf:async()=>({state:'DONE',valid:true,decision:'HOLD',completed_at_ms:completed})});
  assert.equal(r.close,true);assert.equal(r.fallback,true);assert.equal(r.state.holdUntil,null);
});
test('fresh HOLD still extends and fresh EXIT still closes',async()=>{
  for(const decision of ['HOLD','EXIT']){
    const r=await holdStep({...initialHoldState(100),pending:{key:'k',event:'TIME_EXIT_CANDIDATE:V17_MAX_HOLD',at:T-2000}},
      {now:T,price:100,peak:100,timeCandidate:'V17_MAX_HOLD',positionId:'p',
        answerOf:async()=>({state:'DONE',valid:true,decision,completed_at_ms:T-1000})});
    assert.equal(r.close,decision==='EXIT');
    if(decision==='HOLD')assert.equal(r.state.holdUntil,T+HOLD_POLICY.holdTtlMs);
  }
});
const position={entryPrice:1.1,peakPrice:1.15,stopPrice:1,entryAt:T-60000,lastHighAt:T-30000,requireLiveQuote:true};
function input(){const s=src(T);Object.assign(s.book,{T:T-20,requestedAtMs:T-100,receivedAtMs:T-10});return s;}
test('live position values use fresh bid, clamp peak, and retain candle trend facts',()=>{
  const s=input(),f=computeFacts(s,{asOf:T,position});
  assert.equal(f.values.position_return,1.199/1.1-1);
  assert.equal(f.values.position_drawdown_from_peak,0);
  assert.equal(f.values.return_5m,computeFacts(s,{asOf:T}).values.return_5m);
  assert.notEqual(f.values.position_return,computeFacts(s,{asOf:T,position:{...position,requireLiveQuote:false}}).values.position_return);
});
for(const change of [{T:T-6000},{T:T+1},{requestedAtMs:T-6000},{receivedAtMs:T+1},{T:undefined}])
test('stale or unproven live bid cannot become a position valuation '+JSON.stringify(change),()=>{
  const s=input();Object.assign(s.book,change);
  const f=computeFacts(s,{asOf:T,position});assert.equal(f.values.position_return,null);assert.equal(f.values.position_stop_distance,null);
});
async function packet(){return buildDecisionPacket({task:'HOLD',subjectId:'p',symbol:'ABCUSDT',dataMode:'LIVE',
  facts:computeFacts(input(),{asOf:T,position}),position:{event:'MOMENTUM_DETERIORATION'}});}
test('shadow is opt-in, budget-claimed once, independent and retains unknown cost reservation',async()=>{
  const store=new MemoryReviewStore(),p=await packet();let calls=0;
  const args={packet:p,snapshotAt:T,key:'s',parentKey:'g',identity:{},store,config,apiKey:'test',
    invoke:async shared=>{calls++;assert.equal(shared.packet.snapshot_hash,p.snapshot_hash);return {valid:true,answer:{decision_preference:'EXIT'}};}};
  assert.equal((await recordHoldShadow(args)).state,'DISABLED');assert.equal(calls,0);
  assert.equal((await recordHoldShadow({...args,enabled:true})).state,'DONE');
  assert.equal((await recordHoldShadow({...args,enabled:true})).state,'DUPLICATE');assert.equal(calls,1);
  const key=await shadowJobKey('g');assert.match(key,/^[0-9a-f]{64}$/);
  const row=await store.get(key);assert.deepEqual(row.record.authority,[]);assert.equal(row.record.result.api_cost_usd,null);
  const blocked={...args,key:'blocked',enabled:true,store:{claim:async()=>{throw Error('API_BUDGET_EXHAUSTED');}}};
  assert.equal((await recordHoldShadow(blocked)).state,'UNAVAILABLE');assert.equal(calls,1);
});
test('shadow keys satisfy the production DB constraint and differ by parent',async()=>{
  const a=await shadowJobKey('a'),b=await shadowJobKey('b');assert.notEqual(a,b);assert.equal(a,await shadowJobKey('a'));
  const store=new MemoryReviewStore(),claim=store.claim.bind(store);
  store.claim=async(key,record,config)=>{assert.match(key,/^[0-9a-f]{64}$/);return claim(key,record,config);};
  const r=await recordHoldShadow({packet:await packet(),snapshotAt:T,parentKey:'test-parent',identity:{},store,config,
    apiKey:'test',enabled:true,invoke:async()=>({valid:false,attempted:false})});
  assert.equal(r.state,'DONE');
});
test('GPT result is durable and usable while DeepSeek is unresolved',async()=>{
  const store=new MemoryReviewStore(),tasks=[],p=await packet();let finish;
  const gate=new Promise(resolve=>{finish=resolve;});
  setFd1HoldTestHooks({store,apiKey:'test',config,shadowEnabled:true,deepseekKey:'test',schedule:t=>tasks.push(t),
    counterCall:async()=>{await gate;return {valid:true,answer:{decision_preference:'EXIT'}};},
    review:async({onPacket})=>{onPacket(p,T);return {packet:p,result:{valid:true,decision:'HOLD',completed_at_ms:T,api_cost_usd:.001}};}});
  try{
    const pos={id:'p',symbol:'ABCUSDT',entry_price:1.1,entry_at:new Date(T-60000).toISOString()};
    const args={meta:{},state:{peakPrice:1.2,stopPrice:1},bid:1.19,now:T,timeCandidate:'V17_MAX_HOLD'};
    const started=await fd1HoldTick({},pos,args);
    // Let the background GPT persistence finish; the unresolved counter must not block it.
    for(let i=0;i<20;i++)await Promise.resolve();
    assert.equal((await store.get(started.start.key)).state,'DONE');
    const consumed=await fd1HoldTick({},pos,{...args,meta:{fd1Hold:started.state},now:T+1000});
    assert.equal(consumed.close,false);assert.equal(consumed.reason,'FD1_GPT_HOLD');
  }finally{finish();await Promise.all(tasks);setFd1HoldTestHooks(null);}
});
test('live quote failure returns ABSTAIN before any model call',async()=>{
  const r=await runHoldReview({position:{...position,id:'p',symbol:'ABCUSDT'},event:'REVIEW',apiKey:'test',now:()=>T,
    fetchFn:async()=>new Response('{}',{status:503})});
  assert.equal(r.result.attempted,false);assert.equal(r.result.decision,'ABSTAIN');
});
test('live review supplies identical bid valuation to GPT and observer; observer failure is isolated',async()=>{
  const s=input();let observed,seen;
  const fetchFn=async(url,init)=>{
    if(String(url).includes('api.openai.com')){
      seen=JSON.parse(JSON.parse(init.body).input[1].content);
      return new Response(JSON.stringify({model:'gpt-5.4-mini-2026-03-17',status:'completed',
        usage:{input_tokens:100,output_tokens:30},output:[{type:'message',content:[{type:'output_text',
          text:JSON.stringify({t:'HOLD',c:seen.candidate_id,d:'HOLD',reasons:[],support:['return_5m'],n:'trend alive'})}]}]}));
    }
    const u=new URL(url);let body;
    if(u.pathname.endsWith('/depth'))body=s.book;
    else if(u.pathname.endsWith('/klines'))body=u.searchParams.get('symbol')==='BTCUSDT'?s.btc:u.searchParams.get('interval')==='5m'?s.five:s.one;
    else if(u.pathname.endsWith('/openInterestHist'))body=s.oiHist;
    else if(u.pathname.endsWith('/premiumIndexKlines'))body=s.premium;
    else body={lastFundingRate:s.funding.rate};
    return new Response(JSON.stringify(body));
  };
  const r=await runHoldReview({position:{...position,id:'p',symbol:'ABCUSDT'},event:'REVIEW',apiKey:'test',now:()=>T,fetchFn,
    onPacket:p=>{observed=p;throw Error('observer failure');}});
  assert.equal(r.result.valid,true);assert.equal(r.result.decision,'HOLD');
  assert.equal(observed.snapshot_hash,r.packet.snapshot_hash);
  assert.equal(seen.position.valuation.basis,'EXECUTABLE_BID');
  assert.equal(seen.facts.position.position_return,Number((1.199/1.1-1).toPrecision(5)));
});
