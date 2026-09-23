import {VERSION,MODEL,LIMITS,OUTPUT_SCHEMA,WIRE_OUTPUT_SCHEMA,canonical,hash,baselineAllowed,decisionIdentity,triggerExpiry,validateAnswer,parseApiResponse,ensure} from './contract.mjs';
import {SYSTEM_PROMPT} from './prompt.mjs';
import {collectMarket,buildPacket,packetHash} from './market.mjs';
import {callFinalReviewer} from './openai.mjs';
export const MAX_RESERVED_USD=.10; // Conservative ceiling for the bounded packet/output, not measured spend.
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function configFromEnv(get){
  const requested=String(get('GPT_FINAL_REVIEW_MODE')||'OFF').toUpperCase();
  const mode=['OFF','SHADOW','ENFORCE'].includes(requested)?requested:'ENFORCE';
  return Object.freeze({mode,modeValid:['OFF','SHADOW','ENFORCE'].includes(requested),
    approvalRef:String(get('GPT_FINAL_REVIEW_API_APPROVAL')||''),apiBudgetUsd:Number(get('GPT_FINAL_REVIEW_DAILY_BUDGET_USD')||0),
    maxCalls:Number(get('GPT_FINAL_REVIEW_MAX_CALLS_PER_DAY')||0),
    enforceApproved:get('GPT_FINAL_REVIEW_ENFORCE_APPROVED')==='true'});
}
/** Test-only store; the executor uses the durable Supabase store below, never this one. */
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
  async save(key,owner,state,record){const old=this.rows.get(key);ensure(old?.owner===owner&&old.state==='RUNNING','REVIEW_WRITE_CAS');
    this.rows.set(key,{...old,state,record:structuredClone(record)});return true;}
}
export class FinalReviewCoordinator {
  constructor({config,store,apiKey=()=>'',fetchFn=fetch,market=collectMarket,now=Date.now,schedule=p=>{p.catch(()=>{});}}){
    this.config=config;this.store=store;this.apiKey=apiKey;this.fetchFn=fetchFn;this.market=market;this.now=now;this.schedule=schedule;
    this.tickets=new Map();this.tracked=new Map();this.pending=new Map();this.readyHints=new Map();this.yieldArmed=false;
    this.binding=hash({version:VERSION,model:MODEL,prompt:SYSTEM_PROMPT,schema:OUTPUT_SCHEMA,wireSchema:WIRE_OUTPUT_SCHEMA,limits:LIMITS});
  }
  authorized(){const c=this.config;return c.modeValid!==false&&c.approvalRef.length>0&&c.apiBudgetUsd>=MAX_RESERVED_USD&&
    Number.isInteger(c.maxCalls)&&c.maxCalls>0&&!!this.apiKey()&&(c.mode!=='ENFORCE'||c.enforceApproved===true);}
  async consider(s){
    if(this.config.mode==='OFF')return {allowed:true,reason:'OFF'};
    const shadow=this.config.mode==='SHADOW';
    // A failed re-read must not leave an earlier PASS ticket usable.
    this.tickets.delete(String(s?.id));
    for(const [k,h] of this.readyHints)if(h.signalId===String(s?.id))this.readyHints.delete(k);
    const deny=reason=>({allowed:shadow,reason,decision:'ABSTAIN',scope:'CANDIDATE'});
    if(!baselineAllowed(s))return deny('BASELINE_REJECT_OR_INVALID');
    if(!this.authorized())return deny('GPT_REVIEW_NOT_CONFIGURED_OR_APPROVED');
    const now=this.now(),expires=triggerExpiry(s);
    if(now>=expires-LIMITS.executionReserveMs)return deny('GPT_TRIGGER_EXPIRED');
    try{
      const identity=decisionIdentity(s),identityJson=canonical(identity),binding=await this.binding;
      const key=await hash({binding,identity});this.tracked.set(key,{identityJson,s:structuredClone(s),expires});
      let row=await this.store.get(key);
      if(!row){
        const record={version:VERSION,binding,identity,identity_json:identityJson,expires_at_ms:expires,
          reserved_usd:MAX_RESERVED_USD,api_approval_ref:this.config.approvalRef,packet:null,result:null};
        const claimed=await this.store.claim(key,record,this.config);row=claimed.row;
        if(claimed.created){
          // Only the independent promise waits for the API. No trading lease is passed.
          const task=this.work(key,row.owner,record).catch(()=>false).finally(()=>this.pending.delete(key));
          this.pending.set(key,task);this.schedule(task);
        }
      }
      if(row.state!=='DONE')return deny('GPT_REVIEW_PENDING');
      const checked=await this.validateStored(row,identityJson,expires,binding);
      if(checked.valid)this.tickets.set(String(s.id),checked.ticket);
      return {allowed:shadow||checked.allowed,reason:checked.reason,decision:checked.decision,scope:'CANDIDATE'};
    }catch{return deny('GPT_REVIEW_STORAGE_OR_VALIDATION_ERROR');}
  }
  async work(key,owner,record){
    try{
      const current=await this.market(record.identity,{fetchFn:this.fetchFn,now:this.now,
        deadlineMs:record.expires_at_ms-LIMITS.executionReserveMs});
      const captured=this.now();record.packet=await buildPacket(record.identity,current,captured);record.snapshot_at_ms=captured;
      record.valid_until_ms=Math.min(record.expires_at_ms-LIMITS.executionReserveMs,captured+LIMITS.reviewMaxAgeMs);
      // Snapshot persistence before the paid request; failures cannot lead to an unrecorded PASS.
      if(this.store.snapshot)await this.store.snapshot(key,owner,record);
      record.result=await callFinalReviewer(record.packet,{apiKey:this.apiKey(),fetchFn:this.fetchFn,now:this.now,
        deadlineMs:record.valid_until_ms});
    }catch{
      record.result={origin:'LOCAL_DATA_ERROR',valid:false,decision:'ABSTAIN',error:'REVIEW_PREPARATION_FAILED',
        attempted:false,api_cost_usd:0,completed_at_ms:this.now()};
    }
    await this.store.save(key,owner,'DONE',record);
    // Mark ready only after durable save and complete raw-response validation.
    // This hint can shorten observation waiting, but a new lease cycle still
    // rereads and validates the journal before it creates an entry ticket.
    const checked=await this.validateStored({record},record.identity_json,record.expires_at_ms,record.binding).catch(()=>null);
    if(checked?.allowed)this.readyHints.set(key,{signalId:record.identity.signal_id,validUntil:checked.ticket.validUntil});
    return record.result?.valid===true;
  }
  async validateStored(row,identityJson,expires,binding){
    const r=row.record,z=r?.result,now=this.now();
    const deny=reason=>({valid:false,allowed:false,decision:'ABSTAIN',reason});
    if(r?.version!==VERSION||r.binding!==binding||r.identity_json!==identityJson||r.expires_at_ms!==expires)return deny('GPT_BINDING_MISMATCH');
    if(!r.packet||await packetHash(r.packet)!==r.packet.snapshot_hash)return deny('GPT_SNAPSHOT_MISMATCH');
    if(!Number.isSafeInteger(r.snapshot_at_ms)||r.snapshot_at_ms>now||r.snapshot_at_ms<r.identity.trigger_at_ms||
      r.packet.as_of_offset_ms!==r.snapshot_at_ms-r.identity.trigger_at_ms)return deny('GPT_SNAPSHOT_TIME_INVALID');
    if(!Number.isSafeInteger(z?.completed_at_ms)||z.completed_at_ms>now||z.completed_at_ms<r.snapshot_at_ms||
      !Number.isSafeInteger(r.valid_until_ms)||r.valid_until_ms!==Math.min(expires-LIMITS.executionReserveMs,r.snapshot_at_ms+LIMITS.reviewMaxAgeMs)||
      now>=r.valid_until_ms||z.completed_at_ms>=r.valid_until_ms)return deny('GPT_STALE_OR_FUTURE_REVIEW');
    if(z.origin!=='OPENAI_API'||!z.valid||!z.raw_response||z.model_requested!==MODEL||z.raw_response.model!==MODEL||!z.request_id)
      return deny('GPT_NO_VALID_API_RESPONSE');
    const answer=validateAnswer(parseApiResponse(z.raw_response,r.packet),r.packet);
    const ticket={identityJson,decision:answer.decision,validUntil:r.valid_until_ms,expires,
      candidateId:r.packet.candidate_id,snapshotHash:r.packet.snapshot_hash,model:MODEL,summary:answer.summary};
    return {valid:true,allowed:answer.decision==='PASS',decision:answer.decision,reason:'GPT_'+answer.decision,ticket};
  }
  /** Pure, no I/O. Run again immediately before intent creation. */
  check(s){
    if(this.config.mode==='OFF'||this.config.mode==='SHADOW')return {allowed:true,reason:this.config.mode};
    if(!this.authorized())return {allowed:false,reason:'GPT_REVIEW_NOT_APPROVED'};
    const t=this.tickets.get(String(s?.id)),now=this.now();
    if(!baselineAllowed(s)||!t||t.identityJson!==canonical(decisionIdentity(s)))return {allowed:false,reason:'GPT_REVIEW_IDENTITY_CHANGED'};
    if(now>=t.validUntil||now>=t.expires-LIMITS.executionReserveMs)return {allowed:false,reason:'GPT_REVIEW_EXPIRED'};
    return {allowed:t.decision==='PASS',reason:'GPT_'+t.decision,review:t};
  }
  /** Pure scheduling hint. No database/network wait on the protection loop. */
  consumeReadyYield(){
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
