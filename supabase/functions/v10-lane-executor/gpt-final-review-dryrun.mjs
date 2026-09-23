// Order-free production dry run of the GPT final review path (operator/verification only).
// Builds an ISOLATED coordinator (purpose=DRYRUN): the live entry path's coordinator,
// control row, tickets and hints are never touched. It never claims signals, writes
// orders, positions, incidents or audit rows; the only writes are DRYRUN journal rows.
import {FinalReviewCoordinator,RELEASE} from '../_shared/gpt-final-review/coordinator.mjs';
import {SupabaseReviewStore} from '../_shared/gpt-final-review/supabase-store.mjs';
import {collectMarket} from '../_shared/gpt-final-review/market.mjs';
import {baselineAllowed} from '../_shared/gpt-final-review/contract.mjs';
export const DRYRUN_BUDGET=Object.freeze({capUsd:1.5,maxCalls:150});
/** A real engine-approved candidate is replayed on a clock shifted to trigger+offset so the
 * reviewer sees the point-in-time market and every TTL/freshness rule applies unchanged. */
export function replayClock(triggerAt,offsetMs,realNow=Date.now){
  const shift=realNow()-(triggerAt+offsetMs);return ()=>realNow()-shift;
}
export function dryRunCoordinator(db,{triggerAt,offsetMs=4000,runId,apiKey,fetchFn=fetch}){
  const now=replayClock(triggerAt,offsetMs);
  return new FinalReviewCoordinator({config:{mode:'ENFORCE',modeValid:true,approvalRef:'DRYRUN:'+String(runId).slice(0,60),
    apiBudgetUsd:DRYRUN_BUDGET.capUsd,maxCalls:DRYRUN_BUDGET.maxCalls,enforceApproved:true,source:'DRYRUN'},
    store:new SupabaseReviewStore(db),apiKey:()=>apiKey,fetchFn,now,purpose:'DRYRUN',
    market:(identity,opts)=>collectMarket(identity,{...opts,now})});
}
/** Phase 1, OUTSIDE any execution lease: claim + API + durable completion. */
export async function dryRunReviewPhase(c,s){
  const t0=Date.now(),first=await c.consider(s);
  const pending=[...c.pending.values()];
  await Promise.all(pending);
  return {first:first.reason,apiTaskCreated:pending.length>0,elapsedMs:Date.now()-t0,baselineAllowed:baselineAllowed(s),release:RELEASE};
}
