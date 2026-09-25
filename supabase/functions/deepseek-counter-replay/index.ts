import {sharedReview,callCounter,MODEL_CANDIDATES} from '../_shared/gpt-final-decision/parallel.mjs';
import {recheckPayload,validateRecheck} from '../_shared/gpt-final-decision/recheck.mjs';
import {payloadFor,callDecision,hash} from '../_shared/gpt-final-decision/api.mjs';
import inputs from '../../../research/deepseek-counter-20260925/inputs.json' with {type:'json'};
import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.57.4';
const orderedInputs=[...inputs].sort((a,b)=>a.snapshot_at_ms-b.snapshot_at_ms||a.job_key.localeCompare(b.job_key));
const reply=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
function eq(a:string,b:string){if(a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;}
Deno.serve(async(req:Request)=>{
  if(req.method!=='POST')return reply(405,{error:'POST_ONLY'});
  try{
    const db=createClient(Deno.env.get('SUPABASE_URL')||'',Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'',{auth:{persistSession:false,autoRefreshToken:false}});
    const {data,error}=await db.from('edge_internal_tokens').select('token').eq('name','gpt-final-decision-replay').maybeSingle();
    const supplied=req.headers.get('x-fd1-replay-token')||'',expected=data?.token||'';
    if(error||!supplied||!expected||!eq(supplied,expected))return reply(401,{error:'UNAUTHORIZED'});
    const key=Deno.env.get('deepseek api');
    if(!key)return reply(200,{ok:false,error:'DEEPSEEK_KEY_MISSING',orderCalls:0});
    const config=await req.json();
    const start=config.start,count=config.count;
    if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(count)||count<1||count>8||start+count>orderedInputs.length)return reply(400,{error:'INVALID_RANGE'});
    const out=[];
    for(const row of orderedInputs.slice(start,start+count)){
      const rc=row.packet.task==='RECHECK',inputPayload=rc?recheckPayload:payloadFor;
      const sharedOptions={snapshotAtMs:row.snapshot_at_ms,inputPayload};
      const shared=await sharedReview(row.packet,sharedOptions);
      const timeoutMs=rc?4000:8000,started=Date.now();
      const starts:number[]=[];
      const invoke=(fn:()=>unknown)=>{starts.push(Date.now());return Promise.resolve().then(fn);};
      const gptOptions={apiKey:Deno.env.get('OPENAI_API_KEY')||'',timeoutMs,...(rc?{payloadFn:recheckPayload,validate:validateRecheck}:{})};
      const counterOptions=MODEL_CANDIDATES.map(candidate=>({apiKey:key,...candidate,timeoutMs}));
      const results=await Promise.allSettled([
        invoke(()=>callDecision(shared.packet,gptOptions)),
        ...counterOptions.map(options=>invoke(()=>callCounter(shared,options)))
      ]);
      const get=(i:number)=>{const item=results[i];return item.status==='fulfilled'?item.value:{valid:false,error:'PROVIDER_ERROR'};};
      out.push({job_key:row.job_key,task:row.packet.task,source_commit:row.source_commit,snapshot_at_ms:row.snapshot_at_ms,
        snapshot_hash:shared.snapshot_hash,replay_payload_hash:await hash(inputPayload(shared.packet)),
        historical_prompt_hash:row.prompt_hash,historical_schema_hash:row.schema_hash,request_start_ms:starts,
        started_at_ms:started,completed_at_ms:Date.now(),gpt:get(0),
        candidates:MODEL_CANDIDATES.map((candidate,i)=>({candidate,counter:get(i+1)}))});
    }
    return reply(200,{ok:true,version:'FD1_COUNTER_REPLAY_2',start,count,results:out,orderCalls:0});
  }catch{return reply(500,{ok:false,error:'REPLAY_FAILED',orderCalls:0});}
});