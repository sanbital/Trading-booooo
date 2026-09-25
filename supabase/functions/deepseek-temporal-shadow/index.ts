import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import {compareTemporal} from '../_shared/gpt-final-decision/temporal.mjs';
const reply=(s:number,b:unknown)=>new Response(JSON.stringify(b),{status:s,headers:{'content-type':'application/json','cache-control':'no-store'}});
function eq(a:string,b:string){if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;}
Deno.serve(async(req:Request)=>{
  if(req.method!=='POST')return reply(405,{error:'POST_ONLY'});
  try{
    const db=createClient(Deno.env.get('SUPABASE_URL')||'',Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'',{auth:{persistSession:false,autoRefreshToken:false}});
    const tok=await db.from('edge_internal_tokens').select('token').eq('name','gpt-final-decision-replay').maybeSingle();
    const supplied=req.headers.get('x-fd1-replay-token')||'',expected=tok.data?.token||'';
    if(tok.error||!supplied||!expected||!eq(supplied,expected))return reply(401,{error:'UNAUTHORIZED'});
    const key=Deno.env.get('deepseek api');
    if(!key)return reply(503,{error:'DEEPSEEK_KEY_MISSING',orderCalls:0});
    // Request body cannot select models, URLs, inputs, budgets or a trading mode.
    const counts={done:0,errors:0};
    for(let i=0;i<4;i++){
      const claimed=await db.rpc('deepseek_temporal_claim');
      if(claimed.error)throw Error('CLAIM_FAILED');
      const row=claimed.data?.[0];if(!row)break;
      let result:unknown,state='DONE';
      try{result=await compareTemporal(row,row.previous,{apiKey:key});}
      catch{result={error:'TEMPORAL_PREP_FAILED',authority:[]};state='ERROR';}
      const written=await db.from('deepseek_temporal_jobs').update({state,result,completed_at:new Date().toISOString()})
        .eq('id',row.id).eq('state','RUNNING').eq('claimed_at',row.claimed_at);
      if(written.error)throw Error('WRITE_FAILED');
      if(state==='DONE')counts.done++;else counts.errors++;
    }
    return reply(200,{ok:true,version:'DS_HOLD_TEMPORAL_1',...counts,authority:[],orderCalls:0});
  }catch{return reply(500,{ok:false,error:'SHADOW_FAILED',authority:[],orderCalls:0});}
});
