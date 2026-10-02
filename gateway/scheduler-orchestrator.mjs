// One clock, per-job single-flight, database leader/tick fencing. No replay of old ticks.
export function dependencyFailure(error) {
  const status=Number(error?.status);
  if (status===429) return {retryable:true,code:'RATE_LIMIT'};
  if (status>=400 && status<500) return {retryable:false,permanent:true,code:`HTTP_${status}`};
  if (status>=500) return {retryable:true,code:`HTTP_${status}`};
  const message=String(error?.message??error);
  if (/connection refused|ECONNREFUSED|connection reset|ECONNRESET|EAI_AGAIN|ENOTFOUND|DNS|timeout|timed out|fetch failed|AbortError|DB_DEGRADED/i.test(message)) {
    return {retryable:true,code:'DEPENDENCY_UNAVAILABLE'};
  }
  if (/SCHEDULER_FENCED/.test(message)) return {retryable:true,code:'SCHEDULER_FENCED'};
  return {retryable:true,code:'JOB_INTERNAL_ERROR'};
}
export function retryDelayMs(failures,{baseMs=30000,maxMs=60000,random=Math.random}={}) {
  const bound=Math.min(maxMs,baseMs*2**Math.min(Math.max(0,failures-1),10));
  return Math.floor(bound*(.5+.5*Math.max(0,Math.min(1,random()))));
}
export function createSchedulerOrchestrator({repository,runJob,recover,breaker,
  owner=crypto.randomUUID(),schedulerKey='trading-production',now=Date.now,timers=globalThis,
  onEvent=()=>{},random=Math.random}) {
  let stopped=true,clock,lease=null,refreshRunning=false,nextRefresh=0,recovered=false;
  let recoveryTask=null,recoveryController=null,jobsCache=[],catalogAt=-Infinity;
  const due=new Map();
  const running=new Map(),state={heartbeatAt:null,leader:false,fence:null,jobs:{},lastError:null};
  const note=(job,result)=>{
    state.jobs[job]={...(state.jobs[job]??{}),...result};
    onEvent({job_key:job,...result});
  };
  const fail=error=>{
    const classified=dependencyFailure(error);
    state.lastError=classified.code;
    if (classified.retryable) breaker.open(now());
    lease=null;recovered=false;state.leader=false;
    recoveryController?.abort();
  };
  async function refresh() {
    if (refreshRunning || now()<nextRefresh || breaker.suppressed(now())) return;
    refreshRunning=true;
    try {
      if (!lease) {
        lease=await repository.lead(schedulerKey,owner);
        if (!lease) {nextRefresh=now()+3000;return;}
        recovered=false;
      } else if (!(await repository.heartbeat(lease))) throw Error('SCHEDULER_FENCED');
      state.leader=true;state.fence=lease.fence;
      state.heartbeatAt=new Date(now()).toISOString();nextRefresh=now()+3000;
      breaker.clear();state.lastError=null;
      if (!recovered && !recoveryTask) {
        // Recovery adapter must query open orders, positions, ambiguous orders,
        // fills, native protection and capacity, in that order, before clearing freeze.
        const recoveringLease=lease;
        recoveryController=new AbortController();
        recoveryTask=Promise.resolve().then(()=>recover(recoveringLease,{signal:recoveryController.signal}));
        recoveryTask.then(ok=>{if(lease?.fence===recoveringLease.fence)recovered=ok===true;},fail)
          .finally(()=>{recoveryTask=null;});
      }
    } catch(error) {fail(error);}
    finally {refreshRunning=false;}
  }
  async function launch(job,heldLease) {
    if (running.has(job.job_key)) return;
    const controller=new AbortController();
    let timeout,work;
    const task=(async()=>{
      let claim;
      try {
        claim=await repository.claim(heldLease,job.job_key);
        if (!claim) return;
        note(job.job_key,{lastStart:new Date(now()).toISOString(),result:'STARTED',tick:claim.idempotency_key});
        const timeoutPromise=new Promise((_,reject)=>{
          timeout=timers.setTimeout(()=>{controller.abort();reject(new Error('job timeout'));},job.timeout_ms);
        });
        work=Promise.resolve().then(()=>runJob(claim,{signal:controller.signal,lease:heldLease}));
        const result=await Promise.race([work,timeoutPromise]);
        if (result?.status==='DB_DEGRADED') throw Error('DB_DEGRADED');
        if (result?.ok===false) throw Error('JOB_REPORTED_FAILURE');
        const outcome=result?.skipped?'SKIPPED':'SUCCEEDED';
        const succeeded=await repository.finish(heldLease,claim,{state:'SUCCEEDED',result:outcome,
          cursor:result?.cursor??null});
        if (!succeeded) throw Error('SCHEDULER_FENCED');
        note(job.job_key,{lastSuccess:new Date(now()).toISOString(),result:outcome});
      } catch(error) {
        const classified=dependencyFailure(error);
        note(job.job_key,{result:classified.code});
        if (claim) {
          try {await repository.finish(heldLease,claim,{state:controller.signal.aborted?'UNKNOWN':'FAILED',
            result:classified.code,retryMs:classified.retryable?retryDelayMs((job.failure_count??0)+1,{random}):0,
            permanent:classified.permanent===true});} catch(finishError) {fail(finishError);}
        }
        // Endpoint errors affect this job. DB transport/claim errors affect readiness.
        if (!claim || /DB_DEGRADED|SCHEDULER_FENCED/.test(String(error.message))) fail(error);
      } finally {
        if (timeout!==undefined) timers.clearTimeout(timeout);
        controller.abort();
        // Do not start another instance if an adapter ignored AbortSignal. Other
        // jobs continue; this job retains its bulkhead until actual work settles.
        if (work) await work.catch(()=>{});
      }
    })();
    running.set(job.job_key,{task,controller});
    task.finally(()=>running.delete(job.job_key));
  }
  async function tick() {
    if (stopped) return;
    state.processHeartbeatAt=new Date(now()).toISOString();
    await refresh();
    if (!lease || breaker.suppressed(now()) || refreshRunning) return;
    try {
      if (now()-catalogAt>=30000) {jobsCache=await repository.jobs(schedulerKey);catalogAt=now();}
      const heldLease=lease;
      for (const job of jobsCache) {
        if (!job.enabled || (job.requires_recovery && !recovered)) continue;
        if (now()<(due.get(job.job_key)??-Infinity)) continue;
        due.set(job.job_key,now()+job.period_ms);
        launch(job,heldLease);
      }
    } catch(error) {fail(error);}
  }
  return {
    state, tick,
    start() {if(!stopped)return;stopped=false;clock=timers.setInterval(()=>{tick().catch(fail);},1000);clock?.unref?.();},
    async stop() {stopped=true;timers.clearInterval(clock);for(const r of running.values())r.controller.abort();
      recoveryController?.abort();
      // A hung adapter cannot prevent the scheduler shutdown path.
      lease=null;recovered=false;state.leader=false;},
    activeJobs:()=>[...running.keys()],
  };
}
