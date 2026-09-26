// Dedicated collector authentication. No arbitrary SQL, URL, prompt, or trading API.
import {createHandler} from './handler.mjs';
const base=Deno.env.get('SUPABASE_URL')!;
const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
async function db(path:string,body?:unknown) {
  const r=await fetch(base+'/rest/v1/'+path,{method:body===undefined?'GET':'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  if(!r.ok) throw Error('DATABASE_'+r.status);
  return await r.json();
}
Deno.serve(createHandler({
 getToken:async()=>(await db('edge_internal_tokens?name=eq.doa-capture&select=token&limit=1'))[0]?.token,
 invoke:(action:string,body:unknown)=>db('rpc/doa_capture_rpc',{p_action:action,p_body:body}),
}));
