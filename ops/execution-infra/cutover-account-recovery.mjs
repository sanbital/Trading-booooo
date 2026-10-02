/** Recovery is venue reads, attribution and native protection only. It grants no BUY
 * or historical tick replay, even if the old cron was already paused at DB restart. */
export async function recoverAccountAtCutover({project,accessToken,fetchImpl=fetch}){
 const url=`https://${project}.supabase.co`;
 const r=await fetchImpl(`https://api.supabase.com/v1/projects/${project}/api-keys?reveal=true`,{
  headers:{authorization:`Bearer ${accessToken}`},signal:AbortSignal.timeout(5000)});
 if(!r.ok)throw Error('CUTOVER_RECOVERY_KEY_UNAVAILABLE');
 const keys=await r.json(),key=keys.find(k=>k.name==='service_role')?.api_key;if(!key)throw Error('CUTOVER_RECOVERY_KEY_MISSING');
 const t=await fetchImpl(`${url}/rest/v1/edge_internal_tokens?name=eq.v10-lane-executor&select=token&limit=1`,{
  headers:{apikey:key,authorization:`Bearer ${key}`},signal:AbortSignal.timeout(2500)});
 if(!t.ok)throw Error('CUTOVER_RECOVERY_AUTH_UNAVAILABLE');const token=(await t.json())[0]?.token;if(!token)throw Error('CUTOVER_RECOVERY_AUTH_MISSING');
 const p=await fetchImpl(`${url}/functions/v1/v10-lane-executor`,{method:'POST',
  headers:{'content-type':'application/json','x-v10-executor-token':token},body:JSON.stringify({mode:'account-recovery'}),signal:AbortSignal.timeout(30000)});
 if(!p.ok)throw Error('CUTOVER_RECOVERY_UNAVAILABLE');const result=await p.json();if(result.ready!==true)throw Error('CUTOVER_RECONCILIATION_INCOMPLETE');return true;
}
