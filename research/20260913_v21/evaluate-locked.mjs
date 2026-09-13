#!/usr/bin/env node
/**
 * Deterministic evaluation of the immutable V21 rules against actual auto trades.
 * This script never calls a venue, database, or order path.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  POLICY_VERSION,
  entryDecision,
  initialReclaimState,
  reclaimExitDecision,
} from './candidate-rules.mjs';

const dir=path.dirname(fileURLToPath(import.meta.url));
const protocol=JSON.parse(fs.readFileSync(path.join(dir,'protocol.json'),'utf8'));
const [inputFile,outputFile]=process.argv.slice(2);
if(!inputFile||!outputFile)throw Error('Usage: node evaluate-locked.mjs INPUT.json OUTPUT.json');
const input=JSON.parse(fs.readFileSync(inputFile,'utf8'));
const num=value=>value===null||value===''||value===undefined?null:(Number.isFinite(Number(value))?Number(value):null);
const at=value=>Number.isFinite(Date.parse(value))?Date.parse(value):null;
const sum=(rows,fn=x=>x)=>rows.reduce((total,row)=>total+Number(fn(row)??0),0);
const round=(value,digits=9)=>Number.isFinite(value)?Number(value.toFixed(digits)):null;
const cutoff=Date.parse(protocol.development_cutoff_utc);
const qv3At=Date.parse('2026-09-11T15:20:00Z');
const priorValidationEnd=Date.parse('2026-09-12T12:54:14.867543Z');

const positions=input.positions.filter(p=>p.state==='CLOSED'&&p.side==='LONG'&&at(p.entry_at)!==null)
  .sort((a,b)=>at(a.entry_at)-at(b.entry_at)||String(a.id).localeCompare(String(b.id)));
const ids=new Set(positions.map(p=>p.id));
const decisions=new Map();
for(const raw of input.decisions){
  if(!ids.has(raw.position_id))continue;
  const details=raw.details??{};
  const row={raw,positionId:raw.position_id,decidedAtMs:at(raw.decided_at),
    detectedAtMs:num(details.detectedAtMs),quoteRequestedAtMs:num(details.quoteRequestedAtMs),
    quoteReceivedAtMs:num(details.quoteReceivedAtMs),exchangeBookAtMs:num(details.exchangeBookAtMs),
    bid:num(details.bid),observedMfe:num(details.observedMfe),priceReturn:num(details.priceReturn)};
  let list=decisions.get(raw.position_id);if(!list)decisions.set(raw.position_id,list=[]);list.push(row);
}
for(const rows of decisions.values())rows.sort((a,b)=>(a.detectedAtMs??a.decidedAtMs)-(b.detectedAtMs??b.decidedAtMs));
const openingOrder=new Map();
for(const order of input.orders){
  if(order.intent!=='OPEN_LONG'||!order.position_id)continue;
  const prior=openingOrder.get(order.position_id);
  if(!prior||at(order.created_at)<at(prior.created_at))openingOrder.set(order.position_id,order);
}
const fillsByPosition=new Map();
for(const fill of input.fills){
  if(!ids.has(fill.v17_position_id))continue;
  let list=fillsByPosition.get(fill.v17_position_id);if(!list)fillsByPosition.set(fill.v17_position_id,list=[]);list.push(fill);
}

function cohort(p){const t=at(p.entry_at);return t<qv3At?'PRE_QV3':t<=priorValidationEnd?'QV3_EARLY':t<=cutoff?'QV3_LATE_DEV':'LOCKED_HOLDOUT';}
function features(p){return p.metadata?.entryFeatures??{};}
function limitPrice(p){return num(openingOrder.get(p.id)?.request_payload?.order?.price);}
function fundingCrossings(p){
  const start=at(p.entry_at),end=at(p.closed_at);if(start===null||end===null)return [];
  const step=8*3600000,first=Math.ceil(start/step)*step,out=[];
  for(let t=first;t<end;t+=step)out.push(new Date(t).toISOString());return out;
}
function actualFees(p){return sum(fillsByPosition.get(p.id)??[],x=>num(x.fee_quote_amount));}
function actualGross(p){return sum(fillsByPosition.get(p.id)??[],x=>num(x.realized_pnl_quote));}

function triggerExit(p){
  const f=features(p),limit=limitPrice(p),entryAt=at(p.entry_at),entryPrice=num(p.entry_price);
  const state0=initialReclaimState({positionId:p.id,entryAt,entryPrice,features:f,limitPrice:limit});
  if(!state0)return null;
  let state=state0;
  for(const obs of decisions.get(p.id)??[]){
    const detected=obs.detectedAtMs;
    if(!Number.isSafeInteger(detected)||detected>=at(p.closed_at))continue;
    const r=reclaimExitDecision({position:{id:p.id,ownership:'AUTO',side:'LONG',state:'OPEN',entryAt,entryPrice},state,observation:obs});
    if(r.state)state=r.state;
    if(r.wouldClose)return {signalAt:detected,observation:obs,state};
  }
  return null;
}

function baseRow(p){
  const qty=num(p.original_quantity),entryPrice=num(p.entry_price),exitPrice=num(p.exit_price),pnl=num(p.realized_pnl_usdt);
  const ds=decisions.get(p.id)??[];
  const mfe=Math.max(0,num(p.peak_price)&&entryPrice?num(p.peak_price)/entryPrice-1:0,...ds.map(x=>x.observedMfe??0));
  const mae=Math.min(0,exitPrice&&entryPrice?exitPrice/entryPrice-1:0,...ds.map(x=>x.priceReturn??0));
  const grossPeak=qty&&entryPrice?mfe*qty*entryPrice:0;
  return {id:p.id,symbol:p.symbol,cohort:cohort(p),entryAt:at(p.entry_at),exitAt:at(p.closed_at),entryPrice,exitPrice,qty,
    pnl,actualPnl:pnl,actualReason:p.exit_reason,reason:p.exit_reason,modified:false,mfe,mae,
    giveback:Math.max(0,grossPeak-pnl),fees:actualFees(p),gross:actualGross(p),fundingCrossings:fundingCrossings(p),
    entryDecision:entryDecision(features(p),limitPrice(p))};
}
function exitRow(p,scenario){
  const base=baseRow(p),trigger=triggerExit(p);if(!trigger)return base;
  const earliest=trigger.signalAt+(scenario.delayMs??0);
  const obs=(decisions.get(p.id)??[]).find(x=>Number.isSafeInteger(x.detectedAtMs)&&x.detectedAtMs>=earliest&&x.detectedAtMs<base.exitAt&&x.bid>0);
  if(!obs)return base;
  const exitPrice=obs.bid*(1-scenario.exitImpact),entryFee=num(p.entry_fee_usdt)??0,exitFee=exitPrice*base.qty*scenario.exitFeeRate;
  const pnl=(exitPrice-base.entryPrice)*base.qty-entryFee-exitFee;
  const observed=(decisions.get(p.id)??[]).filter(x=>(x.detectedAtMs??Infinity)<=obs.detectedAtMs);
  const mfe=Math.max(0,...observed.map(x=>x.observedMfe??0),...observed.map(x=>x.bid?x.bid/base.entryPrice-1:0));
  const mae=Math.min(0,exitPrice/base.entryPrice-1,...observed.map(x=>x.priceReturn??0));
  return {...base,exitAt:obs.detectedAtMs,exitPrice,pnl,reason:'V21_RECLAIM_FAILURE_3',modified:true,mfe,mae,
    giveback:Math.max(0,mfe*base.qty*base.entryPrice-pnl),fees:entryFee+exitFee,
    trigger:{signalAt:trigger.signalAt,executionAt:obs.detectedAtMs,bid:obs.bid}};
}
function entryRow(p,row){
  if(!row.entryDecision.wouldBlock)return row;
  return {...row,exitAt:row.entryAt,pnl:0,reason:'V21_DECAY_NO_RECLAIM',modified:true,mfe:0,mae:0,giveback:0,fees:0,avoided:true};
}
function rowsFor(mode,scenario){return positions.map(p=>{
  const base=mode==='C'||mode==='D'?exitRow(p,scenario):baseRow(p);
  return mode==='B'||mode==='D'?entryRow(p,base):base;
});}

function stats(rows,baselineRows){
  const ordered=[...rows].sort((a,b)=>a.exitAt-b.exitAt||a.id.localeCompare(b.id));let equity=100,peak=100,maxDrawdown=0,lossStreak=0,maxLossStreak=0;
  for(const row of ordered){equity+=row.pnl;peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,peak-equity);lossStreak=row.pnl<0?lossStreak+1:0;maxLossStreak=Math.max(maxLossStreak,lossStreak);}
  const wins=rows.filter(x=>x.pnl>0),losses=rows.filter(x=>x.pnl<0),grossProfit=sum(wins,x=>x.pnl),grossLoss=-sum(losses,x=>x.pnl);
  const topIds=new Set([...baselineRows].sort((a,b)=>b.actualPnl-a.actualPnl).slice(0,3).map(x=>x.id));
  const largeBaseline=sum(baselineRows.filter(x=>topIds.has(x.id)),x=>Math.max(0,x.actualPnl));
  const largeCandidate=sum(rows.filter(x=>topIds.has(x.id)),x=>Math.max(0,x.pnl));
  return {trades:rows.filter(x=>!x.avoided).length,opportunities:rows.length,endingEquity:round(equity),netPnl:round(sum(rows,x=>x.pnl)),
    deltaVsBaseline:round(sum(rows,x=>x.pnl)-sum(baselineRows,x=>x.pnl)),maxDrawdown:round(maxDrawdown),
    winRate:round(rows.filter(x=>!x.avoided).length?wins.length/rows.filter(x=>!x.avoided).length:null),wins:wins.length,losses:losses.length,
    averageWin:round(wins.length?grossProfit/wins.length:null),averageLoss:round(losses.length?-grossLoss/losses.length:null),
    profitFactor:round(grossLoss?grossProfit/grossLoss:null),expectancy:round(rows.filter(x=>!x.avoided).length?sum(rows,x=>x.pnl)/rows.filter(x=>!x.avoided).length:null),
    fees:round(sum(rows,x=>x.fees)),worstTrade:round(rows.length?Math.min(...rows.map(x=>x.pnl)):null),maxConsecutiveLosses:maxLossStreak,
    giveback:round(sum(rows,x=>x.giveback)),modified:rows.filter(x=>x.modified).length,avoided:rows.filter(x=>x.avoided).length,
    avoidedLoss:round(-sum(rows.filter(x=>x.avoided&&x.actualPnl<0),x=>x.actualPnl)),missedProfit:round(sum(rows.filter(x=>x.avoided&&x.actualPnl>0),x=>x.actualPnl)),
    opportunityRetention:round(rows.filter(x=>!x.avoided).length/rows.length),winnerToLoss:rows.filter(x=>x.actualPnl>0&&x.pnl<=0&&!x.avoided).length,
    largeWinnerValueRetention:round(largeBaseline?largeCandidate/largeBaseline:null),top3Net:round(sum(rows.filter(x=>topIds.has(x.id)),x=>x.pnl)),
    excludingBaselineTop3Net:round(sum(rows.filter(x=>!topIds.has(x.id)),x=>x.pnl)),fundingCrossingPositions:rows.filter(x=>x.fundingCrossings.length).length};
}
function breakdown(rows,base){return Object.fromEntries(['PRE_QV3','QV3_EARLY','QV3_LATE_DEV','LOCKED_HOLDOUT'].map(name=>{
  const rs=rows.filter(x=>x.cohort===name),bs=base.filter(x=>x.cohort===name);return [name,stats(rs,bs)];}));}
function robustness(rows,base){
  const changed=rows.map((x,i)=>({id:x.id,symbol:x.symbol,delta:x.pnl-base[i].pnl})).filter(x=>Math.abs(x.delta)>1e-12);
  const total=sum(changed,x=>x.delta),bySymbol=new Map();for(const x of changed)bySymbol.set(x.symbol,(bySymbol.get(x.symbol)??0)+x.delta);
  return {changed:changed.length,totalDelta:round(total),leaveOneTradeMinDelta:round(changed.length?Math.min(...changed.map(x=>total-x.delta)):total),
    leaveOneSymbolMinDelta:round(bySymbol.size?Math.min(...bySymbol.values().map(x=>total-x)):total),
    largestTradeContribution:round(changed.length?Math.max(...changed.map(x=>x.delta)):0),largestSymbolContribution:round(bySymbol.size?Math.max(...bySymbol.values()):0)};
}

const scenarios={
  normal:{exitImpact:protocol.fixed_execution.normal_additional_exit_impact,exitFeeRate:protocol.fixed_execution.normal_fee_rate_each_side,delayMs:0},
  stress:{exitImpact:protocol.fixed_execution.stress_exit_impact_bps/10000,exitFeeRate:protocol.fixed_execution.stress_fee_rate_each_side,delayMs:0},
  stress_delay:{exitImpact:protocol.fixed_execution.stress_exit_impact_bps/10000,exitFeeRate:protocol.fixed_execution.stress_fee_rate_each_side,delayMs:protocol.fixed_execution.delay_stress_ms},
};
const result={protocol:protocol.protocol,policyVersion:POLICY_VERSION,input:path.resolve(inputFile),inputQueriedAt:input.queried_at,evaluatedAt:new Date().toISOString(),
  sample:{positions:positions.length,firstEntry:new Date(positions[0].entry_at).toISOString(),lastClose:new Date(Math.max(...positions.map(x=>at(x.closed_at)))).toISOString(),
    decisionRows:sum([...decisions.values()],x=>x.length),missingOpeningOrders:positions.filter(x=>!openingOrder.has(x.id)).length,
    fundingCrossingPositions:positions.filter(x=>fundingCrossings(x).length).length,fundingAttributedPositions:0},
  scenarios:{}};
for(const [scenarioName,scenario] of Object.entries(scenarios)){
  const A=rowsFor('A',scenario),B=rowsFor('B',scenario),C=rowsFor('C',scenario),D=rowsFor('D',scenario);
  result.scenarios[scenarioName]={summary:{A:stats(A,A),B:stats(B,A),C:stats(C,A),D:stats(D,A)},
    cohorts:{A:breakdown(A,A),B:breakdown(B,A),C:breakdown(C,A),D:breakdown(D,A)},
    robustness:{B:robustness(B,A),C:robustness(C,A),D:robustness(D,A)},
    changed:{B:B.filter(x=>x.modified).map(x=>({id:x.id,symbol:x.symbol,cohort:x.cohort,actual:x.actualPnl,candidate:x.pnl,reason:x.reason})),
      C:C.filter(x=>x.modified).map(x=>({id:x.id,symbol:x.symbol,cohort:x.cohort,actual:x.actualPnl,candidate:x.pnl,reason:x.reason,trigger:x.trigger})),
      D:D.filter(x=>x.modified).map(x=>({id:x.id,symbol:x.symbol,cohort:x.cohort,actual:x.actualPnl,candidate:x.pnl,reason:x.reason,trigger:x.trigger}))}};
}
const holdoutN=positions.filter(x=>at(x.entry_at)>cutoff).length;
result.gates={holdoutClosedTrades:{required:protocol.promotion_gates.holdout_minimum_closed_trades,observed:holdoutN,pass:holdoutN>=protocol.promotion_gates.holdout_minimum_closed_trades},
  funding:{crossingPositions:result.sample.fundingCrossingPositions,attributed:0,pass:result.sample.fundingCrossingPositions===0},
  interpretation:holdoutN<protocol.promotion_gates.holdout_minimum_closed_trades?'DEFER':'EVALUATE_ALL_REMAINING_GATES'};
fs.writeFileSync(outputFile,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({sample:result.sample,gates:result.gates,normal:result.scenarios.normal.summary,normalCohorts:{B:result.scenarios.normal.cohorts.B,C:result.scenarios.normal.cohorts.C,D:result.scenarios.normal.cohorts.D}},null,2));
