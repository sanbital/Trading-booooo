/** Local no-order runner journal. All locks are short filesystem-only operations. */
import {mkdirSync,readFileSync,writeFileSync,renameSync,unlinkSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {ensure} from '../../supabase/functions/_shared/gpt-final-review/contract.mjs';
import {MAX_RESERVED_USD} from '../../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
export class FileReviewStore {
  constructor(directory){this.directory=resolve(directory);mkdirSync(this.directory,{recursive:true,mode:0o700});}
  path(key){ensure(/^[a-f0-9]{64}$/.test(key),'JOURNAL_KEY_INVALID');return join(this.directory,key+'.json');}
  async get(key){try{return JSON.parse(readFileSync(this.path(key),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  atomic(path,value){const temp=path+'.'+crypto.randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});renameSync(temp,path);}
  async claim(key,record,config){
    const lock=join(this.directory,'budget.lock');
    // Concurrent CLI invocation fails closed rather than running a second request.
    writeFileSync(lock,'LOCAL_JOURNAL_LOCK',{flag:'wx',mode:0o600});
    try{
      const old=await this.get(key);if(old)return {created:false,row:old};
      const day=new Date().toISOString().slice(0,10),bp=join(this.directory,'budget-'+day+'.json');
      const budget=existsSync(bp)?JSON.parse(readFileSync(bp,'utf8')):{calls:0,reserved:0};
      ensure(budget.calls<config.maxCalls&&budget.reserved+MAX_RESERVED_USD<=config.apiBudgetUsd,'API_BUDGET_EXHAUSTED');
      this.atomic(bp,{calls:budget.calls+1,reserved:budget.reserved+MAX_RESERVED_USD,unit:'USD_RESERVATION_NOT_INVOICE'});
      const row={key,owner:crypto.randomUUID(),state:'RUNNING',record};
      writeFileSync(this.path(key),JSON.stringify(row,null,2),{flag:'wx',mode:0o600});return {created:true,row};
    }finally{unlinkSync(lock);}
  }
  async snapshot(key,owner,record){const old=await this.get(key);ensure(old?.owner===owner&&old.state==='RUNNING','JOURNAL_CAS');this.atomic(this.path(key),{...old,record});}
  async save(key,owner,state,record){const old=await this.get(key);ensure(old?.owner===owner&&old.state==='RUNNING','JOURNAL_CAS');this.atomic(this.path(key),{...old,state,record});return true;}
}
