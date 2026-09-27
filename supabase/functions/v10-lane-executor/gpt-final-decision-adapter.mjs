import {positionGeneration} from '../_shared/exit-authority.mjs';
import {readCaptureWithRecovery,emergencyDynamicPacket} from '../_shared/gpt-final-decision/capture-context.mjs';
import {DYNAMIC_POLICY,positionDynamicState,entryFailureEvidence,entryCaptureSafety} from '../_shared/gpt-final-decision/dynamic-flow.mjs';
import {dynamicsEvent} from '../_shared/gpt-final-decision/trajectory.mjs';
/** Strategic closes require fresh validated GPT FINAL. Existing hard safety executes first. */
import {holdStep,initialHoldState,runHoldReview,TIME_REASONS,FD1_HOLD_POLICY_VERSION,HOLD_POLICY} from '../_shared/gpt-final-decision/hold.mjs';
import {SupabaseReviewStore,readReviewControl} from '../_shared/gpt-final-review/supabase-store.mjs';
import {configFromControl} from '../_shared/gpt-final-review/coordinator.mjs';
import {recordHoldShadow,shadowJobKey,holdShadowEnabled,HOLD_RELEASE} from '../_shared/gpt-final-decision/hold-shadow.mjs';
import {revalidateArbitration,DUAL_VERSION} from '../_shared/gpt-final-decision/dual.mjs';
import {hash} from '../_shared/gpt-final-decision/api.mjs';
import {validateAdvisory} from '../_shared/gpt-final-decision/advisory.mjs';
export {HOLD_RELEASE,holdShadowEnabled};
export {FD1_HOLD_POLICY_VERSION,TIME_REASONS};
const getenv=n=>globalThis.Deno?.env?.get(n)??'';
let testHooks=null;
export function setFd1HoldTestHooks(h){testHooks=h;}
function authorized(c,apiKey){return c.mode==='ENFORCE'&&c.modeValid!==false&&c.enforceApproved===true&&c.approvalRef.length>0&&
  c.apiBudgetUsd>=0.10&&Number.isInteger(c.maxCalls)&&c.maxCalls>0&&!!apiKey;}
function emergencyEligible(c,deepseekKey){return c?.mode==='ENFORCE'&&c?.modeValid!==false&&c?.enforceApproved===true&&
  typeof c?.approvalRef==='string'&&c.approvalRef.length>0&&!!deepseekKey;}
async function deepseekEmergency(result,{p,packet,generation,now}){
  // Current lifecycle has GPT-only strategy authority; historical records retain
  // their original validator, but advisory output cannot execute a dynamic review.
  if(packet?.dynamic_policy)return null;
  const ds=result?.arbitration?.deepseek,a=ds?.answer,decision=a?.decision_preference;
  if(ds?.valid!==true||!['HOLD','PROTECT','EXIT'].includes(decision)||a?.recommended_action!==decision)return null;
  const completed=Number(ds.completed_at_ms),snapshot=Number(ds.snapshot_at_ms),snapshotHash=String(ds.snapshot_hash??'');
  if(!Number.isSafeInteger(completed)||completed>now||now-completed>HOLD_POLICY.exitMaxAgeMs||
     !Number.isSafeInteger(snapshot)||snapshot>now||now-snapshot>HOLD_POLICY.exitMaxAgeMs||
     completed<snapshot||!/^[a-f0-9]{64}$/.test(snapshotHash))return null;
  // A persisted valid flag alone cannot grant authority. Rebind the exact frozen
  // HOLD snapshot, position generation and supported evidence when consuming it.
  try{
    const arb=result.arbitration,input=arb.initial_input,{snapshot:identityWithHash,...market}=input,
      {snapshot_hash:recordedHash,...identity}=identityWithHash;
    if(arb.version!==DUAL_VERSION||packet?.task!=='HOLD'||identity.task!=='HOLD'||
       packet.position?.position_id!==String(p.id)||packet.position?.generation!==generation||
       identity.position_state?.position_id!==String(p.id)||identity.position_state?.generation!==generation||
       identity.symbol!==String(p.symbol).toUpperCase()||packet.candidate_id!==identity.candidate_id||
       identity.snapshot_at_ms!==snapshot||recordedHash!==snapshotHash||arb.snapshot_hash!==snapshotHash||
       arb.deepseek_snapshot_hash!==snapshotHash||arb.gpt_first_snapshot_hash!==snapshotHash||
       await hash({identity,market})!==snapshotHash)return null;
    // runHoldReview persists the refreshed FINAL packet when available. Bind that
    // exact packet to its own frozen snapshot; FIRST and FINAL may legitimately differ.
    const packetInput=arb.final_input??input,{snapshot:packetIdentityWithHash,...packetMarket}=packetInput,
      {snapshot_hash:packetSnapshotHash,...packetIdentity}=packetIdentityWithHash;
    if(packet.symbol!==identity.symbol||packetIdentity.task!=='HOLD'||packetIdentity.symbol!==identity.symbol||
       packetIdentity.candidate_id!==packet.candidate_id||
       packetIdentity.position_state?.position_id!==String(p.id)||packetIdentity.position_state?.generation!==generation||
       !Number.isSafeInteger(packetIdentity.snapshot_at_ms)||packetIdentity.snapshot_at_ms<snapshot||packetIdentity.snapshot_at_ms>now||
       packetSnapshotHash!==(arb.final_input?arb.final_snapshot_hash:snapshotHash)||
       await hash({identity:packetIdentity,market:packetMarket})!==packetSnapshotHash||
       await hash(packet)!==packetIdentity.packet_hash)return null;
    validateAdvisory(a,{packet:{task:'HOLD',candidate_id:identity.candidate_id},snapshot_hash:snapshotHash,market_input:input});
  }catch{return null;}
  return {decision,valid:true,authority:'DEEPSEEK_EMERGENCY_EXIT_ONLY',completed_at_ms:completed,
    snapshot_at_ms:snapshot,snapshot_hash:snapshotHash,positionId:String(p.id),generation};
}
function applyEmergency(step,e,{p,generation,now,bid,state,timeCandidate,softTrigger,dynamics,why}){
  let s={...step.state,pending:null,retryAfter:null,
    last:{key:step.start?.key??null,event:step.start?.event??null,decision:e.decision,authority:e.authority,at:now},
    emergency:{provider:'deepseek',trigger:why,decision:e.decision,at:now,snapshotHash:e.snapshot_hash}};
  s.softReceipt={key:step.state?.pending?.softKey??softTrigger?.key,price:bid,peak:state.peakPrice,
    evidenceKey:dynamics?.evidenceKey??null,at:now};
  if(e.decision==='EXIT')return {close:true,reason:'FD1_DEEPSEEK_EXIT',fallback:true,state:s,approval:{
    authority:e.authority,valid:true,decision:'EXIT',positionId:String(p.id),generation,
    snapshotHash:e.snapshot_hash,completedAt:e.completed_at_ms,snapshotAt:e.snapshot_at_ms}};
  if(e.decision==='PROTECT'){
    // GPT is the only approver of a protection raise. DeepSeek stands in for GPT only to
    // EXIT or HOLD, so its PROTECT keeps exactly the last approved level (the mandated
    // KEEP_LAST_APPROVED_PROTECTION fallback) and buys sensitivity, not a higher stop.
    s.protectUntil=now+HOLD_POLICY.protectMs;s.holdUntil=timeCandidate?s.protectUntil:s.holdUntil;
    s.protection={mode:'ELEVATED',sensitivityMultiplier:2,intervalMs:HOLD_POLICY.protectMs,exposureIncrease:false};
    s.protectDeclined={verdict:'KEEP_LAST_APPROVED_PROTECTION',provider:'deepseek',
      requested:Number(softTrigger?.level)||null,standing:Number(s.protectLevel)||null,at:now};
    return {close:false,reason:'FD1_DEEPSEEK_PROTECT',fallback:true,state:s};
  }
  if(timeCandidate)s.holdUntil=now+HOLD_POLICY.holdTtlMs;
  return {close:false,reason:'FD1_DEEPSEEK_HOLD',fallback:true,state:s};
}
/**
 * @returns {close:boolean, reason:string|null, fallback?:boolean, state:object, review?:object}
 */
export async function fd1HoldTick(db,p,{meta,state,bid,now,timeCandidate,softTrigger=null,exitContext=null}){
  if(p.state!=='OPEN'||!(Number(p.remaining_quantity)>0))return {close:false,reason:'FD1_POSITION_NOT_OPEN',state:meta.fd1Hold??initialHoldState(p.entry_price)};
  const store=testHooks?.store??new SupabaseReviewStore(db),apiKey=testHooks?.apiKey??getenv('OPENAI_API_KEY');
  let prior=meta.fd1Hold&&meta.fd1Hold.version===FD1_HOLD_POLICY_VERSION?meta.fd1Hold:
    {...initialHoldState(p.entry_price),...(meta.fd1Hold??{}),version:FD1_HOLD_POLICY_VERSION,pending:null,holdUntil:null};
  const generation=positionGeneration(p);
  if(prior.generation&&prior.generation!==generation)prior=initialHoldState(p.entry_price);
  prior={...prior,generation};
  const pendingRead=prior.pending?store.get(prior.pending.key).catch(()=>null):null;
  let dynamics=null;
  if(now-(prior.dynamicsAt??0)>=DYNAMIC_POLICY.positionReadMs||!prior.dynamicTracker){
    const capture=await (testHooks?.capture??readCaptureWithRecovery)(p.symbol,now,{positionId:p.id,now:testHooks?.now??Date.now});
    dynamics=dynamicsEvent(capture,prior.dynamicsObservation,!!prior.protectUntil);
    const capturedAt=testHooks?.capture?now:Date.now();
    const seed=meta.entryDynamicSeed?.capture;
    const previous=prior.dynamicTracker??(seed?{generation,last_valid_capture:seed}:null);
    let tracker=positionDynamicState(previous,capture,{at:capturedAt,bid,entry:Number(p.entry_price),generation,positionId:p.id});
    if(tracker.status==='DATA_DEGRADED'){
      const emergency=testHooks?.emergency?await testHooks.emergency(p.symbol):testHooks?.capture?
        {status:'UNAVAILABLE',reason:'TEST_EMERGENCY_NOT_SUPPLIED',full_trajectory:false,entry_allowed:false}:
        await emergencyDynamicPacket(p.symbol);
      tracker={...tracker,emergency_packet:emergency};
      dynamics={...dynamics,event:'DATA_DEGRADED',evidenceKey:'DATA_DEGRADED:'+Math.floor(now/DYNAMIC_POLICY.missingRetryMs)};
      prior={...prior,holdUntil:null};
    }else{
      const failure=entryFailureEvidence(capture,{entry:Number(p.entry_price),peak:state.peakPrice,prior:prior.dynamicTracker?.last_valid_capture});
      tracker.entry_failure=failure;
      if(prior.dynamicTracker?.status==='DATA_DEGRADED'){
        dynamics={...dynamics,event:'TRAJECTORY_RECOVERED',evidenceKey:'RECOVERED:'+capture.end_ms};
        prior={...prior,retryAfter:null,holdUntil:null};
      }
      else if(failure.review)dynamics={...dynamics,event:'ENTRY_FAILURE_MULTI_AXIS',evidenceKey:'ENTRY_FAILURE:'+capture.end_ms};
      else if(!prior.dynamicTracker&&now>=Date.parse(p.entry_at)&&now-Date.parse(p.entry_at)<120000)
        dynamics={...dynamics,event:'POST_FILL_THESIS_REVIEW',evidenceKey:'POST_FILL:'+p.id};
      const btc=capture.trajectory?.at(-1)?.btc_return_1m,hard=Number(exitContext?.hard_floor);
      if(Number.isFinite(btc)&&btc<=-.005)dynamics={...dynamics,event:'BTC_SHOCK',evidenceKey:'BTC_SHOCK:'+capture.end_ms};
      if(hard>0&&bid>hard&&bid/hard-1<=.0025)dynamics={...dynamics,event:'NATIVE_HARD_STOP_PROXIMITY',evidenceKey:'HARD_PROXIMITY:'+capture.end_ms};
    }
    prior={...prior,dynamicsAt:capturedAt,dynamicsObservation:dynamics.observation,dynamicTracker:tracker};
  }
  const answerOf=async key=>{const row=await (pendingRead??store.get(key));if(!row)return null;const r=row.record?.result??{},
      identityOk=row.record?.identity?.position_id===String(p.id)&&row.record?.identity?.generation===generation&&row.record?.purpose==='PRODUCTION'&&
        row.record?.packet?.position?.generation===generation;
    let valid=false;try{valid=r.valid===true&&identityOk&&revalidateArbitration(r,row.record.packet).decision===r.decision;}catch{}
    const reviewedCapture=row.record?.packet?.facts?.capture_context;
    if(valid&&row.record?.packet?.dynamic_policy&&reviewedCapture?.status==='AVAILABLE'&&
      !entryCaptureSafety(reviewedCapture,testHooks?now:Date.now()).ok)valid=false;
    if(valid)return {state:row.state,decision:r.decision,valid:true,authority:'GPT_FINAL_ONLY',
      dynamic_state:row.record?.packet?.dynamic_data_state?.status??null,
      started_at_ms:r.started_at_ms,completed_at_ms:r.completed_at_ms,snapshot_at_ms:r.final_snapshot_at_ms,snapshot_hash:r.arbitration?.final_snapshot_hash??null,
      refresh_error:r.arbitration?.refresh_error??null};
    if(row.state==='DONE'&&identityOk){
      const emergency=await deepseekEmergency(r,{p,packet:row.record.packet,generation,now});
      if(emergency)return {state:row.state,...emergency,refresh_error:null};
    }
    return {state:row.state,decision:r.decision,valid:false,error:r.error,authority:null,completed_at_ms:r.completed_at_ms,
      snapshot_at_ms:r.final_snapshot_at_ms,snapshot_hash:null,refresh_error:r.arbitration?.refresh_error??null};};
  let step;
  try{step=await holdStep(prior,{now,price:bid,peak:state.peakPrice,timeCandidate,softTrigger,dynamics,positionId:p.id,generation,answerOf,clock:testHooks?()=>now:Date.now});}
  catch{return {close:false,reason:'FD1_FINAL_UNAVAILABLE',state:prior};}
  if(!step.start)return step;
  // A review is starting: claim it in the shared journal/ledger, then ask in the background.
  const fail=why=>({close:false,reason:'FD1_FINAL_UNAVAILABLE',
    state:{...step.state,pending:null,retryAfter:now+60000,last:{key:step.start.key,event:step.start.event,decision:why,at:now}}});
  try{
    const config=testHooks?.config??configFromControl(await readReviewControl(db).catch(()=>null),getenv),
      deepseekKey=testHooks?.deepseekKey??getenv('deepseek api'),f=meta.entryFeatures??{},
      position={id:p.id,capturePositionId:p.id,generation,symbol:p.symbol,entryPrice:Number(p.entry_price),
        entryCapture:meta.gptEntryDecision?.initial?.capture_context??meta.finalRecheck?.initial_context?.capture_context,
        finalCapture:meta.finalRecheck?.final?.capture_context??meta.entryDynamicSeed?.capture,
        peakPrice:state.peakPrice,entryAt:Date.parse(p.entry_at),lastHighAt:state.lastHighAt,stopPrice:state.stopPrice,entryFeatures:f},
      emergencyReview=async why=>{
        if(!emergencyEligible(config,deepseekKey))return null;
        const out=await (testHooks?.review??runHoldReview)({apiKey:'',deepseekKey,exitContext,position,dynamicState:prior.dynamicTracker,
          event:step.start.event,timeCandidate,stopStage:state.protectionStage??null});
        // Provider completion occurs after the observation that started this tick.
        const consumedAt=(testHooks?.now??Date.now)();
        const e=await deepseekEmergency(out.result,{p,packet:out.packet,generation,now:consumedAt});
        return e?applyEmergency(step,e,{p,generation,now:consumedAt,bid,state,timeCandidate,softTrigger,dynamics,why}):null;
      };
    if(!authorized(config,apiKey)){
      const emergency=await emergencyReview('GPT_UNAVAILABLE');
      return emergency??fail('NOT_AUTHORIZED');
    }
    const record={version:FD1_HOLD_POLICY_VERSION,kind:'FD1_HOLD',purpose:'PRODUCTION',api_approval_ref:config.approvalRef,
      identity:{signal_id:String(p.signal_id??''),symbol:String(p.symbol).toUpperCase(),position_id:String(p.id),generation,event:step.start.event},
      reserved_usd:0.10,source_commit:FD1_HOLD_POLICY_VERSION,packet:null,result:null};
    let claimed;
    try{claimed=await store.claim(step.start.key,record,config);}
    catch(e){
      if(/API_BUDGET_EXHAUSTED/.test(String(e?.message??e))){
        const emergency=await emergencyReview('GPT_BUDGET_EXHAUSTED');
        if(emergency)return emergency;
        return fail('BUDGET_EXHAUSTED');
      }
      return fail('CLAIM_FAILED');
    }
    if(claimed.created){
      const owner=claimed.row.owner;
      const task=(async()=>{
        // GPT FINAL remains primary. If it is unavailable after the claim, answerOf may consume
        // the already-validated DeepSeek review on the next management observation.
        const out=await (testHooks?.review??runHoldReview)({apiKey,deepseekKey,exitContext,position,dynamicState:prior.dynamicTracker,
          event:step.start.event,timeCandidate,stopStage:state.protectionStage??null});
        await store.complete(step.start.key,owner,{...record,packet:out.packet,result:{...out.result,final_packet:undefined},
          snapshot_at_ms:out.packet?now:null});
      })().catch(e=>console.error('FD1_HOLD_REVIEW_FAILED',p.id,String(e?.message??e).slice(0,200)));
      if(testHooks?.schedule)testHooks.schedule(task);
      else if(globalThis.EdgeRuntime?.waitUntil)EdgeRuntime.waitUntil(task);
    }
    return step;
  }catch{return fail('ADAPTER_ERROR');}
}
/** Authenticated order-free deployed-path check: both providers, claims and completion. */
export async function fd1ExitProbe(db,{symbol,runId,apiKey,fetchFn=fetch}){
  const config=configFromControl(await readReviewControl(db),getenv);
  if(!authorized(config,apiKey))return {ok:false,error:'NOT_AUTHORIZED',orderCalls:0};
  const key=await hash({runId,symbol,v:DUAL_VERSION,kind:'EXIT_PROBE'}),store=new SupabaseReviewStore(db);
  const record={version:HOLD_RELEASE,kind:'FD1_HOLD_PROBE',purpose:'DRYRUN',api_approval_ref:config.approvalRef,
    identity:{symbol,position_id:'fixture:'+runId,event:'SOFT_PROTECTION_TRIGGER:P142_LOCK'},
    reserved_usd:.10,source_commit:HOLD_RELEASE,packet:null,result:null};
  const claim=await store.claim(key,record,config);
  if(!claim.created)return {ok:true,duplicate:true,jobKey:key,orderCalls:0};
  let out;
  try{
    const res=await fetchFn('https://fapi.binance.com/fapi/v1/depth?limit=100&symbol='+encodeURIComponent(symbol),
      {signal:AbortSignal.timeout(2500)});
    if(!res.ok)throw Error('QUOTE_HTTP_'+res.status);const bid=Number((await res.json()).bids?.[0]?.[0]);
    if(!(bid>0))throw Error('QUOTE_INVALID');
    const t=Date.now();
    out=await runHoldReview({apiKey,deepseekKey:getenv('deepseek api'),fetchFn,position:{id:'fixture:'+runId,symbol,entryPrice:bid*.99,peakPrice:bid,
      entryAt:t-50*60000,lastHighAt:t-46*60000,stopPrice:bid*.975,entryFeatures:{}},
      event:record.identity.event,timeCandidate:null,stopStage:'retestAnchor_LOCK',exitContext:{version:'AI_EXIT_AUTHORITY_2',fixture:true,current_price:bid,entry_price:bid*.99,hard_floor:bid*.975,soft_trigger:{active:true,reason:'P142_LOCK',level:bid*1.001},exposure_increase_allowed:false}});
  }catch(e){out={packet:null,result:{valid:false,decision:'ABSTAIN',attempted:false,error:'PROBE_PREP_FAILED:'+String(e?.message??e).slice(0,100),api_cost_usd:0}};}
  await store.complete(key,claim.row.owner,{...record,packet:out.packet,result:{...out.result,final_packet:undefined},
    snapshot_at_ms:out.packet?.position?.valuation?.snapshot_at_ms??null});
  const a=out.result.arbitration;
  return {ok:out.result.valid===true&&a?.deepseek_valid===true,fixture:true,orderCalls:0,release:DUAL_VERSION,
    jobKey:key,gpt:out.result,deepseek:a?.deepseek??null,
    valuation:out.packet?.position?.valuation??null,snapshotHash:a?.snapshot_hash??null,
    identicalPacket:a?.gpt_first_snapshot_hash===a?.deepseek_snapshot_hash};
}
/** ORDER-FREE production probe of both FD1 decisions on live data (no lease, no claim of
 * signals, no order, no position write). Entry: the production FD1 engine on a fixture
 * trigger at the current minute. Hold: a fixture position with a pending TIME exit
 * candidate. Both call the real API once. Journal rows are DRYRUN only. */
export async function fd1Probe(db,{symbol,apiKey,runId,fetchFn=fetch,engine,store=new SupabaseReviewStore(db),simulateEntryTimeout=false}){
  const liveConfig=configFromControl(await readReviewControl(db),getenv);
  if(!authorized(liveConfig,apiKey))return {error:'NOT_AUTHORIZED',orderCalls:0};
  const MIN=60000,trigger=simulateEntryTimeout?Date.now():Math.floor(Date.now()/MIN)*MIN;
  const url='https://fapi.binance.com/fapi/v1/klines?'+new URLSearchParams({symbol,interval:'1m',limit:'2',endTime:String(trigger-1)});
  const r=await fetchFn(url,{signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error('LIVE_KLINES_'+r.status);
  const last=Number((await r.json()).filter(x=>Number(x[6])<trigger).at(-1)?.[4]);if(!(last>0))throw Error('LIVE_PRICE');
  const {FinalReviewCoordinator}=await import('../_shared/gpt-final-review/coordinator.mjs');
  const s={id:'fd1-probe-'+symbol+'-'+trigger+'-'+String(runId).slice(0,20),symbol,status:'NEW',features:{strategy:'LEADER_MOMENTUM_V17',
    referenceClose:last,dayReturn:null,rank:null,v17Setup:{state:'TRIGGERED',triggerAt:trigger},exitPolicy:{}}};
  let injected=false;
  const probeEngine=simulateEntryTimeout?{...engine,async call(packet,options){
    if(!injected){injected=true;return {valid:false,decision:'ABSTAIN',error:'API_TIMEOUT',attempted:false,
      origin:'ORDER_FREE_TIMEOUT_FIXTURE',completed_at_ms:Date.now(),api_cost_usd:0};}
    return engine.call.call(this,packet,options);
  }}:engine;
  const c=new FinalReviewCoordinator({config:{...liveConfig,source:'DRYRUN'},store,apiKey:()=>apiKey,fetchFn,purpose:'DRYRUN',engine:probeEngine,baseline:()=>true});
  const t0=Date.now(),first=await c.consider(s);await c.waitReady();const second=await c.consider(s);
  const row=second.jobKey?await store.get(second.jobKey):null,res=row?.record?.result,pk=row?.record?.packet;
  const entry={fixture:true,triggerAt:trigger,first:first.reason,final:second.reason,decision:second.decision??null,allowed:second.allowed===true,
    elapsedMs:Date.now()-t0,latencyMs:res?.latency_ms??null,costUsd:res?.api_cost_usd??null,error:res?.error??null,
    arbitration:res?.arbitration??null,quality:pk?.facts?.quality??null,sourceErrors:pk?.source_errors??null,answer:res?.answer??null,jobKey:second.jobKey??null,
    timeoutRecovery:row?.record?.timeout_recovery??null,valid:res?.valid===true,
    wouldOrder:second.allowed===true?'NEXT_STEP_IS_EXISTING_ORDER_GUARDS (not executed: probe)':'NO_ORDER'};
  if(simulateEntryTimeout)return {entry,timeoutFixture:true,injected,hold:null};
  const h0=Date.now(),hold=await runHoldReview({apiKey,deepseekKey:getenv('deepseek api'),fetchFn,position:{id:'fd1-probe-position-'+trigger,symbol,entryPrice:last*.99,peakPrice:last*1.01,
    entryAt:Date.now()-50*MIN,lastHighAt:Date.now()-46*MIN,stopPrice:last*.99*.99,entryFeatures:{referenceClose:last*.99}},
    event:'TIME_EXIT_CANDIDATE:V17_MOMENTUM_STALE',timeCandidate:'V17_MOMENTUM_STALE',stopStage:'RISK_CUT'});
  return {entry,hold:{fixture:true,decision:hold.result.decision,valid:hold.result.valid===true,latencyMs:hold.result.latency_ms??null,
    arbitration:hold.result.arbitration??null,costUsd:hold.result.api_cost_usd??null,error:hold.result.error??null,answer:hold.result.answer??null,elapsedMs:Date.now()-h0,
    facts_quality:hold.packet?.facts?.quality??null,consequence:hold.result.decision==='HOLD'&&hold.result.valid?'TIME_EXIT_DEFERRED_15M':hold.result.valid&&hold.result.decision==='EXIT'?'FINAL_STRATEGIC_EXIT':'PROTECTION_RETAINED'}};
}
