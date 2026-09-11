/** Retrospective matched-entry diagnostic only. No orders, signals, or production controls. */
import fs from 'node:fs';
import path from 'node:path';
import {nextExitReviewed,EXIT_REVIEW_R5} from '../../supabase/functions/_shared/leader-exit-review.mjs';
const [evidenceArg,outArg]=process.argv.slice(2);
if(!evidenceArg||!outArg)throw Error('Usage: node replay.mjs EVIDENCE_DIR OUTPUT_DIR');
const evidence=path.resolve(evidenceArg),out=path.resolve(outArg);
const audit=JSON.parse(fs.readFileSync(path.join(out,'trade_audit.json')));
const candles=JSON.parse(fs.readFileSync(path.join(evidence,'candles_1m.json')));
const cutoff=Date.parse(audit.asof);
const variants={R5:{},BE_AT_1PCT:{breakEvenArmPct:.01},LOCK_AT_1_5PCT:{profitLockArmPct:.015},
  WIDER_TREND_EXIT:{profitLockArmPct:.025,profitLockCapture:.4,trailGapPct:.02},
  ABLATE_TIME_CUT:{failCutAfterMs:null},ABLATE_PROFIT_LOCK:{profitLockArmPct:null}};
const settings={normal:{slip:.001,feeFactor:1,delayMs:0},cost_stress:{slip:.002,feeFactor:2,delayMs:0},
  delay_stress:{slip:.002,feeFactor:2,delayMs:60000}};

function replay(r,bars,change,execution,boundary){
  const policy={...EXIT_REVIEW_R5,...r.baseline_config,...change};
  let state={entryPrice:r.entry_price,entryAt:r.entry_ms,entryFee:r.entry_fee,quantity:r.quantity,
    peakPrice:r.entry_price,lastHighAt:r.entry_ms,stopPrice:r.entry_price*(1-policy.stopPct)};
  const usable=bars.filter(b=>b[6]<cutoff&&b[6]>=r.entry_ms);
  let fill=null,reason=null,unknownSequence=false;
  for(const b of usable){
    const t=Number(b[0]),open=Number(b[1]),low=Number(b[3]);
    if(t<r.entry_ms){
      if(boundary==='ADVERSE'&&low<=state.stopPrice){fill={price:state.stopPrice*(1-execution.slip),time:r.entry_ms+1};reason='ENTRY_BAR_ADVERSE_BOUND';unknownSequence=true;break;}
      continue;
    }
    const residentStop=state.stopPrice;
    const d=nextExitReviewed(state,open,t,policy);
    state={...state,stopPrice:d.stopPrice,peakPrice:d.peakPrice,lastHighAt:d.lastHighAt};
    if(d.action==='CLOSE'){
      const target=t+execution.delayMs,fb=usable.find(x=>x[0]>=target);
      if(!fb)break;
      // If the previously resident stop could execute during a delayed software exit,
      // use its adverse price bound. It never receives a future high as an input.
      const pending=usable.filter(x=>x[0]>=t&&x[0]<target);
      const hit=pending.find(x=>Number(x[3])<=residentStop);
      fill=hit?{price:Math.min(Number(hit[1]),residentStop)*(1-execution.slip),time:Number(hit[6])}:
        {price:Number(fb[1])*(1-execution.slip),time:Number(fb[0])};
      reason=d.reason;unknownSequence=Boolean(hit);break;
    }
    if(low<=state.stopPrice){fill={price:Math.min(open,state.stopPrice)*(1-execution.slip),time:Number(b[6])};reason='NATIVE_'+d.protectionStage;unknownSequence=true;break;}
  }
  const censored=!fill;
  if(!fill){const b=usable.at(-1);fill={price:b?Number(b[4]):r.entry_price,time:b?b[6]:r.entry_ms};reason='RIGHT_CENSORED';}
  const fee=r.entry_fee*execution.feeFactor+fill.price*r.quantity*.0005*execution.feeFactor;
  const net=(fill.price-r.entry_price)*r.quantity-fee;
  return {id:r.id,symbol:r.symbol,cohort:r.cohort,actual_net:r.net_before_funding,net,fee,exit_price:fill.price,exit_ms:fill.time,
    actual_exit_ms:r.exit_ms,reason,censored,unknown_intraminute_sequence:unknownSequence};
}
function stats(rs){const closed=rs.filter(r=>!r.censored),vals=closed.map(r=>r.net),win=vals.filter(x=>x>0),loss=vals.filter(x=>x<0);
  let eq=0,peak=0,mdd=0;for(const r of [...closed].sort((a,b)=>a.exit_ms-b.exit_ms)){eq+=r.net;peak=Math.max(peak,eq);mdd=Math.max(mdd,peak-eq);}
  return {n:rs.length,closed:closed.length,censored:rs.length-closed.length,net:vals.reduce((a,b)=>a+b,0),
    expectancy:vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:null,win_rate:vals.length?win.length/vals.length:null,
    profit_factor:loss.length?win.reduce((a,b)=>a+b,0)/-loss.reduce((a,b)=>a+b,0):null,
    worst:vals.length?Math.min(...vals):null,closed_curve_drawdown:mdd,
    sacrificed_actual_winners:closed.filter(r=>r.actual_net>0&&r.net<=0).length,
    rescued_actual_losers:closed.filter(r=>r.actual_net<0&&r.net>0).length,
    baseline_mean_abs_pnl_error:closed.length?closed.reduce((a,r)=>a+Math.abs(r.net-r.actual_net),0)/closed.length:null};}
// Fix eligibility BEFORE simulation: same six-hour future horizon for every variant.
const eligible=audit.trades.filter(r=>r.policy==='V17_EXIT_R5_TAIL'&&r.entry_ms+6*3600000+60000<=cutoff);
const results=[],details={};
for(const [executionName,execution]of Object.entries(settings))for(const boundary of ['SKIP','ADVERSE'])for(const [name,change]of Object.entries(variants)){
  const rs=eligible.map(r=>replay(r,candles[r.id],change,execution,boundary));
  details[`${executionName}/${boundary}/${name}`]=rs;
  for(const cohort of ['PRE','POST'])results.push({execution:executionName,boundary,candidate:name,cohort,...stats(rs.filter(r=>r.cohort===cohort))});
}
const summary={protocol:'MATCHED_ACTUAL_ENTRIES_ONLY_NOT_ACCOUNT_BACKTEST',cutoff:audit.asof,
  eligible:eligible.length,eligible_post:eligible.filter(r=>r.cohort==='POST').length,eligible_pre:eligible.filter(r=>r.cohort==='PRE').length,
  fees:'actual entry commission; simulated exit 5bp, doubled in stress',slippage:'10bp baseline;20bp stress',
  timing:'1m-open monitor proxy; 60s software lag stress; native intrabar trigger time uncertain',
  caveats:['No funding ledger','No simulation of changed subsequent entries, slot contention or cash allocation','No signal-count or opportunity-retention claim',
    'PRE is an earlier R5 episode sample, not original strategy performance','Intrabar ordering unknown; entry-bar SKIP/ADVERSE bounds','No parameter chosen or promoted'],
  live_promotion_pass:false,live_promotion_reason:'Only 20 new-version trades; required post sample>=100 and account/funding/fidelity gates not met',
  results,details};
fs.writeFileSync(path.join(out,'replay_diagnostic.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify({eligible:summary.eligible,post:summary.eligible_post,pre:summary.eligible_pre,
  base:results.filter(r=>r.execution==='normal'&&r.boundary==='SKIP'),promotion:false},null,2));
