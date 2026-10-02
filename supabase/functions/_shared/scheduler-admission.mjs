/** Call only AFTER the endpoint's existing authentication. No scheduler credential
 * can grant trading authority. The DB binds each tick to its audited target/body.
 */
export async function admitSchedulerRequest({endpoint,body,rpc}) {
  const envelope=body?.scheduler;
  const {scheduler,recovery_cursor,catchup_limit,...payload}=body??{};
  const result=await rpc('trading_scheduler_admit',{
    p_endpoint:endpoint,p_body:payload,p_envelope:envelope??null,
  });
  if(result?.error)throw Error('SCHEDULER_ADMISSION_DB_UNAVAILABLE');
  const state=result?.data??result;
  return {allowed:state==='LEGACY_ALLOWED'||state==='ACCEPTED',reason:state};
}
