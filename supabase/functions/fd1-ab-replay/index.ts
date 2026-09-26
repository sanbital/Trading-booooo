// @ts-nocheck
// FD1 ENTRY A/B replay (2026-09-26). ORDER-FREE and TRADING-STATE-FREE.
//
// One deployment per arm: the SAME entry file bundled with either the production FD1
// modules (arm BASE, facts FD1_FACTS_1) or the candidate modules (arm NEW, FD1_FACTS_2).
// Each job is a historical V17 decision point; the function reads only Binance history
// published before as_of (no order book), builds the arm's FD1 ENTRY packet exactly as
// production does (data_mode=REPLAY), asks GPT once and stores the validated answer in
// fd1_replay_jobs. It claims only its own run tag, uses the capped replay budget and never
// touches production GPT ledgers, signals, orders, positions or controls.
import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import {computeFacts,modelJudgments,FACTS_VERSION} from './gfd/facts.mjs';
import {readSources} from './gfd/market.mjs';
import {buildDecisionPacket,callDecision} from './gfd/api.mjs';
const ARM=FACTS_VERSION==='FD1_FACTS_1'?'BASE':'NEW',TAG='x26-'+ARM.toLowerCase();
const BATCH=18,CONCURRENCY=3,RESERVE_USD=0.02,WALL_MS=100_000;
const reply=(s,b)=>new Response(JSON.stringify(b),{status:s,headers:{'content-type':'application/json','cache-control':'no-store'}});
function eq(a,b){if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;}
const FACTORS=['absorption','volumeTails','fresh15over30','btcAnyUp','buyerShareRise','fresh5over15','recentHourLead'];
/** Compact job context -> the judgment block production builds from signal features (arm's own modelJudgments). */
export function expandContext(c){
  const [ref,dayReturn,rank,r5,c15,bAllowed,branch,bits,v30,v30failed,cecAction,cecPred]=c.k;
  const factors=Object.fromEntries(FACTORS.map((k,i)=>[k,bits?.[i]==='1'?true:bits?.[i]==='0'?false:null]));
  const features={strategy:'LEADER_MOMENTUM_V17',rank,dayReturn,return5m:r5,confirmationReturn15m:c15,v17Setup:{state:'TRIGGERED'},
    b06133:{allowed:bAllowed===1,branch,reason:bAllowed===1?'B06133_ALLOW':'B06133_REJECT',factors},
    v30Front:{admitted:v30===1,failed:v30failed?v30failed.split(','):[]},
    cec0040:cecAction?{action:cecAction,effectiveAllowed:cecAction!=='REJECT',ready:true,predictionUsdt:cecPred}:{}};
  return {referenceClose:ref,dayReturn,rank,judgments:modelJudgments(features),history:Array.isArray(c.history)?c.history:[]};
}
async function one(db,job,apiKey,btcCache){
  const c=expandContext(job.context),at=Number(job.as_of_ms);
  let result,packet=null;
  try{
    const {src,errors}=await readSources(job.symbol,at,{mode:'REPLAY',btcCache});
    // BASE ignores ctx.history (production has no trade memory); NEW computes it.
    const facts=computeFacts(src,{asOf:at,referenceClose:c.referenceClose,dayReturn:c.dayReturn,rank:c.rank,history:c.history});
    packet=await buildDecisionPacket({task:'ENTRY',subjectId:job.id,symbol:job.symbol,dataMode:'REPLAY',facts,judgments:c.judgments});
    const budget=await db.rpc('fd1_replay_reserve',{p_reserve:RESERVE_USD});
    if(budget.error||budget.data!==true)result={decision:'ABSTAIN',valid:false,error:'FD_REPLAY_BUDGET_EXHAUSTED',attempted:false,source_errors:errors};
    else{result=await callDecision(packet,{apiKey});result.source_errors=errors;
      await db.rpc('fd1_replay_settle',{p_reserve:RESERVE_USD,p_cost:Number(result.api_cost_usd??(result.http_status&&result.http_status>=400?0:RESERVE_USD))});}
  }catch(e){result={decision:'ABSTAIN',valid:false,error:'FD_REPLAY_PREP:'+String(e?.message??e).slice(0,80),attempted:false};}
  const up=await db.from('fd1_replay_jobs').update({state:'DONE',packet,result,decision:result.decision,valid:result.valid===true,
    error:result.error??null,api_cost_usd:result.api_cost_usd??0,latency_ms:result.latency_ms??null,completed_at:new Date().toISOString()})
    .eq('id',job.id).eq('state','RUNNING');
  if(up.error)throw Error('JOB_WRITE:'+up.error.message);
  return result.decision;
}
export async function run(db,apiKey){
  const started=Date.now();
  const pick=await db.from('fd1_replay_jobs').select('id').eq('run_tag',TAG).eq('state','NEW').order('as_of_ms').limit(BATCH);
  if(pick.error)throw Error('PICK:'+pick.error.message);
  const ids=(pick.data??[]).map(x=>x.id);
  const claim=ids.length?await db.from('fd1_replay_jobs').update({state:'RUNNING',claimed_at:new Date().toISOString()})
    .in('id',ids).eq('state','NEW').select('*'):{data:[]};
  if(claim.error)throw Error('CLAIM:'+claim.error.message);
  const jobs=claim.data??[],btcCache=new Map(),out={};let i=0;
  const worker=async()=>{while(i<jobs.length&&Date.now()-started<WALL_MS){const j=jobs[i++];const d=await one(db,j,apiKey,btcCache);out[d]=(out[d]??0)+1;}};
  await Promise.all(Array.from({length:CONCURRENCY},worker));
  return {ok:true,arm:ARM,tag:TAG,facts:FACTS_VERSION,claimed:jobs.length,decisions:out,orderCalls:0};
}
Deno.serve(async req=>{
  if(req.method!=='POST')return reply(405,{ok:false,error:'POST_ONLY'});
  const db=createClient(Deno.env.get('SUPABASE_URL')||'',Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'',{auth:{persistSession:false,autoRefreshToken:false}});
  const tok=await db.from('edge_internal_tokens').select('token').eq('name','gpt-final-decision-replay').maybeSingle();
  const got=(req.headers.get('x-fd1-replay-token')||'').trim(),exp=String(tok.data?.token||'');
  if(tok.error||!got||!exp||!eq(got,exp))return reply(401,{ok:false,error:'UNAUTHORIZED'});
  try{return reply(200,await run(db,Deno.env.get('OPENAI_API_KEY')||''));}
  catch(e){return reply(500,{ok:false,arm:ARM,error:String(e?.message??e).slice(0,300),orderCalls:0});}
});
