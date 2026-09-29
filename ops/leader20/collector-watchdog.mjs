// Third layer of collector survival (2026-09-29). Runs OUTSIDE both the worker and Fly.
//
// Layer 1 keeps the worker alive through transport failures; layer 2 makes Fly restart it if the
// process dies. Neither covers the case that actually happened: the machine gone, or wedged in a
// state where it is "running" but no longer streaming. This job watches the one fact that cannot
// lie -- the heartbeat the collector writes on every ingest -- and forces recovery.
//
// It never changes trading state: no capacity, no admission, no order, no capture policy. It only
// starts or restarts the collector machine, and reports what it saw.
const project='etaajwpernzrcdrifdnw';
const app='sanbital-doa-capture-20260925';
const STALE_MS=Number(process.env.WATCHDOG_STALE_MS??180000);
const token=process.env.FLY_API_TOKEN,access=process.env.SUPABASE_ACCESS_TOKEN;
if(!token||!access)throw Error('WATCHDOG_CREDENTIALS_MISSING');
if(!(STALE_MS>=120000))throw Error('WATCHDOG_STALE_MS_TOO_TIGHT');

const out={checked_at:new Date().toISOString(),stale_threshold_ms:STALE_MS,action:'NONE'};
const fail=m=>{out.error=m;console.log(JSON.stringify(out,null,2));process.exit(1);};

// The management query API can be unavailable on its own: on 2026-09-29 it returned HTTP 544 to a
// GitHub runner while the project still reported ACTIVE_HEALTHY. A watchdog that gives up on the
// first failure is not a watchdog, so retry before concluding anything about the collector.
async function query(sql,attempts=4){
 let last;
 for(let i=1;i<=attempts;i++){
  try{
   const r=await fetch(`https://api.supabase.com/v1/projects/${project}/database/query`,
    {method:'POST',headers:{Authorization:'Bearer '+access,'Content-Type':'application/json'},
     body:JSON.stringify({query:sql}),signal:AbortSignal.timeout(30000)});
   if(r.ok)return r.json();
   last='SUPABASE_QUERY_'+r.status;
  }catch(e){last='SUPABASE_QUERY_'+(e.name==='TimeoutError'?'TIMEOUT':'NETWORK');}
  if(i<attempts)await new Promise(r=>setTimeout(r,i*5000));
 }
 throw Error(last);
}
// Is the project's own runtime serving, independent of the management API? The 2026-09-29 outage
// showed "the control plane cannot answer" and "the platform is down" are different failures,
// and only the second one means trading is actually blind.
async function runtimeReachable(){
 try{
  const r=await fetch(`https://${project}.supabase.co/functions/v1/doa-capture-ingest`,
   {method:'POST',headers:{'Content-Type':'application/json'},body:'{}',
    signal:AbortSignal.timeout(15000)});
  return {reachable:true,status:r.status};
 }catch(e){return {reachable:false,status:null,error:e.name};}
}
async function machines(path='',method='GET',body){
 const r=await fetch(`https://api.machines.dev/v1/apps/${app}/machines`+path,
  {method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},
   ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});
 if(!r.ok)throw Error('MACHINE_HTTP_'+r.status);
 return r.status===200?r.json():{};
}

out.runtime=await runtimeReachable();
// The control row is the authority on whether capture is supposed to be running at all. A
// deliberately disabled or ended collector is NOT an outage and must never be restarted.
const [c]=await query(`select enabled,
 extract(epoch from (clock_timestamp()-heartbeat_at))*1000 heartbeat_age_ms,
 ends_at<=clock_timestamp() window_ended,
 (select count(distinct symbol) from doa_capture.live_micro
   where kind='micro' and at>clock_timestamp()-interval '90 seconds') streaming
 from doa_capture.control where id=1`).catch(e=>fail(String(e.message)));
if(!c)fail('CONTROL_ROW_MISSING');
out.control={enabled:c.enabled,heartbeat_age_ms:Math.round(Number(c.heartbeat_age_ms)),
 window_ended:c.window_ended,streaming_symbols:Number(c.streaming)};

if(!c.enabled){out.action='NONE';out.reason='COLLECTOR_DISABLED_BY_OPERATOR';}
else if(c.window_ended){out.action='NONE';out.reason='CAPTURE_WINDOW_ENDED';}
else if(!(Number(c.heartbeat_age_ms)>STALE_MS)){out.action='NONE';out.reason='HEARTBEAT_HEALTHY';}
else{
 out.reason='HEARTBEAT_STALE';
 const list=await machines().catch(e=>fail(String(e.message)));
 out.machines=list.map(m=>({id:m.id,state:m.state,restart:m.config?.restart??null}));
 if(list.length!==1)fail('EXPECTED_ONE_COLLECTOR_FOUND_'+list.length);
 const m=list[0];
 // Started but not streaming is the wedged case: replace the process, do not just poke it.
 out.action=m.state==='started'?'RESTART':'START';
 await machines(`/${m.id}/${m.state==='started'?'restart':'start'}`,'POST').catch(e=>fail(String(e.message)));
 // Recovery is only real once the heartbeat moves again.
 for(let i=0;i<20;i++){
  await new Promise(r=>setTimeout(r,15000));
  const [v]=await query(`select extract(epoch from (clock_timestamp()-heartbeat_at))*1000 age
   from doa_capture.control where id=1`).catch(()=>[null]);
  const age=v&&Math.round(Number(v.age));
  if(Number.isFinite(age)&&age<60000){out.recovered=true;out.heartbeat_age_after_ms=age;break;}
 }
 if(!out.recovered)fail('COLLECTOR_DID_NOT_RESUME');
}
console.log(JSON.stringify(out,null,2));
