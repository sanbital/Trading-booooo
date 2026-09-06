// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const REVISION = "V16-MOMENTUM-BROAD-SHADOW-1.0.0";
const OBSERVER_REVISION = "MARKET-REGIME-OBSERVER-v2-C01-HYSTERESIS-v1-FULLMARKET";
const BASES = ["https://fapi.binance.com", "https://fapi1.binance.com", "https://fapi2.binance.com"];
const BAR5 = 5 * 60_000;
const STAGE_CONCURRENCY = 24;
const MICRO_CONCURRENCY = 10;
const INTENDED_NOTIONAL_USDT = 120;

const env = (n:string) => (Deno.env.get(n) || "").trim();
const num = (v:any, d=Number.NaN) => Number.isFinite(Number(v)) ? Number(v) : d;
const clamp = (v:number, lo:number, hi:number) => Math.min(hi, Math.max(lo, v));
const mean = (xs:number[]) => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : Number.NaN;
const median = (xs:number[]) => { if (!xs.length) return Number.NaN; const a=[...xs].sort((x,y)=>x-y), m=Math.floor(a.length/2); return a.length%2 ? a[m] : (a[m-1]+a[m])/2; };
function eq(a:string,b:string){ if(a.length!==b.length)return false; let d=0; for(let i=0;i<a.length;i++) d|=a.charCodeAt(i)^b.charCodeAt(i); return d===0; }
function reply(status:number, body:any){ return new Response(JSON.stringify(body), {status, headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}}); }
async function fetchJson(path:string, timeout=12000){
  let last="UNKNOWN";
  for(const base of BASES){
    try{
      const r=await fetch(base+path,{headers:{accept:"application/json","user-agent":"Trading-booooo-v16-broad-shadow/1.0"},signal:AbortSignal.timeout(timeout)});
      const t=await r.text(); if(r.ok)return t?JSON.parse(t):null; last=`${base}:${r.status}:${t.slice(0,160)}`;
    }catch(e){ last=`${base}:${e instanceof Error?e.message:String(e)}`; }
  }
  throw new Error(`BINANCE_FETCH_FAILED:${last}`);
}
async function mapLimit(items:any[], limit:number, fn:(x:any)=>Promise<any>){
  const out=new Array(items.length); let cursor=0;
  async function w(){ for(;;){ const i=cursor++; if(i>=items.length)return; out[i]=await fn(items[i]); } }
  await Promise.all(Array.from({length:Math.min(limit,items.length)},()=>w())); return out;
}

type Bar={t:number;o:number;h:number;l:number;c:number;q:number;tbq:number};
type Member={symbol:string;qv24:number;r24:number;last:number};
function parseBar(r:any[]):Bar{return{t:num(r[0]),o:num(r[1]),h:num(r[2]),l:num(r[3]),c:num(r[4]),q:num(r[7],0),tbq:num(r[10],0)}}
async function bars(symbol:string,interval:"5m"|"15m",limit:number,endTime:number):Promise<Bar[]>{
  const raw=await fetchJson(`/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}&endTime=${endTime}`);
  return (Array.isArray(raw)?raw:[]).map(parseBar).filter((b:Bar)=>b.t>0&&b.c>0&&b.h>0&&b.l>0);
}
async function universe():Promise<Member[]>{
  const [info,tickers]=await Promise.all([fetchJson("/fapi/v1/exchangeInfo"),fetchJson("/fapi/v1/ticker/24hr")]);
  const active=new Set((info?.symbols||[]).filter((x:any)=>x?.status==="TRADING"&&x?.quoteAsset==="USDT"&&x?.contractType==="PERPETUAL").map((x:any)=>String(x.symbol||"").toUpperCase()).filter(Boolean));
  return (Array.isArray(tickers)?tickers:[]).map((x:any)=>({symbol:String(x?.symbol||"").toUpperCase(),qv24:num(x?.quoteVolume,0),r24:num(x?.priceChangePercent,0)/100,last:num(x?.lastPrice,0)})).filter((x:Member)=>active.has(x.symbol)&&x.last>0).sort((a:Member,b:Member)=>a.symbol.localeCompare(b.symbol));
}
function atr14(a:Bar[],i:number){ const tr:number[]=[]; for(let k=Math.max(1,i-13);k<=i;k++) tr.push(Math.max(a[k].h-a[k].l,Math.abs(a[k].h-a[k-1].c),Math.abs(a[k].l-a[k-1].c))); return mean(tr); }
function swingHigh(a:Bar[],i:number){
  const start=Math.max(2,i-72);
  for(let k=i-2;k>=start;k--){
    const h=a[k].h, local=h>=a[k-1].h&&h>=a[k-2].h&&h>=a[k+1].h&&h>=a[k+2].h;
    if(!local)continue;
    const post=a.slice(k+1,i+1); if(!post.length)continue;
    const low=Math.min(...post.map(b=>b.l)), depth=Math.max(0,(h-low)/h), near=a[i].c>=h*.985||a[i].h>=h*.995;
    if(near&&depth>=.0025)return{index:k,high:h,pullbackLow:low,pullbackDepth:depth};
  }
  let high=-Infinity,index=-1; for(let k=start;k<i;k++) if(a[k].h>=high){high=a[k].h;index=k;}
  const post=index>=0?a.slice(index+1,i+1):[],low=post.length?Math.min(...post.map(b=>b.l)):a[i].l;
  return{index,high,pullbackLow:low,pullbackDepth:high>0?Math.max(0,(high-low)/high):0};
}
function stageOne(member:Member,a:Bar[]){
  if(a.length<100)throw new Error(`INSUFFICIENT_5M:${a.length}`);
  const i=a.length-1,cur=a[i],ret15=cur.c/a[i-3].c-1,ret60=cur.c/a[i-12].c-1,ret180=cur.c/a[i-36].c-1;
  const qMed=median(a.slice(i-20,i).map(b=>b.q).filter(x=>x>0)),qvRatio=qMed>0?cur.q/qMed:0,takerBuyShare=cur.q>0?cur.tbq/cur.q:.5;
  const range=Math.max(cur.h-cur.l,cur.c*1e-9),closeLocation=clamp((cur.c-cur.l)/range,0,1),upperWick=clamp((cur.h-Math.max(cur.o,cur.c))/range,0,1),barReturn=cur.c/cur.o-1,atr=atr14(a,i);
  const sw=swingHigh(a,i),priorHigh=sw.high,priorHighIndex=sw.index,ageBars=i-priorHighIndex,pullbackLow=sw.pullbackLow,pullbackDepth=sw.pullbackDepth;
  const impulseWindow=a.slice(Math.max(0,priorHighIndex-24),Math.max(1,priorHighIndex+1)),impulseLow=impulseWindow.length?Math.min(...impulseWindow.map(b=>b.l)):Number.NaN,impulseReturn=Number.isFinite(impulseLow)&&impulseLow>0?priorHigh/impulseLow-1:0,pullbackDepthAtr=atr>0?(priorHigh-pullbackLow)/atr:Number.NaN;
  const breakoutBps=priorHigh>0?(cur.c/priorHigh-1)*10000:0,antiChaseAtr=atr>0?Math.max(0,cur.c-priorHigh)/atr:Number.NaN;
  const preImpulseQ=median(a.slice(Math.max(0,priorHighIndex-12),priorHighIndex+1).map(b=>b.q).filter(x=>x>0)),baseQ=median(a.slice(Math.max(priorHighIndex+1,i-12),i).map(b=>b.q).filter(x=>x>0));
  const baseVolumeRatio=preImpulseQ>0&&Number.isFinite(baseQ)?baseQ/preImpulseQ:Number.NaN,recentRanges=a.slice(Math.max(0,i-5),i).map(b=>b.h-b.l),baseCompressionAtr=atr>0&&recentRanges.length?median(recentRanges)/atr:Number.NaN;
  const before=a.slice(Math.max(0,priorHighIndex-12),Math.max(1,priorHighIndex)),earlierLow=before.length?Math.min(...before.map(b=>b.l)):Number.NaN,higherLowPreserved=Number.isFinite(earlierLow)?pullbackLow>=earlierLow*.995:true;
  const absorptionRisk=takerBuyShare>=.58&&(barReturn<=0||closeLocation<.45);
  let state:string|null=null;
  if(cur.c>priorHigh&&ageBars>=3&&ageBars<=72&&impulseReturn>=.015&&pullbackDepth>=.0035&&pullbackDepth<=.18&&pullbackDepthAtr>=.75&&higherLowPreserved)state="BREAKOUT_RECLAIM";
  else if(cur.c>priorHigh&&ageBars>=1)state="DIRECT_BREAKOUT";
  else if(priorHigh>0&&cur.c>=priorHigh*.992&&ageBars>=3&&impulseReturn>=.01&&pullbackDepth>=.0035&&pullbackDepth<=.18)state="WATCH_BREAKOUT";
  else if(ret15>=.008||ret60>=.02||(ret60>0&&qvRatio>=2))state="RISING";
  if(!state)return null;
  let score=state==="BREAKOUT_RECLAIM"?30:state==="DIRECT_BREAKOUT"?20:state==="WATCH_BREAKOUT"?12:8;
  score+=clamp(impulseReturn*300,0,15)+clamp(ret60*150,0,10)+clamp((qvRatio-1)*5,0,10)+clamp((takerBuyShare-.50)*60,0,10)+clamp((closeLocation-.50)*20,0,10);
  if(pullbackDepth>=.005&&pullbackDepth<=.08)score+=5;if(Number.isFinite(pullbackDepthAtr)&&pullbackDepthAtr>=1)score+=3;if(baseVolumeRatio<=1.15)score+=3;if(baseCompressionAtr<=1.10)score+=3;if(higherLowPreserved)score+=3;if(Number.isFinite(antiChaseAtr)&&antiChaseAtr<=1.25)score+=4;
  if(upperWick>.45)score-=8;if(absorptionRisk)score-=8;if(Number.isFinite(antiChaseAtr)&&antiChaseAtr>2)score-=10;
  return{symbol:member.symbol,state,score:clamp(score,0,100),signalBarAt:cur.t,referenceClose:cur.c,metrics:{ret15,ret60,ret180,barReturn,qv5:cur.q,qvRatio,qv24:member.qv24,r24:member.r24,takerBuyShare,closeLocation,upperWick,absorptionRisk,atr14:atr,priorHigh,priorHighAgeBars:ageBars,pullbackLow,pullbackDepth,pullbackDepthAtr,impulseLow,impulseReturn,breakoutBps,antiChaseAtr,baseVolumeRatio,baseCompressionAtr,higherLowPreserved}};
}
function sumDepth(levels:any[],mid:number,side:"bid"|"ask",bps:number){let quote=0;for(const row of levels||[]){const p=num(row?.[0]),q=num(row?.[1]);if(!(p>0&&q>0))continue;const dist=side==="bid"?(mid-p)/mid*10000:(p-mid)/mid*10000;if(dist<=bps+1e-9)quote+=p*q;}return quote;}
function slippage(asks:any[],notional:number){ if(!asks?.length)return Number.POSITIVE_INFINITY; const best=num(asks[0]?.[0]); let rem=notional,qty=0,cost=0; for(const r of asks){const p=num(r?.[0]),q=num(r?.[1]);if(!(p>0&&q>0))continue;const v=p*q,t=Math.min(rem,v);cost+=t;qty+=t/p;rem-=t;if(rem<=1e-9)break;} return rem>1e-6||!(qty>0)||!(best>0)?Number.POSITIVE_INFINITY:((cost/qty)/best-1)*10000; }
async function broadMicro(c:any,endTime:number){
  const [m15,oiRaw,book]=await Promise.all([
    bars(c.symbol,"15m",40,endTime),
    fetchJson(`/futures/data/openInterestHist?symbol=${encodeURIComponent(c.symbol)}&period=5m&limit=6`).catch(()=>[]),
    fetchJson(`/fapi/v1/depth?symbol=${encodeURIComponent(c.symbol)}&limit=100`).catch(()=>({bids:[],asks:[]})),
  ]);
  const rows=Array.isArray(oiRaw)?oiRaw:[],oiNow=rows.length?num(rows.at(-1)?.sumOpenInterest):Number.NaN,oiPrev=rows.length>=4?num(rows.at(-4)?.sumOpenInterest):Number.NaN,oiDelta15=oiNow>0&&oiPrev>0?oiNow/oiPrev-1:Number.NaN;
  const bids=Array.isArray(book?.bids)?book.bids:[],asks=Array.isArray(book?.asks)?book.asks:[],bid=num(bids?.[0]?.[0]),ask=num(asks?.[0]?.[0]),mid=bid>0&&ask>0?(bid+ask)/2:Number.NaN,spreadBps=mid>0?(ask-bid)/mid*10000:Number.POSITIVE_INFINITY,bid10=mid>0?sumDepth(bids,mid,"bid",10):0,ask10=mid>0?sumDepth(asks,mid,"ask",10):0,imbalance=bid10+ask10>0?(bid10-ask10)/(bid10+ask10):0,buySlippageBps=slippage(asks,INTENDED_NOTIONAL_USDT),m15Ret60=m15.length>=5?m15.at(-1)!.c/m15.at(-5)!.c-1:Number.NaN;
  const executionOk=spreadBps<=10&&buySlippageBps<=10,flowOk=c.metrics.takerBuyShare>=.50,oiOk=!Number.isFinite(oiDelta15)||oiDelta15>=-.01,bookOk=imbalance>=-.50;
  return{broadConfirm:executionOk&&flowOk&&oiOk&&bookOk,microstructure:{bestBid:bid,bestAsk:ask,spreadBps,bidDepth10:bid10,askDepth10:ask10,depthImbalance10:imbalance,buySlippageBps,oiNow,oiDelta15,m15Ret60,intendedNotionalUsdt:INTENDED_NOTIONAL_USDT}};
}

Deno.serve(async(req)=>{
  if(req.method!=="POST")return reply(405,{ok:false,error:"POST_ONLY"});
  const U=env("SUPABASE_URL"),K=env("SUPABASE_SERVICE_ROLE_KEY"); if(!U||!K)return reply(500,{ok:false,error:"SUPABASE_ENV_MISSING"});
  const db=createClient(U,K,{auth:{persistSession:false,autoRefreshToken:false}}),got=(req.headers.get("x-v16-broad-token")||"").trim(),tok=await db.from("edge_internal_tokens").select("token").eq("name","v16-momentum-broad-shadow").maybeSingle(),expected=String(tok.data?.token||"").trim();
  if(tok.error||!got||!expected||!eq(got,expected))return reply(401,{ok:false,error:"UNAUTHORIZED"});
  const now=Date.now(),currentOpen=Math.floor(now/BAR5)*BAR5,endTime=currentOpen-1;
  try{
    const [members,obs]=await Promise.all([universe(),db.from("market_regime_observations").select("observed_at,predicted_regime,confidence").eq("model_revision",OBSERVER_REVISION).eq("trading_influence",true).order("observed_at",{ascending:false}).limit(1).maybeSingle()]);
    const regime=String(obs.data?.predicted_regime||"UNKNOWN").toUpperCase();
    const scanned=await mapLimit(members,STAGE_CONCURRENCY,async(m:any)=>{try{return{candidate:stageOne(m,await bars(m.symbol,"5m",120,endTime)),error:null}}catch(e){return{candidate:null,error:`${m.symbol}:${e instanceof Error?e.message:String(e)}`}}});
    const stage1=scanned.map(x=>x.candidate).filter(Boolean).sort((a:any,b:any)=>b.score-a.score||a.symbol.localeCompare(b.symbol));
    const actionable=stage1.filter((x:any)=>["BREAKOUT_RECLAIM","DIRECT_BREAKOUT","WATCH_BREAKOUT"].includes(x.state));
    const enriched=await mapLimit(actionable,MICRO_CONCURRENCY,async(c:any)=>{try{return{...c,...await broadMicro(c,endTime),microError:null}}catch(e){return{...c,broadConfirm:false,microstructure:{},microError:e instanceof Error?e.message:String(e)}}});
    const errors=scanned.map(x=>x.error).filter(Boolean);
    const run=await db.from("v16_broad_shadow_runs").insert({revision:REVISION,regime,universe_count:members.length,stage1_count:stage1.length,actionable_count:actionable.length,broad_confirm_count:enriched.filter((x:any)=>x.broadConfirm).length,data_error_count:errors.length,summary:{shadowOnly:true,liveOrdersSubmitted:0,regimeIsEntryGate:false,coverage:"ALL_ACTIVE_BINANCE_USDT_PERPETUALS",actionableStates:["BREAKOUT_RECLAIM","DIRECT_BREAKOUT","WATCH_BREAKOUT"],observerObservedAt:obs.data?.observed_at||null,observerConfidence:obs.data?.confidence??null,errorSample:errors.slice(0,20)}}).select("id,run_at").single();
    if(run.error||!run.data)throw new Error(`RUN_WRITE:${run.error?.message||"missing"}`);
    if(enriched.length){const rows=enriched.map((x:any)=>({run_id:run.data.id,observed_at:run.data.run_at,signal_bar_at:new Date(x.signalBarAt).toISOString(),symbol:x.symbol,state:x.state,stage_score:x.score,broad_confirm:!!x.broadConfirm,regime,metrics:{...x.metrics,referenceClose:x.referenceClose,microError:x.microError||null},microstructure:x.microstructure||{}})),w=await db.from("v16_broad_shadow_candidates").insert(rows);if(w.error)throw new Error(`CANDIDATE_WRITE:${w.error.message}`);}
    return reply(200,{ok:true,revision:REVISION,shadowOnly:true,liveOrdersSubmitted:0,regime,regimeIsEntryGate:false,universe:members.length,stage1:stage1.length,actionable:actionable.length,broadConfirmed:enriched.filter((x:any)=>x.broadConfirm).length,dataErrors:errors.length,top:enriched.slice(0,30).map((x:any)=>({symbol:x.symbol,state:x.state,score:Number(x.score.toFixed(2)),broadConfirm:x.broadConfirm,impulseReturn:x.metrics.impulseReturn,pullbackDepth:x.metrics.pullbackDepth,takerBuyShare:x.metrics.takerBuyShare,spreadBps:x.microstructure?.spreadBps??null,oiDelta15:x.microstructure?.oiDelta15??null}))});
  }catch(e){return reply(500,{ok:false,revision:REVISION,shadowOnly:true,error:e instanceof Error?e.message:String(e)});}
});
