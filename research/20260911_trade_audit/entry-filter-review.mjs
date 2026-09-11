/** Conditional fixed-entry diagnostics, NOT an account backtest or profit forecast. */
import fs from 'node:fs';
import path from 'node:path';
import {evaluateEntry,VARIANTS} from '../../supabase/functions/_shared/leader-strategy-shadow.mjs';
import {nextExitReviewed,EXIT_REVIEW_R5} from '../../supabase/functions/_shared/leader-exit-review.mjs';
const [positionsFile,auditFile,decisionsFile,outFile]=process.argv.slice(2);
if(!outFile)throw Error('Usage: node entry-filter-review.mjs POSITIONS AUDIT DECISIONS OUTPUT');
const positions=JSON.parse(fs.readFileSync(positionsFile)),audit=JSON.parse(fs.readFileSync(auditFile));
const decisions=JSON.parse(fs.readFileSync(decisionsFile));
const known=new Map(audit.trades.map(t=>[t.id,t]));
const rows=positions.filter(p=>p.state==='CLOSED'&&p.metadata?.leaderExitPolicyVersion==='V17_EXIT_R5_TAIL')
  .sort((a,b)=>Date.parse(a.entry_at)-Date.parse(b.entry_at)||a.id.localeCompare(b.id));
function fee(p){
  const prior=known.get(p.id);if(prior)return prior.fees;
  const entry=Number(p.entry_fee_usdt),orders=p.metadata?.exitProtection?.orders??[];
  const accounted=orders.filter(x=>x.accountingPending===false&&Number(x.appliedQuantity)>0);
  if(Math.abs(accounted.reduce((s,x)=>s+Number(x.appliedQuantity),0)-Number(p.original_quantity))>1e-7)
    throw Error('MISSING_EXACT_FEES:'+p.id);
  return entry+accounted.reduce((s,x)=>s+Number(x.appliedFee),0);
}
const feeById=new Map(rows.map(p=>[p.id,fee(p)]));
function stats(a,net){
  const ns=a.map(net),wins=ns.filter(n=>n>0),losses=ns.filter(n=>n<0);
  let equity=0,peak=0,mdd=0;
  for(const r of [...a].sort((x,y)=>Date.parse(x.closed_at)-Date.parse(y.closed_at))){equity+=net(r);peak=Math.max(peak,equity);mdd=Math.max(mdd,peak-equity);}
  return {n:a.length,net:ns.reduce((s,x)=>s+x,0),expectancy:a.length?ns.reduce((s,x)=>s+x,0)/a.length:null,
    winRate:a.length?wins.length/a.length:null,avgWin:wins.length?wins.reduce((s,x)=>s+x,0)/wins.length:null,
    avgLoss:losses.length?losses.reduce((s,x)=>s+x,0)/losses.length:null,
    profitFactor:losses.length?wins.reduce((s,x)=>s+x,0)/-losses.reduce((s,x)=>s+x,0):null,
    closedCurveMdd:mdd,worst:a.length?Math.min(...ns):null,
    notionalHours:a.reduce((s,p)=>s+Number(p.entry_price)*Number(p.original_quantity)*(Date.parse(p.closed_at)-Date.parse(p.entry_at))/3600000,0)};
}
const configs={...Object.fromEntries(Object.entries(VARIANTS).filter(([k])=>k!=='LOCK_1P5')),
  SENS_REPEAT_1:{stopLossCountKstDay:1},SENS_REPEAT_3:{stopLossCountKstDay:3},
  SENS_SPIKE_2PCT:{maxClosed5mReturn:.02},SENS_SPIKE_4PCT:{maxClosed5mReturn:.04}};
const results=[],details={};
for(const [name,config] of Object.entries(configs))for(const lag of [0,180000]){
  const accepted=[],filtered=[],unavailable=[],ds=[];
  for(const p of rows){
    // Feedback uses ONLY this variant's previously accepted closed episodes.
    // Rejecting a trade does not leave its counterfactual loss in the loss counter.
    const history=accepted.map(x=>({...x,available_at:Date.parse(x.updated_at)+lag}));
    const d=evaluateEntry({symbol:p.symbol,features:p.metadata.entryFeatures,asOf:Date.parse(p.entry_at),history,variant:name,config});
    ds.push({id:p.id,entryAt:p.entry_at,patch:p.metadata.executorPatch,...d});
    if(d.verdict==='WOULD_FILTER')filtered.push(p);
    else if(d.verdict==='UNAVAILABLE')unavailable.push(p);
    else accepted.push(p);
  }
  details[`${name}/settlement_lag_${lag}`]=ds;
  for(const stress of [false,true])for(const patch of [...new Set(rows.map(p=>p.metadata.executorPatch))]){
    const all=rows.filter(p=>p.metadata.executorPatch===patch),keep=accepted.filter(p=>p.metadata.executorPatch===patch),
      cut=filtered.filter(p=>p.metadata.executorPatch===patch),unknown=unavailable.filter(p=>p.metadata.executorPatch===patch);
    // Normal: actual fill net (no double slippage). Stress ONLY: extra exact fees plus
    // an additional adverse 20bp on exit notional. It is not an observed account return.
    const net=p=>Number(p.realized_pnl_usdt)-(stress?feeById.get(p.id)+Number(p.exit_price)*Number(p.original_quantity)*.002:0);
    results.push({candidate:name,settlementLagMs:lag,stress,patch,...stats(keep,net),original:stats(all,net),
      knownExecutedEntryRetention:keep.length/all.length,filtered:cut.length,unavailable:unknown.length,
      avoidedLoserNet:cut.filter(p=>net(p)<0).reduce((s,p)=>s+net(p),0),
      sacrificedWinnerNet:cut.filter(p=>net(p)>0).reduce((s,p)=>s+net(p),0),
      filteredIds:cut.map(p=>p.id)});
  }
}
// Separate deterministic decision parity from execution-price fidelity.
// Replay recorded bids in order; never seed a past decision with final peak/stop.
const parity=[];
for(const p of rows){
  let state={entryPrice:Number(p.entry_price),entryAt:Date.parse(p.entry_at),entryFee:Number(p.entry_fee_usdt),
    quantity:Number(p.original_quantity),peakPrice:Number(p.entry_price),stopPrice:Number(p.entry_price)*.975,lastHighAt:Date.parse(p.entry_at)};
  const ds=decisions.filter(d=>d.position_id===p.id&&Number(d.details?.bid)>0&&Date.parse(d.decided_at)>=state.entryAt)
    .sort((a,b)=>Date.parse(a.decided_at)-Date.parse(b.decided_at));
  let checked=0,stopMatch=0,actionMatch=0,gaps=0,prior=state.entryAt;
  for(const d of ds){
    const t=Number(d.details?.detectedAtMs)||Date.parse(d.decided_at);
    if(t<state.entryAt||t<prior)continue;
    if(t-prior>90000)gaps++;
    const v=nextExitReviewed(state,Number(d.details.bid),t,{...EXIT_REVIEW_R5,...p.metadata.leaderExitPolicy});
    if(Number.isFinite(Number(d.details.stopPrice))){checked++;
      if(Math.abs(v.stopPrice-Number(d.details.stopPrice))<=Math.max(1e-10,state.entryPrice*1e-8))stopMatch++;
      if(v.action===d.details.action)actionMatch++;
    }
    state={...state,peakPrice:v.peakPrice,stopPrice:v.stopPrice,lastHighAt:v.lastHighAt};prior=t;
  }
  parity.push({id:p.id,patch:p.metadata.executorPatch,checked,stopMatch,actionMatch,gapsOver90s:gaps});
}
const output={protocol:'CONDITIONAL_FIXED_EXECUTED_ENTRIES_EXPLORATORY',r5Episodes:rows.length,
  allSeenData:true,outOfSampleTrades:0,fundingVerified:false,livePromotion:false,
  limitations:['No unexecuted historical signals or replacement entries','No changed slot/cash competition',
    'No account marked-to-market drawdown','Settlement availability uses current recorded updated_at conservatively',
    'Stress is synthetic; actual fills already include actual execution price impact'],
  results,details,recordedDecisionParity:parity};
fs.mkdirSync(path.dirname(outFile),{recursive:true});fs.writeFileSync(outFile,JSON.stringify(output,null,2));
console.log(JSON.stringify({r5Episodes:rows.length,latest:results.filter(x=>x.patch==='V18-OPS-ISOLATION-3'&&!x.stress&&x.settlementLagMs===0),
  parity:parity.reduce((a,x)=>({checked:a.checked+x.checked,stopMatch:a.stopMatch+x.stopMatch,actionMatch:a.actionMatch+x.actionMatch}),{checked:0,stopMatch:0,actionMatch:0})},null,2));
