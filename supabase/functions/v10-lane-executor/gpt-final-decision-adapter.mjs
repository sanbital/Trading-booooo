import {positionGeneration} from '../_shared/exit-authority.mjs';
import {readCapture} from '../_shared/gpt-final-decision/capture-context.mjs';
import {dynamicsEvent} from '../_shared/gpt-final-decision/trajectory.mjs';
/** Strategic closes require fresh validated GPT FINAL. Existing hard safety executes first. */
import {holdStep,initialHoldState,runHoldReview,TIME_REASONS,FD1_HOLD_POLICY_VERSION,HOLD_POLICY} from '../_shared/gpt-final-decision/hold.mjs';
import {SupabaseReviewStore,readReviewControl} from '../_shared/gpt-final-review/supabase-store.mjs';
import {configFromControl} from '../_shared/gpt-final-review/coordinator.mjs';
import {recordHoldShadow,shadowJobKey,holdShadowEnabled,HOLD_RELEASE} from '../_shared/gpt-final-decision/hold-shadow.mjs';
import {revalidateArbitration,DUAL_VERSION} from '../_shared/gpt-final-decision/dual.mjs';
import {hash} from '../_shared/gpt-final-decision/api.mjs';
export {HOLD_RELEASE,holdShadowEnabled};
export {FD1_HOLD_POLICY_VERSION,TIME_REASONS};
const getenv=n=>globalThis.Deno?.env?.get(n)??'';
let testHooks=null;
export function setFd1HoldTestHooks(h){testHooks=h;}
function authorized(c,apiKey){return c.mode==='ENFORCE'&&c.modeValid!==false&&c.enforceApproved===true&&c.approvalRef.length>0&&
  c.apiBudgetUsd>=0.10&&Number.isInteger(c.maxCalls)&&c.maxCalls>0&&!!apiKey;}
function emergencyEligible(c,deepseekKey){return c?.mode==='ENFORCE'&&c?.modeValid!==false&&c?.enforceApproved===true&&
  typeof c?.approvalRef==='string'&&c.approvalRef.length>0&&!!deepseekKey;}
function deepseekEmergency(result,{p,generation,now}){
  const ds=result?.arbitration?.deepseek,a=ds?.answer,decision=a?.decision_preference;
  if(ds?.valid!==true||!['HOLD','PROTECT','EXIT'].includes(decision)||a?.recommended_action!==decision)return null;
  const completed=Number(ds.completed_at_ms),snapshot=Number(ds.snapshot_at_ms),snapshotHash=String(ds.snapshot_hash??'');
  if(!Number.isSafeInteger(completed)||completed>now||now-completed>HOLD_POLICY.exitMaxAgeMs||
     !Number.isSafeInteger(snapshot)||snapshot>now||now-snapshot>HOLD_POLICY.exitMaxAgeMs||
     !/^[a-f0-9]{64}$/.test(snapshotHash))return null;
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
    s.protectLevel=Math.max(Number(s.protectLevel)||0,Number(softTrigger?.level)||0,bid*(1+HOLD_POLICY.deteriorationDrawdown/2));
    s.protectUntil=now+HOLD_POLICY.protectMs;s.holdUntil=timeCandidate?s.protectUntil:s.holdUntil;
    s.protection={mode:'ELEVATED',sensitivityMultiplier:2,intervalMs:HOLD_POLICY.protectMs,exposureIncrease:false};
    return {close:false,reason:'FD1_DEEPSEEK_PROTECT',fallback:true,state:s};
  }
  if(timeCandidate)s.holdUntil=now+HOLD_POLICY.holdTtlMs;
  return {close:false,reason:'FD1_DEEPSEEK_HOLD',fallback:true,state:s};
}
/**
 * @returns {close:boolean, reason:string|null, fallback?:boolean, state:object, review?:object}
 */
export async function fd1HoldTick(db,p,{meta,state,bid,now,timeCandidate,softTrigger=null,exitContext=null}){
  const store=testHooks?.store??new SupabaseReviewStore(db),apiKey=testHooks?.apiKey??getenv('OPENAI_API_KEY');
  let prior=meta.fd1Hold&&meta.fd1Hold.version===FD1_HOLD_POLICY_VERSION?meta.fd1Hold:
    {...initialHoldState(p.entry_price),...(meta.fd1Hold??{}),version:FD1_HOLD_POLICY_VERSION,pending:null,holdUntil:null};
  const generation=positionGeneration(p);
  if(prior.generation&&prior.generation!==generation)prior=initialHoldState(p.entry_price);
  prior={...prior,generation};
  let dynamics=null;
  if(!prior.pending&&now-(prior.dynamicsAt??0)>=10000){
    const capture=await (testHooks?.capture??readCapture)(p.symbol,now,{positionId:p.id});
    dynamics=dynamicsEvent(capture,prior.dynamicsObservation,!!prior.protectUntil);
    prior={...prior,dynamicsAt:now,dynamicsObservation:dynamics.observation};
  }
  const answerOf=async key=>{const row=await store.get(key);if(!row)return null;const r=row.record?.result??{},
      identityOk=row.record?.identity?.position_id===String(p.id)&&row.record?.identity?.generation===generation&&row.record?.purpose==='PRODUCTION'&&
        row.record?.packet?.position?.generation===generation;
    let valid=false;try{valid=r.valid===true&&identityOk&&revalidateArbitration(r,row.record.packet).decision===r.decision;}catch{}
    if(valid)return {state:row.state,decision:r.decision,valid:true,authority:'GPT_FINAL_ONLY',
      completed_at_ms:r.completed_at_ms,snapshot_at_ms:r.final_snapshot_at_ms,snapshot_hash:r.arbitration?.final_snapshot_hash??null,
      refresh_error:r.arbitration?.refresh_error??null};
    if(row.state==='DONE'&&identityOk){
      const emergency=deepseekEmergency(r,{p,generation,now});
      if(emergency)return {state:row.state,...emergency,refresh_error:null};
    }
    return {state:row.state,decision:r.decision,valid:false,authority:null,completed_at_ms:r.completed_at_ms,
      snapshot_at_ms:r.final_snapshot_at_ms,snapshot_hash:null,refresh_error:r.arbitration?.refresh_error??null};};
  let step;
  try{step=await holdStep(prior,{now,price:bid,peak:state.peakPrice,timeCandidate,softTrigger,dynamics,positionId:p.id,generation,answerOf});}
  catch{return {close:false,reason:'FD1_FINAL_UNAVAILABLE',state:prior};}
  if(!step.start)return step;
  // A review is starting: claim it in the shared journal/ledger, then ask in the background.
  const fail=why=>({close:false,reason:'FD1_FINAL_UNAVAILABLE',
    state:{...step.state,pending:null,retryAfter:now+60000,last:{key:step.start.key,event:step.start.event,decision:why,at:now}}});
  try{
    const config=testHooks?.config??configFromControl(await readReviewControl(db).catch(()=>null),getenv),
      deepseekKey=testHooks?.deepseekKey??getenv('deepseek api'),f=meta.entryFeatures??{},
      position={id:p.id,capturePositionId:p.id,generation,symbol:p.symbol,entryPrice:Number(p.entry_price),
        peakPrice:state.peakPrice,entryAt:Date.parse(p.entry_at),lastHighAt:state.lastHighAt,stopPrice:state.stopPrice,entryFeatures:f},
      emergencyReview=async why=>{
        if(!emergencyEligible(config,deepseekKey))return null;
        const out=await (testHooks?.review??runHoldReview)({apiKey:'',deepseekKey,exitContext,position,
          event:step.start.event,timeCandidate,stopStage:state.protectionStage??null});
        const e=deepseekEmergency(out.result,{p,generation,now});
        return e?applyEmergency(step,e,{p,generation,now,bid,state,timeCandidate,softTrigger,dynamics,why}):null;
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
        const out=await (testHooks?.review??runHoldReview)({apiKey,deepseekKey,exitContext,position,
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
    const res=await fetchFn('https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol='+encodeURIComponent(symbol),
      {signal:AbortSignal.timeout(2500)});
    if(!res.ok)throw Error('QUOTE_HTTP');const bid=Number((await res.json()).bidPrice);
    if(!(bid>0))throw Error('QUOTE_INVALID');
    const t=Date.now();
    out=await runHoldReview({apiKey,deepseekKey:getenv('deepseek api'),fetchFn,position:{id:'fixture:'+runId,symbol,entryPrice:bid*.99,peakPrice:bid,
      entryAt:t-50*60000,lastHighAt:t-46*60000,stopPrice:bid*.975,entryFeatures:{}},
      event:record.identity.event,timeCandidate:null,stopStage:'retestAnchor_LOCK',exitContext:{version:'AI_EXIT_AUTHORITY_2',fixture:true,current_price:bid,entry_price:bid*.99,hard_floor:bid*.975,soft_trigger:{active:true,reason:'P142_LOCK',level:bid*1.001},exposure_increase_allowed:false}});
  }catch{out={packet:null,result:{valid:false,decision:'ABSTAIN',attempted:false,error:'PROBE_PREP_FAILED',api_cost_usd:0}};}
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
export async function fd1Probe(db,{symbol,apiKey,runId,fetchFn=fetch,engine,store=new SupabaseReviewStore(db)}){
  const MIN=60000,trigger=Math.floor(Date.now()/MIN)*MIN;
  const url='https://fapi.binance.com/fapi/v1/klines?'+new URLSearchParams({symbol,interval:'1m',limit:'2',endTime:String(trigger-1)});
  const r=await fetchFn(url,{signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error('LIVE_KLINES_'+r.status);
  const last=Number((await r.json()).filter(x=>Number(x[6])<trigger).at(-1)?.[4]);if(!(last>0))throw Error('LIVE_PRICE');
  const {FinalReviewCoordinator}=await import('../_shared/gpt-final-review/coordinator.mjs');
  const s={id:'fd1-probe-'+symbol+'-'+trigger+'-'+String(runId).slice(0,20),symbol,status:'NEW',features:{strategy:'LEADER_MOMENTUM_V17',
    referenceClose:last,dayReturn:null,rank:null,v17Setup:{state:'TRIGGERED',triggerAt:trigger},exitPolicy:{}}};
  const c=new FinalReviewCoordinator({config:{mode:'ENFORCE',modeValid:true,approvalRef:'FD1_PROBE:'+String(runId).slice(0,50),apiBudgetUsd:1.5,
    maxCalls:150,enforceApproved:true,source:'DRYRUN'},store,apiKey:()=>apiKey,fetchFn,purpose:'DRYRUN',engine,baseline:()=>true});
  const t0=Date.now(),first=await c.consider(s);await Promise.all([...c.pending.values()]);const second=await c.consider(s);
  const row=second.jobKey?await store.get(second.jobKey):null,res=row?.record?.result,pk=row?.record?.packet;
  const entry={fixture:true,triggerAt:trigger,first:first.reason,final:second.reason,decision:second.decision??null,allowed:second.allowed===true,
    elapsedMs:Date.now()-t0,latencyMs:res?.latency_ms??null,costUsd:res?.api_cost_usd??null,error:res?.error??null,
    arbitration:res?.arbitration??null,quality:pk?.facts?.quality??null,sourceErrors:pk?.source_errors??null,answer:res?.answer??null,jobKey:second.jobKey??null,
    wouldOrder:second.allowed===true?'NEXT_STEP_IS_EXISTING_ORDER_GUARDS (not executed: probe)':'NO_ORDER'};
  const h0=Date.now(),hold=await runHoldReview({apiKey,deepseekKey:getenv('deepseek api'),fetchFn,position:{id:'fd1-probe-position-'+trigger,symbol,entryPrice:last*.99,peakPrice:last*1.01,
    entryAt:Date.now()-50*MIN,lastHighAt:Date.now()-46*MIN,stopPrice:last*.99*.99,entryFeatures:{referenceClose:last*.99}},
    event:'TIME_EXIT_CANDIDATE:V17_MOMENTUM_STALE',timeCandidate:'V17_MOMENTUM_STALE',stopStage:'RISK_CUT'});
  return {entry,hold:{fixture:true,decision:hold.result.decision,valid:hold.result.valid===true,latencyMs:hold.result.latency_ms??null,
    arbitration:hold.result.arbitration??null,costUsd:hold.result.api_cost_usd??null,error:hold.result.error??null,answer:hold.result.answer??null,elapsedMs:Date.now()-h0,
    facts_quality:hold.packet?.facts?.quality??null,consequence:hold.result.decision==='HOLD'&&hold.result.valid?'TIME_EXIT_DEFERRED_15M':hold.result.valid&&hold.result.decision==='EXIT'?'FINAL_STRATEGIC_EXIT':'PROTECTION_RETAINED'}};
}
