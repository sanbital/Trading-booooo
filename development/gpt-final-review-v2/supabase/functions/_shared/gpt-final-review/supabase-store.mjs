import {ensure} from './contract.mjs';
import {MAX_RESERVED_USD} from './coordinator.mjs';
/** Writes exclusively to the new review journal. Does not modify trading tables. */
export class SupabaseReviewStore {
  constructor(db){this.db=db;}
  async get(key){const r=await this.db.from('gpt_final_entry_reviews').select('job_key,owner,state,record').eq('job_key',key).maybeSingle();
    ensure(!r.error,'REVIEW_STORE_READ');return r.data?{...r.data,key:r.data.job_key}:null;}
  async claim(key,record,config){const r=await this.db.rpc('gpt_final_review_claim',{
    p_job_key:key,p_record:record,p_cap_usd:config.apiBudgetUsd,p_max_calls:config.maxCalls,p_reserve_usd:MAX_RESERVED_USD});
    ensure(!r.error&&r.data?.row,'REVIEW_STORE_CLAIM');return r.data;}
  async snapshot(key,owner,record){const r=await this.db.from('gpt_final_entry_reviews').update({record}).eq('job_key',key).eq('owner',owner).eq('state','RUNNING').select('job_key').maybeSingle();
    ensure(!r.error&&r.data,'REVIEW_SNAPSHOT_CAS');}
  async save(key,owner,state,record){const r=await this.db.from('gpt_final_entry_reviews').update({state,record,completed_at:new Date().toISOString()})
    .eq('job_key',key).eq('owner',owner).eq('state','RUNNING').select('job_key').maybeSingle();ensure(!r.error&&r.data,'REVIEW_RESULT_CAS');return true;}
}
