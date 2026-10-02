// @ts-nocheck
import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import {admitSchedulerRequest} from '../_shared/scheduler-admission.mjs';
import {ENGINE} from '../_shared/deterministic/market-state.mjs';
import {observe} from '../_shared/deterministic/runtime.mjs';
import {refreshUniverse} from '../_shared/deterministic/universe.mjs';
const reply=(s,b)=>new Response(JSON.stringify(b),{status:s,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
function equal(a,b){if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;}
export async function generate(db,{diagnostic=false,refresh=refreshUniverse,scan=observe}={}){
 if(diagnostic)return scan(db,{diagnostic:true});
 // A refresh error leaves the previous observation set in place. The executor
 // refuses new entries after its expiry; position safety has independent ownership.
 let refreshError=null;
 try{await refresh(db);}catch(e){refreshError=String(e.message??e);}
 const result=await scan(db);return {...result,universe_refresh_error:refreshError};
}
Deno.serve(async req=>{
 if(req.method!=='POST')return reply(405,{ok:false,error:'POST_ONLY'});
 const url=Deno.env.get('SUPABASE_URL')||'',key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
 if(!url||!key)return reply(500,{ok:false,error:'SUPABASE_ENV_MISSING'});
 const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(url,init={})=>fetch(url,{...init,signal:AbortSignal.timeout(2500)})}});
 const token=await db.from('edge_internal_tokens').select('token').eq('name','v10-lane-signal-generator').maybeSingle();
 const supplied=(req.headers.get('x-v10-lane-token')||'').trim(),expected=String(token.data?.token||'');
 if(token.error||!supplied||!expected||!equal(supplied,expected))return reply(401,{ok:false,error:'UNAUTHORIZED'});
 let body;try{body=await req.json();}catch{return reply(400,{ok:false,error:'INVALID_JSON'});}
 const mode=String(body?.mode||'run').toLowerCase();
 if(!['run','preflight','diagnostic','leader20-observe'].includes(mode))return reply(400,{ok:false,error:'INVALID_MODE'});
 try{
  if(['run','leader20-observe'].includes(mode)){
   const admission=await admitSchedulerRequest({endpoint:'v10-lane-signal-generator',body,rpc:(name,args)=>db.rpc(name,args)});
   if(!admission.allowed)return reply(200,{ok:true,skipped:admission.reason});
  }
  return reply(200,await generate(db,{diagnostic:['preflight','diagnostic'].includes(mode)}));
 }
 catch(e){return reply(503,{ok:false,patch:ENGINE,error:e instanceof Error?e.message:String(e)});}
});
