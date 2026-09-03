// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const REV="V15-RANGE-R7-PARITY-SHADOW-2.0.0";
const FP="RANGE_V15_R7_PARITY_SHADOW_2_0_0";
const OBS="MARKET-REGIME-OBSERVER-v2-C01-HYSTERESIS-v1-FULLMARKET";
const EXIT_KEY="RANGE_R7_STATE_T1P00_A18_G0P75__RT110";
const M15=900000, LEV=3, ATR_N=56, ATR_BASE=2880, BB_ENTRY=80, QV24=96, RET24=96, BTC72=288, REQ=2938;
const MIN_QV=50_000_000, CD=6*3600000, MAX_HOLD=6*3600000;
const ENTRY_PREM=0.0006, ENTRY_FEE=0.0005, EXIT_FEE=0.0005, HAIR=0.0005;
const ARM_ROE=18, GIVEBACK_ROE=0.75, TARGET_BB_IMPROVEMENT=1;
const SYMS=["ETHUSDT","XRPUSDT","SOLUSDT","DOGEUSDT","ADAUSDT","AVAXUSDT","LINKUSDT","BCHUSDT","DOTUSDT","TRXUSDT","NEARUSDT","ETCUSDT","XLMUSDT","ATOMUSDT","UNIUSDT"];
const BASE=["https://fapi.binance.com","https://fapi1.binance.com","https://fapi2.binance.com"];

type Bar={t:number,o:number,h:number,l:number,c:number,q:number,ct:number};
type Feat={symbol:string,signalBarAt:number,referenceClose:number,atrRatio:number,bbPos:number,qv24:number,r24:number};
type ShadowState={trailArmed:boolean,trailArmedAtMs:number|null,peakPrice:number,lastEvaluatedBarOpenMs:number|null};

function R(status:number,body:any){return new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json","cache-control":"no-store"}})}
const N=(v:any,d=NaN)=>{const x=Number(v);return Number.isFinite(x)?x:d};
function A(a:number[]){return a.length?a.reduce((s,x)=>s+x,0)/a.length:NaN}
function SD(a:number[]){if(a.length<2)return NaN;const m=A(a);return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1))}
function bar(r:any[]):Bar{return{t:N(r[0]),o:N(r[1]),h:N(r[2]),l:N(r[3]),c:N(r[4]),ct:N(r[6]),q:N(r[7])}}
function cteq(a:string,b:string){if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0}
async function F(path:string){let e="";for(const b of BASE){try{const r=await fetch(b+path,{headers:{"user-agent":"Trading-booooo-v15-range-r7-shadow/2.0"},signal:AbortSignal.timeout(15000)});const t=await r.text();if(r.ok)return t?JSON.parse(t):[];e=`${b}:${r.status}:${t.slice(0,120)}`}catch(x){e=String(x)}}throw Error(`BINANCE:${e}`)}
async function pool<T,U>(a:T[],n:number,fn:(x:T)=>Promise<U>){const o=new Array<U>(a.length);let i=0;async function w(){for(;;){const j=i++;if(j>=a.length)return;try{o[j]=await fn(a[j])}catch(e){o[j]=({error:String(e)} as any)}}}await Promise.all(Array.from({length:Math.min(n,a.length)},()=>w()));return o}
async function hist(s:string,t:number){const m=new Map<number,Bar>();let end=t+M15-1;for(let pg=0;pg<3&&m.size<REQ;pg++){const x=(await F(`/fapi/v1/klines?symbol=${s}&interval=15m&limit=1500&endTime=${end}`)).map(bar);if(!x.length)break;for(const b of x)if(b.t<=t)m.set(b.t,b);end=Math.min(...x.map((z:Bar)=>z.t))-1}const a=[...m.values()].sort((a,b)=>a.t-b.t);if(a.length<REQ||a.at(-1)?.t!==t)throw Error(`HIST:${s}:${a.length}`);return a.slice(-3000)}
async function recent(s:string,limit=220){return (await F(`/fapi/v1/klines?symbol=${s}&interval=15m&limit=${limit}`)).map(bar).sort((a:Bar,b:Bar)=>a.t-b.t)}
function atrs(b:Bar[]){const tr=Array(b.length).fill(NaN),a=Array(b.length).fill(NaN);let sum=0,c=0;for(let i=1;i<b.length;i++)tr[i]=Math.max(b[i].h-b[i].l,Math.abs(b[i].h-b[i-1].c),Math.abs(b[i].l-b[i-1].c));for(let i=0;i<b.length;i++){if(Number.isFinite(tr[i])){sum+=tr[i];c++}const j=i-ATR_N;if(j>=0&&Number.isFinite(tr[j])){sum-=tr[j];c--}if(c===ATR_N)a[i]=sum/ATR_N}return a}
function bbAt(b:Bar[],i:number,n:number){const x=b.slice(i-n+1,i+1).map(z=>z.c);if(x.length!==n)return NaN;const sd=SD(x);return sd?(b[i].c-A(x))/(2*sd):NaN}
function feat(s:string,b:Bar[]):Feat{const i=b.length-1,a=atrs(b),base=a.slice(i-ATR_BASE,i);if(base.length!==ATR_BASE||base.some(x=>!Number.isFinite(x))||!Number.isFinite(a[i]))throw Error(`ATR:${s}`);return{symbol:s,signalBarAt:b[i].t,referenceClose:b[i].c,atrRatio:a[i]/A(base),bbPos:bbAt(b,i,BB_ENTRY),qv24:b.slice(i-QV24+1,i+1).reduce((q,z)=>q+z.q,0),r24:b[i].c/b[i-RET24].c-1}}
function route(x:number){return x<-.05?"BEAR":x<=.04?"RANGE":x>.05?"BULL":"CASH"}
function btcCtx(b:Bar[]){const i=b.length-1;const cur=b[i].c/b[i-BTC72].c-1,prev=b[i-1].c/b[i-1-BTC72].c-1;return{current:cur,previous:prev,confirmed:route(cur)==="RANGE"&&route(prev)==="RANGE"}}
function initial(entry:number):ShadowState{return{trailArmed:false,trailArmedAtMs:null,peakPrice:entry,lastEvaluatedBarOpenMs:null}}
function bb20(closes:number[]){if(closes.length<20)return null;const x=closes.slice(-20),sd=SD(x);return sd?(x.at(-1)!-A(x))/(2*sd):null}
function stopFill(open:number,stop:number){return Math.min(open,stop*(1-HAIR))}

async function processOpenPositions(db:any,now:number){const q=await db.from("v10_regime_shadow_positions").select("*").eq("fingerprint",FP).eq("terminal",false).order("opened_at",{ascending:true});if(q.error)throw Error(`POS_READ:${q.error.message}`);let closed=0,evals=0;for(const pos of q.data||[]){const bars=await recent(String(pos.symbol),220),all=new Map(bars.map((x:Bar)=>[x.t,x])),done=bars.filter((x:Bar)=>x.ct<now);const closes:number[]=[];let state:any=(pos.state&&Object.keys(pos.state).length)?pos.state:initial(N(pos.entry_price));const entry=N(pos.entry_price),entryBb=N(pos.entry_bb_pos),opened=Date.parse(pos.opened_at),last=pos.last_evaluated_bar_open_at?Date.parse(pos.last_evaluated_bar_open_at):-Infinity;let exitPrice:number|null=null,exitReason:string|null=null,exitAt:string|null=null;
    for(const b of done){closes.push(b.c);if(b.t<opened||b.t<=last)continue;evals++;
      if(b.t>=opened+MAX_HOLD){exitPrice=b.o;exitReason="MAX_HOLD_BACKSTOP";exitAt=new Date(b.t).toISOString();break}
      if(state.trailArmed&&state.trailArmedAtMs!=null&&b.t>state.trailArmedAtMs){const stop=Math.max(entry,state.peakPrice*(1-GIVEBACK_ROE/(100*LEV)));if(b.l<=stop){exitPrice=stopFill(b.o,stop);exitReason="FULL_PROFIT_TRAIL";exitAt=new Date(b.t).toISOString();break}}
      const bb=bb20(closes);if(bb!=null&&bb-entryBb>=TARGET_BB_IMPROVEMENT){const nx:any=all.get(b.t+M15);if(nx){exitPrice=nx.o;exitReason="FULL_STATE_TARGET";exitAt=new Date(b.t+M15).toISOString();break}}
      if(!state.trailArmed){const arm=entry*(1+ARM_ROE/(100*LEV));if(b.h>=arm){state={...state,trailArmed:true,trailArmedAtMs:b.t,peakPrice:arm,lastEvaluatedBarOpenMs:b.t};continue}}
      if(state.trailArmed&&state.trailArmedAtMs!=null&&b.t>state.trailArmedAtMs)state.peakPrice=Math.max(N(state.peakPrice,entry),b.h);
      state.lastEvaluatedBarOpenMs=b.t;
    }
    if(exitPrice!=null&&exitReason&&exitAt){const gross=(exitPrice/entry-1)*10000,net=gross-(ENTRY_FEE+EXIT_FEE)*10000;const u=await db.from("v10_regime_shadow_positions").update({state:{...state,lastEvaluatedBarOpenMs:Date.parse(exitAt)},remaining_fraction:0,realized_gross_bps:gross,realized_net_bps:net,terminal:true,closed_at:exitAt,exit_reason:exitReason,exit_price:exitPrice,last_evaluated_bar_open_at:exitAt,updated_at:new Date().toISOString()}).eq("id",pos.id);if(u.error)throw Error(`POS_CLOSE:${u.error.message}`);closed++}
    else if(Number.isFinite(N(state.lastEvaluatedBarOpenMs))){const iso=new Date(N(state.lastEvaluatedBarOpenMs)).toISOString();const u=await db.from("v10_regime_shadow_positions").update({state,last_evaluated_bar_open_at:iso,updated_at:new Date().toISOString()}).eq("id",pos.id);if(u.error)throw Error(`POS_UPDATE:${u.error.message}`)}
  }
  return{openBefore:(q.data||[]).length,closed,exitEvaluations:evals};
}

Deno.serve(async(req:Request)=>{if(req.method!=="POST")return R(405,{ok:false,error:"POST_ONLY"});const U=(Deno.env.get("SUPABASE_URL")||"").trim(),K=(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"").trim();if(!U||!K)return R(500,{ok:false,error:"SUPABASE_ENV_MISSING"});const db=createClient(U,K,{auth:{persistSession:false,autoRefreshToken:false}});const supplied=(req.headers.get("x-v10-lane-token")||"").trim();const tr=await db.from("edge_internal_tokens").select("token").eq("name","v10-lane-signal-generator").maybeSingle();const expected=String(tr.data?.token||"").trim();if(tr.error||!supplied||!expected||!cteq(supplied,expected))return R(401,{ok:false,error:"UNAUTHORIZED"});
  try{const body=await req.json().catch(()=>({})),diagnostic=String(body.mode||"").toLowerCase()==="diagnostic",now=Date.now(),currentOpen=Math.floor(now/M15)*M15,signalT=currentOpen-M15;
    const oq=await db.from("market_regime_observations").select("id,observed_at,predicted_regime,bull_score,confidence,sample_size").eq("model_revision",OBS).eq("trading_influence",true).order("observed_at",{ascending:false}).limit(1).maybeSingle();if(oq.error||!oq.data)throw Error("OBSERVER");const o=oq.data,healthy=now-Date.parse(o.observed_at)<=720000&&N(o.confidence,0)>=.60&&N(o.sample_size,0)>=240;
    const rows:any[]=await pool(["BTCUSDT",...SYMS],4,async s=>({symbol:s,bars:await hist(s,signalT)}));const bm=new Map(rows.filter(x=>!x.error).map(x=>[x.symbol,x.bars]));const bt=bm.get("BTCUSDT");if(!bt)throw Error("BTC_HISTORY");const bc=btcCtx(bt);
    const eligible:Feat[]=[];const rejected:any[]=[];for(const s of SYMS){const b=bm.get(s);if(!b){rejected.push({symbol:s,reason:"HISTORY"});continue}try{const f=feat(s,b);let reason="ELIGIBLE";if(!healthy)reason="OBSERVER_UNHEALTHY";else if(o.predicted_regime!=="NEUTRAL")reason="REGIME_NOT_NEUTRAL";else if(!bc.confirmed||Math.abs(bc.current)>.02)reason="BTC72_GATE";else if(f.qv24<MIN_QV)reason="QV24_LT_50M";else if(f.atrRatio<1.65)reason="ATR_LT_1P65";else if(f.bbPos>-1.05)reason="BB_GT_M1P05";else if(f.r24<-.06)reason="R24_LT_M6PCT";if(reason==="ELIGIBLE")eligible.push(f);else rejected.push({symbol:s,reason,atrRatio:f.atrRatio,bbPos:f.bbPos,qv24:f.qv24,r24:f.r24})}catch(e){rejected.push({symbol:s,reason:String(e)})}}
    eligible.sort((a,b)=>a.bbPos-b.bbPos||b.atrRatio-a.atrRatio||a.symbol.localeCompare(b.symbol));
    if(diagnostic)return R(200,{ok:true,diagnostic:true,revision:REV,fingerprint:FP,signalBarAt:new Date(signalT).toISOString(),observer:o,healthy,btc72:bc,eligible,selected:eligible[0]||null,rejected,liveOrdersSubmitted:0});
    const exits=await processOpenPositions(db,now);
    const openQ=await db.from("v10_regime_shadow_positions").select("id,symbol,opened_at").eq("fingerprint",FP).eq("terminal",false).limit(1);if(openQ.error)throw Error(`OPEN_CHECK:${openQ.error.message}`);let opened=0,selected:any=null,skip:string|null=null;
    if((openQ.data||[]).length){skip="MAX1_OPEN_POSITION"}
    else if(!eligible.length){skip="NO_ELIGIBLE"}
    else{selected=eligible[0];const last=await db.from("v10_regime_shadow_positions").select("signal_bar_at").eq("fingerprint",FP).eq("symbol",selected.symbol).order("signal_bar_at",{ascending:false}).limit(1).maybeSingle();if(last.error)throw Error(`COOLDOWN_READ:${last.error.message}`);if(last.data&&signalT-Date.parse(last.data.signal_bar_at)<CD)skip="SYMBOL_COOLDOWN";else{const rb=await recent(selected.symbol,4),eb=rb.find((x:Bar)=>x.t===currentOpen);if(!eb)skip="ENTRY_BAR_MISSING";else{const entry=eb.o*(1+ENTRY_PREM),state=initial(entry);const ins=await db.from("v10_regime_shadow_positions").upsert({lane:"RANGE",symbol:selected.symbol,side:"LONG",signal_bar_at:new Date(signalT).toISOString(),entry_bar_at:new Date(currentOpen).toISOString(),opened_at:new Date(currentOpen).toISOString(),entry_price:entry,entry_bb_pos:selected.bbPos,leverage:LEV,hold_hours:6,fingerprint:FP,validation_state:"FORWARD_SHADOW",exit_policy_key:EXIT_KEY,exit_policy_revision:"V10-LANES-EXIT-RUNTIME-1.1.0",exit_policy_spec_sha256:"V15_R7_PARITY",policy_parameters:{targetBbImprovement:TARGET_BB_IMPROVEMENT,trailArmRoe:ARM_ROE,trailGivebackRoe:GIVEBACK_ROE,maxHoldHours:6,entryPremiumBps:6,roundTripFeesBps:10,portfolioRule:"MAX1_EXACT_EXIT_RELEASE",entryGate:"BTCABS20_R24GE6"},state,remaining_fraction:1,realized_gross_bps:0,realized_net_bps:0,terminal:false},{onConflict:"lane,symbol,signal_bar_at",ignoreDuplicates:true});if(ins.error)throw Error(`OPEN_WRITE:${ins.error.message}`);opened=1}}}
    return R(200,{ok:true,mode:"shadow",revision:REV,fingerprint:FP,signalBarAt:new Date(signalT).toISOString(),observer:o,btc72:bc,eligible:eligible.length,selected,opened,skip,exits,liveOrdersSubmitted:0,orderRoutingCompiled:false});
  }catch(e){return R(500,{ok:false,revision:REV,fingerprint:FP,error:String(e?.message||e),liveOrdersSubmitted:0,orderRoutingCompiled:false})}
});