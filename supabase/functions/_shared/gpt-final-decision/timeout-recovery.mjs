/** A transport deadline is not a market decision. Retries always buy a NEW review,
 * inside the original trigger and budget; no failed answer grants order authority. */
export const TIMEOUT_RECOVERY=Object.freeze({version:'FRESH_TIMEOUT_RECOVERY_1',maxAttempts:4,minRemainingMs:15000,waitMs:45000});
export function isReviewTimeout(result){
  return result?.valid!==true&&['API_TIMEOUT','FD_ARBITRATION_NO_TIME','FD_ARBITRATION_EXPIRED',
    'DYNAMIC_TRAJECTORY_STALE_OR_FUTURE'].includes(result?.error);
}
export function canRecoverTimeout(result,{now,deadline,attempt=1}){
  return isReviewTimeout(result)&&Number.isSafeInteger(result.completed_at_ms)&&result.completed_at_ms<=now&&
    Number.isSafeInteger(attempt)&&attempt>0&&attempt<TIMEOUT_RECOVERY.maxAttempts&&
    Number.isFinite(deadline)&&deadline-now>=TIMEOUT_RECOVERY.minRemainingMs;
}
/** Start every continuation through its ordinary cycle entry point, after the
 * preceding cycle has released its lease. Also used by the order-free probe. */
export async function resumeReviewTimeouts(runCycle,{now=Date.now,enabled=()=>true}={}){
  const started=now();let result=await runCycle();
  for(let i=1;i<TIMEOUT_RECOVERY.maxAttempts&&result?.entry?.reviewRetryPending===true&&
    result?.ok!==false&&!result?.skipped&&enabled()&&now()-started<TIMEOUT_RECOVERY.waitMs;i++)result=await runCycle();
  return result;
}
