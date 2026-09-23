// TEMPORARY order-free verification harness for the GPT final entry reviewer.
// It has no exchange credentials, no order/gateway code and no trading-table writes.
// It writes only purpose=VERIFICATION rows to the GPT review journal (budget-capped).
import {MODEL,LIMITS,hash,canonical,decisionIdentity,arithmeticCheck,evidenceAt,baselineAllowed} from '../_shared/gpt-final-review/contract.mjs';
import {collectMarket,computeMarket,buildPacket} from '../_shared/gpt-final-review/market.mjs';
import {callFinalReviewer,payloadFor,profileOf} from '../_shared/gpt-final-review/openai.mjs';
import {FinalReviewCoordinator,MemoryReviewStore,RELEASE,MAX_RESERVED_USD} from '../_shared/gpt-final-review/coordinator.mjs';
import {promptFor} from '../_shared/gpt-final-review/prompt.mjs';
import {wireSchema} from '../_shared/gpt-final-review/wire-v4.mjs';
import {evaluateB06133,fetchB06133Inputs} from '../_shared/leader-b06133-entry.mjs';

const MIN=60000;
export const VERIFY_LIMITS=Object.freeze({maxCallsPerRequest:12,capUsd:1.5,maxCallsPerDay:150});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const exitPolicy={stopPct:.01,trailArmPct:.008,trailGapPct:.004,maxHoldMs:3600000,staleMs:120000};

/** A: synthetic full-contract fixture (deterministic bars, current trigger minute). */
export function syntheticCandidate(id,triggerAt){
  const s={id,symbol:'TESTUSDT',status:'NEW',features:{referenceClose:100,exitPolicy,
    v17Setup:{state:'TRIGGERED',triggerAt},b06133:{version:'B06133_ENTRY_SELECTION_1',allowed:true,result:true,branch:'R62',
      factors:{},source:{decisionAt:triggerAt,featureValues:{volumeRatio:4.2,return5m:.011,return15m:.021,return30m:.034,return60m:.041},
        prebars:[0,1,2].map(i=>({openTime:triggerAt-(3-i)*MIN,closeTime:triggerAt-(2-i)*MIN-1,open:100+i,high:102+i,low:99+i,close:101+i,quoteVolume:100,takerBuyQuote:45+i})),
        btc:{return30m:.004,return2h:.009,freshnessMs:0}}},
    cec0040:{version:'CEC0040_CAUSAL_EDGE_CONTROLLER_1',targetVersion:'CEC0040_P142_MEAN44_1',decisionAt:triggerAt,action:'PROBE',ready:true,effectiveAllowed:true,enforcementEnabled:true}}};
  s.features.b06133.factors=arithmeticCheck(decisionIdentity(s)).expected;return s;
}
function syntheticBars(n,interval,end,base,drift){
  return Array.from({length:n},(_,i)=>{const t=end-(n-i)*interval,o=base*(1+drift*i),c=o*(1+drift*.6);
    return [t,String(o),String(Math.max(o,c)*1.001),String(Math.min(o,c)*.999),String(c),'1000',t+interval-1,String(1000*c),10,'560',String(560*c),'0'];});
}
export function syntheticMarket(s,asOf){
  const t=Number(s.features.v17Setup.triggerAt),end=Math.floor(asOf/MIN)*MIN,req=asOf-400,rec=asOf-150;
  return computeMarket(decisionIdentity(s),{one:{rows:syntheticBars(61,MIN,end,98,.0004),requestedAt:req,receivedAt:rec},
    five:{rows:syntheticBars(12,5*MIN,Math.floor(asOf/(5*MIN))*5*MIN,96,.002),requestedAt:req,receivedAt:rec},
    btc:{rows:syntheticBars(16,MIN,end,60000,.0001),requestedAt:req,receivedAt:rec}},asOf);
}

/** B: order-free fixture from CURRENT public Binance data. Factor values are computed by the
 * production B06133 selector; the fixture computes the input feature values itself (documented
 * formulas) and declares the fixture CEC stamp. Branch is the selector's own when it approves;
 * otherwise R62 is declared as the reviewed claim so the reviewer must detect the contradiction. */
export async function liveCandidate(symbol,triggerAt,fetchFn=fetch){
  const url='https://fapi.binance.com/fapi/v1/klines?'+new URLSearchParams({symbol,interval:'1m',limit:'61',endTime:String(triggerAt-1)});
  const r=await fetchFn(url,{signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error('LIVE_KLINES_'+r.status);
  const k=(await r.json()).filter(x=>Number(x[6])<triggerAt);if(k.length<61)throw Error('LIVE_KLINES_SHORT');
  const c=k.map(x=>Number(x[4])),q=k.map(x=>Number(x[7])),last=c.at(-1),ret=n=>last/c.at(-1-n)-1;
  const recent=q.slice(-15).reduce((a,b)=>a+b,0),prior=q.slice(-60,-15).reduce((a,b)=>a+b,0)/3;
  const features={volumeRatio:prior>0?recent/prior:null,return5m:ret(5),return15m:ret(15),return30m:ret(30),return60m:ret(60),referenceClose:last,exitPolicy};
  const input=await fetchB06133Inputs(symbol,triggerAt,fetchFn);
  const b=evaluateB06133({features,...input,decisionAt:triggerAt});
  const selectorAllowed=b.allowed===true;
  const stamp={...b,allowed:true,result:true,branch:selectorAllowed?b.branch:'R62'};
  const s={id:'verify-live-'+symbol+'-'+triggerAt,symbol,status:'NEW',features:{...features,
    v17Setup:{state:'TRIGGERED',triggerAt},b06133:stamp,
    cec0040:{version:'CEC0040_CAUSAL_EDGE_CONTROLLER_1',targetVersion:'CEC0040_P142_MEAN44_1',decisionAt:triggerAt,action:'PROBE',ready:true,effectiveAllowed:true,enforcementEnabled:true}}};
  return {s,selectorAllowed,selectorBranch:b.branch,selectorReason:b.reason};
}

/** Evidence-ID restoration audit: every selected ID must map to the exact source value/unit. */
export function restorationAudit(answer,packet){
  let checked=0,exact=0;
  for(const e of [...answer.supporting_evidence,...answer.opposing_evidence]){
    checked++;const f=evidenceAt(packet,e.field_path);if(Object.is(f.value,e.observed_value)&&f.unit===e.unit)exact++;
  }
  const claimPaths=answer.checked_claims.flatMap(c=>c.evidence_paths);
  for(const p of claimPaths)evidenceAt(packet,p);
  return {evidenceChecked:checked,evidenceExact:exact,claimPathsResolved:claimPaths.length};
}
function summarize(result,packet){
  const u=result.usage??{};
  return {decision:result.decision,valid:result.valid,error:result.error,httpStatus:result.http_status,latencyMs:result.latency_ms,
    requestIdPresent:typeof result.request_id==='string'&&result.request_id.length>0,
    refusal:/REFUSAL/.test(result.error??''),timeout:result.error==='API_TIMEOUT',
    structured:!!result.raw_response&&result.raw_response.status==='completed',
    candidateMatch:result.answer?result.answer.candidate_id===packet.candidate_id:null,
    snapshotMatch:result.answer?result.answer.snapshot_hash===packet.snapshot_hash:null,
    restoration:result.answer?restorationAudit(result.answer,packet):null,
    inputTokens:u.input_tokens??null,cachedTokens:u.input_tokens_details?.cached_tokens??null,outputTokens:u.output_tokens??null,
    costUsd:result.api_cost_usd,summary:result.answer?.summary??null};
}

/** One journaled, budget-reserved API call on a prepared packet. */
async function journaledCall({store,packet,identity,jobSeed,profile,apiKey,fetchFn,cfg,snapshotAt,expiresAt}){
  const key=await hash({purpose:'VERIFICATION',jobSeed});
  const record={version:packet.version,binding:'VERIFICATION:'+profile,identity,identity_json:canonical(identity),expires_at_ms:expiresAt,
    reserved_usd:MAX_RESERVED_USD,api_approval_ref:cfg.approvalRef,purpose:'VERIFICATION',wire_profile:profile,
    prompt_hash:await hash(promptFor(profileOf(profile).wire)),schema_hash:await hash(wireSchema(profileOf(profile).wire)),
    source_commit:RELEASE,packet,snapshot_at_ms:snapshotAt,result:null};
  const claimed=await store.claim(key,record,cfg);
  if(!claimed.created)return {duplicate:true,jobKey:key,state:claimed.row.state};
  const result=await callFinalReviewer(packet,{apiKey,fetchFn,now:Date.now,deadlineMs:Date.now()+LIMITS.requestMs+500,profile});
  record.result=result;await store.complete(key,claimed.row.owner,record);
  return {duplicate:false,jobKey:key,result};
}

export async function bench({db,store,apiKey,fetchFn=fetch,body}){
  const n=Math.max(1,Math.min(VERIFY_LIMITS.maxCallsPerRequest,Number(body.n??1)|0)),profile=String(body.profile??'V5');
  profileOf(profile);
  const cfg={approvalRef:'VERIFICATION:'+String(body.runId??'run'),apiBudgetUsd:VERIFY_LIMITS.capUsd,maxCalls:VERIFY_LIMITS.maxCallsPerDay};
  const fixture=String(body.fixture??'synthetic'),out=[];
  const symbols=Array.isArray(body.symbols)&&body.symbols.length?body.symbols.map(String):['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','BNBUSDT'];
  for(let i=0;i<n;i++){
    const now=Date.now(),trigger=Math.floor(now/MIN)*MIN;let s,market,asOf,meta={};
    if(fixture==='synthetic'){s=syntheticCandidate('verify-synthetic-'+body.runId+'-'+i,trigger);asOf=Date.now();market=syntheticMarket(s,asOf);}
    else if(fixture==='live'){
      const symbol=symbols[i%symbols.length],live=await liveCandidate(symbol,trigger,fetchFn);s=live.s;
      meta={symbol,selectorAllowed:live.selectorAllowed,selectorBranch:live.selectorBranch,selectorReason:live.selectorReason};
      market=await collectMarket(decisionIdentity(s),{fetchFn,now:Date.now,deadlineMs:Date.now()+5000});asOf=Date.now();
    }else throw Error('FIXTURE_UNSUPPORTED');
    const identity=decisionIdentity(s),packet=await buildPacket(identity,market,asOf);
    const call=await journaledCall({store,packet,identity,jobSeed:{run:body.runId,fixture,profile,i,trigger,id:s.id},profile,apiKey,fetchFn,cfg,snapshotAt:asOf,expiresAt:trigger+MIN});
    out.push({i,fixture,profile,...meta,marketComplete:packet.current_market.quality.complete,arithmeticConsistent:packet.original_model.arithmetic_check.consistent,
      duplicate:call.duplicate,jobKey:call.jobKey,...(call.result?summarize(call.result,packet):{})});
    if(body.gapMs)await sleep(Math.min(5000,Number(body.gapMs)));
  }
  return out;
}

/** C: real engine-approved historical candidates, reviewed in SHADOW on the point-in-time
 * market (public klines as of trigger+offset). The coordinator runs on a clock shifted to that
 * instant so trigger TTL, snapshot freshness and staleness rules apply unchanged. */
export function shiftedClock(triggerAt,offsetMs){const shift=Date.now()-(triggerAt+offsetMs);return ()=>Date.now()-shift;}
export async function replay({db,store,apiKey,fetchFn=fetch,body}){
  const ids=(Array.isArray(body.signalIds)?body.signalIds:[]).slice(0,VERIFY_LIMITS.maxCallsPerRequest).map(String);
  const profile=String(body.profile??'V5'),out=[];
  const cfg={mode:'SHADOW',modeValid:true,approvalRef:'VERIFICATION_REPLAY:'+String(body.runId??'run'),apiBudgetUsd:VERIFY_LIMITS.capUsd,
    maxCalls:VERIFY_LIMITS.maxCallsPerDay,enforceApproved:false,source:'VERIFICATION'};
  for(const id of ids){
    const r=await db.from('v11_long_regime_signals').select('id,symbol,status,reject_reason,features').eq('id',id).maybeSingle();
    if(r.error||!r.data){out.push({id,error:'SIGNAL_NOT_FOUND'});continue;}
    // Journal status is irrelevant to the historical decision identity; reviewed as the NEW candidate it was.
    const s={...r.data,status:'NEW'},trigger=Number(s.features?.v17Setup?.triggerAt);
    const baseline=baselineAllowed(s);
    const now=shiftedClock(trigger,Number(body.offsetMs??4000));
    const c=new FinalReviewCoordinator({config:cfg,store,apiKey:()=>apiKey,fetchFn,now,profile,purpose:'VERIFICATION',
      market:(identity,opts)=>collectMarket(identity,{...opts,now})});
    const started=Date.now(),first=await c.consider(s);
    await Promise.all([...c.pending.values()]);
    const second=await c.consider(s),row=second.jobKey?await store.get(second.jobKey):null;
    const z=row?.record?.result;
    out.push({id,symbol:s.symbol,historicalStatus:r.data.status,historicalRejectReason:r.data.reject_reason,baselineAllowed:baseline,
      branch:s.features?.b06133?.branch,cecAction:s.features?.cec0040?.action,first:first.reason,final:second.reason,decision:second.decision??null,
      shadowAllowed:second.allowed,elapsedMs:Date.now()-started,
      ...(z&&row.record.packet?summarize(z,row.record.packet):{}),marketComplete:row?.record?.packet?.current_market?.quality?.complete??null});
  }
  return out;
}

/** Candidate-scoped fault handling through the REAL journal with an injected transport
 * (no OpenAI call is made in these scenarios). */
export async function faults({store,body}){
  const out={},cfg={mode:'ENFORCE',modeValid:true,approvalRef:'VERIFICATION_FAULTS:'+String(body.runId??'run'),apiBudgetUsd:VERIFY_LIMITS.capUsd,
    maxCalls:VERIFY_LIMITS.maxCallsPerDay,enforceApproved:true,source:'VERIFICATION'};
  const trigger=Math.floor(Date.now()/MIN)*MIN;
  const scenario=async(name,fetchFn,{timeoutFirst=false}={})=>{
    const s=syntheticCandidate('verify-fault-'+name+'-'+body.runId,trigger);
    const c=new FinalReviewCoordinator({config:cfg,store,apiKey:()=>'NOT_A_REAL_KEY_FAULT_INJECTION',fetchFn,purpose:'VERIFICATION',
      market:async(identity)=>syntheticMarket(s,Date.now())});
    const a=await c.consider(s);await Promise.all([...c.pending.values()]);const b=await c.consider(s);
    const row=b.jobKey?await store.get(b.jobKey):null;
    out[name]={first:a.reason,final:b.reason,allowed:b.allowed,check:c.check(s).reason,error:row?.record?.result?.error??null,state:row?.state??null};
  };
  const json=(o,status=200)=>new Response(JSON.stringify(o),{status,headers:{'content-type':'application/json','x-request-id':'req_fault_injection'}});
  await scenario('http429',async()=>json({error:{message:'rate limited'}},429));
  await scenario('http500',async()=>json({error:{message:'server'}},500));
  await scenario('malformed',async()=>json({id:'x',status:'completed',model:MODEL,output:[{type:'message',content:[{type:'output_text',text:'{not json'}]}],usage:{input_tokens:10,output_tokens:5,input_tokens_details:{cached_tokens:0}}}));
  await scenario('wrongCandidate',async(url,init)=>{const input=JSON.parse(JSON.parse(init.body).input[1].content);
    return json({id:'x',status:'completed',model:MODEL,service_tier:'default',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({w:input.w,c:'c_'+'0'.repeat(32),h:input.h,d:'PASS',k:[{i:'CURRENT_REACCELERATION',v:'SUPPORTED',e:['C_return_5m']}],support:['C_return_5m','C_last_body'],oppose:[],n:'근거가 유지됩니다'})}]}],usage:{input_tokens:10,output_tokens:5,input_tokens_details:{cached_tokens:0}}});});
  await scenario('wrongSnapshot',async(url,init)=>{const input=JSON.parse(JSON.parse(init.body).input[1].content);
    return json({id:'x',status:'completed',model:MODEL,service_tier:'default',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({w:input.w,c:input.c,h:'f'.repeat(64),d:'PASS',k:[{i:'CURRENT_REACCELERATION',v:'SUPPORTED',e:['C_return_5m']}],support:['C_return_5m','C_last_body'],oppose:[],n:'근거가 유지됩니다'})}]}],usage:{input_tokens:10,output_tokens:5,input_tokens_details:{cached_tokens:0}}});});
  await scenario('timeout',()=>new Promise(()=>{}));
  return out;
}

/** Duplicate protection with a REAL API call: two coordinators, same candidate, concurrently. */
export async function duplicate({store,apiKey,fetchFn=fetch,body}){
  const cfg={mode:'ENFORCE',modeValid:true,approvalRef:'VERIFICATION_DUPLICATE:'+String(body.runId??'run'),apiBudgetUsd:VERIFY_LIMITS.capUsd,
    maxCalls:VERIFY_LIMITS.maxCallsPerDay,enforceApproved:true,source:'VERIFICATION'};
  const trigger=Math.floor(Date.now()/MIN)*MIN,s=syntheticCandidate('verify-duplicate-'+body.runId,trigger);
  let requests=0;const counting=async(...a)=>{if(String(a[0]).startsWith('https://api.openai.com/'))requests++;return fetchFn(...a);};
  const mk=()=>new FinalReviewCoordinator({config:cfg,store,apiKey:()=>apiKey,fetchFn:counting,purpose:'VERIFICATION',market:async()=>syntheticMarket(s,Date.now())});
  const a=mk(),b=mk();
  const [ra,rb]=await Promise.all([a.consider(s),b.consider(s)]);
  await Promise.all([...a.pending.values(),...b.pending.values()]);
  const [fa,fb]=await Promise.all([a.consider(s),b.consider(s)]);
  const third=mk(),rc=await third.consider(s);await Promise.all([...third.pending.values()]);
  return {firstA:ra.reason,firstB:rb.reason,finalA:fa.reason,finalB:fb.reason,lateCoordinator:rc.reason,sameJob:!!fa.jobKey&&fa.jobKey===fb.jobKey,apiRequests:requests,
    pendingCreatedByA:a.pending.size,pendingCreatedByB:b.pending.size};
}
