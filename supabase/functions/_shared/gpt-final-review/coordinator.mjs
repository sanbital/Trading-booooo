import {clockCaptureValid} from '../leader20/clock.mjs';
import {clockTicketCheck} from '../leader20/clock-final.mjs';
import {wireSchema,parseApiResponseWire} from './wire-v4.mjs';
import {VERSION,MODEL,LIMITS,OUTPUT_SCHEMA,canonical,hash,baselineAllowed,decisionIdentity,triggerExpiry,validateAnswer,ensure} from './contract.mjs';
import {clockAuthorityDeadline} from '../leader20/campaign.mjs';
/** A clock window with no derivable deadline is already expired, never open-ended. */
const clockDeadlineOf=w=>clockAuthorityDeadline(w)??-Infinity;
import {promptFor} from './prompt.mjs';
import {collectMarket,buildPacket,packetHash} from './market.mjs';
import {callFinalReviewer,DEFAULT_PROFILE,profileOf} from './openai.mjs';
import {initialContext} from '../gpt-final-decision/recheck.mjs';
import {DYNAMIC_POLICY,entryCaptureSafety} from '../gpt-final-decision/dynamic-flow.mjs';
import {TIMEOUT_RECOVERY,canRecoverTimeout,isReviewRecoverable,reviewedCaptureEnd} from '../gpt-final-decision/timeout-recovery.mjs';
export const MAX_RESERVED_USD=.10; // Conservative per-call reservation; settled to documented token cost after the call.
/** (2026-09-25) An engine with agedRecheck lets a stored BUY that outlived its own answer
 * validity reach the order path while at least this long remains before the trigger's
 * execution reserve: enough for E1 (~3 s) and one forced GPT FINAL RECHECK (fresh read
 * 1.5 s + request <=4 s). The aged answer itself can never dispatch (see check()). */
export const AGED_RECHECK_MIN_MS=8000;
/** Human-readable release label stored with every review (source_commit column). */
export const RELEASE='gpt-final-review-v8-recovery-audit-20260927';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const MODES=['OFF','SHADOW','ENFORCE'];
function freezeTicket(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(freezeTicket);Object.freeze(value);}return value;}
/** Legacy env-only configuration (tests and emergency override). */
export function configFromEnv(get){
  const requested=String(get('GPT_FINAL_REVIEW_MODE')||'OFF').toUpperCase();
  const mode=MODES.includes(requested)?requested:'ENFORCE';
  return Object.freeze({mode,modeValid:MODES.includes(requested),
    approvalRef:String(get('GPT_FINAL_REVIEW_API_APPROVAL')||''),apiBudgetUsd:Number(get('GPT_FINAL_REVIEW_DAILY_BUDGET_USD')||0),
    maxCalls:Number(get('GPT_FINAL_REVIEW_MAX_CALLS_PER_DAY')||0),
    enforceApproved:get('GPT_FINAL_REVIEW_ENFORCE_APPROVED')==='true',source:'ENV'});
}
/** Production configuration: the gpt_final_review_control row is the authority.
 * GPT_FINAL_REVIEW_MODE=OFF in the function environment is an emergency kill that
 * restores the existing model path regardless of the row. An unreadable row fails
 * closed for candidates (ENFORCE without authorization => candidate ABSTAIN). */
export function configFromControl(row,get=()=>''){
  if(String(get('GPT_FINAL_REVIEW_MODE')||'').toUpperCase()==='OFF')
    return Object.freeze({mode:'OFF',modeValid:true,approvalRef:'',apiBudgetUsd:0,maxCalls:0,enforceApproved:false,source:'ENV_KILL'});
  if(!row||typeof row!=='object')
    return Object.freeze({mode:'ENFORCE',modeValid:false,approvalRef:'',apiBudgetUsd:0,maxCalls:0,enforceApproved:false,source:'CONTROL_UNREADABLE'});
  const mode=String(row.mode??'').toUpperCase();
  return Object.freeze({mode:MODES.includes(mode)?mode:'ENFORCE',modeValid:MODES.includes(mode),
    approvalRef:String(row.approval_ref??''),apiBudgetUsd:Number(row.daily_cap_usd??0),maxCalls:Number(row.max_calls_per_day??0),
    enforceApproved:row.enforce_approved===true,source:'DB_CONTROL'});
}
/** Test-only store; the executor uses the durable Supabase store, never this one. */
export class MemoryReviewStore {
  rows=new Map();reserved=0;calls=0;
  async claim(key,record,config){
    if(this.rows.has(key))return {created:false,row:structuredClone(this.rows.get(key))};
    ensure(this.calls<config.maxCalls&&this.reserved+MAX_RESERVED_USD<=config.apiBudgetUsd,'API_BUDGET_EXHAUSTED');
    this.calls++;this.reserved+=MAX_RESERVED_USD;
    const row={key,owner:crypto.randomUUID(),state:'RUNNING',record:structuredClone(record)};this.rows.set(key,row);
    return {created:true,row:structuredClone(row)};
  }
  async get(key){return structuredClone(this.rows.get(key)??null);}
  async snapshot(key,owner,record){const old=this.rows.get(key);ensure(old?.owner===owner&&old.state==='RUNNING','REVIEW_SNAPSHOT_CAS');
    this.rows.set(key,{...old,record:structuredClone(record)});return true;}
  async complete(key,owner,record){const old=this.rows.get(key);ensure(old?.owner===owner&&old.state==='RUNNING','REVIEW_RESULT_CAS');
    this.rows.set(key,{...old,state:'DONE',record:structuredClone(record)});return true;}
}
export class FinalReviewCoordinator {
  // Process-local capabilities: never serialized, recovered, or shared with another cycle.
  retryLifecycles=new WeakMap();
  executionStarts=new Set();
  beginExecution(s,{supersededBy=null}={}){
    const check=this.check(s,{supersededBy});
    if(!check.allowed)return null;
    const executionKey=String(s.id)+':'+check.review?.snapshotHash;
    if(check.review?.clockFinalAuthority&&this.executionStarts.has(executionKey))return null;
    const token=Object.freeze({});
    this.retryLifecycles.set(token,{ticket:check.review,signal:s,startedAt:this.now(),deadline:null,used:false});
    if(check.review?.clockFinalAuthority)this.executionStarts.add(executionKey);
    return token;
  }
  confirmFirstFinality(token,{orderId,confirmedAt,quantity}){
    const life=this.retryLifecycles.get(token),at=Date.parse(confirmedAt);
    if(!life||life.deadline!==null||!orderId||!Number.isFinite(at)||at<life.startedAt||at>this.now()||
      !Number.isFinite(quantity)||quantity<0)return false;
    life.deadline=at+15000;life.firstOrderId=orderId;life.targetQuantity=quantity;
    return true;
  }
  consumeRetry(token){const life=this.retryLifecycles.get(token);if(!life||life.used||this.now()>=life.deadline)return false;life.used=true;return true;}
  constructor({config,store,apiKey=()=>'',fetchFn=fetch,market=collectMarket,now=Date.now,schedule=p=>{p.catch(()=>{});},
    profile=DEFAULT_PROFILE,purpose='PRODUCTION',baseline=baselineAllowed,expiry=triggerExpiry,engine=null,
    onResolved=async()=>{},onDurableAllowed=async()=>{}}){
    this.config=config;this.store=store;this.apiKey=apiKey;this.fetchFn=fetchFn;this.market=market;this.now=now;this.schedule=schedule;
    this.baseline=baseline;this.expiry=expiry;this.engine=engine;this.identity=engine?.identity??decisionIdentity;
    this.onResolved=onResolved;this.onDurableAllowed=onDurableAllowed;this.waitOutcomes=[];
    // An engine (FD1 final decision) replaces the question and answer contract; the durable
    // claim/ledger/TTL/ticket machinery below is identical for every engine.
    this.profile=engine?engine.id:profile;this.purpose=purpose;const wire=engine?null:profileOf(profile).wire,promptText=engine?engine.promptText:promptFor(profileOf(profile).prompt??wire);
    this.tickets=new Map();this.tracked=new Map();this.pending=new Map();this.readyHints=new Map();this.clockWakeAt=new Map();this.yieldArmed=false;this.followUpUntil=0;
    this.promptHash=hash(promptText);this.schemaHash=hash(engine?engine.schema:wireSchema(wire));
    // purpose is bound so PRODUCTION, DRYRUN and VERIFICATION reviews of one candidate never share a row.
    this.binding=engine?hash({version:VERSION,engine:engine.id,model:engine.model,prompt:promptText,schema:engine.schema,limits:LIMITS,purpose}):
      hash({version:VERSION,model:MODEL,prompt:promptText,schema:OUTPUT_SCHEMA,wireSchema:wireSchema(wire),limits:LIMITS,profile:profileOf(profile),purpose});
  }
  setConfig(config){this.config=config;}
  allowDecision(){return this.engine?this.engine.allow:'PASS';}
  reviewValidUntil(packet,snapshotAt,expires){
    const ordinary=Math.min(expires-LIMITS.executionReserveMs,snapshotAt+LIMITS.reviewMaxAgeMs);
    return this.engine?.reviewValidUntil?.(packet,{snapshotAt,expires,ordinary})??ordinary;
  }
  authorized(){const c=this.config;return c.modeValid!==false&&c.approvalRef.length>0&&c.apiBudgetUsd>=MAX_RESERVED_USD&&
    Number.isInteger(c.maxCalls)&&c.maxCalls>0&&!!this.apiKey()&&(c.mode!=='ENFORCE'||c.enforceApproved===true);}
  async consider(s,{completedOnly=false}={}){
    if(this.config.mode==='OFF')return {allowed:true,reason:'OFF'};
    const shadow=this.config.mode==='SHADOW';
    // A failed re-read must not leave an earlier PASS ticket usable.
    this.tickets.delete(String(s?.id));
    for(const [k,h] of this.readyHints)if(h.signalId===String(s?.id))this.readyHints.delete(k);
    const deny=reason=>({allowed:shadow,reason,decision:'ABSTAIN',scope:'CANDIDATE'});
    if(!this.baseline(s))return deny('BASELINE_REJECT_OR_INVALID');
    if(!this.authorized())return deny(this.config.source==='CONTROL_UNREADABLE'?'GPT_CONTROL_UNREADABLE':'GPT_REVIEW_NOT_CONFIGURED_OR_APPROVED');
    // expiry() is already bounded by the derived slot deadline for clock entries; a null or
    // NaN expiry coerces to an immediate refusal rather than an open window.
    const now=this.now(),expires=this.expiry(s);
    if(!(Number.isFinite(expires))||now>=expires-(s?.features?.leader20?.entry_window?0:LIMITS.executionReserveMs))
      return deny(s?.features?.leader20?.entry_window?'CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION':'GPT_TRIGGER_EXPIRED');
    let key;
    try{
      const identity=this.identity(s),identityJson=canonical(identity),binding=await this.binding;
      key=await hash({binding,identity});this.tracked.set(key,{identityJson,s:structuredClone(s),expires});
      let row=await this.store.get(key);
      // Follow durable child keys across cycles/processes. A timeout has no opinion;
      // retain its evidence and reserve/pay separately for a fresh attempt.
      let recovery=null,waits=0,attempt=1,afterEnd=null;
      while(row?.state==='DONE'){
        const timedOut=this.engine?.timeoutRecovery===true&&isReviewRecoverable(row.record?.result);
        if(!timedOut&&row.record?.result?.decision!=='WAIT')break;
        // Campaigns own their next observation event and cost pacing. A completed
        // WAIT must not silently enter the legacy seconds-long retry chain.
        if(!timedOut&&this.engine?.reobserveWait?.(identity)===false)break;
        if(row.record.binding!==binding||row.record.identity_json!==identityJson)return deny('GPT_BINDING_MISMATCH');
        const completed=row.record.result.completed_at_ms;
        const childKey=await hash({binding,identity,...(timedOut?{timeout_after:key}:{wait_after:key})}),child=await this.store.get(childKey);
        if(timedOut){
          if(!Number.isSafeInteger(completed)||completed>this.now()||
            !child&&!canRecoverTimeout(row.record.result,{now:this.now(),deadline:expires-LIMITS.executionReserveMs,attempt}))
            return {...deny('GPT_REVIEW_RECOVERY_EXHAUSTED'),jobKey:key,error:row.record.result.error,storedDecision:'WAIT'};
        }else{
          const validTime=Number.isSafeInteger(completed)&&completed<=this.now();
          const room=waits<DYNAMIC_POLICY.maxWaitReviews&&(!this.engine?.timeoutRecovery||
            attempt<TIMEOUT_RECOVERY.maxAttempts&&expires-LIMITS.executionReserveMs-this.now()>=TIMEOUT_RECOVERY.minRemainingMs);
          if(!validTime||!child&&(!room||this.now()-completed<DYNAMIC_POLICY.missingRetryMs))
            return {allowed:false,decision:'WAIT',storedDecision:'WAIT',reason:'GPT_WAIT_REOBSERVE',scope:'CANDIDATE',jobKey:key,
              reviewRetryPending:validTime&&room};
        }
        if(!timedOut)waits++;
        attempt++;
        const end=reviewedCaptureEnd(row.record);
        if(end!==null)afterEnd=afterEnd===null?end:Math.max(afterEnd,end);
        recovery=timedOut?{version:TIMEOUT_RECOVERY.version,attempt,parent_job_key:key,
          previous_error:row.record.result.error,after_end_ms:afterEnd}:null;
        const parent=key;
        key=childKey;
        this.tracked.delete(parent);this.readyHints.delete(parent);
        this.tracked.set(key,{identityJson,s:structuredClone(s),expires});
        row=child;
      }
      if(!row){
        // Queue refresh may consume a durable completed answer, but must never
        // acquire data, claim a review, reserve spend or dispatch a provider.
        if(completedOnly)return deny('GPT_REVIEW_PENDING');
        const record={version:VERSION,binding,identity,identity_json:identityJson,expires_at_ms:expires,
          reserved_usd:MAX_RESERVED_USD,api_approval_ref:this.config.approvalRef,purpose:this.purpose,wire_profile:this.profile,
          prompt_hash:await this.promptHash,schema_hash:await this.schemaHash,source_commit:RELEASE,packet:null,result:null,
          ...(this.engine?.timeoutRecovery?{review_attempt:attempt,after_capture_end_ms:afterEnd}:{}),
          ...(recovery?{timeout_recovery:recovery}:{})};
        if(this.store.deferClaimUntilPrepared===true){
          // Acquisition runs outside the trading lease and before a durable RUNNING
          // claim. A killed worker during the 24-bucket wait leaves no orphan job.
          if(!this.pending.has(key)){
            const task=this.work(key,null,record,{deferredClaim:true}).catch(()=>false).finally(()=>this.pending.delete(key));
            this.pending.set(key,task);this.schedule(task);
          }
          return deny('GPT_REVIEW_PENDING');
        }
        let claimed;
        try{claimed=await this.store.claim(key,record,this.config);}
        catch(e){if(/API_BUDGET_EXHAUSTED/.test(String(e?.message??e))){
          this.tracked.delete(key);
          if(recovery)this.tracked.set(recovery.parent_job_key,{identityJson,s:structuredClone(s),expires});
          return deny('GPT_API_BUDGET_EXHAUSTED');
        }throw e;}
        row=claimed.row;
        if(claimed.created){
          const task=this.work(key,row.owner,record).catch(()=>false).finally(()=>this.pending.delete(key));
          this.pending.set(key,task);this.schedule(task);
        }
      }
      // RUNNING rows are never re-called: an uncertain request stays pending until TTL.
      if(row.state!=='DONE')return deny('GPT_REVIEW_PENDING');
      const checked=await this.validateStored(row,identityJson,expires,binding);
      if(checked.valid)this.tickets.set(String(s.id),checked.ticket);
      // storedDecision: the recorded answer's own decision, for lifecycle labels only (never admission).
      const stored=row.record?.result?.decision;
      return {allowed:shadow||checked.allowed,reason:checked.reason,decision:checked.decision,scope:'CANDIDATE',jobKey:key,
        gptAttempted:typeof row.record?.result?.attempted==='boolean'?row.record.result.attempted:null,
        ...(['BUY','WAIT','SKIP','ABSTAIN'].includes(stored)?{storedDecision:stored}:{}),
        ...(checked.aged?{aged:true}:{}),...(checked.detail?{detail:checked.detail}:{}),
        ...(!checked.valid&&row.record?.result?.error?{error:String(row.record.result.error).slice(0,80)}:{})};
    }catch{return deny('GPT_REVIEW_STORAGE_OR_VALIDATION_ERROR');}
  }
  async work(key,owner,record,{deferredClaim=false}={}){
    let preparationStage='TRANSPORT';
    try{
      let fetchFn=this.fetchFn;
      const deadlineMs=record.expires_at_ms-LIMITS.executionReserveMs;
      ensure(this.now()<deadlineMs,'REVIEW_TRIGGER_EXPIRED');
      let captured;
      preparationStage='CAPTURE';
      if(this.engine){const prep=await this.engine.prepare(record.identity,{fetchFn:this.fetchFn,now:this.now,deadlineMs,
        afterEndMs:record.after_capture_end_ms??record.timeout_recovery?.after_end_ms??-Infinity});record.packet=prep.packet;captured=prep.captured;}
      else{const current=await this.market(record.identity,{fetchFn:this.fetchFn,now:this.now,deadlineMs});
        captured=this.now();record.packet=await buildPacket(record.identity,current,captured);}
      record.snapshot_at_ms=captured;
      record.valid_until_ms=this.reviewValidUntil(record.packet,captured,record.expires_at_ms);
      const capture=record.packet?.facts?.capture_context,afterEnd=record.after_capture_end_ms??record.timeout_recovery?.after_end_ms;
      ensure(capture?.reason!=='INFERENCE_CAPTURE_NOT_READY','DYNAMIC_INFERENCE_CAPTURE_NOT_READY');
      if(afterEnd!=null)ensure(clockCaptureValid(capture,this.now())||capture?.end_ms>afterEnd,'RETRY_CAPTURE_NOT_ADVANCED');
      if(this.engine?.timeoutRecovery)ensure(entryCaptureSafety(capture,this.now()).ok,'DYNAMIC_TRAJECTORY_STALE_OR_FUTURE');
      if(deferredClaim){
        const claimed=await this.store.claim(key,record,this.config);
        if(!claimed.created)return false;
        owner=claimed.row.owner;
      }
      // Snapshot persistence before the paid request; failures cannot lead to an unrecorded PASS.
      preparationStage='SNAPSHOT';
      if(this.store.snapshot)await this.store.snapshot(key,owner,record);
      preparationStage='DEADLINE';
      ensure(this.now()<record.valid_until_ms,'REVIEW_TRIGGER_EXPIRED');
      const analysisDeadline=this.engine?.analysisDeadline?this.engine.analysisDeadline(record.packet,
        {now:this.now(),executionDeadline:deadlineMs,ordinaryDeadline:record.valid_until_ms}):record.valid_until_ms;
      ensure(Number.isFinite(analysisDeadline)&&analysisDeadline>this.now(),'REVIEW_RECHECK_ROOM_REQUIRED');
      record.analysis_deadline_ms=analysisDeadline;
      // Preflight is outside the lease: recheck its immutable evidence immediately
      // before the provider transport. No aged preflight packet may reach GPT.
      if(this.engine?.timeoutRecovery)ensure(entryCaptureSafety(capture,this.now()).ok,'DYNAMIC_TRAJECTORY_STALE_OR_FUTURE');
      fetchFn=this.store.transport?await this.store.transport(key,record,this.fetchFn):this.fetchFn;
      preparationStage='MODEL';
      record.result=this.engine?await this.engine.call(record.packet,{apiKey:this.apiKey(),fetchFn,now:this.now,deadlineMs:analysisDeadline,identity:record.identity}):
        await callFinalReviewer(record.packet,{apiKey:this.apiKey(),fetchFn,now:this.now,
        deadlineMs:record.valid_until_ms,profile:this.profile});
      if(this.engine&&record.result.final_packet){
        record.packet=record.result.final_packet;
        record.snapshot_at_ms=record.result.final_snapshot_at_ms;
        record.valid_until_ms=this.reviewValidUntil(record.packet,record.snapshot_at_ms,record.expires_at_ms);
      }
      // DURABLE DECISION BOUNDARY: persist the exact final packet + provider-derived result
      // while RUNNING, before terminal CAS. Recovery can promote this immutable snapshot
      // without another paid provider call.
      preparationStage='RESULT_SNAPSHOT';
      if(this.store.snapshot)try{await this.store.snapshot(key,owner,record);}
      catch(e){
        // Do not replace a valid paid provider decision with LOCAL_DATA_ERROR merely
        // because the pre-CAS durability checkpoint had a transient write failure.
        // complete() gets its own bounded CAS retries; if that also fails the journal
        // remains fail-closed and the provider ledger still records the physical call.
        record.result={...record.result,durability_snapshot_error:'REVIEW_RESULT_SNAPSHOT_FAILED'};
      }
    }catch(e){
      const error=['RETRY_CAPTURE_NOT_ADVANCED','DYNAMIC_INFERENCE_CAPTURE_NOT_READY','DYNAMIC_TRAJECTORY_STALE_OR_FUTURE',
        'REVIEW_TRIGGER_EXPIRED','REVIEW_RECHECK_ROOM_REQUIRED'].includes(e?.message)?e.message:'REVIEW_PREPARATION_FAILED';
      record.result={origin:'LOCAL_DATA_ERROR',valid:false,decision:'ABSTAIN',error,
        preparation_stage:preparationStage,preparation_error_code:/^[A-Z][A-Z0-9_]{1,100}$/.test(e?.message??'')?e.message:(e?.name??'Error'),
        attempted:false,api_cost_usd:0,completed_at_ms:this.now(),model_requested:MODEL,wire_profile:this.profile};
    }
    if(deferredClaim&&!owner){
      // Persist a short-lived, no-provider diagnostic, unless another worker has
      // already claimed this identity. There is no API transport in this branch.
      if(this.now()>=record.expires_at_ms-LIMITS.executionReserveMs)return false;
      const claimed=await this.store.claim(key,record,this.config).catch(()=>null);
      if(!claimed?.created)return false;
      owner=claimed.row.owner;
    }
    await this.store.complete(key,owner,record);
    if(this.engine?.timeoutRecovery===true&&canRecoverTimeout(record.result,{now:this.now(),
      deadline:record.expires_at_ms-LIMITS.executionReserveMs,attempt:record.review_attempt??record.timeout_recovery?.attempt??1})){
      const tracked=this.tracked.get(key);
      if(tracked)await this.consider(tracked.s); // schedules outside the trading lease; durable CAS prevents duplicates
      return false;
    }
    // Mark ready only after durable save and complete raw-response validation.
    // This hint can shorten observation waiting, but a new lease cycle still
    // rereads and validates the journal before it creates an entry ticket.
    const checked=await this.validateStored({record},record.identity_json,record.expires_at_ms,record.binding).catch(()=>null);
    if(checked?.valid){
      this.tickets.set(String(record.identity.signal_id),checked.ticket);
      if(checked.allowed&&!checked.aged)this.readyHints.set(key,{signalId:record.identity.signal_id,validUntil:checked.ticket.validUntil,
        clock:!!checked.ticket.clockFinalAuthority});
    }
    // Clock BUY fast path: the DB row and outbox trigger are already committed. Hand the
    // durable signal to the caller immediately instead of waiting for all sibling reviews
    // or for pg_net delivery. The callback is only a latency optimization; the durable
    // outbox + sweeper remain the crash/restart fallback.
    if(checked?.allowed&&!checked.aged&&checked.ticket?.clockFinalAuthority){
      const tracked=this.tracked.get(key),review={signalId:record.identity.signal_id,jobKey:key,allowed:true,
        decision:checked.decision,reason:checked.reason,storedDecision:record.result?.decision??null};
      if(tracked?.s)this.schedule(this.onDurableAllowed(tracked.s,review)
        .catch(()=>console.error('GPT_DURABLE_ALLOWED_WAKE_FAILED',record.identity.signal_id)));
    }
    return record.result?.valid===true;
  }
  async validateStored(row,identityJson,expires,binding){
    const r=row.record,z=r?.result,now=this.now();
    const deny=reason=>({valid:false,allowed:false,decision:'ABSTAIN',reason});
    if(r?.version!==VERSION||r.binding!==binding||r.identity_json!==identityJson||r.expires_at_ms!==expires)return deny('GPT_BINDING_MISMATCH');
    if(!r.packet||await (this.engine?this.engine.packetHash(r.packet):packetHash(r.packet))!==r.packet.snapshot_hash)return deny('GPT_SNAPSHOT_MISMATCH');
    if(!Number.isSafeInteger(r.snapshot_at_ms)||r.snapshot_at_ms>now||r.snapshot_at_ms<r.identity.trigger_at_ms||
      r.packet.as_of_offset_ms!==r.snapshot_at_ms-r.identity.trigger_at_ms)return deny('GPT_SNAPSHOT_TIME_INVALID');
    if(!Number.isSafeInteger(z?.completed_at_ms)||z.completed_at_ms>now||z.completed_at_ms<r.snapshot_at_ms||
      !Number.isSafeInteger(r.valid_until_ms)||r.valid_until_ms!==this.reviewValidUntil(r.packet,r.snapshot_at_ms,expires))
      return deny('GPT_STALE_OR_FUTURE_REVIEW');
    // The stored packet's own expires_at_ms is evidence, not authority: the deadline is derived
    // from the slot, so a record written with a looser TTL cannot outlive its clock window.
    if(r.packet.leader20?.entry_window&&now>=clockDeadlineOf(r.packet.leader20.entry_window))
      return deny('CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION');
    // Past its own validity the answer is AGED. Without an agedRecheck engine, or too close to
    // the trigger expiry for a recheck, that is the same refusal as before.
    const aged=now>=r.valid_until_ms||z.completed_at_ms>=r.valid_until_ms;
    if(aged&&(this.engine?.agedRecheck!==true||now>=expires-LIMITS.executionReserveMs-AGED_RECHECK_MIN_MS))
      return deny('GPT_STALE_OR_FUTURE_REVIEW');
    const model=this.engine?this.engine.model:MODEL;
    if(z.origin!=='OPENAI_API'||!z.valid||!z.raw_response||z.model_requested!==model||z.raw_response.model!==model||!z.request_id||
      z.wire_profile!==this.profile)
      return deny('GPT_NO_VALID_API_RESPONSE');
    const answer=this.engine?this.engine.revalidate(z,r.packet):validateAnswer(parseApiResponseWire(z.raw_response,r.packet,profileOf(this.profile).wire),r.packet);
    const clockAuthority=this.engine?.clockFinalAuthority?.(r.packet,z,r.identity);
    if(answer.decision==='BUY'&&this.engine?.clockFinalAuthority&&r.packet.leader20?.entry_window&&!clockAuthority)
      return deny('CLOCK_FINAL_AUTHORITY_INVALID');
    const ticket={identityJson,decision:answer.decision,validUntil:r.valid_until_ms,expires,
      candidateId:r.packet.candidate_id,snapshotHash:r.packet.snapshot_hash,model,summary:answer.summary,
      // FINAL RECHECK: what this decision was based on (initial facts, book reference, support).
      ...(this.engine?{initial:initialContext(r,answer)}:{}),...(aged?{aged:true}:{}),
      ...(clockAuthority?{clockFinalAuthority:clockAuthority}:{}),
      ...(this.engine?.requiresFinalRecheck?.(r.packet,z,r.identity)?{requiresFinalRecheck:true}:{})};
    if(clockAuthority)freezeTicket(ticket);
    // detail: the stored answer's own reason (SKIP categories / ABSTAIN reason) for the journal.
    const detail=answer.decision==='SKIP'?(answer.reasons??[]).map(x=>x.category).join(','):
      answer.decision==='ABSTAIN'?String(answer.abstain_reason??''):'';
    return {valid:true,allowed:answer.decision===this.allowDecision(),decision:answer.decision,
      reason:'GPT_'+answer.decision+(aged?'_AGED':''),ticket,...(aged?{aged:true}:{}),...(detail?{detail}:{})};
  }
  /** Pure, no I/O. Run again immediately before intent creation.
   * allowAged admits an AGED BUY ticket at the order path's entry only: nothing is dispatched
   * on it, because every later check (no allowAged) refuses it until a GPT FINAL RECHECK BUY
   * supersedes the aged answer (supersededBy). */
  check(s,{supersededBy=null,retryAuthority=null,allowAged=false}={}){
    if(this.config.mode==='OFF'||this.config.mode==='SHADOW')return {allowed:true,reason:this.config.mode};
    if(!this.authorized())return {allowed:false,reason:'GPT_REVIEW_NOT_APPROVED'};
    const t=this.tickets.get(String(s?.id)),now=this.now();
    if(!this.baseline(s)||!t||t.identityJson!==canonical(this.identity(s)))return {allowed:false,reason:'GPT_REVIEW_IDENTITY_CHANGED'};
    if(t.clockFinalAuthority){const clock=clockTicketCheck(t,this.identity(s),now);if(!clock.ok)return {allowed:false,reason:clock.reason};}
    // A FINAL RECHECK answer supersedes the initial answer's age limit only; the trigger
    // expiry, identity and baseline above/below still bind. Its own validity is checked by the caller.
    const life=retryAuthority&&this.retryLifecycles.get(retryAuthority);
    if(retryAuthority&&(!life||life.signal!==s||life.ticket!==t||life.used||life.deadline===null||now>=life.deadline))
      return {allowed:false,reason:'IOC_RETRY_AUTHORITY_EXPIRED_OR_INVALID'};
    if(t.requiresFinalRecheck&&!life&&supersededBy===null&&!allowAged)
      return {allowed:false,reason:'GPT_FINAL_RECHECK_REQUIRED'};
    // A ticket can cross its answer deadline after validateStored and before openBull.
    // Evaluate that boundary here too, under the same forced-recheck engine contract.
    // This grants only entry to FINAL preparation; dispatch still omits allowAged.
    const agedEntry=allowAged===true&&this.engine?.agedRecheck===true&&
      (t.aged===true||now>=t.validUntil)&&supersededBy===null&&!life&&
      now<t.expires-LIMITS.executionReserveMs-AGED_RECHECK_MIN_MS;
    if(!life&&!agedEntry&&((supersededBy===null&&now>=t.validUntil)||now>=t.expires-(t.clockFinalAuthority?0:LIMITS.executionReserveMs)))return {allowed:false,reason:'GPT_REVIEW_EXPIRED'};
    return {allowed:t.decision===this.allowDecision(),reason:'GPT_'+t.decision+(agedEntry?'_AGED_RECHECK_REQUIRED':''),review:t,
      ...(agedEntry?{aged:true}:{})};
  }
  /** After an entry, one early end of the observation loop so a follow-up cycle can still
   * reach another GPT BUY inside its trigger window (armFollowUp). One-shot. */
  armFollowUp(signals){
    const now=this.now(),until=Math.max(0,...(signals??[]).map(s=>{try{return this.expiry(s)-LIMITS.executionReserveMs-AGED_RECHECK_MIN_MS;}catch{return 0;}}));
    this.followUpUntil=until>now?until:0;
    return this.followUpUntil>0;
  }
  /** Pure scheduling hint. No database/network wait on the protection loop. */
  consumeReadyYield(){
    if(this.followUpUntil>0){
      const due=this.now()<this.followUpUntil;this.followUpUntil=0;
      if(due&&this.config.mode==='ENFORCE'&&this.authorized())return true;
    }
    if(this.config.mode!=='ENFORCE'||!this.yieldArmed||!this.authorized())return false;
    const now=this.now();
    for(const [key,hint] of this.readyHints){
      if(now>=hint.validUntil){this.readyHints.delete(key);continue;}
      if(this.tracked.has(key)){
        if(hint.clock&&!this.clockWakeAt.has(String(hint.signalId)))this.clockWakeAt.set(String(hint.signalId),now);
        this.yieldArmed=false;return true;
      }
    }
    return false;
  }
  /** Drain only provider work already started by this invocation.
   * This does not start a new review and does not extend any authority deadline.
   * EdgeRuntime.waitUntil is not a durability boundary: the request must keep the
   * worker alive until a started provider result has reached complete CAS. */
  async drainPending({exclude=null}={}){
    let count=0,rejected=0;
    // A completed provider attempt may synchronously schedule one bounded recovery
    // child. Re-read the map after each settle so the durability boundary covers the
    // whole chain started by this invocation, not only the first snapshot of tasks.
    for(let round=0;round<8;round++){
      const tasks=[...this.pending].filter(([key])=>!exclude?.has(key)).map(([,task])=>task);
      if(!tasks.length)return {count,rejected};
      count+=tasks.length;
      const settled=await Promise.allSettled(tasks),bad=settled.filter(x=>x.status==='rejected');
      rejected+=bad.length;
      if(bad.length)console.error('GPT_PENDING_DRAIN_REJECTED',bad.length);
      await Promise.resolve();
    }
    console.error('GPT_PENDING_DRAIN_ROUND_LIMIT');
    return {count,rejected};
  }
  /** Called only AFTER runWithLease has returned, never from the order path. */
  async waitReady(){
    this.waitOutcomes=[];
    if(this.config.mode!=='ENFORCE'||!this.tracked.size)return false;
    const deadline=Math.min(this.now()+(this.engine?.timeoutRecovery?TIMEOUT_RECOVERY.waitMs:LIMITS.requestMs+3000),Math.max(...[...this.tracked.values()].map(x=>x.expires-LIMITS.executionReserveMs)));
    const reported=new Set();let firstRead=true;
    // Read once even at the deadline, so a completed failure cannot remain PENDING.
    while(firstRead||this.now()<deadline){
      firstRead=false;let unresolved=false,ready=false;
      // A completed clock BUY is only a wake hint; still reread and validate its
      // durable row before returning. Unrelated diagnostics must not delay it.
      const ordered=[...this.tracked].sort(([a],[b])=>Number(this.readyHints.get(b)?.clock===true)-Number(this.readyHints.get(a)?.clock===true));
      for(const [key,t] of ordered){
        const row=await this.store.get(key).catch(()=>null);
        if(!this.tracked.has(key)){unresolved=true;continue;}
        this.tickets.delete(String(t.s.id));
        if(!row||row.state!=='DONE'){unresolved=true;continue;}
        if(this.engine?.timeoutRecovery&&(isReviewRecoverable(row.record?.result)||row.record?.result?.decision==='WAIT')){
          const next=await this.consider(t.s);
          if(next.reason==='GPT_REVIEW_PENDING'||next.reviewRetryPending===true||!this.tracked.has(key)){unresolved=true;continue;}
          if(!reported.has(key)){
            const review={signalId:t.s.id,...next};reported.add(key);this.waitOutcomes.push(review);
            await this.onResolved(t.s,review).catch(()=>console.error('GPT_ASYNC_LIFECYCLE_WRITE_FAILED',t.s.id));
          }
          continue;
        }
        const checked=await this.validateStored(row,t.identityJson,t.expires,await this.binding)
          .catch(()=>({valid:false,allowed:false,decision:'ABSTAIN',reason:'GPT_REVIEW_STORAGE_OR_VALIDATION_ERROR'}));
        if(!this.tracked.has(key)){unresolved=true;continue;}
        // The durable row, never a ready hint or pending promise, restores the ticket.
        if(checked.valid)this.tickets.set(String(t.s.id),checked.ticket);
        if(checked.allowed)ready=true;
        const review={signalId:t.s.id,jobKey:key,allowed:checked.allowed,decision:checked.decision,reason:checked.reason,
          gptAttempted:typeof row.record?.result?.attempted==='boolean'?row.record.result.attempted:null,
          storedDecision:row.record?.result?.decision??null,detail:checked.detail??null,error:row.record?.result?.error??null};
        if(!reported.has(key)){
          reported.add(key);this.waitOutcomes.push(review);
          const note=this.onResolved(t.s,review).catch(()=>console.error('GPT_ASYNC_LIFECYCLE_WRITE_FAILED',t.s.id));
          if(checked.allowed&&checked.ticket?.clockFinalAuthority)this.schedule(note);else await note;
        }
        if(checked.allowed&&checked.ticket?.clockFinalAuthority){
          const id=String(t.s.id);if(!this.clockWakeAt.has(id))this.clockWakeAt.set(id,this.now());
          return true;
        }
      }
      if(ready)return true;
      if(!unresolved)return false;
      await sleep(Math.min(150,Math.max(1,deadline-this.now())));
    }
    return false;
  }
}
