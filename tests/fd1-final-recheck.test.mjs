// GPT FINAL RECHECK (FD1-RC1): INITIAL GPT BUY -> pre-dispatch change detector -> (only when the
// market meaningfully changed) GPT FINAL RECHECK -> deterministic post-recheck safety -> order guards.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {normalizeEntryBook} from '../supabase/functions/v10-lane-executor/entry-evidence.mjs';
import {execFileSync} from 'node:child_process';
import {FinalReviewCoordinator,MemoryReviewStore} from '../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
import {baselineAllowedLive,v30FrontDecision,V30_FRONT_LIVE_VERSION} from '../supabase/functions/_shared/gpt-final-review/contract.mjs';
import {FD1_ENTRY_ENGINE} from '../supabase/functions/_shared/gpt-final-decision/engine.mjs';
import {detectChange,preDispatchSnapshot,validateRecheck,recheckFlags,buildRecheckPacket,recheckAllows,postRecheckSafety,
  RECHECK_POLICY,RECHECK_PROMPT,recheckPayload} from '../supabase/functions/_shared/gpt-final-decision/recheck.mjs';
import {computeFacts} from '../supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {gptFilterExecutable,gptFinalCheck,gptBeginExecution,gptConfirmFirstFinality,gptConsumeRetry,setTestCoordinator} from '../supabase/functions/v10-lane-executor/gpt-final-review-adapter.mjs';
import {IOC_RETRY_POLICY,planAggressiveIocRetry,floorStep} from '../supabase/functions/v10-lane-executor/entry-ioc-retry.mjs';
import {finalRecheckStep,setRecheckTestHooks,withOrderTiming} from '../supabase/functions/v10-lane-executor/gpt-final-recheck-adapter.mjs';
import {nilTicket,NIL_E1,NIL_DISPATCH_QUOTE,NIL_SIGNAL,NIL_DISPATCH_AT} from '../supabase/functions/v10-lane-executor/recheck-nil-fixture.mjs';
import {candidate,T} from '../development/gpt-final-review/tests/helpers.mjs';
import {RECHECK_HOOKS} from '../development/gpt-final-review/executor-hooks-recheck.mjs';
import {klines,src as srcFixture} from '../development/gpt-final-decision/tests/fixtures.mjs';
const MIN=60000,MODEL='gpt-5.4-mini-2026-03-17';
const ENFORCE={mode:'ENFORCE',modeValid:true,approvalRef:'t',apiBudgetUsd:3,maxCalls:300,enforceApproved:true,source:'TEST'};
const BOOK={bids:[[1.199,2000],[1.198,2000]],asks:[[1.2,2000],[1.201,2000]]};
const raw=(input,w)=>new Response(JSON.stringify({model:MODEL,status:'completed',usage:{input_tokens:3000,output_tokens:80,input_tokens_details:{cached_tokens:0}},
  output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({c:input.candidate_id,...w})}]}]}),{status:200,headers:{'x-request-id':'req'}});
const RECHECK_WIRE={BUY:{t:'RECHECK',d:'BUY',reasons:[],support:['return_5m','taker_buy_ratio_5m'],n:'상승 근거 유지'},
  SKIP:{t:'RECHECK',d:'SKIP',reasons:[{r:'TAPE_SELLING',e:['tape_return','tape_buy_share']}],support:[],n:'매도 우위 전환'},
  ABSTAIN:{t:'RECHECK',d:'ABSTAIN',reasons:[],support:[],n:'판단 불가'},
  INVALID:{t:'RECHECK',d:'SKIP',reasons:[{r:'PRICE_SLIPPED',e:['price_change_since_initial']}],support:[],n:'가격 하락'}};
/** One market: Binance reads + OpenAI; the initial answer is BUY, the recheck answer is `final`. */
function world({initial='BUY',final='BUY'}={}){
  const calls={entry:0,recheck:0};
  const fetchFn=async(url,init)=>{
    const u=new URL(url);
    if(u.hostname==='api.openai.com'){const input=JSON.parse(JSON.parse(init.body).input[1].content);
      if(input.t==='RECHECK'){calls.recheck++;
        if(final==='TIMEOUT')return new Promise(()=>{});
        if(final==='ERROR')return new Response(JSON.stringify({error:{type:'server_error'}}),{status:500,headers:{'x-request-id':'r'}});
        return raw(input,RECHECK_WIRE[final]);}
      calls.entry++;
      const w={BUY:{d:'BUY',reasons:[],support:['return_5m','taker_buy_ratio_5m'],n:'상승 지속'},SKIP:{d:'SKIP',reasons:[],support:[],n:'건너뜀'},
        ABSTAIN:{d:'ABSTAIN',reasons:[],support:[],n:'판단 불가'}}[initial];
      return raw(input,{t:'ENTRY',...w});}
    const p=u.pathname,at=Number(u.searchParams.get('endTime')??T)+1;
    if(p==='/fapi/v1/klines')return Response.json(klines(Number(u.searchParams.get('limit')),u.searchParams.get('interval')==='5m'?5*MIN:MIN,at,{step:u.searchParams.get('symbol')==='BTCUSDT'?.0001:.001}));
    if(p==='/futures/data/openInterestHist')return Response.json(Array.from({length:13},(_,i)=>({timestamp:Math.floor(T/300000)*300000-(12-i)*300000,sumOpenInterest:1000+i,sumOpenInterestValue:5e6})));
    if(p==='/fapi/v1/premiumIndexKlines')return Response.json([[T-MIN,'0','0','0','0.0002','0',T-1]]);
    if(p==='/fapi/v1/premiumIndex')return Response.json({lastFundingRate:'0.0001'});
    if(p==='/fapi/v1/depth')return Response.json(BOOK);
    return new Response('no',{status:404});
  };
  return {fetchFn,calls};
}
function v30Candidate(action,id='sig-'+action){
  const s=candidate(id);const b=s.features.b06133;
  b.allowed=false;b.result=false;b.branch=null;b.reason='B06133_REJECT';b.factors={...b.factors,fresh5over15:true,volumeTails:false};
  s.features.referenceClose=1;s.features.v30Front=v30FrontDecision(b,V30_FRONT_LIVE_VERSION);
  s.features.cec0040={...s.features.cec0040,action,modelAllowed:action!=='REJECT',effectiveAllowed:action!=='REJECT',enforcementEnabled:true,
    predictionUsdt:action==='REJECT'?-3.67:0.4,trainingCount:125};
  return s;
}
/** INITIAL decision through the real coordinator + FD1 engine; returns the order-time ticket. */
async function initialDecision({initial='BUY',final='BUY',action='ADMIT',clock}={}){
  let now=T+1500;const w=world({initial,final}),store=new MemoryReviewStore();
  const c=new FinalReviewCoordinator({config:ENFORCE,store,apiKey:()=>'k',now:clock??(()=>now),fetchFn:w.fetchFn,engine:FD1_ENTRY_ENGINE,
    baseline:baselineAllowedLive,schedule:()=>{}});
  const db={},s=v30Candidate(action);setTestCoordinator(db,c);
  await gptFilterExecutable(db,[s]);await Promise.all([...c.pending.values()]);await gptFilterExecutable(db,[s]);
  const check=gptFinalCheck(db,s),log=[];
  setRecheckTestHooks({store,config:ENFORCE,apiKey:'k',fetchFn:w.fetchFn,log,schedule:()=>{},
    readFresh:async(symbol,at)=>({src:srcFixture(at),errors:{}})});
  return {db,c,s,w,check,ticket:check.review,log,setNow:x=>{now=x;},store};
}
const calmQuote=at=>({best_bid:1.199,best_ask:1.2,bids:BOOK.bids,asks:BOOK.asks,timing:{requested_at_ms:at-10,received_at_ms:at}});
const e1Obs=(ret,share,n=150)=>({confirmationState:'BASELINE_ELIGIBLE',reasonCodes:['E1_NOT_FAST_WEAK'],expectedCostBps:12,
  observations:[{startAt:T,endAt:T+10000,return:ret,buyShare:share,tradeCount:n}]});
const CALM=e1Obs(0.001,0.6),WEAK=e1Obs(-0.003,0.35);

test('1. INITIAL BUY + no meaningful change -> no extra GPT call; the initial BUY stands and the order check passes',async()=>{
  const x=await initialDecision();assert.equal(x.check.allowed,true);assert.ok(x.ticket.initial?.executionRef?.mid>0,'initial book reference carried');
  x.setNow(T+9000);
  const r=await finalRecheckStep(x.db,x.s,{ticket:x.ticket,e1:CALM,rawQuote:calmQuote(T+8900),now:()=>T+9000});
  assert.equal(r.record.recheck_triggered,false,JSON.stringify(r.record.recheck_reasons));assert.equal(r.proceed,true);
  assert.equal(x.w.calls.recheck,0);assert.equal(gptFinalCheck(x.db,x.s,r.record).allowed,true);
  assert.equal(x.log.length,1);assert.equal(x.log[0].outcome,'NO_RECHECK_INITIAL_BUY_STANDS');
});
test('2+3. INITIAL BUY + meaningful deterioration -> FINAL RECHECK; FINAL BUY -> safety passes -> order check passes (beyond the initial 15 s age)',async()=>{
  const x=await initialDecision({final:'BUY'});x.setNow(T+12000);
  const r=await finalRecheckStep(x.db,x.s,{ticket:x.ticket,e1:WEAK,rawQuote:calmQuote(T+11900),now:()=>T+12000});
  assert.equal(r.record.recheck_triggered,true);assert.ok(r.record.recheck_reasons.includes('TAPE_FLOW_REVERSED'));
  assert.equal(x.w.calls.recheck,1);assert.equal(r.record.final_gpt_decision,'BUY');assert.equal(r.proceed,true);
  // initial answer's 15 s age limit is superseded by the recheck, never the trigger expiry
  x.setNow(T+17500);
  const safety=postRecheckSafety({recheck:r.record.final,quote:calmQuote(T+17400),at:T+17500});
  assert.equal(safety.ok,true,JSON.stringify(safety));
  assert.equal(gptFinalCheck(x.db,x.s,r.record).allowed,true);
  assert.equal(gptFinalCheck(x.db,x.s,{recheck_triggered:false}).allowed,false,'without the recheck the initial answer has expired');
  const t=withOrderTiming(r.record,T+17600);assert.equal(t.decision_to_order_ms,T+17600-x.ticket.initial.completedAt);
});
for(const [id,final,err] of [['4','SKIP',null],['5','ABSTAIN',null],['6a','TIMEOUT','API_TIMEOUT'],['6b','ERROR','HTTP_500'],['6c','INVALID','RC_SKIP_PRICE_ONLY']])
test(`${id}. FINAL ${final} -> no order`,async()=>{
  const x=await initialDecision({final});
  const r=await finalRecheckStep(x.db,x.s,{ticket:x.ticket,e1:WEAK,rawQuote:calmQuote(T+11900),now:()=>T+12000});
  assert.equal(r.record.recheck_triggered,true);assert.equal(r.proceed,false);
  assert.equal(gptFinalCheck(x.db,x.s,r.record).allowed,false);
  if(err)assert.match(String(r.record.final.error),new RegExp(err==='RC_SKIP_PRICE_ONLY'?'RC_SKIP_PRICE_ONLY|FD_REASON_NOT_PRESENT':err));
  assert.equal(x.log.at(-1).outcome,'NO_ORDER_'+(final==='SKIP'?'SKIP':'ABSTAIN'));
});
test('6d. expired FINAL BUY -> no order (and no fallback to the INITIAL BUY)',async()=>{
  const x=await initialDecision({final:'BUY'});
  const r=await finalRecheckStep(x.db,x.s,{ticket:x.ticket,e1:WEAK,rawQuote:calmQuote(T+11900),now:()=>T+12000});
  assert.equal(r.proceed,true);
  const late=r.record.final.valid_until_ms+1;x.setNow(late);
  assert.equal(recheckAllows(r.record.final,late),false);assert.equal(gptFinalCheck(x.db,x.s,r.record).allowed,false);
});
test('6e. final rechecks are bounded per IOC attempt: duplicate sequence fails, sequence 2 is the last allowed',async()=>{
  const x=await initialDecision({final:'BUY'});
  const first=await finalRecheckStep(x.db,x.s,{ticket:x.ticket,e1:WEAK,rawQuote:calmQuote(T+11900),now:()=>T+12000,sequence:1});
  assert.equal(first.proceed,true);
  const duplicate=await finalRecheckStep(x.db,x.s,{ticket:x.ticket,e1:WEAK,rawQuote:calmQuote(T+12900),now:()=>T+13000,sequence:1});
  assert.equal(duplicate.proceed,false);assert.equal(duplicate.record.final.error,'RC_LIMIT_REACHED');
  const second=await finalRecheckStep(x.db,x.s,{ticket:x.ticket,e1:WEAK,rawQuote:calmQuote(T+13900),now:()=>T+14000,sequence:2});
  assert.equal(second.proceed,true);assert.equal(RECHECK_POLICY.maxRechecksPerCandidate,2);
  const third=await finalRecheckStep(x.db,x.s,{ticket:x.ticket,e1:WEAK,rawQuote:calmQuote(T+14900),now:()=>T+15000,sequence:3});
  assert.equal(third.proceed,false);assert.equal(third.record.final.error,'RC_LIMIT_REACHED');
});
test('7. FINAL BUY, then the dispatch quote is not newer than the answer -> no order',async()=>{
  const x=await initialDecision({final:'BUY'});
  const r=await finalRecheckStep(x.db,x.s,{ticket:x.ticket,e1:WEAK,rawQuote:calmQuote(T+11900),now:()=>T+12000});
  const s=postRecheckSafety({recheck:r.record.final,quote:calmQuote(r.record.final.completed_at_ms-1),at:T+13000});
  assert.deepEqual([s.ok,s.reason],[false,'RC_POST_QUOTE_NOT_AFTER_ANSWER']);
});
test('8. FINAL BUY post-safety blocks catastrophic execution risk, but price drift is not a second strategy veto',async()=>{
  const x=await initialDecision({final:'BUY'});
  const r=await finalRecheckStep(x.db,x.s,{ticket:x.ticket,e1:WEAK,rawQuote:calmQuote(T+11900),now:()=>T+12000});
  const wide=postRecheckSafety({recheck:r.record.final,quote:{best_bid:1.19,best_ask:1.2,timing:{received_at_ms:T+13000}},at:T+13000});
  assert.deepEqual([wide.ok,wide.reason],[false,'RC_POST_SPREAD_CATASTROPHIC']);
  const drop=postRecheckSafety({recheck:r.record.final,quote:{best_bid:1.193,best_ask:1.1932,timing:{received_at_ms:T+13000}},at:T+13000});
  assert.equal(drop.ok,true);assert.ok(drop.drift<0);
});
for(const [id,initial] of [['9','SKIP'],['10','ABSTAIN']])
test(`${id}. INITIAL ${initial} -> no order and no FINAL RECHECK (openBull returns before the detector)`,async()=>{
  const x=await initialDecision({initial});assert.equal(x.check.allowed,false);assert.equal(x.w.calls.recheck,0);
  const src=readFileSync(new URL('../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8');
  const early=src.indexOf('if(!gptEntryCheck.allowed)return{entered:false'),step=src.indexOf('await finalRecheckStep(db,s,');
  assert.ok(early>0&&step>early,'the recheck step is only reachable after an allowed INITIAL BUY');
});
test('11. CEC REJECT + INITIAL BUY + FINAL BUY -> order check passes (CEC is evidence)',async()=>{
  const x=await initialDecision({action:'REJECT',final:'BUY'});assert.equal(x.check.allowed,true);
  const r=await finalRecheckStep(x.db,x.s,{ticket:x.ticket,e1:WEAK,rawQuote:calmQuote(T+11900),now:()=>T+12000});
  assert.equal(r.proceed,true);x.setNow(T+13000);assert.equal(gptFinalCheck(x.db,x.s,r.record).allowed,true);
  const sent=x.store.rows.get(r.record.final.job_key).record.packet;assert.equal(sent.model_judgments.cec0040.action,'REJECT');
});
test('12. CEC REJECT + INITIAL BUY + FINAL SKIP -> no order',async()=>{
  const x=await initialDecision({action:'REJECT',final:'SKIP'});
  const r=await finalRecheckStep(x.db,x.s,{ticket:x.ticket,e1:WEAK,rawQuote:calmQuote(T+11900),now:()=>T+12000});
  assert.equal(r.proceed,false);assert.equal(gptFinalCheck(x.db,x.s,r.record).allowed,false);
});
test('13. NIL fixture: the stored NILUSDT pre-dispatch state triggers a FINAL RECHECK (the answer is left to GPT)',async()=>{
  const snap=preDispatchSnapshot({at:NIL_DISPATCH_AT,rawQuote:NIL_DISPATCH_QUOTE,e1:NIL_E1});
  const d=detectChange(nilTicket().initial,snap);
  assert.equal(d.triggered,true);assert.deepEqual(d.reasons,['TAPE_FLOW_REVERSED']);
  // It is NOT a tail event on any single dimension: price, tape return, buy share and its drop are all inside the bands.
  assert.ok(d.deltas.price_change_since_initial>RECHECK_POLICY.priceAdverse);
  assert.ok(d.deltas.tape_return>RECHECK_POLICY.tapeReturnAdverse&&d.deltas.tape_buy_share>RECHECK_POLICY.buyShareLow);
  assert.ok(d.deltas.buy_share_change_since_initial>RECHECK_POLICY.buyShareDrop);
  // Both GPT answers are valid final answers on the NIL packet: the outcome is GPT's decision, not a rule.
  const facts=computeFacts(srcFixture(NIL_DISPATCH_AT),{asOf:NIL_DISPATCH_AT,referenceClose:1,dayReturn:.6,rank:1});
  const p=await buildRecheckPacket({signalId:NIL_SIGNAL.id,symbol:'NILUSDT',facts,initial:nilTicket().initial,detection:d,judgments:null});
  assert.equal(recheckFlags(p).flags.TAPE_SELLING.level,'SOFT');
  assert.equal(validateRecheck({c:p.candidate_id,...RECHECK_WIRE.SKIP},p).decision,'SKIP');
  assert.equal(validateRecheck({c:p.candidate_id,...RECHECK_WIRE.BUY},p).decision,'BUY');
  const input=JSON.parse(recheckPayload(p).input[1].content);
  assert.equal(input.initial.decision,'BUY');assert.ok(input.change.tape_return<0&&input.change.tape_buy_share<0.5);
  assert.deepEqual(input.initial.support.map(x=>x.key),['return_1m','return_5m','return_15m','return_30m','return_60m','return_4h']);
});
test('detector: thresholds are distribution bands, missing data triggers (never a silent pass), chase triggers',()=>{
  const init={snapshotAt:T,executionRef:{mid:100},facts:{taker_buy_ratio_5m:.55,spread_bps:2,ask_depth_to_order:20,bid_depth_to_order:20,book_imbalance_25bps:0,est_buy_slippage_bps:1}};
  const q=(mid,extra={})=>({at:T+10000,mid,book:{spread_bps:2,ask_depth_to_order:20,bid_depth_to_order:20,book_imbalance_25bps:0,est_buy_slippage_bps:1,...extra},
    tape:{return:.0005,buyShare:.55,tradeCount:100}});
  assert.equal(detectChange(init,q(99.9)).triggered,false);
  assert.deepEqual(detectChange(init,q(99.7)).reasons,['PRICE_ADVERSE']);
  assert.deepEqual(detectChange(init,q(100.6)).reasons,['PRICE_CHASE']);
  assert.ok(detectChange(init,q(100,{spread_bps:12})).reasons.includes('SPREAD_WIDENED'));
  assert.ok(detectChange(init,q(100,{ask_depth_to_order:8})).reasons.includes('DEPTH_DROPPED'));
  assert.ok(detectChange(init,q(100,{book_imbalance_25bps:-.5})).reasons.includes('IMBALANCE_SHIFTED'));
  assert.ok(detectChange(init,q(100,{est_buy_slippage_bps:9})).reasons.includes('SLIPPAGE_WORSENED'));
  assert.deepEqual(detectChange(null,q(100)).reasons,['INITIAL_REFERENCE_MISSING']);
  assert.ok(detectChange(init,{...q(100),tape:null}).reasons.includes('PRE_DISPATCH_TAPE_MISSING'));
  // a 10 s tape with too few trades is noise: flow triggers need minTapeTrades
  assert.equal(detectChange(init,{...q(100),tape:{return:-.004,buyShare:.1,tradeCount:5}}).triggered,false);
});
test('contract: price drop alone is not a SKIP; BUY needs current up-support and no HARD risk; the prompt keeps GPT the judge',async()=>{
  const init={snapshotAt:T,executionRef:{mid:1.21},facts:{taker_buy_ratio_5m:.6},support:['return_5m']};
  const d=detectChange(init,{at:T+10000,mid:1.1995,book:null,tape:{return:.001,buyShare:.6,tradeCount:100}});
  assert.deepEqual(d.reasons,['PRICE_ADVERSE']);
  const facts=computeFacts(srcFixture(T),{asOf:T,referenceClose:1,dayReturn:.1,rank:1});
  const p=await buildRecheckPacket({signalId:'x',symbol:'TESTUSDT',facts,initial:init,detection:d,judgments:null});
  assert.throws(()=>validateRecheck({c:p.candidate_id,...RECHECK_WIRE.INVALID},p),/RC_SKIP_PRICE_ONLY/);
  assert.throws(()=>validateRecheck({c:p.candidate_id,t:'RECHECK',d:'BUY',reasons:[],support:['return_5m'],n:'유지'},p),/FD_BUY_REQUIRES_SUPPORT/);
  const hard=await buildRecheckPacket({signalId:'x',symbol:'TESTUSDT',facts:{...facts,values:{...facts.values,spread_bps:40}},initial:init,detection:d,judgments:null});
  assert.throws(()=>validateRecheck({c:hard.candidate_id,...RECHECK_WIRE.BUY},hard),/FD_BUY_WITH_HARD_RISK/);
  assert.match(RECHECK_PROMPT,/조금 전 이 후보를 BUY했다/);assert.match(RECHECK_PROMPT,/지금 이 순간에도 신규 LONG 진입 근거가 충분한가/);
  assert.match(RECHECK_PROMPT,/자동 승인하는 절차가 아니다/);assert.match(RECHECK_PROMPT,/CEC0040 REJECT를 따를 의무도/);
});
test('14. release invariants: GPT remains before IOC, sizing is 150x3, retry is bounded and protection/lease stay in path',()=>{
  const src=readFileSync(new URL('../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8');
  for(const k of ['const MAX_SLOTS=10','const SETUP_MAX_CONCURRENT=4','PATCH="FD1-BOUNDED-RETRY-AUTHORITY-2"',
    'SLOT_SIZING_CONTRACT.targetMarginUsdt','verifyExecutionLease(db)','protectNewLeaderPosition({','time_in_force:"IOC"',
    'IOC_RETRY_POLICY.maxAttempts','planAggressiveIocRetry(','SIZING_CONTRACT_STALE'])assert.ok(src.includes(k),k);
  const step=src.indexOf('await finalRecheckStep(db,s,'),dispatch=src.indexOf('const gptDispatchCheck=gptFinalCheck(db,s,attempt.finalRecheck);'),
    first=src.indexOf('dispatchEntryIocAttempt(db,s,gateway,{attemptNo:1'),second=src.indexOf('dispatchEntryIocAttempt(db,s,gateway,{attemptNo:2');
  assert.ok(step>0&&dispatch>step&&first>dispatch&&second>first);
  assert.equal(src.split('time_in_force:"IOC"').length-1,1,'IOC shape is centralized in the dispatcher');
  assert.match(src,/strategicDriftToRecheck\(entryTriggerFresh/,'V17 drift must feed recheck rather than hard reject');
});

// Execute the real openBull IOC lifecycle, replacing only I/O dependencies. The real
// coordinator, detector, recheck API parser, authority checks and retry planner run.
async function retryLifecycle({fills=[375],final='BUY',changed=false,expired=false,protection='PROTECTED'}={}){
  let now=T+1500;
  const x=await initialDecision({final,clock:()=>now});
  const source=readFileSync(new URL('../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8');
  const body=source.slice(source.indexOf('let currentPosition=null,lastProtection='),
    source.indexOf('// Best-effort feed for the decision-only exit shadow.'));
  let position=null;const orders=[],events=[],writes=[];
  const db=x.db;db.from=()=>({update:patch=>({eq:async()=>{writes.push(patch);return {};}})});
  const quote=()=>calmQuote(now);
  const gateway=async cmd=>{if(cmd.action==='quote'){if(orders.length===1)now=expired?T+31000:T+19000;return quote();}
    if(cmd.action==='symbol_info')return {quantityStep:1,priceTick:.0001,minNotionalUsdt:5,minQuantity:1};
    if(cmd.action==='v18_open_orders')return {complete:true,orders:[]};throw Error('UNEXPECTED_IO:'+cmd.action);};
  const c={db,s:x.s,gateway,attempt:{gptFinalReview:x.ticket,finalRecheck:{recheck_triggered:false}},
    sized:{amount:375},iocBps:0,limitPrice:1.2,step:1,filters:{priceTick:.0001,minNotionalUsdt:5,minQuantity:1},baseIntentPayload:{},
    manualRows:[],managementFailures:[],finalDecision:{allowed:true},e1Decision:null,NATIVE_STOP_ENABLED:true,
    MARGIN:150,LEV:3,ENTRY_CASH_BUFFER_USDT:.1,RELEASE_SCOPE:{SYMBOL:'SYMBOL'},
    IOC_RETRY_POLICY,planAggressiveIocRetry,floorStep,E1_POLICY:{maxQuoteAgeMs:1000},
    gptFinalCheck,gptBeginExecution,gptConfirmFirstFinality,gptConsumeRetry,
    Date:class extends Date{static now(){return now;}},console,
    N:(v,d=0)=>Number.isFinite(Number(v))?Number(v):d,rec:v=>v??{},withOrderTiming,
    normalizeEntryBook,fetchE1AggTrades:async(_s,startAt,endAt)=>({available:true,startAt,endAt,last10sReturn:.001,takerBuyQuoteShare:.6,tradeCount:50}),retryE1Evidence:()=>changed?WEAK:CALM,
    finalRecheckStep:(db,s,opts)=>finalRecheckStep(db,s,{...opts,now:()=>now}),postRecheckSafety,
    requireLeaderEntryControls:async()=>{},recordMismatch:async()=>{},persistDecisionRisk:async()=>{},
    readOpsPair:async()=>({positions:position?[position]:[],manual:[],pf:{available_quote:1000},match:{ok:true}}),
    snap:async()=>({available_quote:1000}),symbolFilters:x=>x,sizeEntry:()=>({amount:375}),decideEntry:async()=>({allowed:true}),
    registerCec0040Target:async()=>{},
    dispatchEntryIocAttempt:async(db,s,gw,opts)=>{
      const authority=opts.authorize();if(!authority.allowed)return {blocked:true,reason:authority.reason};
      assert.ok(opts.attemptNo<=2);orders.push(opts);events.push('order'+opts.attemptNo);
      now=opts.attemptNo===1?T+14000:now;
      const quantity=fills[opts.attemptNo-1]??0;
      return {oi:{id:'order'+opts.attemptNo,requested_quantity:opts.quantity},receipt:{quantity},
        evidence:{confirmedAt:new Date(now).toISOString()},settledRaw:{quantity}};
    },
    settleKnownEntry:async(db,oi,raw)=>{
      if(!raw.quantity)return null;
      position={id:'pos',original_quantity:(position?.original_quantity??0)+raw.quantity,entry_price:1.2,metadata:{}};
      return position;
    },
    protectNewLeaderPosition:async()=>{events.push('protect');return {status:protection,finishedAt:now};},
  };
  vm.createContext(c);const result=await vm.runInContext('(async function(){'+body+ ')()',c);
  return {result,orders,events,writes,x};
}
test('CASE 1 LTC: full first fill has one IOC and protection, no retry',async()=>{
  const r=await retryLifecycle({fills:[375]});assert.equal(r.orders.length,1);assert.equal(r.result.entered,true);
  assert.equal(r.result.entryProtection.status,'PROTECTED');assert.equal(r.result.sizedMarginUsdt,150);
});
test('CASE 2 BROCCOLI: expired ordinary BUY, fresh no-change evidence, bounded second fill',async()=>{
  const r=await retryLifecycle({fills:[0,375]});assert.equal(r.orders.length,2);assert.equal(r.result.reason,'IOC_RETRY_FILLED');
  assert.equal(r.x.w.calls.recheck,0);assert.equal(r.x.c.check(r.x.s).reason,'GPT_REVIEW_EXPIRED');
});
test('CASE 3: expired retry capability sends no second IOC',async()=>{
  const r=await retryLifecycle({fills:[0,375],expired:true});assert.equal(r.orders.length,1);
  assert.match(r.result.reason,/AUTHORITY_EXPIRED/);
});
for(const [id,final,count] of [[4,'BUY',2],[5,'SKIP',1],[6,'ERROR',1],[6,'ABSTAIN',1],[6,'INVALID',1]])
test(`CASE ${id}: meaningful change FINAL ${final} yields ${count} IOC(s)`,async()=>{
  const r=await retryLifecycle({fills:[0,375],changed:true,final});assert.equal(r.orders.length,count);
});
test('CASE 7: partial protected first fill precedes remaining top-up',async()=>{
  const r=await retryLifecycle({fills:[100,275]});assert.equal(r.orders[1].quantity,275);
  assert.deepEqual(r.events,['order1','protect','order2','protect']);
});
test('CASE 8: failed native protection forbids top-up',async()=>{
  const r=await retryLifecycle({fills:[100,275],protection:'RECONCILIATION_PENDING'});assert.equal(r.orders.length,1);
  assert.equal(r.result.reason,'PARTIAL_FILL_ABORT:PROTECTION_UNAVAILABLE');
});
test('CASE 9: partial second fill is protected; no third IOC',async()=>{
  const r=await retryLifecycle({fills:[0,100]});assert.equal(r.orders.length,2);
  assert.equal(r.result.reason,'PARTIAL_FILL_ABORT:IOC_RETRY_EXHAUSTED');assert.equal(r.result.entryProtection.status,'PROTECTED');
});
test('CASE 10: second zero fill terminalizes; no third IOC',async()=>{
  const r=await retryLifecycle({fills:[0,0]});assert.equal(r.orders.length,2);assert.equal(r.result.reason,'IOC_RETRY_EXHAUSTED');
  assert.equal(r.writes.at(-1).reject_reason,'IOC_RETRY_EXHAUSTED');
});
test('retry capability cannot be fabricated, cloned, reused or moved to another signal/cycle',async()=>{
  const x=await initialDecision();const token=gptBeginExecution(x.db,x.s,null);
  x.setNow(T+10000);assert.equal(x.c.confirmFirstFinality(token,{orderId:'first',confirmedAt:new Date(T+10000).toISOString(),quantity:375}),true);
  const r={recheck_sequence:2,pre_dispatch_at:T+19000,recheck_triggered:false};x.setNow(T+19000);
  assert.equal(gptFinalCheck(x.db,x.s,r,token).allowed,true);
  assert.equal(gptFinalCheck(x.db,{...x.s},r,token).allowed,false);
  assert.equal(gptFinalCheck(x.db,x.s,r,{}).allowed,false);
  assert.equal(gptConsumeRetry(x.db,token),true);assert.equal(gptConsumeRetry(x.db,token),false);
  assert.equal(gptFinalCheck(x.db,x.s,r,token).allowed,false);
});

test('durable intent latency cannot bypass the last authority check; a third IOC cannot create an intent',async()=>{
  const src=readFileSync(new URL('../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8');
  // The next top-level declaration is the extraction boundary, without rewriting dispatch.
  const dispatch=src.slice(src.indexOf('async function dispatchEntryIocAttempt('),src.indexOf('\n// ---',src.indexOf('async function dispatchEntryIocAttempt(')));
  const events=[],writes=[];
  const db={from:()=>({insert:row=>{events.push('intent');return {select:()=>({single:async()=>({data:{id:'o',...row}})})};},
    update:row=>({eq:async()=>{writes.push(row);return {};}})})};
  const ctx={IOC_RETRY_POLICY,LEV:3,REVISION:'test',PATCH:'test',cid:()=> 'id',Date,
    verifyExecutionLease:async()=>events.push('lease'),classifyFailure:()=>({fatal:false})};
  vm.createContext(ctx);vm.runInContext(dispatch+'\nthis.dispatch=dispatchEntryIocAttempt;',ctx);
  const gw=async()=>{events.push('venue');throw Error('MUST_NOT_SEND');};
  const result=await ctx.dispatch(db,{id:'s',symbol:'LTCUSDT'},gw,{attemptNo:2,quantity:1,limitPrice:1,step:1,payload:{},
    authorize:()=>{events.push('authority');return {allowed:false,reason:'IOC_RETRY_AUTHORITY_EXPIRED_OR_INVALID'};}});
  assert.equal(result.blocked,true);assert.deepEqual(events,['intent','lease','authority']);
  assert.equal(writes[0].state,'REJECTED');assert.equal(writes[0].response_payload.notDispatched,true);
  await assert.rejects(ctx.dispatch(db,{id:'s'},gw,{attemptNo:3}),/IOC_RETRY_EXHAUSTED/);
  assert.equal(events.filter(x=>x==='intent').length,1);
});
