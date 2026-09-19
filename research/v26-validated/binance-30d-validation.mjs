import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import {
  POLICY, M5, M15, parseBars, feature15, rankFeatures, entryReason, confirm5,
} from "../../supabase/functions/_shared/leader-momentum-v17.mjs";
import {
  SETUP_POLICY, SETUP_STATE, advancePullbackSetup, startPullbackSetup,
} from "../../supabase/functions/_shared/leader-pullback-reaccel.mjs";
import {
  V26_CANDIDATES, structuralStopPrice, earlyFailureDecision, marketParticipationDecision, entryConfirmation1mDecision, breakoutContinuation1mDecision, triggerQuality1mDecision, antiExhaustionDecision,
} from "../../supabase/functions/_shared/boo/v26-candidate-policy.mjs";
import { resolveRiskPolicy, evaluateLossLimits } from "../../supabase/functions/_shared/boo/risk-policy.mjs";
import { solveQuantity } from "../../supabase/functions/_shared/boo/risk-budget.mjs";

const DAY=86_400_000, MIN=60_000, HOUR=3_600_000;
const END = Number(process.env.REPLAY_END_MS || 1789744200000);
const DAYS = Number(process.env.REPLAY_DAYS || 30);
const START = END - DAYS*DAY;
const WARMUP = 120*M15;
const RESULT_DIR=process.env.RESULT_DIR||"results-30d";
const OUT = new URL("./"+RESULT_DIR+"/", import.meta.url);
const RECOMPUTE_ELIGIBLE=process.env.RECOMPUTE_ELIGIBLE==="1";
const ONLY_CANDIDATE=process.env.ONLY_CANDIDATE||"";
const REPORT_CLASSIFICATION=process.env.REPORT_CLASSIFICATION||"DEVELOPMENT_30D_NOT_INDEPENDENT_HOLDOUT";
mkdirSync(OUT,{recursive:true});

const FEES = Object.freeze({ taker:0.0005 });
const EXEC = Object.freeze({
  baseline:{entryBps:3,stopBps:10,discretionaryBps:5},
  stress2x:{entryBps:6,stopBps:20,discretionaryBps:10},
  stress4x:{entryBps:12,stopBps:40,discretionaryBps:20},
});
const FUNDING_RISK_ALLOWANCE_RATE = 0.001;
const MIN_TRADES = 30, MIN_INDEPENDENT_DAYS = 10;

const EXPORT_DIR=process.env.V26_EXPORT_DIR||"/tmp/v26-export";
const VISION_CACHE=process.env.V26_VISION_CACHE||"/tmp/v26-vision";
mkdirSync(VISION_CACHE,{recursive:true});
const datasetHash=createHash("sha256");
const requestStats={requests:0,retries:0,weight:0,http429:0,http418:0,http451:0,vision404:0,visionFiles:0};

function csvRows(text){
  const out=[];
  for(const line of text.split(/\r?\n/)){
    if(!line)continue;
    const a=line.split(",");
    if(!/^\d+$/.test(a[0]??""))continue;
    out.push(a);
  }
  return out;
}
function loadExport15(){
  const p=EXPORT_DIR+"/raw/k15.csv.gz";
  if(!existsSync(p))throw Error("V26_EXPORT_K15_MISSING");
  const text=gunzipSync(readFileSync(p)).toString("utf8");
  const map=new Map();
  for(const line of text.split(/\r?\n/).slice(1)){
    if(!line)continue;
    const a=line.split(",");
    if(a.length<9)continue;
    const [symbol,t,o,h,l,c,ct,qv,tb]=a;
    const r=[Number(t),o,h,l,c,"0",Number(ct),qv,0,"0",tb,"0"];
    if(!map.has(symbol))map.set(symbol,[]);
    map.get(symbol).push(r);
  }
  const missPath=new URL("./binance-missing-15m-20260903.json",import.meta.url);
  if(existsSync(missPath)){
    const miss=JSON.parse(readFileSync(missPath,"utf8"));
    for(const x of miss.rows||[]){
      if(!map.has(x.symbol))map.set(x.symbol,[]);
      map.get(x.symbol).push(x.row);
    }
  }
  for(const rows of map.values()){
    const by=new Map(rows.map(r=>[Number(r[0]),r]));
    rows.splice(0,rows.length,...[...by.values()].sort((a,b)=>Number(a[0])-Number(b[0])));
  }
  return map;
}
const export15=loadExport15();

const pin=JSON.parse(readFileSync(new URL("./binance-symbol-filters-20260919.json",import.meta.url),"utf8"));
const exchangeInfo={symbols:(pin.symbols||[]).map(s=>({
  symbol:s.symbol,status:s.status,contractType:s.contractType,quoteAsset:s.quoteAsset,
  underlyingType:s.underlyingType,onboardDate:s.onboardDate,deliveryDate:s.deliveryDate,
  filters:[
    {filterType:"PRICE_FILTER",tickSize:s.tickSize},
    {filterType:"LOT_SIZE",stepSize:s.stepSize,minQty:s.minQty,maxQty:s.maxQty},
    {filterType:"MIN_NOTIONAL",notional:s.minNotional},
  ],
}))};

function ymd(t){return new Date(t).toISOString().slice(0,10);}
function daysBetween(start,end){
  const a=[];let t=Math.floor(start/DAY)*DAY,last=Math.floor(end/DAY)*DAY;
  for(;t<=last;t+=DAY)a.push(ymd(t));
  return a;
}
async function visionDay(symbol,interval,date){
  const key=symbol+"|"+interval+"|"+date;
  const safe=encodeURIComponent(symbol);
  const local=VISION_CACHE+"/"+safe+"-"+interval+"-"+date+".csv";
  if(existsSync(local))return csvRows(readFileSync(local,"utf8"));
  const fn=encodeURIComponent(symbol+"-"+interval+"-"+date+".zip");
  const url="https://data.binance.vision/data/futures/um/daily/klines/"+safe+"/"+interval+"/"+fn;
  let res;
  for(let a=0;a<4;a++){
    requestStats.requests++;
    res=await fetch(url,{headers:{"user-agent":"Trading-booooo-v26-validation"}});
    if(res.ok)break;
    if(res.status===404){requestStats.vision404++;return [];}
    requestStats.retries++;
    await new Promise(r=>setTimeout(r,Math.min(8000,500*2**a)));
  }
  if(!res?.ok)throw Error("VISION_HTTP_"+(res?.status??"UNKNOWN")+":"+url);
  const bytes=new Uint8Array(await res.arrayBuffer());
  datasetHash.update(url);datasetHash.update(bytes);
  const zip=VISION_CACHE+"/"+safe+"-"+interval+"-"+date+".zip";
  writeFileSync(zip,bytes);
  const text=execFileSync("unzip",["-p",zip],{encoding:"utf8",maxBuffer:128*1024*1024});
  writeFileSync(local,text);
  requestStats.visionFiles++;
  return csvRows(text);
}
function ym(t){return new Date(t).toISOString().slice(0,7);}
function monthsBetween(start,end){
  const out=[],d=new Date(Date.UTC(new Date(start).getUTCFullYear(),new Date(start).getUTCMonth(),1));
  const last=new Date(Date.UTC(new Date(end).getUTCFullYear(),new Date(end).getUTCMonth(),1));
  while(d<=last){out.push(d.toISOString().slice(0,7));d.setUTCMonth(d.getUTCMonth()+1);}
  return out;
}
async function visionMonth(symbol,interval,month){
  const safe=encodeURIComponent(symbol),local=VISION_CACHE+"/"+safe+"-"+interval+"-"+month+"-monthly.csv";
  if(existsSync(local))return csvRows(readFileSync(local,"utf8"));
  const fn=encodeURIComponent(symbol+"-"+interval+"-"+month+".zip");
  const url="https://data.binance.vision/data/futures/um/monthly/klines/"+safe+"/"+interval+"/"+fn;
  let res;
  for(let a=0;a<4;a++){
    requestStats.requests++;
    res=await fetch(url,{headers:{"user-agent":"Trading-booooo-v26-validation"}});
    if(res.ok)break;
    if(res.status===404){requestStats.vision404++;return [];}
    requestStats.retries++;await new Promise(r=>setTimeout(r,Math.min(8000,500*2**a)));
  }
  if(!res?.ok)throw Error("VISION_MONTH_HTTP_"+(res?.status??"UNKNOWN")+":"+url);
  const bytes=new Uint8Array(await res.arrayBuffer());datasetHash.update(url);datasetHash.update(bytes);
  const zip=VISION_CACHE+"/"+safe+"-"+interval+"-"+month+"-monthly.zip";writeFileSync(zip,bytes);
  const text=execFileSync("unzip",["-p",zip],{encoding:"utf8",maxBuffer:256*1024*1024});
  writeFileSync(local,text);requestStats.visionFiles++;return csvRows(text);
}
async function visionRows(symbol,interval,start,end){
  const all=[];
  if(interval==="15m"){
    let anyMonthly=false;
    for(const month of monthsBetween(start,end)){const rows=await visionMonth(symbol,interval,month);if(rows.length)anyMonthly=true;all.push(...rows);}
    if(anyMonthly)return all.filter(r=>Number(r[0])>=start&&Number(r[0])<=end);
  }
  for(const date of daysBetween(start,end))all.push(...await visionDay(symbol,interval,date));
  return all.filter(r=>Number(r[0])>=start&&Number(r[0])<=end);
}
async function mapLimit(items,limit,fn){
  let next=0,done=0;
  async function worker(){
    while(true){
      const i=next++; if(i>=items.length)return;
      await fn(items[i],i); done++;
      if(done%100===0)console.log("PREFETCH",done,"/",items.length);
    }
  }
  await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));
}
async function pagedKlines(symbol,interval,start,end,limit=1000){
  let rows;
  if(interval==="15m"&&export15.has(symbol)){
    const cached=export15.get(symbol).filter(r=>Number(r[0])>=start&&Number(r[0])<=end);
    rows=cached.length?cached:await visionRows(symbol,interval,start,end);
  }else{
    rows=await visionRows(symbol,interval,start,end);
  }
  const seen=new Map();
  for(const r of rows){
    const t=Number(r[0]);
    if(seen.has(t)&&JSON.stringify(seen.get(t))!==JSON.stringify(r))throw Error("KLINE_CONFLICT:"+symbol+":"+interval+":"+t);
    seen.set(t,r);
  }
  return [...seen.values()].sort((a,b)=>Number(a[0])-Number(b[0]));
}
async function get(path,params={}){
  if(path==="/fapi/v1/exchangeInfo")return exchangeInfo;
  if(path==="/fapi/v1/fundingRate")return [];
  throw Error("UNSUPPORTED_OFFLINE_GET:"+path);
}

function indexRows(rows){return new Map(rows.map(r=>[Number(r[0]),r]));}
function exactBars(index,interval,cutoff,required){
  const last=Math.floor(cutoff/interval)*interval-interval,raw=[];
  for(let i=required-1;i>=0;i--){const row=index.get(last-i*interval);if(!row)throw Error("KLINE_GAP");raw.push(row);}
  return parseBars(raw,interval,cutoff,required);
}
function symbolFilters(s){
  const price=(s.filters||[]).find(f=>f.filterType==="PRICE_FILTER")||{};
  const lot=(s.filters||[]).find(f=>f.filterType==="LOT_SIZE")||{};
  const notional=(s.filters||[]).find(f=>f.filterType==="MIN_NOTIONAL"||f.filterType==="NOTIONAL")||{};
  return {tickSize:Number(price.tickSize),stepSize:Number(lot.stepSize),minQty:Number(lot.minQty),maxQty:Number(lot.maxQty),minNotional:Number(notional.notional??notional.minNotional??5)};
}
function lifecycle(s){const onboard=Number(s.onboardDate||0),d=Number(s.deliveryDate||4_133_404_800_000);return{onboard,delivery:Number.isFinite(d)&&d>0?d:4_133_404_800_000};}
function candidatePolicy(id){return {...POLICY,maxDayReturn:V26_CANDIDATES[id].maxDayReturn,minVolumeRatio:1.30};}
function kstDayKey(t){return new Date(t+9*HOUR).toISOString().slice(0,10);}
function kstWeekKey(t){const d=new Date(t+9*HOUR),dow=(d.getUTCDay()+6)%7;return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()-dow)).toISOString().slice(0,10);}
function aggregate5mFrom1m(rows,cutoff,need=15){
  const buckets=new Map();
  for(const r of rows){const t=Number(r[0]);if(t>=cutoff)continue;const b=Math.floor(t/M5)*M5;let x=buckets.get(b);if(!x)x={t:b,o:Number(r[1]),h:-Infinity,l:Infinity,c:Number(r[4]),n:0};x.h=Math.max(x.h,Number(r[2]));x.l=Math.min(x.l,Number(r[3]));x.c=Number(r[4]);x.n++;buckets.set(b,x);}
  const keys=[...buckets.keys()].filter(t=>t+M5<=cutoff).sort((a,b)=>a-b).slice(-need);
  if(keys.length!==need)return null;for(let i=1;i<keys.length;i++)if(keys[i]-keys[i-1]!==M5)return null;
  const bars=keys.map(k=>buckets.get(k));if(bars.some(b=>b.n!==5))return null;return bars;
}
function atr14_5m(rows,cutoff){const bars=aggregate5mFrom1m(rows,cutoff,15);if(!bars)return null;let sum=0;for(let i=1;i<bars.length;i++){const x=bars[i],p=bars[i-1];sum+=Math.max(x.h-x.l,Math.abs(x.h-p.c),Math.abs(x.l-p.c));}return sum/14;}
function setupTrigger(signal,rows){
  const armed=startPullbackSetup({id:signal.id,symbol:signal.symbol,features:{referenceClose:signal.ref,signal5Close:signal.s5c}},signal.s5c,SETUP_POLICY);
  if(!armed.ok)return{ok:false,reason:armed.reason};let st=armed.state,prev=null;
  for(const r of rows){
    const t=Number(r[0]);if(t<signal.s5c)continue;
    const raw=[t,String(r[1]),String(r[2]),String(r[3]),String(r[4]),String(r[5]??0),t+MIN-1,String(r[7]??0),Number(r[8]??0),String(r[9]??0),String(r[10]??0),String(r[11]??0)];
    const pr=prev?[Number(prev[0]),String(prev[1]),String(prev[2]),String(prev[3]),String(prev[4]),String(prev[5]??0),Number(prev[0])+MIN-1,String(prev[7]??0),Number(prev[8]??0),String(prev[9]??0),String(prev[10]??0),String(prev[11]??0)]:null;
    const out=advancePullbackSetup(st,raw,pr,t+MIN,SETUP_POLICY);st=out.state;prev=r;
    if(st?.state===SETUP_STATE.TRIGGERED)return{ok:true,state:st};
    if([SETUP_STATE.EXPIRED_NO_PULLBACK,SETUP_STATE.EXPIRED_NO_REACCEL,SETUP_STATE.CHASE_EXPIRED,SETUP_STATE.INVALIDATED,SETUP_STATE.CONSUMED].includes(st?.state))return{ok:false,reason:st.terminalReason??st.state,state:st};
  }
  return{ok:false,reason:"SETUP_PATH_INCOMPLETE",state:st};
}
function mergedSignals(signals){const by=new Map(),kept=[];for(const s of [...signals].sort((a,b)=>a.s5c-b.s5c||a.symbol.localeCompare(b.symbol))){const p=by.get(s.symbol);if(p&&s.s5c<p.s5c+SETUP_POLICY.setupTtlMs)continue;by.set(s.symbol,s);kept.push(s);}return kept;}
function simulateExit(op,variant){
  const rows=op.rows.filter(r=>Number(r[0])>=op.entryAt);const entry=op.entryOpen;
  let stop=op.initialStop,peak=entry,lastHighAt=op.entryAt,pending=null,mfe=0,mae=0;const marks=[];
  for(let i=0;i<rows.length;i++){
    const r=rows[i],t=Number(r[0]),o=Number(r[1]),h=Number(r[2]),l=Number(r[3]),c=Number(r[4]),closeAt=t+MIN-1;
    if(pending)return{...op,exitAt:t,exitRef:o,exitKind:"DISCRETIONARY",reason:pending,mfe,mae,marks};
    if(l<=stop){const ref=Math.min(o,stop);mae=Math.min(mae,ref/entry-1);return{...op,exitAt:t,exitRef:ref,exitKind:"STOP",reason:stop>entry*(1-POLICY.stopPct)+1e-12?"PROTECTIVE_STOP":"INITIAL_STOP",mfe,mae,marks};}
    mae=Math.min(mae,l/entry-1);mfe=Math.max(mfe,h/entry-1);if(h>peak){peak=h;lastHighAt=closeAt;}
    const omfe=peak/entry-1;if(omfe>=POLICY.trailArmPct)stop=Math.max(stop,peak*(1-POLICY.trailGapPct));if(omfe>=.02)stop=Math.max(stop,entry+(peak-entry)*.50);if(omfe>=.01||closeAt-op.entryAt>=600_000)stop=Math.max(stop,entry*(1-.012));marks.push({t:closeAt,c});
    if(V26_CANDIDATES[variant].earlyFailureExit&&closeAt-op.entryAt<=5*MIN){const ef=earlyFailureDecision({entryPrice:entry,initialStopPrice:op.initialStop,signalReference:op.ref,entryAt:op.entryAt,now:closeAt+1,completedBars:rows.slice(0,i+1).map(x=>({openTime:Number(x[0]),closeTime:Number(x[0])+MIN-1,high:Number(x[2]),close:Number(x[4]),quoteVolume:Number(x[7]),takerBuyQuote:Number(x[10])}))});if(ef.action==="CLOSE")pending=ef.reason;}
    if(!pending&&closeAt-op.entryAt>=POLICY.maxHoldMs)pending="V17_MAX_HOLD";if(!pending&&closeAt-lastHighAt>=POLICY.staleMs)pending="V17_MOMENTUM_STALE";
  }
  return{...op,exitAt:null,exitRef:null,exitKind:"UNSETTLED",reason:"PATH_END",mfe,mae,marks};
}
function applySlippage(t,s){const entry=t.entryOpen*(1+s.entryBps/10_000);if(!Number.isFinite(t.exitRef))return{...t,entryExec:entry,exitExec:null};const b=t.exitKind==="STOP"?s.stopBps:s.discretionaryBps;return{...t,entryExec:entry,exitExec:t.exitRef*(1-b/10_000)};}
async function fundingFor(symbol){return await get("/fapi/v1/fundingRate",{symbol,startTime:START,endTime:END,limit:1000},1);}
function fundingPnl(rows,entryAt,exitAt,qty){if(!Number.isFinite(exitAt))return{signedCost:0,events:0};let signed=0,n=0;for(const x of rows||[]){const t=Number(x.fundingTime),rate=Number(x.fundingRate),mark=Number(x.markPrice);if(t>entryAt&&t<=exitAt&&Number.isFinite(rate)&&Number.isFinite(mark)&&mark>0){signed+=qty*mark*rate;n++;}}return{signedCost:signed,events:n};}
function riskPolicy(){const r=resolveRiskPolicy({risk_per_trade_pct:.25,max_daily_loss_pct:1,max_weekly_loss_pct:3,max_open_positions:1,max_open_positions_per_exchange:1,max_consecutive_losses:3});if(!r.ok)throw Error("RISK_POLICY_RESOLVE_FAILED:"+JSON.stringify(r.errors));return r.policy;}
const RISK=riskPolicy();
function dstr(v,p=12){
  const n=Number(v);
  if(!Number.isFinite(n))throw Error("NONFINITE_DECIMAL_INPUT:"+v);
  let s=n.toFixed(p).replace(/0+$/,"").replace(/\.$/,"");
  return s===""||s==="-0"?"0":s;
}
function solveRiskQuantity({equity,trade,filters,realizedToday,realizedWeek,highWater,lossStreak,slip}){
  const limits=evaluateLossLimits({policy:RISK,equity:dstr(equity),realizedToday:dstr(realizedToday),
    realizedThisWeek:dstr(realizedWeek),highWaterEquity:dstr(highWater),consecutiveLosses:lossStreak});
  if(!limits.allowed)return{decision:"SKIP",reason:limits.blocks.map(x=>x.code).join("|")||"LOSS_LIMIT"};
  const entry=trade.entryOpen*(1+slip.entryBps/10_000),stopSlip=slip.stopBps/10_000;
  let fundingAllowance="0",lastQty=null,result=null;
  for(let i=0;i<6;i++){
    result=solveQuantity({policy:RISK,equity:dstr(equity),
      bookAsks:[[dstr(entry),"1000000000000"]],
      bookBids:[[dstr(trade.initialStop),"1000000000000"]],
      structuralStop:dstr(trade.initialStop),stopSlippageFrac:dstr(stopSlip),
      takerFeeRate:dstr(FEES.taker,8),stopFeeRate:dstr(FEES.taker,8),
      expectedFundingCost:fundingAllowance,
      filters:{stepSize:dstr(filters.stepSize),minQty:dstr(filters.minQty),
        maxQty:dstr(filters.maxQty),minNotional:dstr(filters.minNotional)},
      reservedRisk:"0",openGrossNotional:"0",availableMargin:dstr(Math.max(0,equity-.10)),
      leverage:"3",entryPriceCap:dstr(entry),dailyRemaining:limits.dailyRemaining,
      weeklyRemaining:limits.weeklyRemaining});
    if(result.decision!=="ENTER")return result;
    const q=Number(result.plan.quantity.toString());
    const next=dstr(q*entry*FUNDING_RISK_ALLOWANCE_RATE);
    if(lastQty!==null&&Math.abs(q-lastQty)<1e-12){fundingAllowance=next;break;}
    lastQty=q;fundingAllowance=next;
  }
  return result;
}
function runIndependentDiagnostic(variant,ops,fundingMap,slip){
  const trades=[],rejections={};
  const reject=r=>rejections[r]=(rejections[r]||0)+1;
  for(const base of ops){
    const sized=solveRiskQuantity({equity:30,trade:base,filters:base.filters,
      realizedToday:0,realizedWeek:0,highWater:30,lossStreak:0,slip});
    if(sized.decision!=="ENTER"){reject(sized.reason||"RISK_SKIP");continue;}
    const qty=Number(sized.plan.quantity.toString()),t=applySlippage(base,slip);
    if(!(qty>0&&Number.isFinite(t.exitExec))){reject("UNSETTLED_OR_INVALID");continue;}
    const fund=fundingPnl(fundingMap.get(t.symbol)||[],t.entryAt,t.exitAt,qty);
    const entryFee=t.entryExec*qty*FEES.taker,exitFee=t.exitExec*qty*FEES.taker;
    const gross=(t.exitExec-t.entryExec)*qty,net=gross-entryFee-exitFee-fund.signedCost;
    trades.push({id:t.id,symbol:t.symbol,entryAt:t.entryAt,exitAt:t.exitAt,net,gross,
      entryFee,exitFee,funding:fund.signedCost,reason:t.reason,qty,initialStop:t.initialStop,
      mfe:t.mfe,mae:t.mae,...(t.diagnosticFeatures||{})});
  }
  const wins=trades.filter(x=>x.net>0),losses=trades.filter(x=>x.net<=0);
  const gp=wins.reduce((a,x)=>a+x.net,0),gl=Math.abs(losses.reduce((a,x)=>a+x.net,0));
  return {variant,trades,rejections,summary:{trades:trades.length,wins:wins.length,losses:losses.length,
    winRate:trades.length?wins.length/trades.length:0,netPnl:trades.reduce((a,x)=>a+x.net,0),
    avgNet:trades.length?trades.reduce((a,x)=>a+x.net,0)/trades.length:0,
    profitFactor:gl>0?gp/gl:(gp>0?Infinity:0)}};
}

function bootstrapLcb(trades,seedText){
  const days=new Map();for(const t of trades){const k=kstDayKey(t.exitAt);if(!days.has(k))days.set(k,[]);days.get(k).push(t);}const blocks=[...days.values()];if(blocks.length<2)return null;
  let seed=2166136261;for(const ch of seedText)seed=(seed^ch.charCodeAt(0))*16777619>>>0;const rnd=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/4294967296;};const vals=[];
  for(let b=0;b<5000;b++){let net=0,n=0;for(let i=0;i<blocks.length;i++){const block=blocks[Math.floor(rnd()*blocks.length)];for(const x of block){net+=x.net;n++;}}vals.push(n?net/n:0);}vals.sort((a,b)=>a-b);return vals[Math.floor(vals.length*.05)];
}
function summarizeAccount(result){
  const ts=result.trades,w=ts.filter(t=>t.net>0),l=ts.filter(t=>t.net<=0),gp=w.reduce((s,t)=>s+t.net,0),gl=Math.abs(l.reduce((s,t)=>s+t.net,0)),net=ts.reduce((s,t)=>s+t.net,0);let streak=0,maxStreak=0;for(const t of ts){if(t.net<=0){streak++;maxStreak=Math.max(maxStreak,streak);}else streak=0;}const byDay={},byWeek={};for(const t of ts){const d=kstDayKey(t.exitAt),wk=kstWeekKey(t.exitAt);byDay[d]=(byDay[d]||0)+t.net;byWeek[wk]=(byWeek[wk]||0)+t.net;}const strip=n=>{const ids=new Set([...ts].sort((a,b)=>b.net-a.net).slice(0,n).map(x=>x.id));return ts.filter(t=>!ids.has(t.id)).reduce((s,t)=>s+t.net,0);};
  return{trades:ts.length,rejections:result.rejections,wins:w.length,losses:l.length,netPnl:net,finalEquity:30+net,returnPct:net/30,profitFactor:gl>0?gp/gl:(gp>0?Infinity:0),avgWin:w.length?gp/w.length:0,avgLoss:l.length?-gl/l.length:0,avgNet:ts.length?net/ts.length:0,mdd:result.mdd,longestLossStreak:maxStreak,byDay,byWeek,removeTop1Net:strip(1),removeTop3Net:strip(3),removeTop5Net:strip(5),activeDays:Object.keys(byDay).length,expectancyLcb5:bootstrapLcb(ts,result.variant)};
}
function runAccount(variant,ops,fundingMap,slip){
  let equity=30,highWater=30,busyUntil=-Infinity,lossStreak=0,mdd=0,peak=30;const realizedDay=new Map(),realizedWeek=new Map(),trades=[],rej={};const reject=r=>rej[r]=(rej[r]||0)+1;
  for(const base of [...ops].sort((a,b)=>a.entryAt-b.entryAt||a.rank-b.rank||a.symbol.localeCompare(b.symbol))){
    if(base.entryAt<busyUntil){reject("SLOT_OCCUPIED");continue;}const d=kstDayKey(base.entryAt),wk=kstWeekKey(base.entryAt);const sized=solveRiskQuantity({equity,trade:base,filters:base.filters,realizedToday:realizedDay.get(d)||0,realizedWeek:realizedWeek.get(wk)||0,highWater,lossStreak,slip});if(sized.decision!=="ENTER"){reject(sized.reason||"RISK_SKIP");continue;}
    const qty=Number(sized.plan.quantity.toString()),t=applySlippage(base,slip);if(!(qty>0&&Number.isFinite(t.exitExec))){reject("UNSETTLED_OR_INVALID");continue;}const fund=fundingPnl(fundingMap.get(t.symbol)||[],t.entryAt,t.exitAt,qty),entryFee=t.entryExec*qty*FEES.taker,exitFee=t.exitExec*qty*FEES.taker,gross=(t.exitExec-t.entryExec)*qty,net=gross-entryFee-exitFee-fund.signedCost;
    for(const m of t.marks){if(m.t>=t.exitAt)break;const accrued=fundingPnl(fundingMap.get(t.symbol)||[],t.entryAt,m.t,qty).signedCost,marked=equity+(m.c-t.entryExec)*qty-entryFee-accrued;peak=Math.max(peak,marked);mdd=Math.min(mdd,marked-peak);}
    equity+=net;peak=Math.max(peak,equity);mdd=Math.min(mdd,equity-peak);highWater=Math.max(highWater,equity);const ed=kstDayKey(t.exitAt),ew=kstWeekKey(t.exitAt);realizedDay.set(ed,(realizedDay.get(ed)||0)+net);realizedWeek.set(ew,(realizedWeek.get(ew)||0)+net);lossStreak=net<=0?lossStreak+1:0;busyUntil=t.exitAt;
    trades.push({id:t.id,symbol:t.symbol,rank:t.rank,entryAt:t.entryAt,exitAt:t.exitAt,reason:t.reason,qty,entry:t.entryExec,exit:t.exitExec,gross,entryFee,exitFee,funding:fund.signedCost,fundingEvents:fund.events,net,plannedLoss:Number(sized.plan.plannedLoss.toString()),initialStop:t.initialStop,mfe:t.mfe,mae:t.mae});
  }
  return{variant,trades,rejections:rej,mdd};
}

const info=await get("/fapi/v1/exchangeInfo",{},10);
const allSymbols=(info.symbols||[]).filter(s=>s.contractType==="PERPETUAL"&&s.quoteAsset==="USDT"&&s.underlyingType==="COIN").filter(s=>{const lc=lifecycle(s);return lc.onboard<END&&lc.delivery>START-WARMUP;});
const meta=new Map(allSymbols.map(s=>[s.symbol,{raw:s,filters:symbolFilters(s),...lifecycle(s)}]));
console.log("UNIVERSE",allSymbols.length,new Date(START).toISOString(),new Date(END).toISOString());
const cutoffState=new Map();
let eligibleWindows=[],eligibleSource="eligible15-repaired.json";
if(!RECOMPUTE_ELIGIBLE){
  const repairedEligible=JSON.parse(readFileSync(new URL("./eligible15-repaired.json",import.meta.url),"utf8"));
  eligibleWindows=(repairedEligible.eligible||[]).map(x=>({
    cut:Number(x.cutoff),
    f:{symbol:x.symbol,referenceClose:Number(x.reference_close),dayReturn:Number(x.day_return),
       return15m:Number(x.return15),return30m:Number(x.return30),return60m:Number(x.return60),
       volumeRatio:Number(x.volume_ratio),qv24:Number(x.qv24),rank:Number(x.rank),atr:1},
    c5:!!x.c5_allowed,marketAllowed:!!x.market_allowed
  }));
}else{
  eligibleSource="RECOMPUTED_BINANCE_VISION_15M";
  const data15=new Map();
  await mapLimit(allSymbols,12,async s=>{
    const lc=lifecycle(s),from=Math.max(START-WARMUP,Math.floor(lc.onboard/M15)*M15);
    const rows=await pagedKlines(s.symbol,"15m",from,END-1,1500).catch(()=>[]);
    data15.set(s.symbol,indexRows(rows));
  });
  for(let cut=Math.ceil(START/M15)*M15;cut<END;cut+=M15){
    const expected=allSymbols.filter(s=>{const lc=lifecycle(s);return lc.onboard<=cut-110*M15&&lc.delivery>cut;});
    const features=[];
    for(const s of expected){try{features.push(feature15(s.symbol,exactBars(data15.get(s.symbol)||new Map(),M15,cut,110),cut));}catch{}}
    const coverage=expected.length?features.length/expected.length:0;
    if(coverage<POLICY.minCoverage){cutoffState.set(cut,{blocked:true,coverage,expected:expected.length,evaluated:features.length});continue;}
    const ranked=rankFeatures(features),by=new Map(ranked.map(x=>[x.symbol,x]));
    const liquid=ranked.filter(x=>x.qv24>=POLICY.minQuoteVolume24h);
    const market=marketParticipationDecision({
      btcReturn60m:by.get("BTCUSDT")?.return60m,
      rising30mCount:liquid.filter(x=>x.return30m>0).length,
      liquidUniverseCount:liquid.length
    });
    const base=ranked.slice(0,POLICY.rankLimit).filter(f=>entryReason(f,candidatePolicy("C0"))==="ELIGIBLE");
    const c5=new Set(ranked.slice(0,POLICY.rankLimit).filter(f=>entryReason(f,candidatePolicy("C5"))==="ELIGIBLE").map(x=>x.symbol));
    for(const f of base)eligibleWindows.push({cut,f,c5:c5.has(f.symbol),marketAllowed:market.status==="KNOWN"&&market.allowed});
  }
}
console.log("ELIGIBLE15",eligibleWindows.length,"SOURCE",eligibleSource);
const need5=new Map();
for(const x of eligibleWindows){
  for(const d of daysBetween(x.cut-14*M5,x.cut+2*M5-1)){
    const k=x.f.symbol+"|"+d;need5.set(k,{symbol:x.f.symbol,date:d});
  }
}
await mapLimit([...need5.values()],16,x=>visionDay(x.symbol,"5m",x.date));
console.log("PREFETCH5_DONE",need5.size);
const rawSignals=[];let ew=0;
for(const x of eligibleWindows){const rows=await pagedKlines(x.f.symbol,"5m",x.cut-14*M5,x.cut+10*M5-1,100).catch(()=>[]),idx=indexRows(rows);for(const t of [x.cut,x.cut+M5,x.cut+2*M5]){if(t<START||t>=END)continue;try{const b=exactBars(idx,M5,t,14),last=b.at(-1),prev=b.at(-2),r5=last.c/prev.c-1,r15=last.c/b.at(-4).c-1;if(r5>=POLICY.min5mReturn&&r15>0&&last.c>=last.o)rawSignals.push({id:`${x.f.symbol}:${t}`,symbol:x.f.symbol,s5c:t,ref:last.c,rank:x.f.rank,c5Allowed:x.c5,marketAllowed:x.marketAllowed,features:{...x.f,referenceClose:last.c,signal5Close:t,return5m:r5,confirmationReturn15m:r15}});}catch{}}if(++ew%100===0)console.log("5M_WINDOWS",ew,"/",eligibleWindows.length);}
const uniqueSignals=[...new Map(rawSignals.map(s=>[s.id,s])).values()].sort((a,b)=>a.s5c-b.s5c||a.symbol.localeCompare(b.symbol));console.log("RAW_SIGNALS",uniqueSignals.length);
const need1=new Map();
for(const sig of uniqueSignals){
  const a=sig.s5c-90*MIN,b=sig.s5c+SETUP_POLICY.setupTtlMs+POLICY.maxHoldMs+15*MIN-1;
  for(const d of daysBetween(a,b)){const k=sig.symbol+"|"+d;need1.set(k,{symbol:sig.symbol,date:d});}
}
await mapLimit([...need1.values()],16,x=>visionDay(x.symbol,"1m",x.date));
console.log("PREFETCH1_DONE",need1.size);
const pathCache=new Map();let ps=0;
for(const s of uniqueSignals){try{const rows=await pagedKlines(s.symbol,"1m",s.s5c-90*MIN,s.s5c+SETUP_POLICY.setupTtlMs+POLICY.maxHoldMs+15*MIN-1,500);pathCache.set(s.id,rows);}catch(e){pathCache.set(s.id,{error:String(e),rows:[]});}if(++ps%50===0)console.log("1M_PATHS",ps,"/",uniqueSignals.length);}

const opportunitiesByVariant=new Map();
const candidateIds=ONLY_CANDIDATE?[ONLY_CANDIDATE]:Object.keys(V26_CANDIDATES);
for(const id of candidateIds){
  let filtered=uniqueSignals.filter(s=>!(id==="C5"||id==="C9")||s.c5Allowed);if(V26_CANDIDATES[id].marketParticipation)filtered=filtered.filter(s=>s.marketAllowed);filtered=mergedSignals(filtered);const ops=[],reasons={};
  for(const s of filtered){
    const cached=pathCache.get(s.id),rows=Array.isArray(cached)?cached:cached?.rows;
    if(!rows?.length){reasons.PATH_MISSING=(reasons.PATH_MISSING||0)+1;continue;}
    const tr=setupTrigger(s,rows.filter(r=>Number(r[0])>=s.s5c-2*MIN));
    if(!tr.ok){reasons[tr.reason]=(reasons[tr.reason]||0)+1;continue;}
    const triggerAt=Number(tr.state.triggerAt);
    let entryAt=triggerAt;
    if(V26_CANDIDATES[id].antiExhaustion){
      const triggerBar=rows.find(r=>Number(r[0])===triggerAt-MIN);
      const decision=antiExhaustionDecision({
        volumeRatio:Number(s.features?.volumeRatio),
        triggerAt,
        bar:triggerBar?{
          openTime:Number(triggerBar[0]),closeTime:Number(triggerBar[0])+MIN-1,
          quoteVolume:Number(triggerBar[7]),takerBuyQuote:Number(triggerBar[10])
        }:null
      });
      if(decision.action!=="ENTER"){
        reasons[decision.reason]=(reasons[decision.reason]||0)+1;
        continue;
      }
    }
    if(V26_CANDIDATES[id].triggerQuality1m){
      const triggerBar=rows.find(r=>Number(r[0])===triggerAt-MIN);
      const decision=triggerQuality1mDecision({
        triggerAt,
        bar:triggerBar?{
          openTime:Number(triggerBar[0]),high:Number(triggerBar[2]),low:Number(triggerBar[3]),
          close:Number(triggerBar[4]),closeTime:Number(triggerBar[0])+MIN-1,
          quoteVolume:Number(triggerBar[7]),takerBuyQuote:Number(triggerBar[10])
        }:null
      });
      if(decision.action!=="ENTER"){
        reasons[decision.reason]=(reasons[decision.reason]||0)+1;
        continue;
      }
    }
    if(V26_CANDIDATES[id].entryConfirmation1m||V26_CANDIDATES[id].breakoutContinuation1m){
      const confirmationRow=rows.find(r=>Number(r[0])===triggerAt);
      let decision;
      if(V26_CANDIDATES[id].breakoutContinuation1m){
        const triggerBar=rows.find(r=>Number(r[0])===triggerAt-MIN);
        decision=breakoutContinuation1mDecision({
          triggerAt,
          signalReference:s.ref,
          triggerHigh:triggerBar?Number(triggerBar[2]):Number.NaN,
          now:triggerAt+MIN,
          bar:confirmationRow?{
            openTime:Number(confirmationRow[0]),low:Number(confirmationRow[3]),
            close:Number(confirmationRow[4]),closeTime:Number(confirmationRow[0])+MIN-1,
            quoteVolume:Number(confirmationRow[7]),takerBuyQuote:Number(confirmationRow[10])
          }:null
        });
      }else{
        decision=entryConfirmation1mDecision({
          triggerAt,
          signalReference:s.ref,
          triggerClose:Number(tr.state.triggerClose),
          setupLow:Number(tr.state.pullbackLow),
          now:triggerAt+MIN,
          bar:confirmationRow?{
            openTime:Number(confirmationRow[0]),low:Number(confirmationRow[3]),
            close:Number(confirmationRow[4]),closeTime:Number(confirmationRow[0])+MIN-1,
            quoteVolume:Number(confirmationRow[7]),takerBuyQuote:Number(confirmationRow[10])
          }:null
        });
      }
      if(decision.action!=="ENTER"){
        reasons[decision.reason]=(reasons[decision.reason]||0)+1;
        continue;
      }
      entryAt=triggerAt+MIN;
    }
    const entryRow=rows.find(r=>Number(r[0])===entryAt);
    if(!entryRow){reasons.ENTRY_BAR_MISSING=(reasons.ENTRY_BAR_MISSING||0)+1;continue;}
    const entryOpen=Number(entryRow[1]);
    if(Math.abs(entryOpen/s.ref-1)>POLICY.maxEntryDriftPct){reasons.ENTRY_DRIFT=(reasons.ENTRY_DRIFT||0)+1;continue;}
    let stop=entryOpen*(1-POLICY.stopPct);
    if(V26_CANDIDATES[id].structuralStop){
      const st=structuralStopPrice({setupLow:Number(tr.state.pullbackLow),priceTick:meta.get(s.symbol)?.filters.tickSize,atr5m14:atr14_5m(rows,entryAt)});
      if(st.status!=="OK"||!(st.price<entryOpen)){reasons[st.reason||"STRUCTURAL_STOP_INVALID"]=(reasons[st.reason||"STRUCTURAL_STOP_INVALID"]||0)+1;continue;}
      stop=st.price;
    }
    const triggerBarForDiag=rows.find(r=>Number(r[0])===triggerAt-MIN);
    const tq=triggerBarForDiag?Number(triggerBarForDiag[7]):Number.NaN;
    const ttb=triggerBarForDiag?Number(triggerBarForDiag[10]):Number.NaN;
    const th=triggerBarForDiag?Number(triggerBarForDiag[2]):Number.NaN;
    const tl=triggerBarForDiag?Number(triggerBarForDiag[3]):Number.NaN;
    const tc=triggerBarForDiag?Number(triggerBarForDiag[4]):Number.NaN;
    const settled=simulateExit({
      ...s,rows,entryAt,entryOpen,initialStop:stop,filters:meta.get(s.symbol).filters,
      diagnosticFeatures:{
        dayReturn:Number(s.features?.dayReturn),
        volumeRatio:Number(s.features?.volumeRatio),
        return5m:Number(s.features?.return5m),
        return15m:Number(s.features?.return15m),
        return30m:Number(s.features?.return30m),
        return60m:Number(s.features?.return60m),
        rank:Number(s.rank),
        pullbackDepth:(s.ref-Number(tr.state.pullbackLow))/s.ref,
        entryDrift:entryOpen/s.ref-1,
        stopDistancePct:(entryOpen-stop)/entryOpen,
        triggerTakerBuyRatio:tq>0?ttb/tq:Number.NaN,
        triggerCloseLocation:Number.isFinite(th)&&Number.isFinite(tl)&&th>tl?(tc-tl)/(th-tl):Number.NaN,
        marketAllowed:!!s.marketAllowed
      }
    },id);
    if(!Number.isFinite(settled.exitAt)){reasons.UNSETTLED=(reasons.UNSETTLED||0)+1;continue;}
    ops.push(settled);
  }
  opportunitiesByVariant.set(id,{ops,reasons,filteredSignals:filtered.length});console.log("OPS",id,filtered.length,ops.length,reasons);
}
const symbolsWithOps=new Set();for(const v of opportunitiesByVariant.values())for(const o of v.ops)symbolsWithOps.add(o.symbol);
writeFileSync(new URL("funding-symbols.json",OUT),JSON.stringify([...symbolsWithOps].sort(),null,2));const fundingMap=new Map();let fd=0;for(const symbol of [...symbolsWithOps].sort()){fundingMap.set(symbol,await fundingFor(symbol).catch(()=>[]));if(++fd%50===0)console.log("FUNDING",fd,"/",symbolsWithOps.size);}

const report={generatedAt:new Date().toISOString(),window:{start:new Date(START).toISOString(),end:new Date(END).toISOString(),days:DAYS},classification:REPORT_CLASSIFICATION,universe:{exchangeInfoPerpetualUsdtCoin:allSymbols.length},requestStats,costModel:{takerFeeRate:FEES.taker,actualFundingFromBinanceFundingRateHistory:false,fundingPendingConnectorEnrichment:true,fundingRiskAllowanceRate:FUNDING_RISK_ALLOWANCE_RATE,slippage:EXEC,historicalL2BookAvailable:false,slippageLimitation:"Binance REST does not provide historical L2 snapshots; baseline/stress bps are pre-registered execution assumptions."},risk:{startingEquity:30,leverage:3,minTrades:MIN_TRADES,minIndependentDays:MIN_INDEPENDENT_DAYS,riskPerTradeFrac:Number(RISK.riskPerTradeFrac.toString()),maxTotalOpenRiskFrac:Number(RISK.maxTotalOpenRiskFrac.toString()),maxGrossNotionalToEquity:Number(RISK.maxGrossNotionalToEquity.toString()),maxConcurrentPositions:RISK.maxConcurrentPositions},dataQuality:{blocked15mCutoffs:0,total15mCutoffs:Math.floor((END-START)/M15),rawSignals:uniqueSignals.length,eligible15Windows:eligibleWindows.length,repairedEligibleSource:eligibleSource},candidates:{},datasetHash:null,codeHash:null,noRobustEdgeFound:true,provisionalCandidate:null};
const tradeDetails={},diagnosticDetails={};
for(const id of candidateIds){
  const x=opportunitiesByVariant.get(id),base=runAccount(id,x.ops,fundingMap,EXEC.baseline),
    s2=runAccount(id,x.ops,fundingMap,EXEC.stress2x),s4=runAccount(id,x.ops,fundingMap,EXEC.stress4x),
    diag=runIndependentDiagnostic(id,x.ops,fundingMap,EXEC.baseline),
    b=summarizeAccount(base),m2=summarizeAccount(s2),m4=summarizeAccount(s4),
    enough=b.trades>=MIN_TRADES&&b.activeDays>=MIN_INDEPENDENT_DAYS;
  report.candidates[id]={preAccount:{filteredSignals:x.filteredSignals,opportunities:x.ops.length,pathReasons:x.reasons},
    baseline:b,stress2x:m2,stress4x:m4,independentOpportunityDiagnostic:diag.summary,
    sufficientSample:enough,developmentPass:enough&&b.profitFactor>=1.2&&m2.netPnl>0&&b.expectancyLcb5!==null&&b.expectancyLcb5>0};
  tradeDetails[id]={baseline:base.trades,stress2x:s2.trades,stress4x:s4.trades};
  diagnosticDetails[id]=diag.trades;
}
const viable=Object.entries(report.candidates).filter(([,v])=>v.developmentPass).sort((a,b)=>b[1].stress2x.netPnl-a[1].stress2x.netPnl);if(viable.length)report.provisionalCandidate=viable[0][0];report.noRobustEdgeFound=true;report.datasetHash=datasetHash.digest("hex");const codeHasher=createHash("sha256");for(const f of [new URL("../../supabase/functions/_shared/leader-momentum-v17.mjs",import.meta.url),new URL("../../supabase/functions/_shared/leader-pullback-reaccel.mjs",import.meta.url),new URL("../../supabase/functions/_shared/boo/v26-candidate-policy.mjs",import.meta.url),new URL("../../supabase/functions/_shared/boo/risk-policy.mjs",import.meta.url),new URL("../../supabase/functions/_shared/boo/risk-budget.mjs",import.meta.url)])codeHasher.update(readFileSync(f));codeHasher.update(readFileSync(new URL(import.meta.url)));report.codeHash=codeHasher.digest("hex");
writeFileSync(new URL("summary.json",OUT),JSON.stringify(report,null,2));writeFileSync(new URL("trades-pre-funding.json",OUT),JSON.stringify(tradeDetails,null,2));writeFileSync(new URL("edge-diagnostic.json",OUT),JSON.stringify(diagnosticDetails,null,2));const md=[];md.push("# Binance 30-day V26 validation","",`Window: ${report.window.start} -> ${report.window.end}`,"","This is a fresh Binance-API development replay, not an independent holdout.","","| Candidate | Trades | Net | Final equity | Return | PF | MDD | LCB/trade | Stress2x net | Stress4x net | Dev pass |","|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");for(const [id,v] of Object.entries(report.candidates)){const b=v.baseline;md.push(`| ${id} | ${b.trades} | ${b.netPnl.toFixed(4)} | ${b.finalEquity.toFixed(4)} | ${(b.returnPct*100).toFixed(2)}% | ${Number.isFinite(b.profitFactor)?b.profitFactor.toFixed(3):"Inf"} | ${b.mdd.toFixed(4)} | ${b.expectancyLcb5==null?"NA":b.expectancyLcb5.toFixed(5)} | ${v.stress2x.netPnl.toFixed(4)} | ${v.stress4x.netPnl.toFixed(4)} | ${v.developmentPass?"YES":"NO"} |`);}md.push("","Provisional candidate: "+(report.provisionalCandidate??"NONE"),"","no_robust_edge_found=true (no unused independent holdout).","","Dataset hash: `"+report.datasetHash+"`","Code hash: `"+report.codeHash+"`");writeFileSync(new URL("SUMMARY.md",OUT),md.join("\n")+"\n");console.log(md.join("\n"));
