import {ensure} from './contract.mjs';
import {MAX_RESERVED_USD} from './coordinator.mjs';
/** Writes exclusively to the review journal and its budget ledger. Never trading tables. */
export class SupabaseReviewStore {
  constructor(db){this.db=db;}
  async get(key){const r=await this.db.from('gpt_final_entry_reviews').select('job_key,owner,state,record').eq('job_key',key).maybeSingle();
    ensure(!r.error,'REVIEW_STORE_READ');return r.data?{...r.data,key:r.data.job_key}:null;}
  async claim(key,record,config){const r=await this.db.rpc('gpt_final_review_claim',{
    p_job_key:key,p_record:record,p_cap_usd:config.apiBudgetUsd,p_max_calls:config.maxCalls,p_reserve_usd:MAX_RESERVED_USD});
    if(r.error&&/API_BUDGET_EXHAUSTED/.test(String(r.error.message??'')))throw Error('API_BUDGET_EXHAUSTED');
    ensure(!r.error&&r.data?.row,'REVIEW_STORE_CLAIM');return r.data;}
  async snapshot(key,owner,record){const r=await this.db.from('gpt_final_entry_reviews').update({record}).eq('job_key',key).eq('owner',owner).eq('state','RUNNING').select('job_key').maybeSingle();
    ensure(!r.error&&r.data,'REVIEW_SNAPSHOT_CAS');}
  /** RUNNING -> DONE once, by the claiming owner; settles the reservation to known cost. */
  async complete(key,owner,record){const r=await this.db.rpc('gpt_final_review_complete',{p_job_key:key,p_owner:owner,p_record:record});
    ensure(!r.error&&r.data?.done===true,'REVIEW_RESULT_CAS');return true;}
}
/** One control read per entry evaluation that has candidates. Never writes. */
export async function readReviewControl(db){
  const r=await db.from('gpt_final_review_control').select('mode,daily_cap_usd,max_calls_per_day,enforce_approved,approval_ref,updated_at').eq('singleton',true).maybeSingle();
  return r.error?null:r.data??null;
}
