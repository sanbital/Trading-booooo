// @ts-nocheck
// No Binance credentials, order endpoints, shell, dynamic imports, SQL or generated code.
import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import {EvolutionStore} from './store.mjs';
import {tradeReview,patternReview} from './research.mjs';
import {marketScan,opportunity,matureOutcomes} from './market-jobs.mjs';
import {simulationJob,validationJob,monitor} from './validation.mjs';
const VERSION='SELF_EVOLUTION_WORKER_1';
const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string'||a.length<32||a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;};
export async function tick(store,keys){
 const now=Date.now(),ingested=await store.rpc('evolution_ingest');
 await store.enqueue('monitor:'+Math.floor(now/300000),'MONITOR',{},1);
 await store.enqueue('outcomes:'+Math.floor(now/600000),'OUTCOMES',{},15);
 await store.enqueue('market:'+Math.floor(now/3600000),'MARKET_SCAN',{},30);
 await store.enqueue('patterns:'+Math.floor(now/21600000),'PATTERN_REVIEW',{},50);
 await store.enqueue('full:'+Math.floor(now/86400000),'FULL_REVIEW',{},60);
 const job=await store.rpc('evolution_claim_job');if(!job){await store.rpc('evolution_worker_heartbeat',{p_version:VERSION});return {ok:true,idle:true,ingested};}
 try{let result;switch(job.kind){
  case 'TRADE_REVIEW':result=await tradeReview(store,job.payload.trade_id,keys);break;
  case 'PATTERN_REVIEW':result=await patternReview(store,keys);break;
  case 'FULL_REVIEW':result=await patternReview(store,keys,{full:true,...job.payload});break;
  case 'MARKET_SCAN':result=job.payload.symbol?await opportunity(store,job.payload):await marketScan(store);break;
  case 'OUTCOMES':result=await matureOutcomes(store);break;
  case 'SIMULATE':result=await simulationJob(store,job.payload.policy_version,keys);break;
  case 'VALIDATE':result=await validationJob(store,job.payload.policy_version);break;
  case 'MONITOR':result=await monitor(store);break;
  default:throw Error('RESEARCH_JOB_KIND');}
  const done=await store.rpc('evolution_finish_job',{p_id:job.id,p_owner:job.owner,p_result:result});
  if(!done)throw Error('JOB_LEASE_LOST');await store.rpc('evolution_worker_heartbeat',{p_version:VERSION});
  console.log(JSON.stringify({version:VERSION,job:job.id,kind:job.kind,state:'DONE',elapsed_ms:Date.now()-now,result}));
  return {ok:true,version:VERSION,job:job.id,kind:job.kind,result,ingested,order_calls:0};
 }catch(e){const error=String(e?.message??e).slice(0,280);await store.rpc('evolution_finish_job',{p_id:job.id,p_owner:job.owner,p_result:null,p_error:error});
  await store.rpc('evolution_worker_heartbeat',{p_version:VERSION,p_error:error});console.error(JSON.stringify({version:VERSION,job:job.id,kind:job.kind,error}));return {ok:false,job:job.id,kind:job.kind,error,order_calls:0};}
}
Deno.serve(async req=>{
 if(req.method!=='POST')return reply(405,{error:'POST_ONLY'});
 const db=createClient(Deno.env.get('SUPABASE_URL'),Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false}}),store=new EvolutionStore(db);
 try{const token=await db.from('edge_internal_tokens').select('token').eq('name','self-evolution-worker').single();
  if(token.error||!equal(req.headers.get('x-evolution-token'),token.data?.token))return reply(401,{error:'UNAUTHORIZED'});
  const raw=await req.text();if(raw.length>1000)return reply(413,{error:'BODY_LIMIT'});const body=raw?JSON.parse(raw):{};
  if(Object.keys(body).some(k=>k!=='action')||body.action&&!['tick','status'].includes(body.action))return reply(400,{error:'ACTION_DENIED'});
  if(body.action==='status')return reply(200,await store.rpc('evolution_report'));
  return reply(200,await tick(store,{gpt:Deno.env.get('OPENAI_API_KEY'),deepseek:Deno.env.get('deepseek api')}));
 }catch(e){console.error('EVOLUTION_REQUEST_FAILED',String(e?.message??e).slice(0,200));return reply(500,{error:'EVOLUTION_REQUEST_FAILED'});}
});
