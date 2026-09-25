// @ts-nocheck
// leader-emerging-shadow (LE-SHADOW-1): order-free Top30 Leader/Emerging observation.
//
// Modes (POST body {"mode": ...}): scan (5-minute universe ranking + shortlist + deterministic
// arms), wait (GPT WAIT follow-up, stage 2 only), outcome (hypothetical labels + production
// link), diagnostic (G5 top10 parity, writes nothing).
//
// It connects to Postgres AS the dedicated role shadow_le_writer with the credential the cron
// job sends in x-shadow-le-credential. It never reads the service-role key, never places or
// cancels orders, never takes the execution lease, never calls the CEC RPC, and never touches
// the production GPT ledger, journal or key. The database enforces the same limits.
import postgres from 'npm:postgres@3.4.5';
import {createGuard} from './guard.mjs';
import {makeStore} from './store.mjs';
import {dbTarget} from './dbtarget.mjs';
import {runScan,runWait,runOutcome,runDiagnostic,PATCH} from './shadow.mjs';
import {makeStoreV2} from './v2/store.mjs';
import {runParity,runV2Wait,runHealth} from './v2/run.mjs';

const reply=(s,b)=>new Response(JSON.stringify(b),{status:s,headers:{'content-type':'application/json','cache-control':'no-store'}});
const MODES={scan:runScan,wait:runWait,outcome:runOutcome,diagnostic:runDiagnostic,
  // LE-SHADOW-2
  parity:async(o)=>runParity({...o,health:o.apiKey?await o.store.gptHealth():null}),
  v2wait:async(o)=>runV2Wait({...o,health:o.apiKey?await o.store.gptHealth():null}),
  health:runHealth};

Deno.serve(async req=>{
  if(req.method!=='POST')return reply(405,{ok:false,error:'POST_ONLY'});
  const credential=(req.headers.get('x-shadow-le-credential')||'').trim();
  if(credential.length<32)return reply(401,{ok:false,error:'UNAUTHORIZED'});
  let mode='';
  try{mode=String((await req.json())?.mode??'');}catch{/* invalid body */}
  const run=MODES[mode];
  if(!run)return reply(400,{ok:false,error:'MODE'});
  const t=dbTarget(Deno.env.get('SUPABASE_DB_URL'),Deno.env.get('SUPABASE_URL'));
  const sql=postgres({host:t.host,port:t.port,database:t.database,username:t.username,password:credential,ssl:'prefer',
    prepare:false,max:1,idle_timeout:2,connect_timeout:8,onnotice:()=>{},connection:{application_name:'leader-emerging-shadow'}});
  try{
    try{
      const who=await sql.unsafe('select current_user as u');
      if(who?.[0]?.u!=='shadow_le_writer')return reply(401,{ok:false,error:'UNEXPECTED_ROLE'});
    }catch{return reply(401,{ok:false,error:'UNAUTHORIZED'});}
    const db={query:(text,params)=>sql.unsafe(text,params)};
    const store=makeStore(db),store2=makeStoreV2(db);
    const guard=createGuard({fetchFn:fetch});
    // Prefer a dedicated shadow key when configured. Otherwise share the production OpenAI
    // project key; shadow DB budgets + production-health stand-down remain enforced. This is the
    // single audited production-key reference permitted by the order-free bundle test.
    const apiKey=(Deno.env.get('OPENAI_API_KEY_SHADOW')||Deno.env.get('OPENAI_API_KEY')||'').trim()||null;
    const out=await run({store,store2,guard,now:Date.now,apiKey});
    return reply(200,{...out,patch:PATCH,role:'shadow_le_writer',db_host_kind:/pooler/.test(t.host??'')?'POOLER':'DIRECT'});
  }catch(e){
    return reply(500,{ok:false,patch:PATCH,error:[e?.code,e?.message??String(e)].filter(Boolean).join(':').slice(0,300),orderCalls:0});
  }finally{
    try{await sql.end({timeout:2});}catch{/* closed */}
  }
});
