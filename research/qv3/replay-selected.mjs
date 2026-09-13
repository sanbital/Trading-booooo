/** Conditional fixed-entry diagnostics. Does not submit orders or claim account replay. */
import fs from 'node:fs';
import path from 'node:path';
import {exitDecision,entryGate,exitSignal} from './rules.mjs';

const VARIANTS=['BASELINE','ENTRY_EXIT_TWO'];
const root=process.argv[2];if(!root)throw Error('Usage: node replay.mjs EVIDENCE_DIR');
const read=n=>JSON.parse(fs.readFileSync(path.join(root,n)));
const protocol=JSON.parse(fs.readFileSync(new URL('./protocol.json',import.meta.url))); const outPath=new URL('./comparison.json',import.meta.url);
const rows=read('episodes.json'),candles=read('candles.json'),decisions=read('decisions.json');
const cutoff=Date.parse(protocol.cutoff),split=Date.parse(protocol.split),deploy=Date.parse(protocol.latest_deployment_registered);
const sum=(xs,f)=>xs.reduce((s,x)=>s+f(x),0),byId=new Map(rows.map(r=>[r.id,r]));
function initial(r){return {entryPrice:r.entry_price,entryAt:r.state_entry_ms,entryFee:r.entry_fee,quantity:r.quantity,peakPrice:r.entry_price,lastHighAt:r.state_entry_ms,stopPrice:r.entry_price*(1-r.baseline_config.stopPct),policy:r.baseline_config};}
const parity=[];
for(const r of rows){
 let state=initial(r);const checks=[];
 for(const q of decisions.filter(d=>d.position_id===r.id&&Number(d.details?.bid)>0).sort((a,b)=>Date.parse(a.decided_at)-Date.parse(b.decided_at))){
  const at=Number(q.details.detectedAtMs)||Date.parse(q.decided_at);if(at<state.entryAt||at>r.exit_ms)continue;
  const d=exitDecision(state,Number(q.details.bid),at);
  checks.push({id:q.id,at,stopError:d.stopPrice-Number(q.details.stopPrice),peakError:d.peakPrice-Number(q.details.peakPrice),actionMatches:d.action===q.details.action,reasonMatches:d.reason===q.details.reason});
  state={...state,stopPrice:d.stopPrice,peakPrice:d.peakPrice,lastHighAt:d.lastHighAt};
 }
 parity.push({id:r.id,symbol:r.symbol,checks,stopMismatches:checks.filter(c=>Math.abs(c.stopError)>r.entry_price*1e-8).length,actionMismatches:checks.filter(c=>!c.actionMatches).length});
}
function simulate(r,variant,e,boundary,prior=false){
 const eg=entryGate(candles[r.id],r.entry_ms,variant); const gate={...eg,verdict:eg.reject?'REJECT':'KEEP'};
 if(gate.verdict!=='KEEP')return {id:r.id,symbol:r.symbol,filtered:gate.verdict==='REJECT',unavailable:gate.verdict==='UNAVAILABLE',gate,entry_ms:r.entry_ms,exit_ms:r.entry_ms,net:0,fee:0,censored:false,trace:[]};
 let state=initial(r),fill=null,reason=null,signalAt=null,ambiguous=false;const trace=[];
 const bars=candles[r.id],usable=bars.filter(b=>Number(b[6])<cutoff&&Number(b[6])>=r.entry_ms);
 for(const b of usable){
  const t=Number(b[0]),open=Number(b[1]),low=Number(b[3]);
  if(t<state.entryAt){
   if(boundary==='ADVERSE_ENTRY_BAR'&&low<=state.stopPrice){fill={time:r.entry_ms+1,price:state.stopPrice*(1-e.price_impact)};reason='ENTRY_BAR_ADVERSE_BOUND';ambiguous=true;break;}
   continue;
  }
  const resident=state.stopPrice;
  const d=exitDecision(state,open,t,variant,bars);
  state={...state,peakPrice:d.peakPrice,lastHighAt:d.lastHighAt,stopPrice:d.stopPrice,candidateStopProvenance:d.candidateStopProvenance};
  trace.push({time:t,bid:open,peak:d.peakPrice,stop:d.stopPrice,action:d.action,reason:d.reason});
  if(d.action==='CLOSE'){
   signalAt=t;const next=usable.find(x=>Number(x[0])>=t+e.software_delay_ms);if(!next)break;
   const native=usable.find(x=>Number(x[0])>=t&&Number(x[0])<Number(next[0])&&Number(x[3])<=resident);
   fill=native?{time:Number(native[6]),price:Math.min(Number(native[1]),resident)*(1-e.price_impact)}:
    {time:Number(next[0]),price:Number(next[1])*(1-e.price_impact)};
   reason=native?'RESIDENT_NATIVE_DURING_SOFTWARE_DELAY':d.reason;ambiguous=!!native;break;
  }
  if(low<=state.stopPrice){fill={time:Number(b[6]),price:Math.min(open,state.stopPrice)*(1-e.price_impact)};reason='NATIVE_'+(d.protectionStage??'BASELINE');ambiguous=true;break;}
 }
 const censored=!fill;if(censored){const b=usable.at(-1);if(!b)throw Error('NO_PRICE_PATH');fill={time:Number(b[6]),price:Number(b[4])};reason='RIGHT_CENSORED_MARK';}
 const fee=r.entry_fee*e.fee_factor+(censored?0:fill.price*r.quantity*e.exit_fee_rate*e.fee_factor),net=(fill.price-r.entry_price)*r.quantity-fee;
 return {id:r.id,symbol:r.symbol,entry_ms:r.entry_ms,exit_ms:fill.time,exit_price:fill.price,filtered:false,unavailable:false,net,fee,censored,reason,signalAt,signal_delay_ms:signalAt===null?null:fill.time-signalAt,
  ambiguous_intrabar:ambiguous,observed_mfe:state.peakPrice/r.entry_price-1,giveback:(state.peakPrice-fill.price)*r.quantity,trace};
}
function stats(all){
 const xs=all.filter(x=>!x.filtered&&!x.unavailable),wins=xs.filter(x=>x.net>0),losses=xs.filter(x=>x.net<0);let equity=0,peak=0,dd=0;
 for(const x of [...xs].filter(x=>!x.censored).sort((a,b)=>a.exit_ms-b.exit_ms)){equity+=x.net;peak=Math.max(peak,equity);dd=Math.max(dd,peak-equity);}
 const events=xs.flatMap(x=>[{t:x.entry_ms,n:1},{t:x.exit_ms,n:-1}]).sort((a,b)=>a.t-b.t||a.n-b.n);let count=0,max=0;for(const x of events){count+=x.n;max=Math.max(max,count);}
 return {n:xs.length,filtered:all.filter(x=>x.filtered).length,unavailable:all.filter(x=>x.unavailable).length,net:sum(xs,x=>x.net),expectancy:xs.length?sum(xs,x=>x.net)/xs.length:null,
 winRate:xs.length?wins.length/xs.length:null,avgWin:wins.length?sum(wins,x=>x.net)/wins.length:null,avgLoss:losses.length?sum(losses,x=>x.net)/losses.length:null,
 profitFactor:losses.length?sum(wins,x=>x.net)/-sum(losses,x=>x.net):null,worst:xs.length?Math.min(...xs.map(x=>x.net)):null,closedCurveDrawdown:dd,censored:xs.filter(x=>x.censored).length,
 retainedExecutedEntryFraction:all.length?xs.length/all.length:null,profitThenLoss:xs.filter(x=>x.observed_mfe>=.01&&x.net<0).length,giveback:sum(xs,x=>x.giveback??0),
 notionalHours:sum(xs,x=>(x.exit_ms-x.entry_ms)/3600000*byId.get(x.id).entry_price*byId.get(x.id).quantity),
 roundTripNotional:sum(xs,x=>byId.get(x.id).entry_price*byId.get(x.id).quantity+(x.censored?0:x.exit_price*byId.get(x.id).quantity)),
 maxSimultaneousFixedEntries:max,accountTurnover:null,accountMtmDrawdown:null,opportunityReductionRate:null};
}
const groups={ALL:()=>true,FIRST_24H:r=>r.entry_ms<split,SECOND_24H:r=>r.entry_ms>=split,LATEST_DEPLOYMENT:r=>r.entry_ms>=deploy,CROSSED_LATEST_DEPLOYMENT:r=>r.entry_ms<deploy&&byId.get(r.id).exit_ms>deploy};
for(const p of new Set(rows.map(x=>x.patch)))groups[p]=r=>byId.get(r.id).patch===p;
const results=[],runs={},priorResults=[];
for(const [scenario,e] of Object.entries(protocol.execution_scenarios))for(const boundary of protocol.bar_order_bounds){
 const base=rows.map(r=>simulate(r,'BASELINE',e,boundary));
 for(const variant of VARIANTS){
  const xs=variant==='BASELINE'?base:rows.map(r=>simulate(r,variant,e,boundary));runs[`${scenario}/${boundary}/${variant}`]=xs;
  for(const [cohort,filter] of Object.entries(groups)){
   const sub=xs.filter(filter),bs=base.filter(filter),s=stats(sub),b=stats(bs);
   results.push({scenario,boundary,variant,cohort,...s,delta:s.net-b.net,baselineNet:b.net,
    avoidedSimulatedLoss:sum(sub.filter((x,i)=>x.filtered&&bs[i].net<0),(x)=>-bs.find(y=>y.id===x.id).net),
    sacrificedSimulatedProfit:sum(sub.filter((x,i)=>x.filtered&&bs[i].net>0),(x)=>bs.find(y=>y.id===x.id).net),
    worsened:sub.filter((x,i)=>x.net<bs[i].net-1e-9).length,improved:sub.filter((x,i)=>x.net>bs[i].net+1e-9).length});
  }
 }

}
const normal=runs['normal/SKIP_ENTRY_BAR/BASELINE'];
const fidelity=Object.fromEntries(Object.entries(groups).map(([k,filter])=>{const xs=normal.filter(filter),es=xs.map(x=>({id:x.id,symbol:x.symbol,error:x.net-byId.get(x.id).net}));return [k,{n:xs.length,meanAbsoluteError:xs.length?sum(es,x=>Math.abs(x.error))/xs.length:null,maxAbsoluteError:es.length?Math.max(...es.map(x=>Math.abs(x.error))):null,over25c:es.filter(x=>Math.abs(x.error)>.25).length,errors:es}];}));
// Matched actual bids test deterministic policy parity; they cannot fill missing counterfactual prices.
const paritySummary={decisions:sum(parity,x=>x.checks.length),stopMismatches:sum(parity,x=>x.stopMismatches),actionMismatches:sum(parity,x=>x.actionMismatches)};
// Fixed-seed paired moving-block bootstrap is descriptive only, not an untouched holdout.
const bootstrap=[]; // No new bootstrap/search; retain original evidence separately.
const outcome={protocol,results,priorResults,runs,fidelity,recordedDecisionParity:parity,paritySummary,bootstrap,livePromotion:false,
 blockingGates:['Frozen comparison window has only 3 post-deployment trades versus required 100','No independent validation trades','Funding unverified','Historical cash/slots and replacement signals not reconstructed','Native intraminute execution fidelity incomplete'],
 scope:'CONDITIONAL_FIXED_EXECUTED_ENTRIES_DIAGNOSTIC_ONLY'};
fs.writeFileSync(outPath,JSON.stringify(outcome,null,2)+'\n');
console.log(JSON.stringify({paritySummary,fidelity:Object.fromEntries(Object.entries(fidelity).map(([k,v])=>[k,{...v,errors:undefined}])),normal:results.filter(x=>x.scenario==='normal'&&x.boundary==='SKIP_ENTRY_BAR'&&['ALL','FIRST_24H','SECOND_24H','LATEST_DEPLOYMENT'].includes(x.cohort)),bootstrap},null,2));
