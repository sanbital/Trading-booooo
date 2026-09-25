import test from 'node:test';
import assert from 'node:assert/strict';
import {computeFacts,modelJudgments,FACT_KEYS} from '../../../supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {validateDecision,riskFlags,wireSchema,CATEGORIES,CHASE_CEILING,EV_SKIP} from '../../../supabase/functions/_shared/gpt-final-decision/contract.mjs';
import {SETUP_POLICY} from '../../../supabase/functions/_shared/leader-pullback-reaccel.mjs';
import {buildDecisionPacket,callDecision,payloadFor,modelInput} from '../../../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {PROMPTS} from '../../../supabase/functions/_shared/gpt-final-decision/prompt.mjs';
import {T,MIN,src,mockApi,entryWire} from './fixtures.mjs';
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
  assert.equal(validateDecision(entryWire({t:'ENTRY',c:p.candidate_id,d:'BUY',reasons:[],support:['return_5m','taker_buy_ratio_5m'],n:'상승 지속'}),p).decision,'BUY');
  assert.throws(()=>validateDecision(entryWire({t:'ENTRY',c:p.candidate_id,d:'BUY',reasons:[],support:['return_5m'],n:'x'}),p),/REQUIRES_SUPPORT/);
  assert.throws(()=>validateDecision(entryWire({t:'ENTRY',c:p.candidate_id,d:'BUY',reasons:[],support:['spread_bps','funding_rate'],n:'x'}),p),/TREND_FACT/);
  const down=await entry({step:-.001},{referenceClose:.5});
  assert.throws(()=>validateDecision(entryWire({t:'ENTRY',c:down.candidate_id,d:'BUY',reasons:[],support:['return_5m','taker_buy_ratio_5m'],n:'x'}),down),/REQUIRES_SUPPORT/);
  assert.deepEqual(validateDecision(entryWire({t:'ENTRY',c:p.candidate_id,d:'BUY',reasons:[],support:['return_5m','taker_buy_ratio_5m','btc_return_15m'],n:'x'}),p).rejected_support,[]);
  const wide=await entry({src:{book:{bids:[[1.0,5000]],asks:[[1.2,5000]]}}});
  assert.throws(()=>validateDecision(entryWire({t:'ENTRY',c:wide.candidate_id,d:'BUY',reasons:[],support:['return_5m','taker_buy_ratio_5m'],n:'x'}),wide),/HARD_RISK/);
});
test('SKIP must name a category actually breached; "already rose" is impossible',async()=>{
  const p=await entry();
  assert.throws(()=>validateDecision(entryWire({t:'ENTRY',c:p.candidate_id,d:'SKIP',reasons:[{r:'MOMENTUM_FADED',e:['return_5m']}],support:[],n:'이미 많이 올랐다'}),p),/REASON_NOT_PRESENT/);
  assert.throws(()=>validateDecision(entryWire({t:'ENTRY',c:p.candidate_id,d:'SKIP',reasons:[],support:[],n:'x'}),p),/REQUIRES_CATEGORY/);
  assert.ok(!Object.keys(CATEGORIES).some(k=>/RISEN|OVEREXT|HIGH_RETURN|VOLATIL|TIME/.test(k)));
  const sell=await entry({buy:.3});
  assert.equal(validateDecision(entryWire({t:'ENTRY',c:sell.candidate_id,d:'SKIP',reasons:[{r:'SELL_DOMINANCE',e:['taker_buy_ratio_5m']}],support:[],n:'매도 우위'}),sell).decision,'SKIP');
  assert.throws(()=>validateDecision(entryWire({t:'ENTRY',c:sell.candidate_id,d:'SKIP',reasons:[{r:'SELL_DOMINANCE',e:['return_5m']}],support:[],n:'x'}),sell),/EVIDENCE_OUTSIDE/);
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
  const ok=mockApi(i=>(entryWire({t:'ENTRY',c:i.candidate_id,d:'BUY',reasons:[],support:['return_5m','relative_strength_15m'],n:'강세 지속'})));
  const r=await callDecision(p,{apiKey:'k',fetchFn:ok.fetchFn});assert.equal(r.decision,'BUY');assert.ok(r.valid);assert.ok(r.api_cost_usd>0);
  const body=ok.calls[0];assert.equal(body.input[0].content,PROMPTS.ENTRY);assert.equal(body.text.format.strict,true);
  const input=JSON.parse(body.input[1].content);assert.ok(input.facts.trend.return_5m>0);assert.ok(!('snapshot_hash' in input));
  for(const [fn,err] of [[mockApi(i=>(entryWire({t:'ENTRY',c:'other',d:'BUY',reasons:[],support:['return_5m','return_15m'],n:'x'}))).fetchFn,/IDENTITY/],
    [mockApi(i=>(entryWire({t:'ENTRY',c:i.candidate_id,d:'BUY',reasons:[],support:['return_5m','return_15m'],n:'x'})),{model:'other'}).fetchFn,/MODEL/],
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
  // (2026-09-25) No category is breached, so no category can be a reason. SKIP stays possible
  // only as EV_UNFAVORABLE, GPT's own expected-value verdict, citing server-verified bearish facts.
  assert.deepEqual(s.properties.reasons.items.properties.r.enum,['EV_UNFAVORABLE']);
  const bear=s.properties.bearish.items.enum;
  assert.ok(bear.length>=2&&bear.every(k=>s.properties.reasons.items.properties.e.items.enum.includes(k)));
  assert.ok(!bear.includes('return_5m')&&!bear.includes('taker_buy_ratio_5m'),'a rising return or buyer tape is never bearish');
  assert.ok(s.properties.support.items.enum.includes('return_5m'));assert.ok(!s.properties.support.items.enum.includes('spread_bps')||calm.facts.values.spread_bps<=10);
  const sell=await entry({buy:.3}),t=wireSchema('ENTRY',sell);
  assert.ok(t.properties.d.enum.includes('SKIP'));assert.ok(t.properties.reasons.items.properties.r.enum.includes('SELL_DOMINANCE'));
  assert.ok(!t.properties.reasons.items.properties.r.enum.includes('MOMENTUM_FADED'));
  assert.ok(!t.properties.support.items.enum.includes('taker_buy_ratio_5m'));
  assert.deepEqual(payloadFor(sell).text.format.schema,t);
});

// ---------------------------------------------------------------------------------------
// 2026-09-25: evidence-first ENTRY. GPT compares evidence and expected value; ABSTAIN is kept
// for its four real reasons; confidence and EV are recorded, never a gate.
// ---------------------------------------------------------------------------------------
test('GPT ABSTAIN: legitimate only with one of its four reasons',async()=>{
  const p=await entry(),w=x=>entryWire({t:'ENTRY',c:p.candidate_id,d:'ABSTAIN',n:'판단 불가',...x});
  assert.throws(()=>validateDecision(w({abstain_reason:'NONE'}),p),/FD_ABSTAIN_REQUIRES_REASON/);
  for(const r of ['DATA_INSUFFICIENT','EVIDENCE_CONFLICT_SEVERE','EV_UNDETERMINABLE','EXECUTION_UNSAFE']){
    const a=validateDecision(w({abstain_reason:r}),p);assert.equal(a.decision,'ABSTAIN');assert.equal(a.abstain_reason,r);}
});
test('GPT BUY: confidence and EV are recorded and flagged, never a gate',async()=>{
  const p=await entry();
  const low=validateDecision(entryWire({t:'ENTRY',c:p.candidate_id,d:'BUY',support:['return_5m','taker_buy_ratio_5m'],
    confidence:.05,ev:'NEGATIVE',upside_pct:.5,downside_pct:2,n:'상승'}),p);
  assert.equal(low.decision,'BUY','a low-confidence BUY is still a BUY');
  assert.equal(low.confidence,.05);assert.deepEqual(low.consistency_flags,['BUY_WITH_NEGATIVE_EV','BUY_WITH_DOWNSIDE_ABOVE_UPSIDE']);
  // BUY's own rules are unchanged: two verified up-facts incl. a trend fact.
  assert.throws(()=>validateDecision(entryWire({t:'ENTRY',c:p.candidate_id,d:'BUY',support:['return_5m'],n:'x'}),p),/REQUIRES_SUPPORT/);
  const b=validateDecision(entryWire({t:'ENTRY',c:p.candidate_id,d:'BUY',support:['return_5m','taker_buy_ratio_5m'],
    bearish:['return_5m','accel_5m_vs_15m'],invalidation:[{fact:'return_5m',op:'BELOW',value:0}],n:'상승'}),p);
  assert.deepEqual(b.rejected_bearish,['return_5m'],'a rising fact cited as bearish is dropped, never counted');
  assert.deepEqual(b.bearish_evidence.map(e=>e.key),['accel_5m_vs_15m']);
  assert.deepEqual(b.invalidation_conditions,[{fact:'return_5m',op:'BELOW',value:0}]);
  assert.deepEqual(b.bullish_evidence,['return_5m','taker_buy_ratio_5m']);
});
test('EV_UNFAVORABLE SKIP: >=2 verified bearish facts incl. price/flow, NEGATIVE EV and downside > upside',async()=>{
  const p=await entry(); // calm uptrend: accelerations marginally negative, buyer_share_change 0
  const w=x=>entryWire({t:'ENTRY',c:p.candidate_id,d:'SKIP',reasons:[{r:EV_SKIP,e:['accel_5m_vs_15m','accel_15m_vs_60m']}],
    bearish:['accel_5m_vs_15m','accel_15m_vs_60m'],ev:'NEGATIVE',upside_pct:.5,downside_pct:1.5,n:'기대값 불리',...x});
  const ok=validateDecision(w(),p);assert.equal(ok.decision,'SKIP');assert.equal(ok.reasons[0].category,EV_SKIP);
  assert.equal(ok.reasons[0].level,'EV');
  assert.throws(()=>validateDecision(w({reasons:[{r:EV_SKIP,e:['return_5m','accel_5m_vs_15m']}]}),p),/BEARISH_FACTS/,'"already rose" can never be cited');
  assert.throws(()=>validateDecision(w({reasons:[{r:EV_SKIP,e:['accel_5m_vs_15m']}]}),p),/BEARISH_FACTS/,'one fact is not enough');
  assert.throws(()=>validateDecision(w({reasons:[{r:EV_SKIP,e:['buyer_share_change','book_imbalance_25bps']}]}),p),/TREND_FACT/);
  assert.throws(()=>validateDecision(w({ev:'POSITIVE'}),p),/NEGATIVE_EV/);
  assert.throws(()=>validateDecision(w({upside_pct:2,downside_pct:1}),p),/DOWNSIDE_ABOVE_UPSIDE/);
  // A category SKIP keeps its own rule: the category must be breached now.
  assert.throws(()=>validateDecision(w({reasons:[{r:'MOMENTUM_FADED',e:['return_5m']}]}),p),/REASON_NOT_PRESENT/);
});
test('CHASE_EXTENDED is offered only for a LIVE chase packet; an ordinary packet is byte-identical',async()=>{
  assert.equal(CHASE_CEILING,SETUP_POLICY.maxChasePct);
  const f=facts(),plain=await buildDecisionPacket({task:'ENTRY',subjectId:'sig-1',symbol:'ABCUSDT',dataMode:'LIVE',facts:f,judgments:null});
  assert.ok(f.values.distance_trigger_reference>CHASE_CEILING,'fixture price is above the chase ceiling');
  assert.equal(riskFlags(plain).flags.CHASE_EXTENDED,undefined,'an ordinary trigger never gets a lateness category');
  assert.ok(!('chase' in plain));assert.ok(!('chase' in modelInput(plain)));
  const chased=await buildDecisionPacket({task:'ENTRY',subjectId:'sig-1',symbol:'ABCUSDT',dataMode:'LIVE',facts:f,judgments:null,
    chase:{chase_state:'LIVE',distance_from_breakout_pct:.004}});
  assert.equal(riskFlags(chased).flags.CHASE_EXTENDED.level,'SOFT');
  assert.ok(wireSchema('ENTRY',chased).properties.reasons.items.properties.r.enum.includes('CHASE_EXTENDED'));
  assert.equal(modelInput(chased).chase.chase_state,'LIVE');assert.notEqual(plain.snapshot_hash,chased.snapshot_hash);
  const skip=validateDecision(entryWire({t:'ENTRY',c:chased.candidate_id,d:'SKIP',reasons:[{r:'CHASE_EXTENDED',e:['distance_trigger_reference']}],n:'늦은 진입'}),chased);
  assert.equal(skip.reasons[0].category,'CHASE_EXTENDED');
  assert.throws(()=>validateDecision(entryWire({t:'ENTRY',c:plain.candidate_id,d:'SKIP',reasons:[{r:'CHASE_EXTENDED',e:['distance_trigger_reference']}],n:'x'}),plain),
    /REASON_NOT_PRESENT/,'lateness is not a SKIP reason for an ordinary trigger');
});
test('ENTRY prompt/schema: evidence and EV are written before the decision; HOLD contract unchanged',async()=>{
  const e=PROMPTS.ENTRY;
  for(const x of ['정보가 완벽하지 않다는 이유만으로 ABSTAIN하지 마라','기록용이며 차단 기준이 아니다','DATA_INSUFFICIENT',
    'EVIDENCE_CONFLICT_SEVERE','EV_UNDETERMINABLE','EXECUTION_UNSAFE',EV_SKIP,'CHASE_EXTENDED'])assert.ok(e.includes(x),x);
  const order=Object.keys(wireSchema('ENTRY').properties);
  for(const k of ['support','bearish','invalidation','upside_pct','downside_pct','ev','confidence'])
    assert.ok(order.indexOf(k)<order.indexOf('d'),k+' precedes the decision');
  assert.deepEqual(Object.keys(wireSchema('HOLD').properties),['t','c','d','reasons','support','n']);
  assert.equal(payloadFor(await entry()).max_output_tokens,1000);assert.equal(payloadFor(await hold()).max_output_tokens,600);
  assert.ok(!PROMPTS.HOLD.includes('EV_UNFAVORABLE'),'HOLD/EXIT prompt untouched by the ENTRY change');
});
