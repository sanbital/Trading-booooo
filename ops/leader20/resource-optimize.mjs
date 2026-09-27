import {execFileSync} from 'node:child_process';
import {writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const app='sanbital-doa-capture-20260925',id='185030da006d48',project='etaajwpernzrcdrifdnw';
mkdirSync('release-evidence',{recursive:true});
const evidence={source_commit:process.env.GITHUB_SHA,app,id,validation_orders:0,samples:[]};
const save=()=>writeFileSync('release-evidence/resource-optimization.json',JSON.stringify(evidence,null,2));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function machines(){const r=await fetch('https://api.machines.dev/v1/apps/'+app+'/machines',{
 headers:{authorization:'Bearer '+process.env.FLY_API_TOKEN},signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error('FLY_READ_'+r.status);return r.json();}
async function query(query){const r=await fetch('https://api.supabase.com/v1/projects/'+project+'/database/query',{
 method:'POST',headers:{authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN,'content-type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error('DB_READ_'+r.status);return r.json();}
const sanitize=m=>({id:m.id,state:m.state,region:m.region,guest:m.config?.guest,image:m.config?.image,
 mounts:m.config?.mounts?.length??0,services:m.config?.services?.length??0});
const canonical=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
const configHash=m=>{const {guest,...rest}=m.config;return createHash('sha256').update(canonical(rest)).digest('hex');};
const current=await machines();if(current.length!==1||current[0].id!==id)throw Error('UNEXPECTED_MACHINE_SET');
const before=current[0];evidence.before=sanitize(before);evidence.nonresource_config_hash=configHash(before);save();
if(before.state!=='started'||before.config.guest.cpu_kind!=='shared'||before.config.guest.cpus!==4||before.config.guest.memory_mb!==1024)throw Error('UNEXPECTED_BASELINE');
const ctl=(await query("select c.active_strategy,c.watch_limit,s.pause_new_entries,(select count(*) from v11_long_regime_positions where state='OPEN' or remaining_quantity>0.000000001 or metadata->>'exitAccountingPending'='true') exposure from leader20_control c cross join trading_settings s where c.singleton and s.id=1"))[0];
if(ctl.active_strategy!=='PAUSED'||ctl.watch_limit!==10||!ctl.pause_new_entries||Number(ctl.exposure)!==0)throw Error('QUIESCENT_TOP10_REQUIRED');
function resize(cpus,memory){try{execFileSync('flyctl',['machine','update',id,'--app',app,'--vm-cpus',String(cpus),'--vm-memory',String(memory),'--yes','--wait-timeout','120'],{stdio:'pipe',timeout:150000});}catch{throw Error('FLY_RESOURCE_UPDATE_FAILED');}}
let changed=false;
try{
 changed=true;resize(1,256);evidence.resized_at=new Date().toISOString();save();
 const after=(await machines())[0];evidence.after=sanitize(after);save();
 if(after.id!==id||configHash(after)!==evidence.nonresource_config_hash||after.config.guest.cpus!==1||after.config.guest.memory_mb!==256)throw Error('RESOURCE_ONLY_UPDATE_PARITY');
 const started=Date.now();let healthySince=null;const seenFresh=new Set();
 while(Date.now()-started<16*60000){
  const s=(await query("with c as(select * from leader20_control where singleton), x as(select m.symbol,doa_context_for_role_v1(m.symbol,now(),'TRADE_CANDIDATE',null) ctx from leader20_members m,c where m.epoch_id=c.epoch_id and m.rank<=c.watch_limit) select now() at,extract(epoch from now()-d.heartbeat_at) heartbeat_age,d.metrics->>'rss_bytes' rss,d.metrics->>'watched' watched,d.metrics->>'synced' synced,d.metrics->>'rest_failures' rest_failures,d.metrics->>'order_calls' order_calls,d.metrics->>'llm_calls' llm_calls,(select jsonb_agg(symbol) from x where ctx->>'status'='AVAILABLE' and (ctx->>'buckets')::int=24 and (ctx->>'end_ms')::numeric>extract(epoch from now())*1000-10000) fresh_symbols from doa_capture.control d where id=1"))[0];
  evidence.samples.push(s);for(const symbol of s.fresh_symbols??[])seenFresh.add(symbol);
  const healthy=Number(s.heartbeat_age)<20&&Number(s.rss)>0&&Number(s.rss)<220*1024*1024&&Number(s.watched)===11&&Number(s.synced)>=10&&Number(s.order_calls)===0&&Number(s.llm_calls)===0;
  healthySince=healthy?(healthySince??Date.now()):null;
  evidence.healthy_seconds=healthySince?(Date.now()-healthySince)/1000:0;evidence.distinct_fresh_symbols=seenFresh.size;save();
  if(healthySince&&Date.now()-healthySince>=10*60000&&seenFresh.size>=10){evidence.verified=true;save();console.log(JSON.stringify({verified:true,guest:evidence.after.guest,samples:evidence.samples.length,healthy_seconds:evidence.healthy_seconds}));break;}
  await sleep(30000);
 }
 if(!evidence.verified)throw Error('SMALL_MACHINE_HEALTH_NOT_PROVEN');
}catch(error){
 evidence.error=String(error.message);save();
 if(changed){try{resize(4,1024);evidence.restored_original_resources=true;}catch{evidence.restore_failed=true;}save();}
 throw Error(evidence.error);
}
