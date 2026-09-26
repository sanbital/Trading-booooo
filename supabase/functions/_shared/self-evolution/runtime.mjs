import {baselinePolicy,validatePolicy,policyContext} from './policy.mjs';
import {hash} from '../gpt-final-decision/api.mjs';
let cached=null,at=0;
/** Bounded policy read only. A research queue is NEVER awaited here. */
export async function readActivePolicy({fetchFn=fetch,now=Date.now,env=k=>globalThis.Deno?.env?.get(k),timeoutMs=250}={}){
 const t=now(),url=env('SUPABASE_URL'),key=env('SUPABASE_SERVICE_ROLE_KEY');
 if(!url||!key)return {bundle:baselinePolicy(),hash:null,source:'BUILTIN'};
 if(cached&&t-at<15000)return cached;
 const ctrl=new AbortController();let timer;
 try{const work=(async()=>{const r=await fetchFn(url+'/rest/v1/rpc/evolution_active_policy',{method:'POST',redirect:'error',signal:ctrl.signal,
  headers:{apikey:key,authorization:'Bearer '+key,'content-type':'application/json'},body:'{}'});
  if(!r.ok)throw Error('POLICY_READ');const s=await r.text();if(s.length>40000)throw Error('POLICY_SIZE');
  const row=JSON.parse(s);validatePolicy(row.bundle);if(row.bundle.data_cutoff_ms>t||await hash(row.bundle)!==row.hash)throw Error('POLICY_INTEGRITY');
  cached={bundle:row.bundle,hash:row.hash,source:'ACTIVE_POINTER',generation:row.generation};at=t;return cached;})();
  return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>{ctrl.abort();reject(Error('POLICY_TIMEOUT'));},timeoutMs);})]);
 }catch{return cached&&t-at<60000?{...cached,source:'BOUNDED_CACHE'}:{bundle:baselinePolicy(),hash:null,source:'BUILTIN_FALLBACK'};}
 finally{clearTimeout(timer);}
}
export async function resolvePolicy(packet,options={}){
 const row=options.policy?{bundle:validatePolicy(options.policy),hash:await hash(options.policy),source:'FROZEN_REPLAY'}:await readActivePolicy(options);
 return {...row,context:policyContext(row.bundle,packet.task,options.snapshotAtMs??Date.now())};
}
