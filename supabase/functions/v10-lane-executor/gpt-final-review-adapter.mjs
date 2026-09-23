import {FinalReviewCoordinator,configFromEnv} from '../_shared/gpt-final-review/coordinator.mjs';
import {SupabaseReviewStore} from '../_shared/gpt-final-review/supabase-store.mjs';
const contexts=new WeakMap();
const getenv=n=>globalThis.Deno?.env?.get(n)??'';
export function coordinatorFor(db){
  if(!contexts.has(db))contexts.set(db,new FinalReviewCoordinator({config:configFromEnv(getenv),
    store:new SupabaseReviewStore(db),apiKey:()=>getenv('OPENAI_API_KEY'),
    schedule:promise=>{if(globalThis.EdgeRuntime?.waitUntil)EdgeRuntime.waitUntil(promise);else promise.catch(()=>{});}}));
  return contexts.get(db);
}
/** One journal lookup per existing-approved candidate. No API await or signal claim. */
export async function gptFilterExecutable(db,executable){
  const c=coordinatorFor(db);
  if(c.config.mode==='OFF')return {candidates:executable,reason:'OFF'};
  if(c.config.mode==='SHADOW'){
    // Even journal I/O must not sit on the original entry/quote timing path.
    for(const s of executable){const task=c.consider(s).catch(()=>null);c.schedule(task);}
    return {candidates:executable,reason:'SHADOW_NONBLOCKING',reviews:[]};
  }
  const candidates=[],reviews=[];
  for(const s of executable){const r=await c.consider(s);reviews.push({signalId:s.id,...r});if(r.allowed)candidates.push(s);}
  const pending=reviews.some(r=>r.reason==='GPT_REVIEW_PENDING');
  c.yieldArmed=candidates.length===0&&pending;
  return {candidates,reason:pending?'GPT_REVIEW_PENDING':reviews.at(-1)?.reason??'GPT_NO_CANDIDATE',reviews};
}
export function gptReviewReadyToResume(db){return coordinatorFor(db).consumeReadyYield();}
export function gptFinalCheck(db,s){return coordinatorFor(db).check(s);}
/** The existing engine keeps its whole lease and protection/X1 behavior unchanged.
 * The API runs independently. Only after lease release may a completed PASS request
 * one additional ordinary cycle. A busy/expired result is never forced through.
 */
export async function runWithGptReview(db,runWithLease){
  const c=coordinatorFor(db),first=await runWithLease(db);
  if(c.config.mode!=='ENFORCE'||first?.entry?.entered||first?.ok===false||first?.skipped||first?.entry?.reason!=='GPT_REVIEW_PENDING')return first;
  let ready=false;try{ready=await c.waitReady();}catch{/* GPT errors are candidate-scoped. */}
  if(!ready)return first;
  const second=await runWithLease(db);
  return {...second,gptFinalReview:{mode:c.config.mode,rechecked:true,firstCycleEntry:first.entry??null}};
}
// Dependency injection for isolated tests only; not exposed as an HTTP operation.
export function setTestCoordinator(db,c){contexts.set(db,c);}
