import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.57.4';
const reply=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
function eq(a:string,b:string){if(a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;}
function providerError(text:string){
  try{
    const body=JSON.parse(text),error=body?.error??body;
    return {message:typeof error?.message==='string'?error.message.slice(0,500):null,
      type:typeof error?.type==='string'?error.type.slice(0,100):null,
      code:typeof error?.code==='string'||typeof error?.code==='number'?error.code:null,
      param:typeof error?.param==='string'?error.param.slice(0,100):null};
  }catch{return {message:'NON_JSON_PROVIDER_ERROR',type:null,code:null,param:null};}
}
Deno.serve(async(req:Request)=>{
  if(req.method!=='POST')return reply(405,{error:'POST_ONLY'});
  try{
    const db=createClient(Deno.env.get('SUPABASE_URL')||'',Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'',{auth:{persistSession:false,autoRefreshToken:false}});
    const {data,error}=await db.from('edge_internal_tokens').select('token').eq('name','gpt-final-decision-replay').maybeSingle();
    const supplied=req.headers.get('x-fd1-replay-token')||'',expected=data?.token||'';
    if(error||!supplied||!expected||!eq(supplied,expected))return reply(401,{error:'UNAUTHORIZED'});
    const key=Deno.env.get('deepseek api');
    if(!key)return reply(200,{ok:false,error:'DEEPSEEK_KEY_MISSING',orderCalls:0});
    const start=Date.now(),headers={authorization:'Bearer '+key};
    const balanceRes=await fetch('https://api.deepseek.com/user/balance',{redirect:'error',headers,signal:AbortSignal.timeout(8000)});
    const balanceText=await balanceRes.text();
    if(!balanceRes.ok){
      return reply(200,{ok:false,http_status:balanceRes.status,provider_error:providerError(balanceText),
        endpoint:'https://api.deepseek.com/user/balance',secret_env_name:'deepseek api',
        key_present:true,latency_ms:Date.now()-start,orderCalls:0});
    }
    const balance=JSON.parse(balanceText);
    const chatRes=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',redirect:'error',
      headers:{...headers,'content-type':'application/json'},signal:AbortSignal.timeout(8000),
      body:JSON.stringify({model:'deepseek-flash',thinking:{type:'disabled'},max_tokens:1,
        messages:[{role:'user',content:'Reply with OK.'}]})});
    const chatText=await chatRes.text();
    if(!chatRes.ok){
      return reply(200,{ok:false,http_status:chatRes.status,provider_error:providerError(chatText),
        endpoint:'https://api.deepseek.com/chat/completions',model:'deepseek-flash',balance,
        secret_env_name:'deepseek api',key_present:true,latency_ms:Date.now()-start,orderCalls:0});
    }
    const chat=JSON.parse(chatText);
    return reply(200,{ok:true,http_status:chatRes.status,endpoint:'https://api.deepseek.com/chat/completions',
      model:chat.model??'deepseek-flash',balance,usage:chat.usage??null,latency_ms:Date.now()-start,orderCalls:0});
  }catch{return reply(200,{ok:false,error:'PROBE_FAILED',orderCalls:0});}
});
