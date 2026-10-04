export const LOSS_LOOP_GUARD_VERSION='LOSS_LOOP_GUARD_1';
export const LOSS_LOOP_POLICY=Object.freeze({
 historyWindowMs:60*60*1000,
 accountBlockMs:15*60*1000,
 accountConsecutiveLosses:3,
 symbolSingleLossMs:10*60*1000,
 symbolRepeatedLossMs:30*60*1000,
 symbolRepeatedWindowMs:60*60*1000
});
const finite=Number.isFinite;
const closedAt=p=>Date.parse(p?.closed_at??'');
const pnl=p=>Number(p?.realized_pnl_usdt);
const isLoss=p=>finite(pnl(p))&&pnl(p)<0&&finite(closedAt(p));
const newest=(history=[])=>[...history].filter(p=>finite(closedAt(p))).sort((a,b)=>closedAt(b)-closedAt(a));

export function evaluateAccountLossCircuit(history,now=Date.now()){
 const rows=newest(history),latest=rows[0],age=latest?now-closedAt(latest):Infinity;
 let consecutive=0;
 for(const p of rows){if(isLoss(p))consecutive++;else break;}
 const blocked=consecutive>=LOSS_LOOP_POLICY.accountConsecutiveLosses&&age>=0&&age<LOSS_LOOP_POLICY.accountBlockMs;
 return {allowed:!blocked,reason:blocked?'RECENT_CONSECUTIVE_LOSS_CIRCUIT':null,version:LOSS_LOOP_GUARD_VERSION,
  consecutive_losses:consecutive,latest_loss_age_ms:finite(age)?age:null,block_ms:LOSS_LOOP_POLICY.accountBlockMs};
}

export function evaluateSymbolReentry(row,history,now=Date.now()){
 const symbol=String(row?.symbol??'').toUpperCase(),same=newest(history).filter(p=>String(p?.symbol??'').toUpperCase()===symbol);
 const last=same[0];
 if(!last||!isLoss(last))return {allowed:true,reason:null,version:LOSS_LOOP_GUARD_VERSION};
 const age=now-closedAt(last);
 if(age<0)return {allowed:false,reason:'REENTRY_HISTORY_TIME_INVALID',version:LOSS_LOOP_GUARD_VERSION};
 const losses=same.filter(p=>isLoss(p)&&now-closedAt(p)<=LOSS_LOOP_POLICY.symbolRepeatedWindowMs).length;
 const lockMs=losses>=2?LOSS_LOOP_POLICY.symbolRepeatedLossMs:LOSS_LOOP_POLICY.symbolSingleLossMs;
 if(age>=lockMs)return {allowed:true,reason:null,version:LOSS_LOOP_GUARD_VERSION,prior_loss_age_ms:age,lock_ms:lockMs,recent_symbol_losses:losses};
 const d=row?.features?.deterministic?.decision??{},ref=Number(d.reference_price),
  priorPeak=Math.max(Number(last?.peak_price)||0,Number(last?.entry_price)||0);
 const freshBreakout=d.decision==='BUY'&&d.phase==='BREAKOUT_CONFIRMATION'&&d.confirmation==='PASS'&&
  d.current_propulsion==='STRONG'&&finite(ref)&&ref>priorPeak&&priorPeak>0;
 if(freshBreakout)return {allowed:true,reason:null,early_release:'FRESH_BREAKOUT_ABOVE_PRIOR_PEAK',version:LOSS_LOOP_GUARD_VERSION,
  prior_loss_age_ms:age,lock_ms:lockMs,recent_symbol_losses:losses,prior_peak:priorPeak,reference_price:ref};
 return {allowed:false,reason:losses>=2?'REENTRY_LOCK_REPEATED_SYMBOL_LOSSES':'REENTRY_LOCK_AFTER_LOSS',version:LOSS_LOOP_GUARD_VERSION,
  prior_loss_age_ms:age,lock_ms:lockMs,recent_symbol_losses:losses,prior_peak:priorPeak,reference_price:finite(ref)?ref:null};
}
