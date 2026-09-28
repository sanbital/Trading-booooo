import {ensure} from './contract.mjs';
import {paidTransport} from '../leader20/paid-transport.mjs';
import {MAX_RESERVED_USD} from './coordinator.mjs';
const retryable=e=>['55P03','57014','40001','40P01'].includes(e?.code)||/abort|timeout|fetch failed/i.test(e?.message??'');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
/** Writes exclusively to the review journal and its budget ledger. Never trading tables. */
export class SupabaseReviewStore {
  constructor(db){this.db=db;this.ledgerModes=new Map();this.deferClaimUntilPrepared=true;}
  async get(key){const r=await this.db.from('gpt_final_entry_reviews').select('job_key,owner,state,record').eq('job_key',key).maybeSingle();
    ensure(!r.error,'REVIEW_STORE_READ');return r.data?{...r.data,key:r.data.job_key}:null;}
  async claim(key,record,config){
    // The RPC may commit before its response is lost. Only this invocation may
    // recover that acknowledgement, never another worker or a completed review.
    // The marker is journal metadata; immutable packet/identity/TTL are untouched.
    const attemptId=crypto.randomUUID(),args={p_job_key:key,
      p_record:{...record,transport_version:'AI_PROVIDER_LEDGER_1',claim_attempt_id:attemptId},
      p_cap_usd:config.apiBudgetUsd,p_max_calls:config.maxCalls,p_reserve_usd:MAX_RESERVED_USD};
    for(let attempt=0;attempt<3;attempt++){
      let r;try{r=await this.db.rpc('gpt_final_review_claim',args);}
      catch(error){r={error:{code:error?.code,message:`${error?.name??''}: ${error?.message??''}`}};}
      if(r.error&&/API_BUDGET_EXHAUSTED/.test(String(r.error.message??'')))throw Error('API_BUDGET_EXHAUSTED');
      if(!r.error&&r.data?.row){
        const row=r.data.row,recovered=attempt>0&&r.data.created===false&&row.state==='RUNNING'&&
          typeof row.owner==='string'&&row.owner.length>0&&row.record?.claim_attempt_id===attemptId;
        this.ledgerModes.set(key,row.provider_ledger===true);
        return recovered?{...r.data,created:true,recovered:true}:r.data;
      }
      if(!retryable(r.error)||attempt===2)throw Error('REVIEW_STORE_CLAIM');
      await delay(100*(attempt+1));
    }
  }
  async transport(key,record,fetchFn=fetch){
    if(!this.ledgerModes.has(key)){
      const r=await this.db.from('gpt_final_entry_reviews').select('provider_ledger').eq('job_key',key).single();
      ensure(!r.error&&r.data,'API_LEDGER_MODE_READ');this.ledgerModes.set(key,r.data.provider_ledger===true);
    }
    if(this.ledgerModes.get(key)!==true)return fetchFn;
    const purpose=record.purpose!=='PRODUCTION'?'VERIFICATION':record.identity?.position_id?
      /EXIT/.test(record.identity.event??'')?'EXIT':'HOLD':record.kind==='FD1_FINAL_RECHECK'?'RECHECK':'ENTRY';
    return paidTransport(this.db,{parentKey:key,purpose,fetchFn});
  }
  async snapshot(key,owner,record){
    for(let attempt=0;attempt<3;attempt++){
      const r=await this.db.from('gpt_final_entry_reviews').update({record}).eq('job_key',key).eq('owner',owner).eq('state','RUNNING').select('job_key').maybeSingle();
      if(!r.error&&r.data)return;
      if(!retryable(r.error)||attempt===2)throw Error('REVIEW_SNAPSHOT_CAS');
      await delay(100*(attempt+1));
    }
  }
  /** RUNNING -> DONE once, by the claiming owner; settles the reservation to known cost. */
  async complete(key,owner,record){
    if(record.result?.dynamic_audit)record={...record,result:{...record.result,dynamic_audit:{...record.result.dynamic_audit,
      signal_id:record.identity?.signal_id??null,position_id:record.identity?.position_id??record.result.dynamic_audit.position_id,
      review_job_key:key,execution_result_ref:'fd1_final_recheck_log.final_job_key / v11_protection_decisions.reviewJobKey'}}};
    for(let attempt=0;attempt<3;attempt++){
      const r=await this.db.rpc('gpt_final_review_complete',{p_job_key:key,p_owner:owner,p_record:record});
      if(!r.error&&r.data?.done===true)return true;
      if(!retryable(r.error)||attempt===2)throw Error('REVIEW_RESULT_CAS');
      await delay(100*(attempt+1));
    }
  }
}
/** One control read per entry evaluation that has candidates. Never writes. */
export async function readReviewControl(db){
  const r=await db.from('gpt_final_review_control').select('mode,daily_cap_usd,max_calls_per_day,enforce_approved,approval_ref,updated_at').eq('singleton',true).maybeSingle();
  return r.error?null:r.data??null;
}
