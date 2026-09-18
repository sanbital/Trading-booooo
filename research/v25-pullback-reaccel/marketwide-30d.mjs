/**
 * 30-day market-wide replay from Binance USDⓈ-M public REST.
 * Research only: exchangeInfo + klines; no authenticated endpoints, no orders.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import {
  feature15, rankFeatures, entryReason, confirm5, POLICY, M5, M15,
} from "../../supabase/functions/_shared/leader-momentum-v17.mjs";
import {
  SETUP_POLICY,
} from "../../supabase/functions/_shared/leader-pullback-reaccel.mjs";
import { SLOT_SIZING_CONTRACT } from "../../supabase/functions/_shared/leader-slot-sizing.mjs";
import { findTrigger, mergeCandidates, runExit, summarise } from "./replay.mjs";

const FAPI="https://fapi.binance.com";
const DAY=86400000, MIN=60000;
const DAYS=Number(process.env.REPLAY_DAYS||30);
const END=Number(process.env.REPLAY_END_MS||Date.now());
const START=END-DAYS*DAY;
const WARMUP=110*M15;
const OUT=new URL("./data/30d-marketwide/",import.meta.url);
mkdirSync(OUT,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const pace=Number(process.env.BINANCE_PACE_MS||80);

async function get(path,params={}){
  const q=new URLSearchParams(Object.entries(params).map(([k,v])=>[k,String(v)]));
  for(let a=0;a<6;a++){
    const res=await fetch(`${FAPI}${path}?${q}`,{headers:{accept:"application/json"}});
    if(res.ok){const j=await res.json(); await sleep(pace); return j;}
    if(res.status===418||res.status===429||res.status>=500){
      await sleep(Math.min(30000,1000*2**a)); continue;
    }
    throw new Error(`BINANCE_${res.status}:${path}:${(await res.text()).slice(0,200)}`);
  }
  throw new Error(`BINANCE_RETRIES_EXHAUSTED:${path}`);
}
async function pagedKlines(symbol,interval,start,end){
  const step={["15m"]:M15,["5m"]:M5,["1m"]:MIN}[interval];
  const out=[]; let cursor=start;
  while(cursor<=end){
    const rows=await get("/fapi/v1/klines",{symbol,interval,startTime:cursor,endTime:end,limit:1500});
    if(!Array.isArray(rows)||!rows.length) break;
    out.push(...rows);
    const next=Number(rows.at(-1)[0])+step;
    if(next<=cursor) throw new Error(`KLINE_CURSOR_STALL:${symbol}:${interval}`);
    cursor=next;
    if(rows.length<1500) break;
  }
  return out;
}
function barObj(r){return {t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],ct:+r[6],qv:+r[7],tb:+r[10]};}
function cutoff15(t){return Math.floor(t/M15)*M15;}
function closed15At(arr,cutoff){
  const xs=arr.filter(b=>b.ct<cutoff);
  return xs.slice(-110);
}
function fiveForConfirm(arr,cutoff){
  const xs=arr.filter(b=>b.ct<cutoff);
  return xs.slice(-14);
}
function mergeOneSymbolLive(cands){
  return mergeCandidates(cands,SETUP_POLICY).kept;
}
function openPosition(at,price){
  const notional=SLOT_SIZING_CONTRACT.targetMarginUsdt*SLOT_SIZING_CONTRACT.leverage;
  const q=notional/price;
  return {price,at,quantity:q,fee:notional*0.0005};
}
function oneSlot(trades){
  const kept=[]; let free=-Infinity;
  for(const t of [...trades].sort((a,b)=>a.entryAt-b.entryAt)){
    if(t.entryAt>=free){kept.push(t);free=t.exitAt;}
  }
  return kept;
}
function longestLossStreak(trades){
  let cur=0,max=0;
  for(const t of [...trades].sort((a,b)=>a.exitAt-b.exitAt)){
    if(t.netPnl<=0){cur++;max=Math.max(max,cur);}else cur=0;
  }
  return max;
}
function stripTopWinners(trades,n){
  const ids=new Set([...trades].sort((a,b)=>b.netPnl-a.netPnl).slice(0,n).map(t=>t.id));
  return trades.filter(t=>!ids.has(t.id));
}

const info=await get("/fapi/v1/exchangeInfo");
const symbols=(info.symbols||[]).filter(s=>
  s.status==="TRADING"&&s.contractType==="PERPETUAL"&&s.quoteAsset==="USDT"&&
  s.underlyingType==="COIN"&&Number(s.onboardDate)<=START-WARMUP
).map(s=>s.symbol).sort();
console.log("symbols",symbols.length,"window",new Date(START).toISOString(),new Date(END).toISOString());

const data15=new Map(), data5=new Map();
let idx=0;
for(const symbol of symbols){
  const [k15,k5]=await Promise.all([
    pagedKlines(symbol,"15m",START-WARMUP,END),
    pagedKlines(symbol,"5m",START-4*M15,END),
  ]);
  data15.set(symbol,k15.map(barObj));
  data5.set(symbol,k5.map(barObj));
  idx++;
  if(idx%25===0) console.log("history",idx,"/",symbols.length);
}

// Production scans every 5m. 15m features use only the latest fully closed 15m bar.
const candidates=[];
for(let t=Math.ceil(START/M5)*M5;t<=END;t+=M5){
  const f15cut=cutoff15(t);
  if(f15cut<START) continue;
  const features=[];
  for(const symbol of symbols){
    const bars=closed15At(data15.get(symbol)||[],f15cut);
    if(bars.length!==110) continue;
    try{features.push(feature15(symbol,bars,f15cut));}catch{}
  }
  if(features.length<50) continue;
  const ranked=rankFeatures(features);
  for(const f of ranked.slice(0,POLICY.rankLimit)){
    if(entryReason(f)!=="ELIGIBLE") continue;
    // Current live selection gate shipped with pullback policy.
    if(!(f.dayReturn<0.08&&f.volumeRatio>=1.30)) continue;
    const b5=fiveForConfirm(data5.get(f.symbol)||[],t);
    if(b5.length!==14) continue;
    const sig=confirm5(f,b5,t);
    if(!sig) continue;
    candidates.push({
      id:`30d:${f.symbol}:${t}`,symbol:f.symbol,s5c:t,ref:sig.referenceClose,
      dayReturn:f.dayReturn,volumeRatio:f.volumeRatio,rank:f.rank,
    });
  }
}
console.log("raw candidates",candidates.length);
const merged=mergeOneSymbolLive(candidates);
console.log("merged candidates",merged.length);

// Fetch only candidate 1m paths: setup window + maximum 6h hold.
const setupBars={},holdBars={};
let ci=0;
for(const c of merged){
  const raw=await pagedKlines(c.symbol,"1m",c.s5c-2*MIN,c.s5c+SETUP_POLICY.setupTtlMs+6*60*MIN+5*MIN);
  const bars=raw.map(r=>[+r[0],+r[1],+r[2],+r[3],+r[4]]);
  setupBars[c.id]=bars.filter(b=>b[0]>=c.s5c-2*MIN&&b[0]<=c.s5c+SETUP_POLICY.setupTtlMs+MIN);
  const tr=findTrigger(c,setupBars[c.id],SETUP_POLICY);
  if(tr.state?.state==="TRIGGERED"){
    holdBars[c.id]=bars.filter(b=>b[0]>=tr.state.triggerAt);
  }
  ci++; if(ci%25===0)console.log("paths",ci,"/",merged.length);
}

const trades=[];
const triggerReasons={};
for(const c of merged){
  const tr=findTrigger(c,setupBars[c.id]||[],SETUP_POLICY);
  const key=tr.state?.state||tr.reason||"UNKNOWN";
  triggerReasons[key]=(triggerReasons[key]||0)+1;
  if(tr.state?.state!=="TRIGGERED")continue;
  const bars=holdBars[c.id];
  if(!bars||bars.length<3)continue;
  const entryBar=bars[0];
  if(entryBar[0]!==tr.state.triggerAt)continue;
  const price=entryBar[1];
  if(Math.abs(price/c.ref-1)>POLICY.maxEntryDriftPct)continue;
  const entry=openPosition(entryBar[0],price);
  const t=runExit(entry,bars,{qv3:"off",stressPct:0});
  trades.push({...t,id:c.id,symbol:c.symbol});
}
trades.sort((a,b)=>a.entryAt-b.entryAt);
const one=oneSlot(trades);
const allSummary=summarise(trades), oneSummary=summarise(one);
const report={
  generatedAt:new Date().toISOString(),
  window:{start:new Date(START).toISOString(),end:new Date(END).toISOString(),days:DAYS},
  universe:{symbols:symbols.length,rawCandidates:candidates.length,mergedCandidates:merged.length,triggerReasons},
  assumptions:{marginUsdt:30,leverage:3,notionalUsdt:90,entryFeeRate:0.0005,exitFeeRate:0.0005,baseExitSlippagePct:0.001,qv3:"shadow-only"},
  allOpportunities:{...allSummary,longestLossStreak:longestLossStreak(trades)},
  oneSlot:{...oneSummary,longestLossStreak:longestLossStreak(one),startingCapital:30,endingCapital:30+oneSummary.netPnl,totalReturnPct:oneSummary.netPnl/30},
  robustness:{
    removeTop1:summarise(stripTopWinners(one,1)),
    removeTop3:summarise(stripTopWinners(one,3)),
    removeTop5:summarise(stripTopWinners(one,5)),
  },
  trades:{all:trades,oneSlot:one},
};
writeFileSync(new URL("results.json",OUT),JSON.stringify(report,null,2));
writeFileSync(new URL("candidates.json",OUT),JSON.stringify({candidates,merged},null,1));
console.log(JSON.stringify(report,null,2));
