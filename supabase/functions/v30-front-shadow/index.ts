// @ts-nocheck
// V30 front-end policy SHADOW observation. ORDER-FREE and TRADING-STATE-FREE.
//
// Question it answers with live data (history has no point-in-time order books):
// "If B06133 were replaced by the V30 score gate, what would the GPT V6 real-time risk
//  reviewer decide on the extra candidates, with a seconds-old book/funding/OI snapshot?"
//
// It reads signals the production executor already triggered and B06133-stamped,
// computes the V30 decision from those UNMODIFIED stamps, and for V30-admitted
// candidates asks the reviewer (journal purpose DRYRUN, prompt V6S). It writes only
// public.v30_front_shadow and the GPT journal. It never writes signals, orders,
// positions, runtime/control rows, never takes the execution lease, never orders.
import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import {FinalReviewCoordinator} from '../_shared/gpt-final-review/coordinator.mjs';
import {SupabaseReviewStore} from '../_shared/gpt-final-review/supabase-store.mjs';
import {v30FrontDecision,baselineAllowedV30,riskAssessment,V30_FRONT_VERSION} from '../_shared/gpt-final-review/contract.mjs';
const PATCH='V30-FRONT-SHADOW-1';
/** Own daily cap, and a floor that always leaves the shared ledger to production. */
const SHADOW_MAX_CALLS_PER_DAY=60,LEDGER_STOP_AT_CALLS=200,LOOKBACK_MS=5*60_000,OBSERVE_WITHIN_MS=150_000;
const reply=(s,b)=>new Response(JSON.stringify(b),{status:s,headers:{'content-type':'application/json','cache-control':'no-store'}});
function eq(a,b){if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;}
const rec=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{};
export async function observe(db,{apiKey,now=Date.now,fetchFn=fetch}={}){
  const since=new Date(now()-LOOKBACK_MS).toISOString();
  const sg=await db.from('v11_long_regime_signals').select('id,symbol,status,reject_reason,features,updated_at')
    .gte('updated_at',since).not('features->b06133','is',null).order('updated_at',{ascending:true}).limit(20);
  if(sg.error)throw Error('SIGNALS:'+sg.error.message);
  const ids=(sg.data??[]).map(x=>x.id);if(!ids.length)return {ok:true,patch:PATCH,observed:0};
  const seen=await db.from('v30_front_shadow').select('signal_id').in('signal_id',ids);
  if(seen.error)throw Error('SHADOW_READ:'+seen.error.message);
  const done=new Set((seen.data??[]).map(x=>x.signal_id)),out=[];
  const day=new Date(now()).toISOString().slice(0,10);
  for(const s of sg.data){
    if(done.has(s.id))continue;
    const f=rec(s.features),b=rec(f.b06133),t=rec(f.v17Setup),triggerAt=Number(b.source?.decisionAt);
    // Only a real trigger: the setup's own trigger instant must be B06133's decision instant.
    if(b.version!=='B06133_ENTRY_SELECTION_1'||!Number.isSafeInteger(triggerAt)||Number(t.triggerAt)!==triggerAt)continue;
    const v30=v30FrontDecision(b),lagMs=now()-triggerAt;
    const row={signal_id:s.id,symbol:s.symbol,trigger_at:new Date(triggerAt).toISOString(),policy_version:V30_FRONT_VERSION,
      v30_admitted:v30.admitted,v30:v30,b06133_allowed:b.allowed===true,b06133_reason:b.reason??null,
      cec:f.cec0040??null,production_status:s.status,production_reason:s.reject_reason??null,observed_lag_ms:lagMs,
      gpt_state:'NOT_REQUESTED',patch:PATCH};
    let gptRun=null;
    if(v30.admitted){
      // Separate observation: the snapshot must still be near the trigger to mean anything.
      if(lagMs>OBSERVE_WITHIN_MS)row.gpt_state='SKIPPED_TOO_LATE';
      else{
        const [mine,ledger]=await Promise.all([
          db.from('v30_front_shadow').select('signal_id',{count:'exact',head:true}).gte('created_at',day).not('gpt_job_key','is',null),
          db.from('gpt_final_review_daily_budget').select('calls').eq('utc_day',day).maybeSingle()]);
        if((mine.count??0)>=SHADOW_MAX_CALLS_PER_DAY||Number(ledger.data?.calls??0)>=LEDGER_STOP_AT_CALLS)row.gpt_state='SKIPPED_BUDGET_RESERVED_FOR_PRODUCTION';
        else gptRun={...s,features:{...f,v30Front:v30}};
      }
    }
    const ins=await db.from('v30_front_shadow').insert(row);
    if(ins.error){if(/duplicate/i.test(ins.error.message))continue;throw Error('SHADOW_WRITE:'+ins.error.message);}
    if(gptRun){
      // Candidate-scoped coordinator: DRYRUN journal, V30 baseline, observation window 180s.
      const c=new FinalReviewCoordinator({config:{mode:'ENFORCE',modeValid:true,approvalRef:'SHADOW_V30:'+day,apiBudgetUsd:3,
        maxCalls:300,enforceApproved:true,source:'SHADOW'},store:new SupabaseReviewStore(db),apiKey:()=>apiKey,fetchFn,now,
        purpose:'DRYRUN',profile:'V6S',baseline:baselineAllowedV30,expiry:x=>Number(x.features.v17Setup.triggerAt)+180_000});
      let first,final,job=null,packet=null,result=null;
      try{first=await c.consider(gptRun);await Promise.all([...c.pending.values()]);final=await c.consider(gptRun);
        job=final.jobKey??null;const j=job?await c.store.get(job):null;packet=j?.record?.packet??null;result=j?.record?.result??null;}
      catch(e){final={reason:'SHADOW_ERROR:'+String(e?.message??e).slice(0,120)};}
      const risk=packet?riskAssessment(packet):null;
      const up=await db.from('v30_front_shadow').update({gpt_state:'DONE',gpt_job_key:job,gpt_decision:final?.decision??null,gpt_reason:final?.reason??null,
        gpt_error:result?.error??null,snapshot_offset_ms:packet?.as_of_offset_ms??null,microstructure_complete:packet?.current_market?.quality?.microstructure_complete??null,
        risk_hard:risk?.hard??null,risk_soft:risk?.soft??null,updated_at:new Date().toISOString()}).eq('signal_id',s.id);
      if(up.error)throw Error('SHADOW_UPDATE:'+up.error.message);
      row.gpt_state='DONE';row.gpt_decision=final?.decision??null;
    }
    out.push({signal:s.id,symbol:s.symbol,admitted:v30.admitted,b06133:b.allowed===true,gpt:row.gpt_state,decision:row.gpt_decision??null});
  }
  return {ok:true,patch:PATCH,observed:out.length,rows:out,orderCalls:0};
}
Deno.serve(async req=>{
  if(req.method!=='POST')return reply(405,{ok:false,error:'POST_ONLY'});
  const url=Deno.env.get('SUPABASE_URL')||'',key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
  const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const tok=await db.from('edge_internal_tokens').select('token').eq('name','v30-front-shadow').maybeSingle();
  const got=(req.headers.get('x-v30-shadow-token')||'').trim(),exp=String(tok.data?.token||'');
  if(tok.error||!got||!exp||!eq(got,exp))return reply(401,{ok:false,error:'UNAUTHORIZED'});
  try{return reply(200,await observe(db,{apiKey:Deno.env.get('OPENAI_API_KEY')||''}));}
  catch(e){return reply(500,{ok:false,patch:PATCH,error:String(e?.message??e).slice(0,300),orderCalls:0});}
});
