import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {computeFacts,bars} from '../supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {technicalFacts} from '../supabase/functions/_shared/gpt-final-decision/technical.mjs';
import {modelInput,hash} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {frozenReview,arbitrationPayload,finalEvidenceTransport,reviewsFor,dualEntryDecision} from '../supabase/functions/_shared/gpt-final-decision/dual.mjs';
import {callAdvisory} from '../supabase/functions/_shared/gpt-final-decision/advisory.mjs';
import {baselinePolicy} from '../supabase/functions/_shared/self-evolution/policy.mjs';
import {deduplicateEvidence} from '../supabase/functions/_shared/gpt-final-decision/compact-hold.mjs';
import {emergencyProtection} from '../supabase/functions/_shared/gpt-final-decision/emergency-protection.mjs';
import {holdStep,initialHoldState,MONTHLY_HOLD_POLICY} from '../supabase/functions/_shared/gpt-final-decision/hold.mjs';
import {validateDecision} from '../supabase/functions/_shared/gpt-final-decision/contract.mjs';
import {fd1HoldTick,setFd1HoldTestHooks} from '../supabase/functions/v10-lane-executor/gpt-final-decision-adapter.mjs';
import {positionGeneration,assertExitAuthority} from '../supabase/functions/_shared/exit-authority.mjs';
import {harness,position} from '../test-support/v18-ops/harness.mjs';
const fixture=name=>JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/'+name,import.meta.url))));
const hbar=fixture('hbar-production-20260929.json.gz'),packet=hbar[2].record.packet;
test('emergency proof dispatches the existing reduce-only close and rejects stale proof',async()=>{
 const at=packet.dynamic_as_of_ms,capture=packet.facts.capture_context,e=packet.position.exit_context,p=position('HBARUSDT',3794,.1187672245651028);
 p.id=packet.position.position_id;p.entry_at='2026-09-28T15:01:38.742Z';
 const h=harness({positions:[p],signal:false,now:at}),bid=Math.min(...capture.trajectory.map(x=>x.mid*(1-x.spread_bps/20000)))-.00001;
 h.state.quotes[p.symbol]=bid;
 h.state.createOrder=(cmd,s)=>{s.exchange=[];return {order:{orderId:'emergency-1',clientOrderId:cmd.order.identifier,symbol:p.symbol,side:'SELL',positionSide:'BOTH',reduceOnly:true,origQty:'3794',executedQty:'3794',avgPrice:String(bid),status:'FILLED',updateTime:at,fills:[{id:'1',qty:'3794',price:String(bid),commission:'.01',commissionAsset:'USDT',time:at}]}};};
 const failure={at,error:'API_TIMEOUT'},args={capture,now:at,bid,peak:e.peak,hardFloor:e.hard_floor,standing:0,technicalFailure:failure};
 const emergency=emergencyProtection(args);assert.equal(emergency.action,'EMERGENCY_EXIT_THESIS_FAILURE');
 const approval={authority:'DETERMINISTIC_TECHNICAL_PROTECTION',valid:true,positionId:p.id,generation:positionGeneration(p),observedAt:at,...args,level:emergency.level};
 await h.ctx.close(h.state.tables.v11_long_regime_positions[0],1,'EMERGENCY_EXIT_THESIS_FAILURE',{finalApproval:approval});
 const calls=h.state.calls.filter(x=>x.action==='create_order');assert.equal(calls.length,1);assert.equal(calls[0].order.position_effect,'CLOSE');assert.equal(calls[0].order.side,'SELL');
 assert.throws(()=>assertExitAuthority('EMERGENCY_EXIT_THESIS_FAILURE',p,approval,at+5001),/EMERGENCY/);
});
for(const mode of ['EXIT','TIGHTER','FAIL'])test('urgent review '+mode+' in the same invocation',async()=>{
 const failed=mode==='FAIL';
 const p={id:packet.position.position_id,entry_at:'2026-09-28T15:01:38.742+00:00',entry_price:.1187672245651028,remaining_quantity:3794,symbol:'HBARUSDT',state:'OPEN'};
 const generation=positionGeneration(p),at=packet.dynamic_as_of_ms,q=structuredClone(packet);q.position.generation=generation;
 let completed=false;const capture=q.facts.capture_context,exit=q.position.exit_context;
 const result=failed?{valid:false,decision:'ABSTAIN',error:'FD_REQUEST_COST_BOUND',completed_at_ms:at}:
 await dualEntryDecision(q,{apiKey:'test',deepseekKey:'',now:()=>at,snapshotAtMs:at,deadlineMs:at+8000,reviewTier:'FAST',policy:baselinePolicy(),
 counterCall:async()=>({valid:false,attempted:false,error:'DEEPSEEK_KEY_MISSING'}),gptCall:async(z,o)=>{const wire={...exitWire(z),...(mode==='TIGHTER'?{d:'HOLD',action:'HOLD',support:['return_5m'],dynamic_action:'HOLD_WITH_TIGHTER_RISK'}:{})},answer=o.validate(wire,z);return {valid:true,decision:answer.decision,answer,wire,attempted:true,api_cost_usd:.01,started_at_ms:at,completed_at_ms:at};}});
 if(!failed)assert.equal(result.valid,true,result.error);
 setFd1HoldTestHooks({apiKey:'test',config:{mode:'ENFORCE',modeValid:true,approvalRef:'test',apiBudgetUsd:3,maxCalls:300,enforceApproved:true},leader20Control:{},
  capture:async()=>capture,now:()=>at,review:async()=>({packet:q,result}),store:{get:async()=>null,claim:async()=>({created:true,row:{owner:'test'}}),complete:async()=>{completed=true;}}});
 try{const r=await fd1HoldTick(null,p,{now:at,bid:exit.current_price,state:{peakPrice:exit.peak},exitContext:exit,meta:{}});
 assert.equal(completed,true);assert.equal(r.state.pending,null);assert.equal(r.state.last.failure_to_action_ms,0);
 if(failed){assert.equal(r.fallback,true);assert.ok(r.state.protectLevel>exit.hard_floor);}
 else if(mode==='TIGHTER'){assert.equal(r.close,false);assert.equal(r.reason,'FD1_GPT_PROTECT');assert.ok(r.state.protectLevel>exit.hard_floor);assert.equal(r.state.last.dynamic_action,'HOLD_WITH_TIGHTER_RISK');}
 else{assert.equal(r.close,true);assert.equal(r.reason,'FD1_GPT_EXIT');}
 }finally{setFd1HoldTestHooks(null);}
});
test('CRV regression: GPT tighter-risk binds candidate from the exact reviewed fresh capture',async()=>{
 const p={id:packet.position.position_id,entry_at:'2026-09-28T15:01:38.742+00:00',
  entry_price:.1187672245651028,remaining_quantity:3794,symbol:'HBARUSDT',state:'OPEN'};
 const generation=positionGeneration(p),at=packet.dynamic_as_of_ms,reviewCapture=structuredClone(packet.facts.capture_context),
  preCapture=structuredClone(reviewCapture),exit=packet.position.exit_context,q=structuredClone(packet);
 // Reproduce the CRV wiring shape: the management tick starts without an emergency candidate,
 // then the fresher packet actually reviewed by GPT contains the full PRICE+FLOW+BOOK failure.
 preCapture.dynamics.horizons.s30.bid_liquidity_change=Math.abs(preCapture.dynamics.horizons.s30.bid_liquidity_change)||0.1;
 assert.equal(emergencyProtection({capture:preCapture,now:at,bid:exit.current_price,peak:exit.peak,
  hardFloor:exit.hard_floor,standing:0,technicalFailure:{candidateOnly:true}}),null);
 const reviewedCandidate=emergencyProtection({capture:reviewCapture,now:at,bid:exit.current_price,peak:exit.peak,
  hardFloor:exit.hard_floor,standing:0,technicalFailure:{candidateOnly:true}});
 assert.ok(reviewedCandidate?.level>exit.hard_floor);
 q.position.generation=generation;
 let completed=false;
 const result=await dualEntryDecision(q,{apiKey:'test',deepseekKey:'',now:()=>at,snapshotAtMs:at,
  deadlineMs:at+8000,reviewTier:'FAST',policy:baselinePolicy(),
  counterCall:async()=>({valid:false,attempted:false,error:'DEEPSEEK_KEY_MISSING'}),
  gptCall:async(z,o)=>{
   const wire={...exitWire(z),d:'HOLD',action:'HOLD',support:['return_5m'],
    dynamic_action:'HOLD_WITH_TIGHTER_RISK'};
   const answer=o.validate(wire,z);
   return {valid:true,decision:answer.decision,answer,wire,attempted:true,api_cost_usd:.01,
    started_at_ms:at,completed_at_ms:at};
  }});
 assert.equal(result.valid,true,result.error);
 setFd1HoldTestHooks({apiKey:'test',
  config:{mode:'ENFORCE',modeValid:true,approvalRef:'test',apiBudgetUsd:3,maxCalls:300,enforceApproved:true},
  leader20Control:{},capture:async()=>preCapture,now:()=>at,review:async()=>({packet:q,result}),
  store:{get:async()=>null,claim:async()=>({created:true,row:{owner:'test'}}),complete:async()=>{completed=true;}}});
 try{
  const r=await fd1HoldTick(null,p,{now:at,bid:exit.current_price,state:{peakPrice:exit.peak},
   exitContext:exit,meta:{}});
  assert.equal(completed,true);
  assert.equal(r.reason,'FD1_GPT_PROTECT');
  assert.equal(r.protectApproval?.verdict,'APPROVED');
  assert.equal(r.state.protectLevel,reviewedCandidate.level);
  assert.equal(r.state.protectReason,'THESIS_REVIEW_PROTECTION');
 }finally{setFd1HoldTestHooks(null);}
});

const candles=fixture('hbar-completed-candles-20260929.json.gz');
const expand=x=>{const root=x;function resolve(v){if(v?.$ref){return resolve(v.$ref.slice(2).split('/').map(k=>k.replace(/~1/g,'/').replace(/~0/g,'~')).reduce((a,k)=>a[k],root));}return Array.isArray(v)?v.map(resolve):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,z])=>[k,resolve(z)])):v;}return resolve(x);};
test('lossless JSON references reconstruct identical data, including every ordered bucket',()=>{
 const x={a:packet,b:packet};assert.deepEqual(expand(deduplicateEvidence(x)),x);
});
test('HBAR and SOON actual oversized HOLD packets now fit both provider bounds with all 24 buckets',async()=>{
 const sources=[...hbar.filter(x=>x.record.packet.task==='HOLD').map(x=>x.record),...fixture('soon-hold-20260929.json.gz').map(x=>({packet:x.packet}))];
 for(const r of sources){const p=r.packet,at=p.dynamic_as_of_ms,f=await frozenReview(p,{snapshotAtMs:at}),a=r.result?.arbitration;
  const payload=finalEvidenceTransport(arbitrationPayload(f,f,reviewsFor(a?.first,a?.deepseek??{valid:false}))).payload;
  assert.ok(Buffer.byteLength(JSON.stringify(payload))<=130000);
  const ds=await callAdvisory(f,{apiKey:'fixture',now:()=>at,fetchFn:async()=>new Response('{}',{status:503})});
  assert.ok(ds.request_bytes<=90000);assert.equal(ds.attempted,true);
  if(p.facts.capture_context.status==='AVAILABLE'){
   const input=expand(f.market_input),c=input.capture_context;assert.equal(c.ordered_path.length,24);
   for(let i=0;i<24;i++)for(const [j,k] of c.ordered_path_columns.entries())assert.deepEqual(c.ordered_path[i][j],p.facts.capture_context.trajectory[i][k]??null);
  }
 }
 assert.equal(hbar[2].record.result.error,'FD_REQUEST_COST_BOUND');assert.equal(hbar[2].record.result.request_bytes,156173);
});
test('HBAR degraded valid HOLD survives with observed static evidence and no invented dynamic citations',()=>{
 const r=hbar[1].record;assert.equal(r.result.error,'FD_LEADER20_EVIDENCE_REQUIRED');
 const {arbitration,...wire}=r.result.wire;assert.equal(validateDecision(wire,r.packet).decision,'HOLD');
});
test('completed technical indicators reach model input with causal live/replay parity',()=>{
 const src={...candles,btc:candles.one},at=candles.asOf,f=computeFacts(src,{asOf:at}),p=structuredClone(hbar[0].record.packet);p.facts=f;
 const v=f.values,input=modelInput(p);
 for(const k of ['rsi_1m_14','rsi_5m_14','stoch_k_1m','stoch_d_1m','stoch_k_5m','stoch_d_5m','bb_position','ema9_vs_ema20','atr_1m_14_normalized','last_lower_wick','body_to_range','close_location_value'])assert.ok(Number.isFinite(v[k]),k);
 assert.equal(input.technical_context.recent_1m_candles.length,3);assert.ok(input.facts.technical.rsi_1m_14>0);
 const t=Math.floor(at/60000)*60000,future=[t,'999','1000','1','500','1',t+59999,'1',1,'1','1'];
 assert.deepEqual(computeFacts({...src,one:[...src.one,future]},{asOf:at}),f);
 assert.deepEqual(technicalFacts(bars(src.one,60000,at),bars(src.five,300000,at)).values,Object.fromEntries(Object.keys(technicalFacts([],[]).values).map(k=>[k,v[k]])));
 const missing=computeFacts({},{asOf:at});assert.equal(missing.values.rsi_1m_14,null);assert.ok(missing.missing.rsi_1m_14);
});
test('flat price, monotonic price and zero-range indicators have defined causal behavior',()=>{
 const a=Array.from({length:30},(_,i)=>({t:i*60000,end:(i+1)*60000-1,o:100,h:100,l:100,c:100}));
 const f=technicalFacts(a,a);assert.equal(f.values.rsi_1m_14,50);assert.equal(f.values.bb_width,0);assert.equal(f.values.bb_position,null);assert.equal(f.values.close_location_value,null);
 const up=a.map((x,i)=>({...x,o:100+i,c:101+i,h:102+i,l:99+i}));assert.equal(technicalFacts(up,up).values.rsi_1m_14,100);
});
function exitWire(p){return {t:'HOLD',c:p.candidate_id,d:'EXIT',reasons:[{r:'GPT_JUDGMENT',e:['position_drawdown_from_peak']}],support:[],n:'진입 근거가 무너졌습니다.',
 structural_strength:'Mixed',current_propulsion:'Selling',propulsion_direction:'REVERSING',dynamic_evidence:[],dynamic_risks:['dynamics.horizons.s30.net_taker_flow'],uncertainty:'Advisor unavailable',confidence:.8,
 dynamic_action:'EXIT_THESIS_BROKEN',action:'EXIT',pressure_state:'FALLING',decision_reason:'Thesis failed',counter_evidence:[],thesis_invalidation:'New highs restore demand',next_review_conditions:'Flat position',
 arbitration:{considered:[],adopted:[],rejected:[],supporting:['current.capture_context.dynamics.horizons.s30.net_taker_flow'],opposing:[],reason:'Multi-axis failure'}};}
for(const failures of [0,1,2])test('HBAR CASE '+['A valid GPT','B compact retry','C retry unavailable'][failures],async()=>{
 const p=structuredClone(packet),at=p.dynamic_as_of_ms;let calls=0;
 const r=await dualEntryDecision(p,{apiKey:'fixture',deepseekKey:'',now:()=>at,snapshotAtMs:at,deadlineMs:at+8000,reviewTier:'FAST',policy:baselinePolicy(),
  counterCall:async()=>({valid:false,attempted:false,error:'DEEPSEEK_KEY_MISSING'}),gptCall:async(q,options)=>{calls++;
   if(calls<=failures)return {valid:false,decision:'ABSTAIN',error:'FD_REQUEST_COST_BOUND',attempted:false,api_cost_usd:0};
   const wire=exitWire(q),answer=options.validate(wire,q);return {valid:true,decision:answer.decision,answer,wire,attempted:true,api_cost_usd:.01,started_at_ms:at,completed_at_ms:at};}});
 assert.equal(calls,failures===0?1:2);assert.equal(r.valid,failures<2);
 if(failures<2)assert.equal(r.decision,'EXIT');else assert.equal(r.arbitration.compact_retry.attempts,1);
});
test('HBAR invalid AI is consumed as real raised protection, never passive ABSTAIN to native stop',async()=>{
 const p={id:packet.position.position_id,entry_at:'2026-09-28T15:01:38.742+00:00',entry_price:.1187672245651028,remaining_quantity:3794,symbol:'HBARUSDT',state:'OPEN'};
 const generation=positionGeneration(p),at=packet.dynamic_as_of_ms,capture=packet.facts.capture_context,exit=packet.position.exit_context;
 const record={purpose:'PRODUCTION',identity:{position_id:p.id,generation},packet,result:{valid:false,decision:'ABSTAIN',error:'FD_REQUEST_COST_BOUND',completed_at_ms:at}};
 const state={...initialHoldState(p.entry_price),generation,pending:{key:'failed',event:'ENTRY_FAILURE_MULTI_AXIS',at:at-1000},dynamicTracker:{generation,status:'AVAILABLE',capture,last_valid_capture:capture}};
 setFd1HoldTestHooks({capture:async()=>capture,now:()=>at,store:{get:async()=>({state:'DONE',record})}});
 try{const r=await fd1HoldTick(null,p,{now:at,bid:exit.current_price,state:{peakPrice:exit.peak},exitContext:exit,meta:{fd1Hold:state}});
  assert.equal(r.reason,'HOLD_WITH_TIGHTER_RISK');assert.equal(r.fallback,true);assert.ok(r.state.protectLevel>exit.hard_floor);assert.equal(r.state.last.applied_decision,'HOLD_WITH_TIGHTER_RISK');assert.ok(r.state.last.failure_to_action_ms<=1000);
 }finally{setFd1HoldTestHooks(null);}
});
test('emergency cannot act on stale, future, incomplete, recovered or unfailed snapshots',()=>{
 const c=packet.facts.capture_context,e=packet.position.exit_context,a={capture:c,now:packet.dynamic_as_of_ms,bid:e.current_price,peak:e.peak,hardFloor:e.hard_floor,technicalFailure:{error:'API_TIMEOUT'}};
 assert.ok(emergencyProtection(a));assert.equal(emergencyProtection({...a,technicalFailure:null}),null);
 assert.equal(emergencyProtection({...a,now:c.end_ms+10000}),null);assert.equal(emergencyProtection({...a,now:c.end_ms-1}),null);
 for(const mutate of [x=>x.trajectory.pop(),x=>x.dynamics.horizons.s30.return=.01,x=>x.dynamics.horizons.s60.net_taker_flow=1,x=>x.dynamics.horizons.s30.imbalance=.1]){const bad=structuredClone(c);mutate(bad);assert.equal(emergencyProtection({...a,capture:bad}),null);}
 const p={id:'p',entry_at:'2026-09-28T15:00:00Z',state:'OPEN',remaining_quantity:1};assert.throws(()=>assertExitAuthority('EMERGENCY_EXIT_THESIS_FAILURE',p,null,a.now),/EMERGENCY_PROOF_REQUIRED/);
});
test('urgent failure bypasses a preceding ordinary review delay and spent review count',async()=>{
 const at=packet.dynamic_as_of_ms,st={...initialHoldState(1),lastReviewAt:at-5000,reviews:100,retryAfter:at+300000};
 const r=await holdStep(st,{now:at,price:.99,peak:1,positionId:'p',generation:'g',dynamics:{event:'ENTRY_FAILURE_MULTI_AXIS',evidenceKey:'fresh'},answerOf:async()=>null},MONTHLY_HOLD_POLICY);
 assert.equal(r.start.event,'ENTRY_FAILURE_MULTI_AXIS');
});
