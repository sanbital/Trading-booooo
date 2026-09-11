/** Paired executed-entry strategy experiment, not a historical market-wide account backtest. */
import fs from 'node:fs';
import path from 'node:path';
import {nextExit48,EXIT48_VARIANTS} from '../../supabase/functions/_shared/leader-exit-candidate48.mjs';
const root=process.argv[2];if(!root)throw Error('Usage: node compare-exit48.mjs DATA_DIR');
const read=n=>JSON.parse(fs.readFileSync(path.join(root,n)));
const rows=read('episodes.json'),candles=read('candles.json');
const protocol=JSON.parse(fs.readFileSync(new URL('./exit48-protocol.json',import.meta.url)));
const cutoff=Date.parse(protocol.cutoff),start=Date.parse(protocol.start),split=start+86400000;
const executions={normal:{slip:.001,feeFactor:1,delay:0},cost_stress:{slip:.002,feeFactor:2,delay:0},delay_stress:{slip:.002,feeFactor:2,delay:60000}};
const sum=(a,f)=>a.reduce((s,x)=>s+f(x),0);
function simulate(r,variant,e,boundary){
  const bars=candles[r.id],usable=bars.filter(b=>b[6]<cutoff&&b[6]>=r.entry_ms);
  let state={entryPrice:r.entry_price,entryAt:r.entry_ms,entryFee:r.entry_fee,quantity:r.quantity,
    peakPrice:r.entry_price,lastHighAt:r.entry_ms,stopPrice:r.entry_price*(1-r.baseline_config.stopPct),policy:r.baseline_config};
  const trace=[];let fill=null,reason=null,ambiguous=false,signalAt=null;
  for(const b of usable){
    const [t,open,low]=[Number(b[0]),Number(b[1]),Number(b[3])];
    if(t<r.entry_ms){
      if(boundary==='ADVERSE'&&low<=state.stopPrice){fill={time:r.entry_ms+1,price:state.stopPrice*(1-e.slip)};reason='ENTRY_BAR_ADVERSE_BOUND';ambiguous=true;break;}
      continue;
    }
    const resident=state.stopPrice,d=nextExit48(state,open,t,variant,bars);
    state={...state,peakPrice:d.peakPrice,lastHighAt:d.lastHighAt,stopPrice:d.stopPrice,candidateStopProvenance:d.candidateStopProvenance};
    trace.push({t,bid:open,stop:d.stopPrice,peak:d.peakPrice,action:d.action,reason:d.reason,stage:d.protectionStage});
    if(d.action==='CLOSE'){
      signalAt=t;
      const target=t+e.delay,next=usable.find(x=>x[0]>=target);
      if(!next)break;
      const hit=usable.find(x=>x[0]>=t&&x[0]<target&&Number(x[3])<=resident);
      fill=hit?{time:Number(hit[6]),price:Math.min(Number(hit[1]),resident)*(1-e.slip)}:
        {time:Number(next[0]),price:Number(next[1])*(1-e.slip)};
      reason=d.reason;ambiguous=!!hit;break;
    }
    if(low<=state.stopPrice){fill={time:Number(b[6]),price:Math.min(open,state.stopPrice)*(1-e.slip)};reason='NATIVE_'+d.protectionStage;ambiguous=true;break;}
  }
  const censored=!fill;
  if(censored){const b=usable.at(-1);if(!b)throw Error('NO_PRICE_PATH:'+r.id);fill={time:Number(b[6]),price:Number(b[4])};reason='RIGHT_CENSORED_MARK';}
  const fee=r.entry_fee*e.feeFactor+(censored?0:fill.price*r.quantity*.0005*e.feeFactor);
  return {id:r.id,symbol:r.symbol,patch:r.patch,entry_ms:r.entry_ms,actual_net:r.net,actual_exit_ms:r.exit_ms,
    net:(fill.price-r.entry_price)*r.quantity-fee,fee,entry_fee_charged:r.entry_fee*e.feeFactor,exit_ms:fill.time,exit_price:fill.price,censored,reason,signalAt,
    signal_delay_ms:signalAt===null?null:fill.time-signalAt,ambiguous_intraminute:ambiguous,
    peak:state.peakPrice,observed_profit_then_loss:state.peakPrice/r.entry_price-1>=.01&&((fill.price-r.entry_price)*r.quantity-fee)<0,
    sampled_giveback:(state.peakPrice-fill.price)*r.quantity,trace};
}
function stats(a){
  const vals=a.map(x=>x.net),wins=vals.filter(x=>x>0),losses=vals.filter(x=>x<0);
  let eq=0,peak=0,mdd=0;for(const r of [...a].filter(x=>!x.censored).sort((a,b)=>a.exit_ms-b.exit_ms)){eq+=r.net;peak=Math.max(peak,eq);mdd=Math.max(mdd,peak-eq);}
  return {n:a.length,closed:a.filter(x=>!x.censored).length,censored:a.filter(x=>x.censored).length,
    netIncludingMarks:sum(a,x=>x.net),realizedNet:sum(a.filter(x=>!x.censored),x=>x.net),
    expectancy:a.length?sum(a,x=>x.net)/a.length:null,winRate:a.length?wins.length/a.length:null,
    avgWin:wins.length?sum(wins,x=>x)/wins.length:null,avgLoss:losses.length?sum(losses,x=>x)/losses.length:null,
    profitFactor:losses.length?sum(wins,x=>x)/-sum(losses,x=>x):null,worst:a.length?Math.min(...vals):null,
    closedCurveDrawdown:mdd,fidelityMeanAbsoluteError:a.length?sum(a,x=>Math.abs(x.net-x.actual_net))/a.length:null,
    observedProfitThenLoss:a.filter(x=>x.observed_profit_then_loss).length,giveback:sum(a,x=>x.sampled_giveback??0),
    grossNotionalHours:sum(a,x=>(x.exit_ms-x.entry_ms)/3600000*rows.find(r=>r.id===x.id).entry_price*rows.find(r=>r.id===x.id).quantity)};
}
// Liquidation-value MTM across these SAME actual entry events. No replacement signal universe.
function markedCurve(rs){
  const grid=[...new Set(rs.flatMap(x=>[x.entry_ms,x.exit_ms,...candles[x.id].filter(b=>b[0]>=x.entry_ms&&b[0]<=x.exit_ms).map(b=>b[0])]))].sort((a,b)=>a-b);
  let peak=0,mdd=0;
  for(const t of grid){
    let eq=0;
    for(const s of rs){
      if(t<s.entry_ms)continue;if(t>=s.exit_ms){eq+=s.net;continue;}
      const r=rows.find(r=>r.id===s.id),bs=candles[s.id],b=bs.find(b=>b[0]===Math.floor(t/60000)*60000);
      const price=t===s.entry_ms?r.entry_price:b?Number(b[1]):r.entry_price;
      eq+=(price-r.entry_price)*r.quantity-s.entry_fee_charged;
    }
    peak=Math.max(peak,eq);mdd=Math.max(mdd,peak-eq);
  }
  return mdd;
}
const filters={ALL:()=>true,FIRST_24H:r=>r.entry_ms<split,SECOND_24H:r=>r.entry_ms>=split,POST_PATCH:r=>r.patch==='V18-OPS-ISOLATION-3'};
for(const patch of new Set(rows.map(x=>x.patch)))filters[patch]=r=>r.patch===patch;
const details={},results=[];
for(const [name,e] of Object.entries(executions))for(const boundary of ['SKIP','ADVERSE']){
  const paired={};
  for(const variant of EXIT48_VARIANTS){
    const rs=rows.map(r=>simulate(r,variant,e,boundary));paired[variant]=rs;
    details[`${name}/${boundary}/${variant}`]=rs;
    for(const [cohort,filter] of Object.entries(filters)){
      const subset=rs.filter(filter),base=variant==='BASELINE'?subset:paired.BASELINE.filter(filter);
      const gain=sum(subset,x=>x.net)-sum(base,x=>x.net);
      results.push({execution:name,boundary,variant,cohort,...stats(subset),deltaVsSameModelBaseline:gain,
        sampledFixedEntryMtmDrawdown:markedCurve(subset),
        improvedTrades:subset.filter((x,i)=>x.net>base[i].net+1e-9).length,
        worsenedTrades:subset.filter((x,i)=>x.net<base[i].net-1e-9).length,
        rescuedActualLosers:subset.filter(x=>x.actual_net<0&&x.net>0).length,
        sacrificedActualWinners:subset.filter(x=>x.actual_net>0&&x.net<=0).length});
    }
  }
}
const actual=Object.fromEntries(Object.entries(filters).map(([k,f])=>[k,stats(rows.filter(f).map(r=>({...r,actual_net:r.net,censored:false,
  sampled_giveback:r.observed_giveback_usdt,observed_profit_then_loss:r.observed_mfe>=.01&&r.net<0})))]));
const outcome={protocol,actual,results,details,livePromotion:false,fundingVerified:false,
  scope:'PAIRED_59_ACTUAL_ENTRIES_NOT_COMPLETE_ACCOUNT_BACKTEST',
  limitations:['Entry universe fixed to actual trades; absent unexecuted signals and alternative allocations',
    'All data previously observed; chronological slices are robustness checks, not untouched holdout',
    '1m monitor/stop fill assumptions require baseline fidelity; entry-bar ordering is bounded',
    'MTM is sampled on fixed entry events, does not enforce cash/slots; funding unknown']};
fs.writeFileSync(path.join(root,'comparison.json'),JSON.stringify(outcome,null,2)+'\n');
console.log(JSON.stringify({actual,normal:results.filter(r=>r.execution==='normal'&&r.boundary==='SKIP'&&['ALL','POST_PATCH','FIRST_24H','SECOND_24H'].includes(r.cohort))},null,2));
