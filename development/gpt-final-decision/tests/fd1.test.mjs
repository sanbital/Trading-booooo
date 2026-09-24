import test from 'node:test';
import assert from 'node:assert/strict';
import {computeFacts,modelJudgments,FACT_KEYS} from '../../../supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {validateDecision,riskFlags,wireSchema,CATEGORIES} from '../../../supabase/functions/_shared/gpt-final-decision/contract.mjs';
import {buildDecisionPacket,callDecision,payloadFor,modelInput} from '../../../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {PROMPTS} from '../../../supabase/functions/_shared/gpt-final-decision/prompt.mjs';
import {T,MIN,src,mockApi} from './fixtures.mjs';
const facts=(opt={},ctx={})=>computeFacts(src(T,opt),{asOf:T+2000,referenceClose:1.1,dayReturn:.2,rank:3,...ctx});
const entry=async(opt,ctx,mode='LIVE')=>buildDecisionPacket({task:'ENTRY',subjectId:'sig-1',symbol:'ABCUSDT',dataMode:mode,facts:facts(opt,ctx),judgments:modelJudgments({})});
const hold=async(opt,pos={entryPrice:1.1,peakPrice:1.2,entryAt:T-3600000,lastHighAt:T-60*MIN,stopPrice:1.05})=>buildDecisionPacket({task:'HOLD',subjectId:'pos-1',symbol:'ABCUSDT',dataMode:'LIVE',
  facts:facts(opt,{position:pos}),judgments:null,position:{event:'TIME_EXIT_CANDIDATE',deterministicExitCandidate:'V17_MOMENTUM_STALE'}});

test('facts use only completed bars before asOf and separate machine judgments',()=>{
  const f=facts();assert.ok(f.quality.candles_complete);assert.ok(f.values.return_5m>0);assert.ok(f.values.taker_buy_ratio_5m>.59);
  assert.equal(f.values.ask_depth_to_order,(1.2*2000+1.201*2000)/600);
  const later=computeFacts({...src(T),one:[...src(T).one,[T,'9','9','9','9','0',T+MIN-1,'1','0','1','1','0']]},{asOf:T+2000});
  assert.equal(later.values.return_1m,f.values.return_1m,'a bar closing after asOf is ignored');
  assert.deepEqual(Object.keys(f.values).sort(),[...FACT_KEYS].sort());
  const j=modelJudgments({b06133:{allowed:false,factors:{fresh5over15:true}}});assert.equal(j.b06133.allowed,false);assert.ok(!('return_5m' in j));
});
test('replay mode withholds the book without a HARD data flag; live requires it',async()=>{
  const r=await entry({src:{book:null,bookMissingReason:'NOT_POINT_IN_TIME_REPLAY'}},{},'REPLAY');
  assert.equal(r.facts.values.spread_bps,null);assert.equal(riskFlags(r).flags.DATA_INCOMPLETE.level,'CLEAR');
  const l=await entry({src:{book:null}});assert.equal(riskFlags(l).flags.DATA_INCOMPLETE.level,'HARD');
});
test('BUY needs >=2 up-side facts incl. a trend fact, and no HARD risk',async()=>{
  const p=await entry();
  assert.equal(validateDecision({t:'ENTRY',c:p.candidate_id,d:'BUY',reasons:[],support:['return_5m','taker_buy_ratio_5m'],n:'상승 지속'},p).decision,'BUY');
  assert.throws(()=>validateDecision({t:'ENTRY',c:p.candidate_id,d:'BUY',reasons:[],support:['return_5m'],n:'x'},p),/REQUIRES_SUPPORT/);
  assert.throws(()=>validateDecision({t:'ENTRY',c:p.candidate_id,d:'BUY',reasons:[],support:['spread_bps','funding_rate'],n:'x'},p),/TREND_FACT/);
  const down=await entry({step:-.001},{referenceClose:.5});
  assert.throws(()=>validateDecision({t:'ENTRY',c:down.candidate_id,d:'BUY',reasons:[],support:['return_5m','taker_buy_ratio_5m'],n:'x'},down),/REQUIRES_SUPPORT/);
  assert.deepEqual(validateDecision({t:'ENTRY',c:p.candidate_id,d:'BUY',reasons:[],support:['return_5m','taker_buy_ratio_5m','btc_return_15m'],n:'x'},p).rejected_support,[]);
  const wide=await entry({src:{book:{bids:[[1.0,5000]],asks:[[1.2,5000]]}}});
  assert.throws(()=>validateDecision({t:'ENTRY',c:wide.candidate_id,d:'BUY',reasons:[],support:['return_5m','taker_buy_ratio_5m'],n:'x'},wide),/HARD_RISK/);
});
test('SKIP must name a category actually breached; "already rose" is impossible',async()=>{
  const p=await entry();
  assert.throws(()=>validateDecision({t:'ENTRY',c:p.candidate_id,d:'SKIP',reasons:[{r:'MOMENTUM_FADED',e:['return_5m']}],support:[],n:'이미 많이 올랐다'},p),/REASON_NOT_PRESENT/);
  assert.throws(()=>validateDecision({t:'ENTRY',c:p.candidate_id,d:'SKIP',reasons:[],support:[],n:'x'},p),/REQUIRES_CATEGORY/);
  assert.ok(!Object.keys(CATEGORIES).some(k=>/RISEN|OVEREXT|HIGH_RETURN|VOLATIL|TIME/.test(k)));
  const sell=await entry({buy:.3});
  assert.equal(validateDecision({t:'ENTRY',c:sell.candidate_id,d:'SKIP',reasons:[{r:'SELL_DOMINANCE',e:['taker_buy_ratio_5m']}],support:[],n:'매도 우위'},sell).decision,'SKIP');
  assert.throws(()=>validateDecision({t:'ENTRY',c:sell.candidate_id,d:'SKIP',reasons:[{r:'SELL_DOMINANCE',e:['return_5m']}],support:[],n:'x'},sell),/EVIDENCE_OUTSIDE/);
});
test('HOLD/EXIT: time is not a category; EXIT needs a breached thesis category',async()=>{
  const p=await hold();
  assert.equal(validateDecision({t:'HOLD',c:p.candidate_id,d:'HOLD',reasons:[],support:['return_15m'],n:'추세 유지'},p).decision,'HOLD');
  assert.throws(()=>validateDecision({t:'HOLD',c:p.candidate_id,d:'EXIT',reasons:[{r:'MOMENTUM_FADED',e:['return_5m']}],support:[],n:'오래 보유'},p),/REASON_NOT_PRESENT/);
  const weak=await hold({step:-.001});
  assert.equal(validateDecision({t:'HOLD',c:weak.candidate_id,d:'EXIT',reasons:[{r:'MOMENTUM_FADED',e:['return_5m','return_15m']}],support:[],n:'가속 소멸'},weak).decision,'EXIT');
  assert.ok(wireSchema('HOLD').properties.support.items.enum.includes('position_return'));
  assert.ok(!wireSchema('ENTRY').properties.support.items.enum.includes('position_return'));
});
test('API: valid answer returned; wrong model, wrong id, timeout and invalid JSON all become ABSTAIN',async()=>{
  const p=await entry();
  const ok=mockApi(i=>({t:'ENTRY',c:i.candidate_id,d:'BUY',reasons:[],support:['return_5m','relative_strength_15m'],n:'강세 지속'}));
  const r=await callDecision(p,{apiKey:'k',fetchFn:ok.fetchFn});assert.equal(r.decision,'BUY');assert.ok(r.valid);assert.ok(r.api_cost_usd>0);
  const body=ok.calls[0];assert.equal(body.input[0].content,PROMPTS.ENTRY);assert.equal(body.text.format.strict,true);
  const input=JSON.parse(body.input[1].content);assert.ok(input.facts.trend.return_5m>0);assert.ok(!('snapshot_hash' in input));
  for(const [fn,err] of [[mockApi(i=>({t:'ENTRY',c:'other',d:'BUY',reasons:[],support:['return_5m','return_15m'],n:'x'})).fetchFn,/IDENTITY/],
    [mockApi(i=>({t:'ENTRY',c:i.candidate_id,d:'BUY',reasons:[],support:['return_5m','return_15m'],n:'x'}),{model:'other'}).fetchFn,/MODEL/],
    [async()=>new Promise(()=>{}),/TIMEOUT/],[async()=>new Response('nope',{status:200}),/NOT_JSON/]]){
    const x=await callDecision(p,{apiKey:'k',fetchFn:fn,timeoutMs:50});assert.equal(x.decision,'ABSTAIN');assert.equal(x.valid,false);assert.match(x.error,err);
  }
  assert.equal((await callDecision(p,{apiKey:''})).decision,'ABSTAIN');
});
test('payload: fixed prefix per task, identity-free cache key, no numbers from the model reach facts',async()=>{
  const a=payloadFor(await entry()),b=payloadFor(await hold());
  assert.equal(a.prompt_cache_key,'boo-fd1-entry');assert.equal(b.prompt_cache_key,'boo-fd1-hold');assert.notEqual(a.input[0].content,b.input[0].content);
  assert.ok(Buffer.byteLength(a.input[1].content)<8000);
});
test('per-snapshot schema: only breached categories and currently-up facts are selectable',async()=>{
  const calm=await entry(),s=wireSchema('ENTRY',calm);
  assert.deepEqual(s.properties.d.enum,['BUY','ABSTAIN']);assert.equal(s.properties.reasons.maxItems,0);
  assert.ok(s.properties.support.items.enum.includes('return_5m'));assert.ok(!s.properties.support.items.enum.includes('spread_bps')||calm.facts.values.spread_bps<=10);
  const sell=await entry({buy:.3}),t=wireSchema('ENTRY',sell);
  assert.ok(t.properties.d.enum.includes('SKIP'));assert.ok(t.properties.reasons.items.properties.r.enum.includes('SELL_DOMINANCE'));
  assert.ok(!t.properties.reasons.items.properties.r.enum.includes('MOMENTUM_FADED'));
  assert.ok(!t.properties.support.items.enum.includes('taker_buy_ratio_5m'));
  assert.deepEqual(payloadFor(sell).text.format.schema,t);
});
