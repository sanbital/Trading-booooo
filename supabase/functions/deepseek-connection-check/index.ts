import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.57.4';
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
    const start=Date.now();
    const res=await fetch('https://api.deepseek.com/models',{redirect:'error',headers:{authorization:'Bearer '+key},signal:AbortSignal.timeout(8000)});
    if(!res.ok)return reply(200,{ok:false,http_status:res.status,latency_ms:Date.now()-start,orderCalls:0});
    const body=await res.json();
    const models=(Array.isArray(body.data)?body.data:[]).map((m:{id?:string})=>m.id).filter((id:unknown)=>typeof id==='string'&&/^deepseek-[a-z0-9.-]+$/.test(id as string));
    return reply(200,{ok:true,models,latency_ms:Date.now()-start,orderCalls:0});
  }catch{return reply(200,{ok:false,error:'PROBE_FAILED',orderCalls:0});}
});