// @ts-nocheck
// GPT FINAL DECISION (FD1) historical replay. ORDER-FREE and TRADING-STATE-FREE.
//
// Validation arm C needs GPT answers on historical decision points. Each job names a
// symbol and a past instant; this function reads ONLY Binance history published before
// that instant (candles, BTC, OI history, premium index, settled funding; no order book,
// which has no history), builds the SAME FD1 packet production uses (data_mode=REPLAY),
// asks GPT once, and stores the validated answer. It uses its own capped budget row and
// never touches the production GPT ledger, signals, orders, positions or controls.
import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import {computeFacts,modelJudgments} from '../_shared/gpt-final-decision/facts.mjs';
import {readSources} from '../_shared/gpt-final-decision/market.mjs';
import {buildDecisionPacket,callDecision} from '../_shared/gpt-final-decision/api.mjs';
import {detectChange,buildRecheckPacket,recheckPayload,validateRecheck} from '../_shared/gpt-final-decision/recheck.mjs';
const PATCH='FD1-REPLAY-5-RECHECK',BATCH=20,CONCURRENCY=3,RESERVE_USD=0.02,WALL_MS=110_000;
const reply=(s,b)=>new Response(JSON.stringify(b),{status:s,headers:{'content-type':'application/json','cache-control':'no-store'}});
function eq(a,b){if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;}
const FACTORS=['absorption','volumeTails','fresh15over30','btcAnyUp','buyerShareRise','fresh5over15','recentHourLead'];
/** Compact job context -> the same judgment block production builds from signal features. */
export function expandContext(c){
  if(!c?.k)return c??{};
  const [ref,dayReturn,rank,r5,c15,bAllowed,branch,bits,v30,v30failed,cecAction,cecPred]=c.k;
  const factors=Object.fromEntries(FACTORS.map((k,i)=>[k,bits[i]==='1'?true:bits[i]==='0'?false:null]));
  const features={strategy:'LEADER_MOMENTUM_V17',rank,dayReturn,return5m:r5,confirmationReturn15m:c15,v17Setup:{state:'TRIGGERED'},
    b06133:{allowed:bAllowed===1,branch,reason:bAllowed===1?'B06133_ALLOW':'B06133_REJECT',factors},
    v30Front:{admitted:v30===1,failed:v30failed?v30failed.split(','):[]},
    cec0040:{action:cecAction,effectiveAllowed:cecAction!=='REJECT',ready:true,predictionUsdt:cecPred}};
  return {...c,referenceClose:ref,dayReturn,rank,judgments:modelJudgments(features)};
}
/** RECHECK replay job: context = {initial (ticket initial context), preDispatch (snapshot at as_of),
 * judgments, referenceClose, dayReturn, rank}. The detector runs first; only a triggered job asks
 * GPT (the same FINAL RECHECK prompt, schema and validation as production). */
async function recheckJob(job,apiKey,btcCache){
  const c=job.context??{},at=Number(job.as_of_ms),detection=detectChange(c.initial,c.preDispatch);
  if(!detection.triggered)return {packet:{detection},result:{decision:'NO_RECHECK',valid:true,attempted:false,api_cost_usd:0,detection}};
  const {src,errors}=await readSources(job.symbol,at,{mode:'REPLAY',btcCache});
  const facts=computeFacts(src,{asOf:at,referenceClose:c.referenceClose,dayReturn:c.dayReturn,rank:c.rank});
  const packet=await buildRecheckPacket({signalId:job.id,symbol:job.symbol,dataMode:'REPLAY',facts,initial:c.initial,detection,judgments:c.judgments??null});
  return {packet,result:{source_errors:errors,detection},call:true};
}
async function one(db,job,apiKey,btcCache){
  const c=expandContext(job.context),at=Number(job.as_of_ms);
  let result,packet=null;
  if(job.task==='RECHECK'){
    try{
      const r=await recheckJob(job,apiKey,btcCache);packet=r.packet;result=r.result;
      if(r.call){
        const budget=await db.rpc('fd1_replay_reserve',{p_reserve:RESERVE_USD});
        if(budget.error||budget.data!==true)result={...result,decision:'ABSTAIN',valid:false,error:'FD_REPLAY_BUDGET_EXHAUSTED',attempted:false};
        else{result={...result,...await callDecision(packet,{apiKey,payloadFn:recheckPayload,validate:validateRecheck})};
          await db.rpc('fd1_replay_settle',{p_reserve:RESERVE_USD,p_cost:Number(result.api_cost_usd??(result.http_status&&result.http_status>=400?0:RESERVE_USD))});}
      }
    }catch(e){result={decision:'ABSTAIN',valid:false,error:'FD_REPLAY_PREP:'+String(e?.message??e).slice(0,80),attempted:false};}
    const up=await db.from('fd1_replay_jobs').update({state:'DONE',packet,result,decision:result.decision,valid:result.valid===true,
      error:result.error??null,api_cost_usd:result.api_cost_usd??0,latency_ms:result.latency_ms??null,completed_at:new Date().toISOString()})
      .eq('id',job.id).eq('state','RUNNING');
    if(up.error)throw Error('JOB_WRITE:'+up.error.message);
    return result.decision;
  }
  try{
    const {src,errors}=await readSources(job.symbol,at,{mode:'REPLAY',btcCache});
    const facts=computeFacts(src,{asOf:at,referenceClose:c.referenceClose,dayReturn:c.dayReturn,rank:c.rank,position:c.position??null});
    packet=await buildDecisionPacket({task:job.task,subjectId:job.id,symbol:job.symbol,dataMode:'REPLAY',facts,
      judgments:c.judgments??null,position:job.task==='HOLD'?{event:c.event,deterministicExitCandidate:c.deterministicExitCandidate??null,stopStage:c.stopStage??null}:null});
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
  const started=Date.now(),claim=await db.rpc('fd1_replay_claim',{p_limit:BATCH});
  if(claim.error)throw Error('CLAIM:'+claim.error.message);
  const jobs=claim.data??[],btcCache=new Map(),out={};let i=0;
  const worker=async()=>{while(i<jobs.length&&Date.now()-started<WALL_MS){const j=jobs[i++];const d=await one(db,j,apiKey,btcCache);out[d]=(out[d]??0)+1;}};
  await Promise.all(Array.from({length:CONCURRENCY},worker));
  return {ok:true,patch:PATCH,claimed:jobs.length,decisions:out,orderCalls:0};
}
Deno.serve(async req=>{
  if(req.method!=='POST')return reply(405,{ok:false,error:'POST_ONLY'});
  const db=createClient(Deno.env.get('SUPABASE_URL')||'',Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'',{auth:{persistSession:false,autoRefreshToken:false}});
  const tok=await db.from('edge_internal_tokens').select('token').eq('name','gpt-final-decision-replay').maybeSingle();
  const got=(req.headers.get('x-fd1-replay-token')||'').trim(),exp=String(tok.data?.token||'');
  if(tok.error||!got||!exp||!eq(got,exp))return reply(401,{ok:false,error:'UNAUTHORIZED'});
  try{return reply(200,await run(db,Deno.env.get('OPENAI_API_KEY')||''));}
  catch(e){return reply(500,{ok:false,patch:PATCH,error:String(e?.message??e).slice(0,300),orderCalls:0});}
});
