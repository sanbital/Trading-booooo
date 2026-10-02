const ALLOWED_ENDPOINTS=new Set(['market-autotrader','v10-lane-executor','v10-lane-signal-generator',
  'market-v2-signal','doa-capture-ingest','market-regime-observer']);
const AUTH_HEADERS={
  'market-autotrader':'x-autotrade-token','v10-lane-executor':'x-v10-executor-token',
  'v10-lane-signal-generator':'x-v10-lane-token','market-v2-signal':'x-v2-signal-token',
  'doa-capture-ingest':'x-doa-capture-token','market-regime-observer':'x-regime-token',
};
const error=status=>Object.assign(new Error(`DEPENDENCY_HTTP_${status}`),{status});
export function createSchedulerRepository({url,key,fetchImpl=fetch}) {
  const request=async(path,body,signal)=>{
    if(!url||!key)throw Error('scheduler DB credentials missing');
    const response=await fetchImpl(`${url}/rest/v1/${path}`,{
      method:body===undefined?'GET':'POST',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(2500)]):AbortSignal.timeout(2500),
      headers:{apikey:key,Authorization:`Bearer ${key}`,'content-type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
    });
    if(!response.ok)throw error(response.status);
    // PostgreSQL void RPCs return HTTP 204 with no JSON document. The SQL
    // completed successfully; parsing that empty body is not a job failure.
    if(response.status===204)return null;
    const bodyText=await response.text();
    return bodyText.trim()?JSON.parse(bodyText):null;
  };
  const args=l=>({p_scheduler:l.scheduler_key,p_owner:l.owner,p_fence:l.fence});
  const rpc=(name,body,signal)=>request(`rpc/${name}`,body,signal);
  return {
    rpc,
    lead:(scheduler,owner)=>rpc('trading_scheduler_lead',{p_scheduler:scheduler,p_owner:owner}),
    heartbeat:l=>rpc('trading_scheduler_heartbeat',args(l)),
    jobs:scheduler=>request(`trading_scheduler_jobs?scheduler_key=eq.${encodeURIComponent(scheduler)}&enabled=eq.true&select=*`),
    claim:(l,job)=>rpc('trading_scheduler_claim',{...args(l),p_job:job}),
    finish:(l,job,result)=>rpc('trading_scheduler_finish',{...args(l),p_job:job.job_key,p_tick:job.tick,
      p_state:result.state,p_result:result.result,p_retry_ms:result.retryMs??0,
      p_permanent:result.permanent??false,p_cursor:result.cursor??null}),
    // Read only an endpoint's internal credential. It is never part of job/log state.
    token:async(name,signal)=>{
      const rows=await request(`edge_internal_tokens?name=eq.${encodeURIComponent(name)}&select=token&limit=1`,undefined,signal);
      if(!rows[0]?.token)throw Object.assign(Error('ENDPOINT_TOKEN_MISSING'),{status:401});
      return rows[0].token;
    },
  };
}
export function createScheduledJobRunner({url,repository,staticTokens={},fetchImpl=fetch}) {
  return async(job,{signal})=>{
    const target=job.target;
    if(target?.rpc) {
      const bound={gpt_final_review_expire:{max:100,fallback:30},leader20_clock_telemetry_maintain:{args:{}},leader20_entry_reservation_sweep:{args:{}},leader20_execution_expire:{max:100,fallback:30},gpt_final_review_recover_ready:{max:100,fallback:30},trading_scheduler_trim_ticks:{max:5000,fallback:5000}}[target.rpc];
      if(!bound)throw Object.assign(Error('UNREGISTERED_JOB_RPC'),{status:400});
      return repository.rpc(target.rpc,bound.args??{p_limit:Math.min(bound.max,Math.max(1,target.limit??bound.fallback))},signal);
    }
    if(!ALLOWED_ENDPOINTS.has(target?.endpoint))throw Object.assign(Error('UNREGISTERED_JOB_ENDPOINT'),{status:400});
    const header=AUTH_HEADERS[target.endpoint];
    if(!header)throw Object.assign(Error('ENDPOINT_AUTH_NOT_AUDITED'),{status:400});
    const token=staticTokens[target.endpoint]??await repository.token(target.token_name??target.endpoint,signal);
    if(!token)throw Object.assign(Error('ENDPOINT_TOKEN_MISSING'),{status:401});
    const response=await fetchImpl(`${url}/functions/v1/${target.endpoint}`,{
      method:'POST',signal,headers:{'content-type':'application/json',[header]:token,
        'x-scheduler-idempotency-key':job.idempotency_key},
      body:JSON.stringify({...target.body,scheduler:{key:job.scheduler_key,job:job.job_key,
        tick:job.tick,owner:job.owner,fence:job.fence,idempotency_key:job.idempotency_key},
        ...(job.recovery_mode==='DURABLE_CURSOR'?{recovery_cursor:job.cursor,catchup_limit:target.catchup_limit??30}:{}),
      }),
    });
    if(!response.ok)throw error(response.status);
    const result=await response.json();
    if(result?.ok===false)throw Object.assign(Error('ENDPOINT_REPORTED_FAILURE'),{status:503});
    return result;
  };
}
