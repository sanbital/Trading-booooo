// @ts-nocheck
// TEMPORARY, order-free GPT final-review verification endpoint (2026-09-23).
// No exchange/gateway credentials or order code. Auth: internal token row
// 'gpt-final-review-verify' (created and read inside the database only).
import {createClient} from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {SupabaseReviewStore} from "../_shared/gpt-final-review/supabase-store.mjs";
import {MODEL} from "../_shared/gpt-final-review/contract.mjs";
import {bench,replay,faults,duplicate} from "./verify-core.mjs";
const res=(status,body)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});
function same(a,b){if(typeof a!=="string"||typeof b!=="string"||a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);return x===0;}
Deno.serve(async req=>{
  if(req.method!=="POST")return res(405,{ok:false});
  const db=createClient(Deno.env.get("SUPABASE_URL"),Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),{auth:{persistSession:false,autoRefreshToken:false}});
  const t=await db.from("edge_internal_tokens").select("token").eq("name","gpt-final-review-verify").maybeSingle();
  if(t.error||!t.data?.token||!same(req.headers.get("x-gpt-verify-token")||"",String(t.data.token)))return res(401,{ok:false});
  const body=await req.json().catch(()=>({})),apiKey=Deno.env.get("OPENAI_API_KEY")||"",store=new SupabaseReviewStore(db);
  try{
    if(body.action==="status"){
      let auth=null;
      if(apiKey){const r=await fetch("https://api.openai.com/v1/models/"+MODEL,{headers:{authorization:"Bearer "+apiKey},signal:AbortSignal.timeout(5000)});auth=r.status;await r.body?.cancel();}
      return res(200,{ok:true,keyPresent:apiKey.length>0,modelProbeStatus:auth,model:MODEL});
    }
    if(!apiKey&&body.action!=="faults")return res(200,{ok:false,error:"OPENAI_API_KEY_MISSING"});
    if(body.action==="bench")return res(200,{ok:true,results:await bench({db,store,apiKey,body})});
    if(body.action==="replay")return res(200,{ok:true,results:await replay({db,store,apiKey,body})});
    if(body.action==="faults")return res(200,{ok:true,results:await faults({store,body})});
    if(body.action==="duplicate")return res(200,{ok:true,results:await duplicate({store,apiKey,body})});
    return res(400,{ok:false,error:"ACTION"});
  }catch(e){return res(500,{ok:false,error:String(e?.message??e).slice(0,200)});}
});
