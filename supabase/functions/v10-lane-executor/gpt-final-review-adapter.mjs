import {FinalReviewCoordinator,configFromControl} from '../_shared/gpt-final-review/coordinator.mjs';
import {SupabaseReviewStore,readReviewControl} from '../_shared/gpt-final-review/supabase-store.mjs';
import {baselineAllowedLive} from '../_shared/gpt-final-review/contract.mjs';
import {FD1_ENTRY_ENGINE} from '../_shared/gpt-final-decision/engine.mjs';
const contexts=new WeakMap();
const getenv=n=>globalThis.Deno?.env?.get(n)??'';
export function coordinatorFor(db){
  // Until the control row is read, the coordinator is OFF: no DB/API work at all.
  if(!contexts.has(db))contexts.set(db,new FinalReviewCoordinator({config:configFromControl({mode:'OFF'},getenv),
    store:new SupabaseReviewStore(db),apiKey:()=>getenv('OPENAI_API_KEY'),
    // FD1 (2026-09-24): GPT is the final entry decision (BUY/SKIP/ABSTAIN) on the V17
    // triggered candidates the live front admits; model outputs are evidence only.
    engine:FD1_ENTRY_ENGINE,baseline:baselineAllowedLive,
    schedule:promise=>{if(globalThis.EdgeRuntime?.waitUntil)EdgeRuntime.waitUntil(promise);else promise.catch(()=>{});}}));
  return contexts.get(db);
}
/** One journal lookup per existing-approved candidate. No API await or signal claim. */
export async function gptFilterExecutable(db,executable){
  const c=coordinatorFor(db);
  // No candidate: no control read, no journal I/O. Existing path unchanged.
  if(!executable.length)return {candidates:executable,reason:c.config.mode};
  if(!c.injected)c.setConfig(configFromControl(await readReviewControl(db).catch(()=>null),getenv));
  // GPT is the final entry decision maker: without an enforcing GPT there is no new entry.
  // OFF (control row or env kill) and SHADOW never fall back to the model stack.
  if(c.config.mode==='OFF')return {candidates:[],reason:'GPT_OFF_NO_NEW_ENTRY'};
  if(c.config.mode==='SHADOW'){
    // Observation only; journal I/O stays off the entry/quote timing path.
    for(const s of executable){const task=c.consider(s).catch(()=>null);c.schedule(task);}
    return {candidates:[],reason:'GPT_SHADOW_NO_NEW_ENTRY',reviews:[]};
  }
  const candidates=[],reviews=[];
  for(const s of executable){const r=await c.consider(s);reviews.push({signalId:s.id,...r});if(r.allowed)candidates.push(s);}
  const pending=reviews.some(r=>r.reason==='GPT_REVIEW_PENDING');
  c.yieldArmed=candidates.length===0&&pending;
  return {candidates,reason:pending?'GPT_REVIEW_PENDING':reviews.at(-1)?.reason??'GPT_NO_CANDIDATE',reviews};
}
export function gptReviewReadyToResume(db){return coordinatorFor(db).consumeReadyYield();}
/** Order-time re-check. Only an ENFORCE-mode, unexpired, identity-bound GPT BUY passes. */
export function gptFinalCheck(db,s){
  const c=coordinatorFor(db);
  if(c.config.mode!=='ENFORCE')return {allowed:false,reason:'GPT_NOT_ENFORCING_NO_NEW_ENTRY'};
  const r=c.check(s);
  return r.allowed===true&&r.review?.decision===c.allowDecision()?r:{...r,allowed:false};
}
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
export function setTestCoordinator(db,c){c.injected=true;contexts.set(db,c);}
