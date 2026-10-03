// Read-only comparison, never submit authorization or an executor trace.
import {ENGINE,classifyMarket,revalidateEntry} from '../../supabase/functions/_shared/deterministic/market-state.mjs';
import {PROFILE} from '../../supabase/functions/_shared/deterministic/calibration.mjs';
import {normalizeCapture,mergeSnapshot} from '../../supabase/functions/_shared/deterministic/features.mjs';
import {overlayExecutableBook} from '../../supabase/functions/_shared/deterministic/runtime.mjs';
export function reusableSeed(seed,now){
 const at=seed?.decision?.at;
 return seed?.version===ENGINE&&seed.decision.decision==='BUY'&&seed.decision.gates?.technical===true&&seed.decision.families?.CANDLE?.bullish===true&&
  Number.isSafeInteger(at)&&at<=now&&now-at<=30000&&Math.floor(at/60000)===Math.floor(now/60000)&&at%60000>=5000;
}
const projection=d=>({phase:d.phase,decision:d.decision,setup:d.setup,trigger:d.trigger,confirmation:d.confirmation,reasons:d.reasons,gates:d.gates,liquidity:d.families.LIQUIDITY});
export function quoteRevalidationEvidence({seed,raw,quote,now=Date.now()}){
 const basis='SAME_MINUTE_SAVED_CANDLE_FACTS_CURRENT_CAPTURE_SIGNED_BOOK_NOT_EXECUTOR_TRACE';
 if(!reusableSeed(seed,now))return {status:'DIAGNOSTIC_UNAVAILABLE',reason:'SAVED_CANDLE_SCOPE_NOT_PROVEN',basis};
 const capture=normalizeCapture(raw,now);
 if(capture.status!=='AVAILABLE')return {status:'DIAGNOSTIC_UNAVAILABLE',reason:capture.reason,basis};
 const facts=mergeSnapshot({values:seed.facts,quality:{candles_complete:true}},capture,{rank:seed.rank,return24h:seed.return24h});
 const input={facts,capture,profile:PROFILE,at:now,price:capture.trajectory.at(-1).mid,return24h:seed.return24h},baseline=classifyMarket(input),executable=overlayExecutableBook(input,quote,now),check=revalidateEntry(seed.decision,executable);
 const h=executable.capture.dynamics?.horizons?.s15;
 return {status:'READ_ONLY_REVALIDATION_COMPARISON',basis,candidate_age_ms:now-seed.decision.at,capture_age_ms:now-capture.end_ms,
  baseline:projection(baseline),signed_book:projection(check.latest),allowed_by_pure_comparison:check.allowed,reason:check.reason,
  executable_capture_status:executable.capture.status,executable_capture_reason:executable.capture.reason??null,
  executable_15s:h?{spread:h.spread,bid_depth:h.bid_depth,ask_depth:h.ask_depth,bid_liquidity_change:h.bid_liquidity_change,ask_liquidity_change:h.ask_liquidity_change,imbalance:h.imbalance,imbalance_trend:h.imbalance_trend,buy_impact_450_bps:h.buy_impact_450_bps,sell_impact_450_bps:h.sell_impact_450_bps}:null};
}
