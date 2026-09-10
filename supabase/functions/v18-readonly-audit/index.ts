// Authenticated account reads only. No trading commands, configuration writes or timers.
import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import {auditAccount} from '../_shared/leader-readonly-audit.mjs';
const env=(k:string)=>(Deno.env.get(k)||'').trim();
const reply=(s:number,b:unknown)=>new Response(JSON.stringify(b),{status:s,headers:{'content-type':'application/json','cache-control':'no-store'}});
function equal(a:string,b:string){if(!a||a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);return x===0;}
async function gateway(command:unknown){
 const url=env('BINANCE_FUTURES_ORDER_GATEWAY_URL')||env('BINANCE_ORDER_GATEWAY_URL')||env('ORDER_GATEWAY_URL');
 const secret=env('BINANCE_FUTURES_GATEWAY_SHARED_SECRET')||env('BINANCE_GATEWAY_SHARED_SECRET')||env('GATEWAY_SHARED_SECRET');
 if(!url||!secret)throw Error('GATEWAY_CONFIG');
 const body=JSON.stringify({exchange:'binance_futures',...(command as object)}),ts=String(Date.now()),nonce=crypto.randomUUID();
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signature=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${ts}\n${nonce}\n${body}`)))).map(x=>x.toString(16).padStart(2,'0')).join('');
 const r=await fetch(`${url.replace(/\/$/,'')}/v1/command`,{method:'POST',headers:{'content-type':'application/json','x-gateway-ts':ts,'x-gateway-nonce':nonce,'x-gateway-signature':signature},body,signal:AbortSignal.timeout(8000)});
 const data=await r.json();if(!r.ok||data?.ok!==true)throw Error(`GATEWAY_READ_FAILED_${r.status}`);return data.result;
}
Deno.serve(async req=>{
 if(req.method!=='POST')return reply(405,{ok:false,error:'POST_ONLY'});
 const db=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}});
 const token=await db.from('edge_internal_tokens').select('token').eq('name','v16-futures-position-diagnostic').maybeSingle();
 if(token.error||!equal(req.headers.get('x-v16-diagnostic-token')||'',String(token.data?.token||'')))return reply(401,{ok:false,error:'UNAUTHORIZED'});
 try {return reply(200,await auditAccount(db,gateway,await req.json()));}
 catch {return reply(400,{ok:false,error:'AUDIT_REQUEST_FAILED'});}
});
