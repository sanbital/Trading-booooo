// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const REVISION = "V16-PRODUCTION-CANARY-1.0.0";
const SOURCE_REVISION = "V16-MOMENTUM-BROAD-SHADOW-1.0.0";
const MAX_SLOTS = 10;
const MARGIN_USDT = 40;
const LEVERAGE = 3;
const NOTIONAL_USDT = MARGIN_USDT * LEVERAGE;

const env = (n:string) => (Deno.env.get(n) || "").trim();
const num = (v:any,d=Number.NaN) => Number.isFinite(Number(v)) ? Number(v) : d;
function eq(a:string,b:string){if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;}
function reply(status:number,body:any){return new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});}
function exitModifier(regime:string){const r=regime.toUpperCase();if(r==="BULL"||r==="STRONG_BULL")return"WIDE";if(r==="BEAR"||r==="RISK_OFF")return"TIGHT";return"MEDIUM";}
function candidateScore(c:any){
  const m=c.metrics||{}, b=c.microstructure||{};
  let s=num(c.stage_score,0);
  const oi=num(b.oiDelta15,Number.NaN), imb=num(b.depthImbalance10,0), spread=num(b.spreadBps,99), slip=num(b.buySlippageBps,99);
  if(Number.isFinite(oi)&&oi>=0)s+=5; else if(Number.isFinite(oi)&&oi<-.005)s-=5;
  if(imb>=0)s+=4; else if(imb<-.4)s-=5;
  if(spread<=3)s+=2;
  if(slip<=2)s+=2;
  if(num(m.impulseReturn,0)>=.03)s+=3;
  if(num(m.pullbackDepthAtr,0)>=1)s+=2;
  return Math.max(0,Math.min(100,s));
}
function admission(c:any){
  const m=c.metrics||{}, b=c.microstructure||{};
  if(c.state!=="BREAKOUT_RECLAIM")return false;
  if(!c.broad_confirm)return false;
  if(num(m.impulseReturn,0)<.015)return false;
  if(num(m.pullbackDepth,0)<.0035 || num(m.pullbackDepth,0)>.18)return false;
  if(num(m.pullbackDepthAtr,0)<.75)return false;
  if(num(m.qvRatio,0)<1.30)return false;
  if(num(m.takerBuyShare,0)<.54)return false;
  if(num(m.upperWick,1)>.45)return false;
  if(num(m.closeLocation,0)<.55)return false;
  if(m.absorptionRisk===true)return false;
  if(Number.isFinite(num(m.antiChaseAtr)) && num(m.antiChaseAtr)>1.50)return false;
  if(num(b.spreadBps,99)>8)return false;
  if(num(b.buySlippageBps,99)>8)return false;
  return true;
}

Deno.serve(async(req)=>{
  if(req.method!=="POST")return reply(405,{ok:false,error:"POST_ONLY"});
  const U=env("SUPABASE_URL"),K=env("SUPABASE_SERVICE_ROLE_KEY"); if(!U||!K)return reply(500,{ok:false,error:"SUPABASE_ENV_MISSING"});
  const db=createClient(U,K,{auth:{persistSession:false,autoRefreshToken:false}});
  const got=(req.headers.get("x-v16-canary-token")||"").trim();
  const tok=await db.from("edge_internal_tokens").select("token").eq("name","v16-production-canary").maybeSingle();
  const expected=String(tok.data?.token||"").trim();
  if(tok.error||!got||!expected||!eq(got,expected))return reply(401,{ok:false,error:"UNAUTHORIZED"});

  try{
    const src=await db.from("v16_broad_shadow_runs").select("id,run_at,regime").eq("revision",SOURCE_REVISION).order("run_at",{ascending:false}).limit(1).maybeSingle();
    if(src.error)throw new Error(`SOURCE_RUN:${src.error.message}`);
    if(!src.data)return reply(200,{ok:true,revision:REVISION,sourceReady:false,orderSubmitted:false});

    const [candQ,liveQ]=await Promise.all([
      db.from("v16_broad_shadow_candidates").select("symbol,state,stage_score,broad_confirm,regime,metrics,microstructure").eq("run_id",src.data.id),
      db.from("v11_long_regime_positions").select("id,symbol").eq("state","OPEN"),
    ]);
    if(candQ.error)throw new Error(`CANDIDATES:${candQ.error.message}`);
    if(liveQ.error)throw new Error(`LIVE_OPEN:${liveQ.error.message}`);

    const liveOpen=liveQ.data||[],openSymbols=new Set(liveOpen.map((x:any)=>String(x.symbol))),availableSlots=Math.max(0,MAX_SLOTS-liveOpen.length);
    const admitted=(candQ.data||[]).filter((c:any)=>admission(c)&&!openSymbols.has(String(c.symbol))).map((c:any)=>({...c,score:candidateScore(c)})).sort((a:any,b:any)=>b.score-a.score||String(a.symbol).localeCompare(String(b.symbol)));
    const selected=admitted.slice(0,availableSlots);
    const modifier=exitModifier(String(src.data.regime||"UNKNOWN"));

    const run=await db.from("v16_production_canary_runs").insert({revision:REVISION,regime:src.data.regime,source_run_id:src.data.id,live_open_count:liveOpen.length,available_slots:availableSlots,candidate_count:admitted.length,selected_count:selected.length,summary:{sourceRevision:SOURCE_REVISION,sourceRunAt:src.data.run_at,regimeIsEntryGate:false,portfolioRule:`${MARGIN_USDT}USDT margin x ${LEVERAGE} leverage, max ${MAX_SLOTS} slots`,orderRouting:"DISABLED_CANARY_ONLY"}}).select("id,run_at").single();
    if(run.error||!run.data)throw new Error(`RUN_WRITE:${run.error?.message||"missing"}`);

    if(selected.length){
      const rows=selected.map((c:any,i:number)=>({run_id:run.data.id,symbol:c.symbol,rank:i+1,score:c.score,side:"LONG",margin_usdt:MARGIN_USDT,leverage:LEVERAGE,intended_notional_usdt:NOTIONAL_USDT,regime:src.data.regime,exit_modifier:modifier,source_metrics:c.metrics||{},source_microstructure:c.microstructure||{},executable:false,order_submitted:false}));
      const w=await db.from("v16_production_canary_intents").insert(rows);if(w.error)throw new Error(`INTENT_WRITE:${w.error.message}`);
    }

    return reply(200,{ok:true,revision:REVISION,sourceReady:true,sourceRunAt:src.data.run_at,regime:src.data.regime,regimeIsEntryGate:false,liveOpen:liveOpen.length,availableSlots,candidates:admitted.length,selected:selected.map((c:any,i:number)=>({rank:i+1,symbol:c.symbol,score:Number(c.score.toFixed(2)),marginUsdt:MARGIN_USDT,leverage:LEVERAGE,intendedNotionalUsdt:NOTIONAL_USDT,exitModifier:modifier})),orderRouting:"DISABLED_CANARY_ONLY",orderSubmitted:false});
  }catch(e){return reply(500,{ok:false,revision:REVISION,orderSubmitted:false,error:e instanceof Error?e.message:String(e)});}
});
