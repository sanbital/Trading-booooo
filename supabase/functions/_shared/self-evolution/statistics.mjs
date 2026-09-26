export const mean=x=>x.length?x.reduce((a,b)=>a+b,0)/x.length:null;
export function quantile(x,p){if(!x.length)return null;const s=[...x].sort((a,b)=>a-b);return s[Math.floor((s.length-1)*p)];}
export function wilson(k,n){if(!n)return {accuracy:0,lower:0,upper:1};const z=1.96,p=k/n,d=1+z*z/n,c=(p+z*z/(2*n))/d,h=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;return {accuracy:p,lower:Math.max(0,c-h),upper:Math.min(1,c+h)};}
export function metrics(trades){
 const t=[...trades].sort((a,b)=>a.closed_ms-b.closed_ms),p=t.map(x=>x.net_usdt),wins=p.filter(x=>x>0),loss=p.filter(x=>x<0);
 let equity=0,peak=0,dd=0;for(const n of p){equity+=n;peak=Math.max(peak,equity);dd=Math.max(dd,peak-equity);}
 return {n:p.length,net_usdt:p.reduce((a,b)=>a+b,0),expectancy:mean(p),win_rate:p.length?wins.length/p.length:null,
  average_winner:mean(wins),average_loser:mean(loss),profit_factor:loss.length?wins.reduce((a,b)=>a+b,0)/-loss.reduce((a,b)=>a+b,0):null,
  max_drawdown:dd,worst_loss:p.length?Math.min(...p):null,tail_loss:quantile(p,.05),downside_risk:loss.length?Math.sqrt(mean(loss.map(x=>x*x))):0,
  fee_drag:t.reduce((s,x)=>s+(x.fees_usdt??0),0),turnover:t.reduce((s,x)=>s+(x.notional_usdt??0)*2,0),
  symbols:new Set(t.map(x=>x.symbol)).size,days:new Set(t.map(x=>Math.floor(x.closed_ms/86400000))).size};
}
/** Cluster paired bootstrap by day. Fixed seed makes the audit reproducible. */
export function pairedBootstrap(pairs,{iterations=1000,seed=71337}={}){
 const blocks=new Map();for(const p of pairs){const key=p.day;(blocks.get(key)??(blocks.set(key,[]),blocks.get(key))).push(p.challenger-p.champion);}
 const b=[...blocks.values()];if(b.length<2)return {lower:null,upper:null,blocks:b.length};let s=seed>>>0;const rnd=()=>{s=(Math.imul(1664525,s)+1013904223)>>>0;return s/4294967296;};
 const dist=[];for(let i=0;i<iterations;i++){const sample=[];for(let j=0;j<b.length;j++)sample.push(...b[Math.floor(rnd()*b.length)]);dist.push(mean(sample));}
 return {lower:quantile(dist,.025),upper:quantile(dist,.975),blocks:b.length,seed,iterations};
}
export function calibrate(rows,cutoff){const groups=new Map();for(const r of rows){if(!(r.outcome_at_ms<=cutoff)||!Number.isFinite(r.net_return_60s))continue;
  for(const provider of ['gpt','deepseek']){const a=r[provider];if(!['BUY','SKIP','HOLD','EXIT','PROTECT'].includes(a))continue;
   const key=[provider,r.stage,r.regime].join('|'),g=groups.get(key)??{provider,stage:r.stage,regime:r.regime,n:0,correct:0,as_of_ms:0,metric:'NET_DIRECTION_60S'};
   const long=['BUY','HOLD','PROTECT'].includes(a);g.n++;g.correct+=Number(long?r.net_return_60s>0:r.net_return_60s<=0);g.as_of_ms=Math.max(g.as_of_ms,r.outcome_at_ms);groups.set(key,g);
  }}return [...groups.values()].map(g=>({...g,...wilson(g.correct,g.n)}));}
export const GATES=Object.freeze({minValidationTrades:100,minHoldoutTrades:50,minDays:14,minSymbols:20,minRegimes:3,minImprovementUsdt:.05,minActivityRatio:.7,maxActivityRatio:1.3,maxTailRatio:1.05,minCoverage:.95,cooldownMs:7*86400000});
export function qualify(e){const errors=[],need=(v,k)=>{if(!v)errors.push(k);};
 need(e.scope_valid===true,'SCOPE');need(e.holdout_complete===true,'HOLDOUT_NOT_MATURE');need(e.actual_trade_replay===true,'ACTUAL_TRADE_REPLAY');need(e.integrity_valid===true,'INTEGRITY');need(e.execution_parity===true,'EXECUTION_PARITY');
 need(e.dataset_hash&&e.policy_hash&&e.champion_hash,'HASH_BINDING');need(e.universe_coverage>=GATES.minCoverage&&e.market_wide===true,'MARKET_WIDE_COVERAGE');
 need(e.future_leakage===false&&e.split_overlap===false&&e.discovery_end<e.validation_start&&e.validation_end<e.holdout_start,'CAUSAL_SPLITS');
 need(e.candidate_frozen_at<=e.validation_start&&e.holdout_uses===1,'UNTOUCHED_HOLDOUT');
 need(e.days>=GATES.minDays&&e.symbols>=GATES.minSymbols&&e.regimes>=GATES.minRegimes,'DIVERSITY');
 need(e.complete_lifecycle_coverage>=GATES.minCoverage,'LIFECYCLE_COVERAGE');need(e.counterfactual_costs===true,'COSTS');
 for(const name of ['validation','holdout']){const s=e[name],n=name==='validation'?GATES.minValidationTrades:GATES.minHoldoutTrades;
  need(s&&s.challenger.n>=n&&s.champion.n>=n,name+'_SAMPLE');if(!s)continue;
  need(s.challenger.expectancy-s.champion.expectancy>=GATES.minImprovementUsdt,name+'_EXPECTANCY');
  need(s.bootstrap?.lower>0,name+'_CONFIDENCE');need(s.challenger.net_usdt>s.champion.net_usdt,name+'_NET');
  need(s.challenger.max_drawdown<=Math.max(.5,s.champion.max_drawdown*1.05),name+'_DRAWDOWN');
  need(s.challenger.worst_loss>=Math.min(-.5,s.champion.worst_loss*1.05)&&s.challenger.tail_loss>=Math.min(-.5,s.champion.tail_loss*GATES.maxTailRatio),name+'_TAIL');
  const ratio=s.challenger.n/Math.max(1,s.champion.n);need(ratio>=GATES.minActivityRatio&&ratio<=GATES.maxActivityRatio,name+'_ACTIVITY');
  need(s.max_symbol_profit_share<=.25&&s.max_day_profit_share<=.25&&s.positive_regime_fraction>=.67,name+'_CONCENTRATION');
  need(s.winner_retention_ratio>=.9,name+'_WINNER_RETENTION');
 }
 return {qualified:!errors.length,reasons:errors,gate_version:'QUANT_GATES_1',gates:GATES};
}
/** Changes policy only; never account risk limits. Unknown / small samples cannot certify degradation. */
export function degradation({baseline,live,decisions,parseFailures,providerFailures,integrityFailure=false}){
 if(integrityFailure)return {rollback:true,reason:'POLICY_INTEGRITY'};
 if(decisions>=20&&(parseFailures/decisions>.3||providerFailures/decisions>.5))return {rollback:true,reason:'DECISION_FAILURE_SURGE'};
 if(live.n>=20&&baseline?.n>=50){
  const floor=Math.min(baseline.tail_loss*1.5,baseline.worst_loss*1.2);
  if(live.worst_loss<floor)return {rollback:true,reason:'LOSS_TAIL_SURGE'};
  if(live.max_drawdown>Math.max(baseline.max_drawdown*1.5,-baseline.worst_loss*3)&&live.expectancy<baseline.expectancy-Math.max(.1,(baseline.downside_risk??0)*.5))return {rollback:true,reason:'EXPECTANCY_DRAWDOWN_DIVERGENCE'};
 }
 return {rollback:false,reason:live.n<20?'INSUFFICIENT_LIVE_SAMPLE':'WITHIN_BASELINE_ENVELOPE'};
}

/** Paired portfolio returns, including zero-trade days; not winner-only decision pairs. */
export function comparePortfolios(base,next,{start,end}){
 const b=base.trades??[],n=next.trades??[],day=x=>Math.floor(x.closed_ms/86400000),sum=x=>x.reduce((v,t)=>v+t.net_usdt,0);
 const pairs=[];for(let d=Math.floor(start/86400000);d<=Math.floor(end/86400000);d++)pairs.push({day:d,champion:sum(b.filter(t=>day(t)===d)),challenger:sum(n.filter(t=>day(t)===d))});
 const concentration=key=>{const groups=new Map();for(const t of n)groups.set(key(t),(groups.get(key(t))??0)+t.net_usdt);const positive=[...groups.values()].filter(v=>v>0),total=positive.reduce((a,v)=>a+v,0);return total>0?Math.max(...positive)/total:1;};
 const regimes=[...new Set([...b,...n].map(t=>t.regime).filter(Boolean))];
 const comparable=regimes.filter(r=>b.filter(t=>t.regime===r).length>=5&&n.filter(t=>t.regime===r).length>=5);
 const winners=b.filter(t=>t.net_usdt>0),nMap=new Map(n.map(t=>[t.entry_decision_id,t]));
 const retained=winners.filter(t=>(nMap.get(t.entry_decision_id)?.net_usdt??0)>0);
 return {champion:metrics(b),challenger:metrics(n),bootstrap:pairedBootstrap(pairs),max_symbol_profit_share:concentration(t=>t.symbol),max_day_profit_share:concentration(day),
 positive_regime_fraction:comparable.length?comparable.filter(r=>sum(n.filter(t=>t.regime===r))>sum(b.filter(t=>t.regime===r))).length/comparable.length:0,
 winner_retention_ratio:winners.length?retained.length/winners.length:0,pairs,regimes:comparable};
}
