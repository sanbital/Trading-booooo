/** A transport deadline is not a market decision. Retries always buy a NEW review,
 * inside the original trigger and budget; no failed answer grants order authority. */
export const TIMEOUT_RECOVERY=Object.freeze({version:'FRESH_TIMEOUT_RECOVERY_1',maxAttempts:4,minRemainingMs:15000,waitMs:45000});
export function isReviewTimeout(result){
  return result?.valid!==true&&(['API_TIMEOUT','FD_ARBITRATION_NO_TIME','FD_ARBITRATION_EXPIRED'].includes(result?.error)||
    result?.error==='DYNAMIC_TRAJECTORY_STALE_OR_FUTURE'&&
      result?.dynamic_audit?.latency_budget?.expired_during_inference===true);
}
/** Acquisition delay is recoverable, but is not a provider timeout or a market opinion. */
export function isReviewRecoverable(result){
  return isReviewTimeout(result)||result?.valid!==true&&['DYNAMIC_INFERENCE_CAPTURE_NOT_READY','RETRY_CAPTURE_NOT_ADVANCED',
    'RC_RETRY_CAPTURE_NOT_ADVANCED','RC_BATCH_CAPTURE_NOT_ADVANCED',
    'DYNAMIC_TRAJECTORY_STALE_OR_FUTURE'].includes(result?.error);
}
/** A missing intermediate capture must never erase the last reviewed bucket. */
export function reviewedCaptureEnd(record){
  const ends=[record?.packet?.facts?.capture_context?.end_ms,record?.after_capture_end_ms,record?.timeout_recovery?.after_end_ms]
    .filter(Number.isSafeInteger);
  return ends.length?Math.max(...ends):null;
}
export function canRecoverTimeout(result,{now,deadline,attempt=1}){
  return isReviewRecoverable(result)&&Number.isSafeInteger(result.completed_at_ms)&&result.completed_at_ms<=now&&
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
