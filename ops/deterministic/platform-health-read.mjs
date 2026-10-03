// Allowlisted, read-only platform observations. Never reveal keys, read host files,
// execute a trading cycle, or change database/project configuration.
export const PROJECT = 'etaajwpernzrcdrifdnw';
const metricNames = /^(node_memory_(MemTotal|MemAvailable|MemFree|SwapTotal|SwapFree)_bytes|node_load[15]|node_load15|node_cpu_seconds_total|node_vmstat_oom_kill|node_boot_time_seconds|node_procs_(running|blocked)|process_resident_memory_bytes|process_cpu_seconds_total|pg_up|pg_settings_max_connections|pg_stat_activity_count|pg_stat_database_numbackends)$/;
export function summarizeMetrics(raw) {
 const samples=[];
 for(const line of raw.split('\n')) {
  const m=line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([-+0-9.eE]+)(?:\s+\d+)?$/);
  if(!m||!metricNames.test(m[1])||!Number.isFinite(Number(m[3])))continue;
  const labels={};for(const l of (m[2]??'').matchAll(/(\w+)="([^"]*)"/g))if(['cpu','mode','state','backend_type'].includes(l[1])&&/^[a-zA-Z0-9 _-]{1,48}$/.test(l[2]))labels[l[1]]=l[2];
  samples.push({name:m[1],labels,value:Number(m[3])});
 }
 return samples;
}
export function summarizeConfig(value) {
 const result={};
 for(const name of ['max_connections','max_worker_processes','max_parallel_workers','shared_buffers','work_mem','maintenance_work_mem','effective_cache_size','statement_timeout','default_pool_size','max_client_conn','pool_mode']) {
  const v=value?.[name];if(typeof v==='number'&&Number.isFinite(v)||typeof v==='string'&&/^[a-zA-Z0-9 .-]{1,48}$/.test(v))result[name]=v;
 }
 return result;
}
export function summarizeHealth(value) {
 const rows=Array.isArray(value)?value:Array.isArray(value?.services)?value.services:[];
 return rows.map(v=>Object.fromEntries(['name','service','status'].filter(k=>typeof v?.[k]==='string'&&/^[a-zA-Z0-9 _.-]{1,64}$/.test(v[k])).map(k=>[k,v[k]])));
}
export async function readPlatform({token,fetchImpl=fetch}) {
 if(!token)throw Error('PLATFORM_TOKEN_MISSING');
 const specs=[['health','health?services=db&services=db_postgres_user&services=rest&services=pooler',summarizeHealth],['postgres_config','config/database/postgres',summarizeConfig],['pooler_config','config/database/pooler',summarizeConfig],['metrics','analytics/endpoints/metrics',summarizeMetrics]];
 const results=await Promise.all(specs.map(async([name,path,summarize])=>{
  const start=Date.now();try {
   const r=await fetchImpl(`https://api.supabase.com/v1/projects/${PROJECT}/${path}`,{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)});
   if(!r.ok)return [name,{ok:false,http:r.status,ms:Date.now()-start}];
   const value=summarize(name==='metrics'?await r.text():await r.json());
   return [name,{ok:true,utc:new Date().toISOString(),ms:Date.now()-start,value}];
  }catch(e){return [name,{ok:false,error:e.name==='TimeoutError'?'TIMEOUT':'REQUEST_FAILED',ms:Date.now()-start}];}
 }));
 return Object.fromEntries(results);
}
