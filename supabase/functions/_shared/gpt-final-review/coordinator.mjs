import {wireSchema,parseApiResponseWire} from './wire-v4.mjs';
import {VERSION,MODEL,LIMITS,OUTPUT_SCHEMA,canonical,hash,baselineAllowed,decisionIdentity,triggerExpiry,validateAnswer,ensure} from './contract.mjs';
import {promptFor} from './prompt.mjs';
import {collectMarket,buildPacket,packetHash} from './market.mjs';
import {callFinalReviewer,DEFAULT_PROFILE,profileOf} from './openai.mjs';
import {initialContext} from '../gpt-final-decision/recheck.mjs';
export const MAX_RESERVED_USD=.10; // Conservative per-call reservation; settled to documented token cost after the call.
/** (2026-09-25) An engine with agedRecheck lets a stored BUY that outlived its own answer
 * validity reach the order path while at least this long remains before the trigger's
 * execution reserve: enough for E1 (~3 s) and one forced GPT FINAL RECHECK (fresh read
 * 1.5 s + request <=4 s). The aged answer itself can never dispatch (see check()). */
export const AGED_RECHECK_MIN_MS=8000;
/** Human-readable release label stored with every review (source_commit column). */
export const RELEASE='gpt-final-review-v6-realtime-risk-20260924';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const MODES=['OFF','SHADOW','ENFORCE'];
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
  async complete(key,owner,record){const old=this.rows.get(key);ensure(old?.owner===owner&&old.state==='RUNNING','REVIEW_RESULT_CAS');
    this.rows.set(key,{...old,state:'DONE',record:structuredClone(record)});return true;}
}
export class FinalReviewCoordinator {
  // Process-local capabilities: never serialized, recovered, or shared with another cycle.
  retryLifecycles=new WeakMap();
  beginExecution(s,{supersededBy=null}={}){
    const check=this.check(s,{supersededBy});
    if(!check.allowed)return null;
    const token=Object.freeze({});
    this.retryLifecycles.set(token,{ticket:check.review,signal:s,startedAt:this.now(),deadline:null,used:false});
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
    profile=DEFAULT_PROFILE,purpose='PRODUCTION',baseline=baselineAllowed,expiry=triggerExpiry,engine=null}){
    this.config=config;this.store=store;this.apiKey=apiKey;this.fetchFn=fetchFn;this.market=market;this.now=now;this.schedule=schedule;
    this.baseline=baseline;this.expiry=expiry;this.engine=engine;this.identity=engine?.identity??decisionIdentity;
    // An engine (FD1 final decision) replaces the question and answer contract; the durable
    // claim/ledger/TTL/ticket machinery below is identical for every engine.
    this.profile=engine?engine.id:profile;this.purpose=purpose;const wire=engine?null:profileOf(profile).wire,promptText=engine?engine.promptText:promptFor(profileOf(profile).prompt??wire);
    this.tickets=new Map();this.tracked=new Map();this.pending=new Map();this.readyHints=new Map();this.yieldArmed=false;this.followUpUntil=0;
    this.promptHash=hash(promptText);this.schemaHash=hash(engine?engine.schema:wireSchema(wire));
    // purpose is bound so PRODUCTION, DRYRUN and VERIFICATION reviews of one candidate never share a row.
    this.binding=engine?hash({version:VERSION,engine:engine.id,model:engine.model,prompt:promptText,schema:engine.schema,limits:LIMITS,purpose}):
      hash({version:VERSION,model:MODEL,prompt:promptText,schema:OUTPUT_SCHEMA,wireSchema:wireSchema(wire),limits:LIMITS,profile:profileOf(profile),purpose});
  }
  setConfig(config){this.config=config;}
  allowDecision(){return this.engine?this.engine.allow:'PASS';}
  authorized(){const c=this.config;return c.modeValid!==false&&c.approvalRef.length>0&&c.apiBudgetUsd>=MAX_RESERVED_USD&&
    Number.isInteger(c.maxCalls)&&c.maxCalls>0&&!!this.apiKey()&&(c.mode!=='ENFORCE'||c.enforceApproved===true);}
  async consider(s){
    if(this.config.mode==='OFF')return {allowed:true,reason:'OFF'};
    const shadow=this.config.mode==='SHADOW';
    // A failed re-read must not leave an earlier PASS ticket usable.
    this.tickets.delete(String(s?.id));
    for(const [k,h] of this.readyHints)if(h.signalId===String(s?.id))this.readyHints.delete(k);
    const deny=reason=>({allowed:shadow,reason,decision:'ABSTAIN',scope:'CANDIDATE'});
    if(!this.baseline(s))return deny('BASELINE_REJECT_OR_INVALID');
    if(!this.authorized())return deny(this.config.source==='CONTROL_UNREADABLE'?'GPT_CONTROL_UNREADABLE':'GPT_REVIEW_NOT_CONFIGURED_OR_APPROVED');
    const now=this.now(),expires=this.expiry(s);
    if(now>=expires-LIMITS.executionReserveMs)return deny('GPT_TRIGGER_EXPIRED');
    let key;
    try{
      const identity=this.identity(s),identityJson=canonical(identity),binding=await this.binding;
      key=await hash({binding,identity});this.tracked.set(key,{identityJson,s:structuredClone(s),expires});
      let row=await this.store.get(key);
      if(!row){
        const record={version:VERSION,binding,identity,identity_json:identityJson,expires_at_ms:expires,
          reserved_usd:MAX_RESERVED_USD,api_approval_ref:this.config.approvalRef,purpose:this.purpose,wire_profile:this.profile,
          prompt_hash:await this.promptHash,schema_hash:await this.schemaHash,source_commit:RELEASE,packet:null,result:null};
        let claimed;
        try{claimed=await this.store.claim(key,record,this.config);}
        catch(e){if(/API_BUDGET_EXHAUSTED/.test(String(e?.message??e)))return deny('GPT_API_BUDGET_EXHAUSTED');throw e;}
        row=claimed.row;
        if(claimed.created){
          // Only the independent promise waits for the API. No trading lease is passed.
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
        ...(['BUY','SKIP','ABSTAIN'].includes(stored)?{storedDecision:stored}:{}),
        ...(checked.aged?{aged:true}:{}),...(checked.detail?{detail:checked.detail}:{}),
        ...(!checked.valid&&row.record?.result?.error?{error:String(row.record.result.error).slice(0,80)}:{})};
    }catch{return deny('GPT_REVIEW_STORAGE_OR_VALIDATION_ERROR');}
  }
  async work(key,owner,record){
    try{
      const deadlineMs=record.expires_at_ms-LIMITS.executionReserveMs;
      let captured;
      if(this.engine){const prep=await this.engine.prepare(record.identity,{fetchFn:this.fetchFn,now:this.now,deadlineMs});record.packet=prep.packet;captured=prep.captured;}
      else{const current=await this.market(record.identity,{fetchFn:this.fetchFn,now:this.now,deadlineMs});
        captured=this.now();record.packet=await buildPacket(record.identity,current,captured);}
      record.snapshot_at_ms=captured;
      record.valid_until_ms=Math.min(record.expires_at_ms-LIMITS.executionReserveMs,captured+LIMITS.reviewMaxAgeMs);
      // Snapshot persistence before the paid request; failures cannot lead to an unrecorded PASS.
      if(this.store.snapshot)await this.store.snapshot(key,owner,record);
      record.result=this.engine?await this.engine.call(record.packet,{apiKey:this.apiKey(),fetchFn:this.fetchFn,now:this.now,deadlineMs:record.valid_until_ms,identity:record.identity}):
        await callFinalReviewer(record.packet,{apiKey:this.apiKey(),fetchFn:this.fetchFn,now:this.now,
        deadlineMs:record.valid_until_ms,profile:this.profile});
      if(this.engine&&record.result.final_packet){
        record.packet=record.result.final_packet;
        record.snapshot_at_ms=record.result.final_snapshot_at_ms;
        record.valid_until_ms=Math.min(deadlineMs,record.snapshot_at_ms+LIMITS.reviewMaxAgeMs);
      }
    }catch{
      record.result={origin:'LOCAL_DATA_ERROR',valid:false,decision:'ABSTAIN',error:'REVIEW_PREPARATION_FAILED',
        attempted:false,api_cost_usd:0,completed_at_ms:this.now(),model_requested:MODEL,wire_profile:this.profile};
    }
    await this.store.complete(key,owner,record);
    // Mark ready only after durable save and complete raw-response validation.
    // This hint can shorten observation waiting, but a new lease cycle still
    // rereads and validates the journal before it creates an entry ticket.
    const checked=await this.validateStored({record},record.identity_json,record.expires_at_ms,record.binding).catch(()=>null);
    if(checked?.allowed&&!checked.aged)this.readyHints.set(key,{signalId:record.identity.signal_id,validUntil:checked.ticket.validUntil});
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
      !Number.isSafeInteger(r.valid_until_ms)||r.valid_until_ms!==Math.min(expires-LIMITS.executionReserveMs,r.snapshot_at_ms+LIMITS.reviewMaxAgeMs))
      return deny('GPT_STALE_OR_FUTURE_REVIEW');
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
    const ticket={identityJson,decision:answer.decision,validUntil:r.valid_until_ms,expires,
      candidateId:r.packet.candidate_id,snapshotHash:r.packet.snapshot_hash,model,summary:answer.summary,
      // FINAL RECHECK: what this decision was based on (initial facts, book reference, support).
      ...(this.engine?{initial:initialContext(r,answer)}:{}),...(aged?{aged:true}:{})};
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
    // A FINAL RECHECK answer supersedes the initial answer's age limit only; the trigger
    // expiry, identity and baseline above/below still bind. Its own validity is checked by the caller.
    const life=retryAuthority&&this.retryLifecycles.get(retryAuthority);
    if(retryAuthority&&(!life||life.signal!==s||life.ticket!==t||life.used||life.deadline===null||now>=life.deadline))
      return {allowed:false,reason:'IOC_RETRY_AUTHORITY_EXPIRED_OR_INVALID'};
    const agedEntry=allowAged===true&&t.aged===true&&supersededBy===null&&!life&&
      now<t.expires-LIMITS.executionReserveMs-AGED_RECHECK_MIN_MS;
    if(!life&&!agedEntry&&((supersededBy===null&&now>=t.validUntil)||now>=t.expires-LIMITS.executionReserveMs))return {allowed:false,reason:'GPT_REVIEW_EXPIRED'};
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
      if(this.tracked.has(key)){this.yieldArmed=false;return true;}
    }
    return false;
  }
  /** Called only AFTER runWithLease has returned, never from the order path. */
  async waitReady(){
    if(this.config.mode!=='ENFORCE'||!this.tracked.size)return false;
    const deadline=Math.min(this.now()+LIMITS.requestMs+3000,Math.max(...[...this.tracked.values()].map(x=>x.expires-LIMITS.executionReserveMs)));
    while(this.now()<deadline){
      let unresolved=false;
      for(const [key,t] of this.tracked){
        const row=await this.store.get(key).catch(()=>null);
        if(!row||row.state!=='DONE'){unresolved=true;continue;}
        const checked=await this.validateStored(row,t.identityJson,t.expires,await this.binding).catch(()=>null);
        if(checked?.allowed)return true;
      }
      if(!unresolved)return false;
      await sleep(Math.min(150,Math.max(1,deadline-this.now())));
    }
    return false;
  }
}
