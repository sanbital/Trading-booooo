// @ts-nocheck
import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import {scanMarket} from '../_shared/leader-market-v17.mjs';
import {POLICY,STRATEGY,entryFresh} from '../_shared/leader-momentum-v17.mjs';
// Existing v11 tables/token/cron remain compatible. BULL is a storage lane only;
// all trading decisions for features.strategy=STRATEGY are regime-independent.
const REVISION='V11-LONG-REGIME-1.0.1';
const PATCH='V17-LEADER-PRODUCTION-INTEGRATION-1';
const reply=(s,b)=>new Response(JSON.stringify(b),{status:s,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
function equal(a,b){if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;}
export async function generate(db,{diagnostic=false,scan=scanMarket,now=Date.now}={}){
  const result=await scan({now:now()});
  if(diagnostic)return {ok:true,diagnostic:true,patch:PATCH,strategy:STRATEGY,...result};
  const stamp=new Date(now()).toISOString();
  const logged=await db.from('v17_market_scan_runs').insert({captured_at:stamp,strategy:STRATEGY,
    signal_close_at:new Date(result.cut15).toISOString(),expected_symbols:result.expected,
    evaluated_symbols:result.evaluated,coverage:result.coverage,details:{
      blocked:result.blocked,reasons:result.reasons,top10:result.top10,
      errors:result.errors,excluded:result.excluded,confirmationErrors:result.confirmationErrors,
      requestWeight:result.weight,scanDurationMs:result.scanDurationMs}});
  if(logged.error)throw Error(`SCAN_AUDIT_WRITE:${logged.error.message}`);
  if(result.blocked)return {ok:true,inserted:0,skipped:result.blocked,...result};
  const [control,runtime,positions]=await Promise.all([
    db.from('v17_operator_control').select('entry_enabled,legacy_entries_retired').eq('singleton',true).single(),
    db.from('v11_long_regime_runtime').select('revision,live_enabled,circuit_open,circuit_reason').eq('singleton',true).single(),
    db.from('v11_long_regime_positions').select('symbol,state').eq('state','OPEN'),
  ]);
  for(const [name,r] of [['CONTROL',control],['RUNTIME',runtime],['POSITIONS',positions]])
    if(r.error)throw Error(`${name}_READ:${r.error.message}`);
  if(control.data?.entry_enabled!==true||control.data?.legacy_entries_retired!==true)
    return {ok:true,inserted:0,skipped:'OPERATOR_CUTOVER_NOT_ENABLED',...result};
  if(runtime.data?.revision!==REVISION)throw Error('RUNTIME_REVISION_MISMATCH');
  if(runtime.data.live_enabled!==true||runtime.data.circuit_open===true)
    return {ok:true,inserted:0,skipped:'RUNTIME_NOT_LIVE',circuitReason:runtime.data.circuit_reason,...result};
  const held=new Set((positions.data||[]).map(p=>String(p.symbol).toUpperCase()));
  const capacity=Math.max(0,POLICY.maxSlots-held.size),inserted=[];
  if(!capacity)return {ok:true,inserted:0,skipped:'SLOT_FULL',...result};
  for(const f of result.candidates){
    if(inserted.length>=capacity)break;
    if(held.has(f.symbol)||entryFresh(f,now(),f.referenceClose))continue;
    const recent=await db.from('v11_long_regime_signals').select('id').eq('symbol',f.symbol)
      .gte('signal_bar_at',new Date(now()-POLICY.cooldownMs).toISOString())
      .in('status',['NEW','CLAIMED','ORDERED','FILLED','CLOSED']).limit(1);
    if(recent.error)throw Error(`COOLDOWN_READ:${recent.error.message}`);
    if(recent.data?.length)continue;
    const write=await db.from('v11_long_regime_signals').upsert({revision:REVISION,lane:'BULL',
      symbol:f.symbol,side:'LONG',signal_bar_at:new Date(f.signal5Open).toISOString(),
      entry_bar_at:new Date(f.signal5Close).toISOString(),features:{...f,storageLaneOnly:'BULL',
        routeAuthority:STRATEGY,maxSlots:POLICY.maxSlots,targetMarginUsdt:POLICY.marginUsdt,
        leverage:POLICY.leverage},status:'NEW',updated_at:stamp},
      {onConflict:'revision,lane,symbol,signal_bar_at',ignoreDuplicates:true}).select('id,symbol');
    if(write.error)throw Error(`SIGNAL_WRITE:${write.error.message}`);
    inserted.push(...(write.data||[]));
  }
  return {ok:true,strategy:STRATEGY,patch:PATCH,inserted:inserted.length,signals:inserted,...result};
}
Deno.serve(async req=>{
  if(req.method!=='POST')return reply(405,{ok:false,error:'POST_ONLY'});
  const url=Deno.env.get('SUPABASE_URL')||'',key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
  if(!url||!key)return reply(500,{ok:false,error:'SUPABASE_ENV_MISSING'});
  const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const token=await db.from('edge_internal_tokens').select('token').eq('name','v10-lane-signal-generator').maybeSingle();
  const supplied=(req.headers.get('x-v10-lane-token')||'').trim(),expected=String(token.data?.token||'');
  if(token.error||!supplied||!expected||!equal(supplied,expected))return reply(401,{ok:false,error:'UNAUTHORIZED'});
  let body;try{body=await req.json();}catch{return reply(400,{ok:false,error:'INVALID_JSON'});}
  const mode=String(body?.mode||'run').toLowerCase();
  if(!['run','preflight','diagnostic'].includes(mode))return reply(400,{ok:false,error:'INVALID_MODE'});
  try{return reply(200,await generate(db,{diagnostic:mode!=='run'}));}
  catch(e){return reply(503,{ok:false,patch:PATCH,error:e instanceof Error?e.message:String(e)});}
});
