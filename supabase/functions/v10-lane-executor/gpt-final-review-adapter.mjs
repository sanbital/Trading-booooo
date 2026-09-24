import {FinalReviewCoordinator,configFromControl} from '../_shared/gpt-final-review/coordinator.mjs';
import {SupabaseReviewStore,readReviewControl} from '../_shared/gpt-final-review/supabase-store.mjs';
import {baselineAllowedLive} from '../_shared/gpt-final-review/contract.mjs';
import {FD1_ENTRY_ENGINE} from '../_shared/gpt-final-decision/engine.mjs';
import {recheckAllows} from '../_shared/gpt-final-decision/recheck.mjs';
const contexts=new WeakMap();
const getenv=n=>globalThis.Deno?.env?.get(n)??'';
/** Operator switches for the two BUY-recovery paths (2026-09-25). Default on; 'false' restores
 * the previous behaviour exactly: an aged BUY is refused, and a run that entered ends the cycle. */
export const recoverySwitches=(get=getenv)=>({agedRecheck:get('FD1_AGED_BUY_RECHECK')!=='false',followUp:get('FD1_ENTRY_FOLLOW_UP')!=='false'});
export function coordinatorFor(db){
  // Until the control row is read, the coordinator is OFF: no DB/API work at all.
  if(!contexts.has(db))contexts.set(db,new FinalReviewCoordinator({config:configFromControl({mode:'OFF'},getenv),
    store:new SupabaseReviewStore(db),apiKey:()=>getenv('OPENAI_API_KEY'),
    // FD1 (2026-09-24): GPT is the final entry decision (BUY/SKIP/ABSTAIN) on the V17
    // triggered candidates the live front admits; model outputs are evidence only.
    // The aged-BUY switch only removes agedRecheck; the binding (prompt, schema, model) is the same.
    engine:recoverySwitches().agedRecheck?FD1_ENTRY_ENGINE:{...FD1_ENTRY_ENGINE,agedRecheck:false},baseline:baselineAllowedLive,
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
/** Arm the one follow-up cycle (see runWithGptReview) for GPT BUY candidates a run entered
 * past; true only if one of them can still be rechecked inside its trigger window. */
export function gptArmFollowUp(db,signals,switches=recoverySwitches()){
  const c=coordinatorFor(db);
  return switches.followUp&&c.config.mode==='ENFORCE'&&signals.length>0&&c.armFollowUp(signals);
}
/** Order-time re-check. Only an ENFORCE-mode, unexpired, identity-bound GPT BUY passes.
 * With a triggered FINAL RECHECK record, the recheck's own valid BUY is additionally required
 * and replaces the initial answer's age limit (never the trigger expiry or identity). */
export function gptBeginExecution(db,s,finalRecheck){
  if(!gptFinalCheck(db,s,finalRecheck).allowed)return null;
  return coordinatorFor(db).beginExecution(s,{supersededBy:finalRecheck?.recheck_triggered?finalRecheck.final.job_key:null});
}
export function gptConfirmFirstFinality(db,token,first){
  return coordinatorFor(db).confirmFirstFinality(token,{orderId:first.oi.id,
    confirmedAt:first.evidence.confirmedAt,quantity:first.oi.requested_quantity});
}
export function gptConsumeRetry(db,token){return coordinatorFor(db).consumeRetry(token);}
/** allowAged: only at the order path's entry (openBull). An aged BUY passes there solely to
 * be re-decided by a forced GPT FINAL RECHECK; every later call omits it and refuses the
 * aged answer unless a valid FINAL BUY supersedes it. */
export function gptFinalCheck(db,s,finalRecheck=null,retryAuthority=null,{allowAged=false}={}){
  const c=coordinatorFor(db);
  if(c.config.mode!=='ENFORCE')return {allowed:false,reason:'GPT_NOT_ENFORCING_NO_NEW_ENTRY'};
  const triggered=finalRecheck?.recheck_triggered===true;
  if(retryAuthority&&(finalRecheck?.recheck_sequence!==2||
    !Number.isFinite(finalRecheck.pre_dispatch_at)||c.now()<finalRecheck.pre_dispatch_at||
    c.now()-finalRecheck.pre_dispatch_at>10000||typeof finalRecheck.recheck_triggered!=='boolean'))
    return {allowed:false,reason:'IOC_RETRY_FRESH_RECHECK_REQUIRED'};
  if(triggered&&!recheckAllows(finalRecheck.final,c.now()))return {allowed:false,reason:'GPT_FINAL_RECHECK_NOT_BUY_OR_EXPIRED'};
  const r=c.check(s,{supersededBy:triggered?finalRecheck.final.job_key:null,retryAuthority,allowAged:allowAged===true&&!finalRecheck&&!retryAuthority});
  return r.allowed===true&&r.review?.decision===c.allowDecision()?r:{...r,allowed:false};
}
/** The coordinator's current control/config for the FINAL RECHECK (same row, same ledger). */
export function gptRecheckConfig(db){return coordinatorFor(db).config;}
/** The existing engine keeps its whole lease and protection/X1 behavior unchanged.
 * The API runs independently. Only after lease release may a completed PASS request
 * one additional ordinary cycle. A busy/expired result is never forced through.
 */
/** (2026-09-25) One run still opens at most one position. When a run entered and other
 * GPT BUY candidates it did not reach still hold a live trigger, ONE follow-up ordinary
 * cycle (new lease, fresh reads, protection first) may take the next of them instead of
 * letting its trigger expire untried (TRBUSDT 2026-09-24 17:17). */
export const FOLLOW_UP_POLICY=Object.freeze({maxFollowUps:1,maxElapsedMs:30000});
function wantsFollowUp(result,started,now){
  return result?.entry?.entered===true&&result.entry.followUpArmed===true&&Number(result.entry.remainingGptBuys)>0&&
    result?.ok!==false&&!result?.skipped&&now-started<FOLLOW_UP_POLICY.maxElapsedMs;
}
export async function runWithGptReview(db,runWithLease,switches=recoverySwitches()){
  const c=coordinatorFor(db),clock=typeof c.now==='function'?()=>c.now():Date.now,started=clock(),first=await runWithLease(db);
  const followUp=async(result,prior)=>{
    if(!switches.followUp||c.config.mode!=='ENFORCE'||!wantsFollowUp(result,started,clock()))return result;
    const next=await runWithLease(db);
    return {...next,gptFinalReview:{...(next?.gptFinalReview??{}),mode:c.config.mode,followUp:true,priorEntries:[...prior,result.entry]}};
  };
  if(c.config.mode!=='ENFORCE'||first?.ok===false||first?.skipped)return first;
  if(first?.entry?.entered)return await followUp(first,[]);
  if(first?.entry?.reason!=='GPT_REVIEW_PENDING')return first;
  let ready=false;try{ready=await c.waitReady();}catch{/* GPT errors are candidate-scoped. */}
  if(!ready)return first;
  const second=await runWithLease(db);
  const out={...second,gptFinalReview:{mode:c.config.mode,rechecked:true,firstCycleEntry:first.entry??null}};
  return second?.entry?.entered?await followUp(out,[]):out;
}
// Dependency injection for isolated tests only; not exposed as an HTTP operation.
export function setTestCoordinator(db,c){c.injected=true;contexts.set(db,c);}
