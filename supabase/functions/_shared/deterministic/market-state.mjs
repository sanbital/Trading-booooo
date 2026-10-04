/** Production decision model. Pure: no providers, network, database or orders. */
export const ENGINE = 'DETERMINISTIC_DYNAMIC_STATE_1';
export const HORIZONS = Object.freeze([5,15,30,60,120]);
const finite=Number.isFinite;
export function quantile(xs,p){const a=xs.filter(finite).sort((a,b)=>a-b);if(!a.length)return null;const i=(a.length-1)*p,l=Math.floor(i);return a[l]+(a[Math.ceil(i)]-a[l])*(i-l);}
export function captureSafety(c,at){
 if(c?.status!=='AVAILABLE'||c.buckets!==24||c.trajectory?.length!==24)return {ok:false,reason:'NO_TRADE_DATA_INVALID'};
 if(!Number.isSafeInteger(at)||!Number.isSafeInteger(c.end_ms)||c.end_ms>at||at-c.end_ms>=10000||c.entry_window)return {ok:false,reason:'NO_TRADE_STALE_CAPTURE'};
 let prev=null;
 for(const p of c.trajectory){
  const times=['start_ms','end_ms','bucket_ms','received_at_ms','exchange_event_ms','book_received_at_ms'];
  if(!times.every(k=>Number.isSafeInteger(p[k]))||p.end_ms>at||p.received_at_ms>at||p.received_at_ms<p.end_ms||
    p.exchange_event_ms>p.end_ms||p.book_received_at_ms>p.end_ms||p.book_received_at_ms<p.exchange_event_ms-1000||
    p.book_received_at_ms-p.exchange_event_ms>10000||p.end_ms-p.book_received_at_ms>10000||
    p.end_ms-p.start_ms<4000||p.end_ms-p.start_ms>6500||Math.abs(p.end_ms-p.bucket_ms)>=1000||
    prev&&(p.start_ms!==prev.end_ms||p.bucket_ms-prev.bucket_ms!==5000))return {ok:false,reason:'NO_TRADE_NONCAUSAL_CAPTURE'};
  if(!['mid','start_mid','bid_depth_25_usdt','ask_depth_25_usdt','spread_bps','imbalance','buy_impact_450_bps','sell_impact_450_bps','aggressive_buy','aggressive_sell'].every(k=>finite(p[k]))||
    p.mid<=0||p.start_mid<=0||p.bid_depth_25_usdt<=0||p.ask_depth_25_usdt<=0||p.spread_bps<0||p.buy_impact_450_bps<0||p.sell_impact_450_bps<0||
    Math.abs(p.imbalance)>1||p.aggressive_buy<0||p.aggressive_sell<0||p.trade_count===0&&p.aggressive_buy+p.aggressive_sell>0||
    !Number.isSafeInteger(p.trade_count)||p.trade_count<0||p.trade_count>0&&(!Number.isSafeInteger(p.flow_event_ms)||!Number.isSafeInteger(p.flow_received_at_ms)||
      p.flow_event_ms>p.end_ms||p.flow_received_at_ms>p.end_ms||p.flow_received_at_ms<=p.start_ms))return {ok:false,reason:'NO_TRADE_BOOK_OR_FLOW_INVALID'};
  prev=p;
 }
 if(c.trajectory[0].start_ms!==c.start_ms||prev.end_ms!==c.end_ms||c.end_ms-c.start_ms<117000||c.end_ms-c.start_ms>123000||
    HORIZONS.some(s=>!finite(c.dynamics?.horizons?.['s'+s]?.return)||!finite(c.dynamics?.horizons?.['s'+s]?.net_taker_flow)))return {ok:false,reason:'NO_TRADE_INCOMPLETE_TRAJECTORY'};
 return {ok:true,age_ms:at-c.end_ms};
}
export function classifyMarket({facts,capture,profile,at,price=null,return24h=null}){
 const v=facts?.values??{},h=capture?.dynamics?.horizons??{},a=h.s15??{},b=h.s30??{},older=h.s60??{},fast=h.s5??{};
 const required=['return_15m','return_60m','ema9_vs_ema20','ema20_distance','atr_1m_14_normalized','volume_ratio_5m_vs_60m','last_body','body_to_range','close_location_value','rsi_1m_14','rsi_5m_14','bb_position','btc_return_1m','btc_atr_normalized','ema20_slope','ema50_slope','ema50_distance'];
 const data=captureSafety(capture,at),calibrated=profile?.version===ENGINE&&profile.training_count>=30&&
  ['volume','ema9_distance','bb_position','rsi_5m_14','atr_1m_14_normalized','spread_bps','roundtrip_impact_bps','entry_drift','mfe']
  .every(k=>profile.bands?.[k]?.samples>=30&&['normal','caution','block'].every(q=>finite(profile.bands[k][q])));
 const technical=required.every(k=>finite(v[k]))&&facts?.quality?.candles_complete===true;
 const bands=profile?.bands??{};
 const priceNow=price??capture?.trajectory?.at(-1)?.mid;
 const trend=v.ema9_vs_ema20>0&&v.return_15m>0&&v.return_60m>0&&v.ema20_distance>=0&&
  v.ema20_slope>=0&&v.ema50_slope>=0&&v.ema50_distance>=-v.atr_1m_14_normalized;
 const structural=trend?'STRONG':v.return_60m>0&&v.ema9_vs_ema20>=0?'CONSTRUCTIVE':'WEAK';
 // Correlated buy share and net flow form ONE evidence family.
 const flowPositive=a.net_taker_flow>0&&fast.net_taker_flow>0;
 const flowRecovering=flowPositive&&a.buy_share>older.buy_share&&a.flow_acceleration>0;
 const flowCollapsing=a.net_taker_flow<0&&b.net_taker_flow<0&&(a.buy_share<older.buy_share||a.flow_acceleration<0);
 const pricePositive=a.return>0&&fast.return>0;
 const priceWeak=a.return<0&&b.return<0;
 const bookSupport=a.bid_liquidity_change>=0||a.imbalance>=0&&a.imbalance_trend>=0;
 const bookWeak=a.bid_liquidity_change<0&&(a.ask_liquidity_change>0||a.imbalance_trend<0)&&a.imbalance<0;
 const momentumIntact=pricePositive&&(a.acceleration_bps_s2>=0||a.sampled_high_renewals>0);
 const propulsion=flowPositive&&momentumIntact&&bookSupport?'STRONG':pricePositive&&flowRecovering&&!bookWeak?'RECOVERING':'WEAK';
 const candleBull=v.last_body>0&&v.close_location_value>0.5&&v.last_upper_wick<=Math.abs(v.last_body)+v.last_lower_wick;
 const candleRejection=v.last_upper_wick>Math.abs(v.last_body)+v.last_lower_wick&&v.close_location_value<0.5;
 const candleBear=v.last_body<0&&v.close_location_value<0.5;
 const recent=capture?.trajectory??[],late=recent.slice(-3),prior=recent.slice(-12,-3);
 const activity=(a.aggressive_notional/15)>(older.aggressive_notional/60);
 const volumeHealthy=(v.volume_ratio_5m_vs_60m>=bands.volume?.normal||flowRecovering&&activity)&&!v.volume_climax_decline;
 const volumeClimax=v.volume_ratio_5m_vs_60m>=bands.volume?.caution||v.volume_climax_decline===true;
 const extension=v.ema9_distance>=bands.ema9_distance?.caution||v.bb_position>=bands.bb_position?.caution||v.rsi_5m_14>=bands.rsi_5m_14?.caution||
  v.rsi_1m_14>=bands.rsi_1m_14?.caution||v.stoch_k_1m>=bands.stoch_k_1m?.caution&&v.ema9_distance>=bands.ema9_distance?.normal;
 const nearHigh=v.distance_high_60m>=-v.atr_1m_14_normalized;
 const dailyExtended=finite(return24h)&&return24h>=bands.day_return?.caution;
 // Overextension RSI/BB/EMA distance counts once. A large 24h return never creates positive evidence.
 const exhaustionFamilies=[];
 if(extension||dailyExtended&&nearHigh)exhaustionFamilies.push('OVEREXTENSION');
 if(flowCollapsing)exhaustionFamilies.push('FLOW');
 if(bookWeak)exhaustionFamilies.push('LIQUIDITY');
 if(candleRejection)exhaustionFamilies.push('CANDLE');
 if(volumeClimax&&!activity)exhaustionFamilies.push('VOLUME');
 if(priceWeak&&a.sampled_high_renewals===0)exhaustionFamilies.push('PRICE_STRUCTURE');
 const exhaustion=exhaustionFamilies.includes('OVEREXTENSION')&&exhaustionFamilies.length>=3?'BLOCK':exhaustionFamilies.length>=2?'CAUTION':'NORMAL';
 const exec=a.spread<=Math.min(25,bands.spread_bps?.block??0)&&
  a.buy_impact_450_bps+a.sell_impact_450_bps<=bands.roundtrip_impact_bps?.block&&
  a.ask_depth>=450&&a.bid_depth>=450&&fast.spread<=Math.min(25,bands.spread_bps?.block??0);
 const shock=v.market_shock===true||finite(v.btc_return_1m)&&finite(v.btc_atr_normalized)&&v.btc_return_1m< -2*v.btc_atr_normalized;
 const volatility=v.atr_1m_14_normalized<=bands.atr_1m_14_normalized?.block;
 const gates={data:data.ok,calibrated:!!calibrated,technical,execution:exec,volatility,market:!shock,structure:structural!=='WEAK',exhaustion:exhaustion!=='BLOCK'};
 const setup=Object.values(gates).every(Boolean)?'PASS':'REJECT';
 const previousHigh=Math.max(...recent.slice(0,-3).map(x=>x.mid));
 const breakout=pricePositive&&b.return>0&&late.length===3&&late.every(x=>x.mid>=previousHigh)&&a.sampled_high_renewals>0;
 const lowAt=recent.length?recent.reduce((best,x,i)=>x.mid<recent[best].mid?i:best,0):-1;
 const pullback=lowAt>0&&lowAt<recent.length-2&&flowRecovering&&pricePositive&&a.recovery_velocity_bps_s>older.recovery_velocity_bps_s;
 const reclaim=recent.length>3&&pricePositive&&flowRecovering&&late.at(-1).mid>Math.max(...prior.map(x=>x.mid));
 const continuation=structural==='STRONG'&&propulsion==='STRONG'&&a.sampled_high_renewals>0&&b.net_taker_flow>0;
 const trigger=breakout?'BREAKOUT':pullback?'PULLBACK_RECOVERY':reclaim?'LOCAL_HIGH_RECLAIM':continuation?'MOMENTUM_REACCELERATION':null;
 // Confirmation is phase specific: a pullback recovery need not exceed the preceding
 // 60s expansion's trade rate; continuation needs sustained participation, not a climax.
 const recentCandles=facts?.technical_context?.recent_1m_candles??[];
 const candleSupport=candleBull||!candleRejection&&recentCandles.slice(-3).filter(x=>x.body_sign>0).length>=2;
 const confirmationVolume=trigger==='BREAKOUT'?activity&&volumeHealthy:volumeHealthy&&(activity||a.trade_count>0&&b.net_taker_flow>0);
 const confirmationCandle=trigger==='PULLBACK_RECOVERY'||trigger==='LOCAL_HIGH_RECLAIM'?
  candleSupport||!candleRejection&&v.last_lower_wick>v.last_upper_wick&&flowRecovering&&activity:candleSupport;
 const confirm=!!trigger&&flowPositive&&pricePositive&&bookSupport&&confirmationVolume&&confirmationCandle&&exec&&(!extension||flowRecovering||breakout);
 const failedBreakout=v.failed_breakout_candle===true&&priceWeak&&(flowCollapsing||bookWeak);
 let phase=exhaustion==='BLOCK'?'EXHAUSTION':failedBreakout?'FAILED_BREAKOUT':flowCollapsing&&bookWeak?'DISTRIBUTION':breakout&&confirm?'BREAKOUT_CONFIRMATION':breakout?'BREAKOUT':
  pullback?'PULLBACK_RECOVERY':propulsion==='STRONG'&&continuation?'MOMENTUM_CONTINUATION':extension&&propulsion==='WEAK'?'LATE_EXTENSION':
  structural!=='WEAK'&&priceWeak&&!flowCollapsing&&!bookWeak&&!candleRejection?'HEALTHY_PULLBACK':priceWeak&&flowCollapsing?'REVERSAL_RISK':
  structural!=='WEAK'&&propulsion==='WEAK'?'MOMENTUM_DECAY':'NO_TRADE';
 const decision=setup==='REJECT'?'REJECT':trigger&&confirm?'BUY':'WAIT';
 const reasons=Object.entries(gates).filter(([,ok])=>!ok).map(([k])=>k.toUpperCase());
 if(!trigger)reasons.push('TRIGGER_NOT_READY');if(!confirm)reasons.push('CONFIRMATION_NOT_READY');
 return {version:ENGINE,at,capture_end_ms:capture?.end_ms??null,reference_price:priceNow,structural_strength:structural,current_propulsion:propulsion,
  phase,exhaustion:{state:exhaustion,families:exhaustionFamilies},setup,trigger:trigger??'WAIT',confirmation:confirm?'PASS':'WAIT',decision,reasons,gates,
  families:{TREND:{structural},MOMENTUM:{intact:momentumIntact,pricePositive,priceWeak},FLOW:{positive:flowPositive,recovering:flowRecovering,collapsing:flowCollapsing},
   LIQUIDITY:{support:bookSupport,weak:bookWeak},VOLUME:{healthy:volumeHealthy,activity,climax:volumeClimax},CANDLE:{bullish:candleBull,bearish:candleBear,rejection:candleRejection},
   PRICE_STRUCTURE:{breakout,pullback,reclaim,renewals:a.sampled_high_renewals??null},EXECUTION:{acceptable:exec},VOLATILITY:{acceptable:volatility},EXHAUSTION:{state:exhaustion}},
  trigger_reference:breakout?previousHigh:pullback?recent[lowAt].mid:reclaim?Math.max(...prior.map(x=>x.mid)):priceNow,
  atr_normalized:v.atr_1m_14_normalized??null};
}
export const ENTRY_RESCUE_POLICY=Object.freeze({
 maxAgeMs:10000,maxChaseDrift:0.008,maxExecutionCostBps:18,maxSpreadBps:5,minTaker5Hard:0.48,minAccel15_60Hard:0,minDistanceHigh15:-0.02,
 strongMinTaker5:0.53,strongMinTaker15:0.52,strongMaxSpreadBps:2.5,strongMaxExecutionCostBps:14,strongMinScore:4,
 overheatRsi1:78,overheatReturn5:0.02,overheatReturn15:0.04,overheatReturn60:0.06,overheatBb:1.20,overheatVol1:2,candleRangeAtr:1.5
});
export function evaluateEntryRescue(initial,input,latest,drift){
 const p=ENTRY_RESCUE_POLICY,v=input?.facts?.values??{},age=input?.at-initial?.at,phase=latest?.phase,
  num=k=>Number(v[k]),isFiniteKey=k=>finite(num(k));
 const deny=reason=>({allowed:false,reason,age_ms:age,strength_score:0});
 if(!Number.isFinite(age)||age<0||age>p.maxAgeMs)return deny('RESCUE_WINDOW_EXPIRED');
 if(!finite(drift)||drift>p.maxChaseDrift)return deny('RESCUE_PRICE_CHASE');
 const hardPhase=['REVERSAL_RISK','DISTRIBUTION','EXHAUSTION','FAILED_BREAKOUT'].includes(phase);
 const failedBreakout=v.failed_breakout_candle===true&&(latest?.families?.FLOW?.recovering!==true||num('taker_buy_ratio_5m')<p.strongMinTaker5);
 const hard=hardPhase||failedBreakout||v.sell_volume_expansion===true||v.volume_climax_decline===true||
  !isFiniteKey('expected_execution_cost_bps')||num('expected_execution_cost_bps')>p.maxExecutionCostBps||
  !isFiniteKey('spread_bps')||num('spread_bps')>p.maxSpreadBps||
  !isFiniteKey('taker_buy_ratio_5m')||num('taker_buy_ratio_5m')<p.minTaker5Hard||
  !isFiniteKey('accel_15m_vs_60m')||num('accel_15m_vs_60m')<p.minAccel15_60Hard||
  !isFiniteKey('distance_high_15m')||num('distance_high_15m')<p.minDistanceHigh15;
 if(hard)return deny('RESCUE_HARD_BLOCK');
 const required=latest?.current_propulsion==='STRONG'&&latest?.structural_strength==='STRONG'&&
  ['MOMENTUM_CONTINUATION','BREAKOUT_CONFIRMATION'].includes(phase)&&
  num('ema9_slope')>0&&num('ema20_slope')>0&&num('ema9_vs_ema20')>0&&num('return_15m')>0&&num('return_60m')>0;
 if(!required)return deny('RESCUE_STRUCTURE_WEAK');
 const overheat=num('rsi_1m_14')>=p.overheatRsi1||num('return_5m')>=p.overheatReturn5||num('return_15m')>=p.overheatReturn15||
  num('return_60m')>=p.overheatReturn60||num('bb_position')>=p.overheatBb&&num('volume_ratio_1m_vs_baseline')>=p.overheatVol1||
  num('candle_range_atr')>=p.candleRangeAtr&&v.higher_high!==true;
 if(overheat)return deny('RESCUE_OVERHEAT');
 const strengths=[
  num('taker_buy_ratio_5m')>=p.strongMinTaker5,
  num('taker_buy_ratio_15m')>=p.strongMinTaker15,
  num('accel_5m_vs_15m')>0,
  num('accel_15m_vs_60m')>0,
  num('spread_bps')<=p.strongMaxSpreadBps,
  num('expected_execution_cost_bps')<=p.strongMaxExecutionCostBps
 ],score=strengths.filter(Boolean).length;
 if(score<p.strongMinScore)return {allowed:false,reason:'RESCUE_STRENGTH_INSUFFICIENT',age_ms:age,strength_score:score,strengths};
 return {allowed:true,reason:'STRONG_CONTINUATION_RESCUE',age_ms:age,strength_score:score,strengths};
}
export function revalidateEntry(initial,input){
 const latest=classifyMarket(input),price=input.price??input.capture?.trajectory?.at(-1)?.mid,drift=price/initial.reference_price-1;
 const failure=latest.decision!=='BUY'?(input.capture?.reason==='CURRENT_EXECUTABLE_DEPTH_INSUFFICIENT'?'CURRENT_EXECUTION_COST_INVALID':latest.gates.data===false||latest.gates.technical===false?'CURRENT_DATA_INCOMPLETE_OR_STALE':latest.gates.execution===false?'CURRENT_EXECUTION_COST_INVALID':latest.phase==='FAILED_BREAKOUT'?'CURRENT_BREAKOUT_FAILED':'CURRENT_MARKET_THESIS_CANCELLED'):!finite(drift)?'PRICE_UNKNOWN':
  drift>Math.min(input.profile.bands.entry_drift.block,initial.atr_normalized)?'LATE_EXECUTION':
  price<initial.trigger_reference&&initial.trigger==='BREAKOUT'?'FAILED_BREAKOUT':
  latest.capture_end_ms<initial.capture_end_ms?'CAPTURE_REGRESSED':null;
 return {allowed:failure===null,action:failure?'CANCEL_ENTRY':'EXECUTE',reason:failure,decision_age_ms:input.at-initial.at,drift,latest};
}
export function decidePosition({position,facts,capture,profile,at,bid,previous=null}){
 const entry=Number(position.entry_price),recordedPeak=Number(position.peak_price),peak=Math.max(Number.isFinite(recordedPeak)?recordedPeak:entry,bid,entry),mfe=peak/entry-1,pnl=bid/entry-1,drawdown=bid/peak-1;
 const current=classifyMarket({facts,capture,profile,at,price:bid}),f=current.families,valid=captureSafety(capture,at).ok&&current.gates.technical&&current.gates.calibrated;
 const weak=[];
 if(f.MOMENTUM.priceWeak)weak.push('PRICE');if(f.FLOW.collapsing)weak.push('FLOW');if(f.LIQUIDITY.weak)weak.push('BOOK');
 if(f.CANDLE.bearish||f.CANDLE.rejection)weak.push('CANDLE');if(!f.VOLUME.activity&&!f.VOLUME.healthy)weak.push('VOLUME');
 const multi=weak.length>=2,collapse=weak.includes('PRICE')&&weak.includes('FLOW')&&(weak.includes('BOOK')||weak.includes('CANDLE'));
 const lastHigh=bid>=Number(position.peak_price)?at:previous?.last_high_ms??Date.parse(position.metadata?.leaderLastHighAt??position.entry_at);
 const protection=Number(position.hard_stop_price),resident=Math.max(Number.isFinite(protection)?protection:0,...(position.metadata?.exitProtection?.orders??[]).filter(o=>!o.terminal&&['ACTIVE','NEW'].includes(o.status)).map(o=>Number(o.spec?.params?.triggerPrice)||0));
 let action='HOLD',state='THESIS_INTACT',reason='DETERMINISTIC_HOLD',level=resident;
 if(bid<=resident){action='EXIT';state='HARD_STOP';reason='DETERMINISTIC_RESIDENT_STOP';}
 else if(!valid){state='DATA_DEGRADED';reason='NO_NEW_THESIS_DATA_INVALID';}
 else if(collapse||facts.values.market_shock&&weak.includes('FLOW')&&weak.includes('PRICE')){action='EXIT';state=mfe>0&&multi?'PROFIT_PROTECTION':'FAILED_CONTINUATION';reason='DETERMINISTIC_THESIS_FAILURE';}
 else if(multi){state='MOMENTUM_WEAKENING';
  if(mfe>profile.bands.mfe.caution&&drawdown<0&&weak.includes('FLOW')){
   action='PROTECT';state=weak.length>=3?'TIGHT_PROTECT':'PROTECT';reason='DETERMINISTIC_PROFIT_PROTECTION';
   // Structure/ATR adaptive protection, evaluated only after independent deterioration.
   const lows=capture.trajectory.slice(-6).map(x=>x.mid),atr=facts.values.atr_1m_14_normalized*bid;
   const structural=Math.min(...lows),cost=entry*(1+2*(position.entry_fee_usdt!=null?Number(position.entry_fee_usdt)/(Number(position.original_quantity)*entry):0.0005));
   level=Math.max(resident,Math.min(bid-Number(position.metadata?.entryMarketRules?.priceTick||entry*1e-8),Math.max(cost,structural-atr)));
   if(bid<=level){action='EXIT';reason='DETERMINISTIC_PROFIT_PROTECTION';}
  }
 }
 return {version:ENGINE,at,action,state,reason,level,peak,mfe,mae:Math.min(previous?.mae??0,pnl),pnl,drawdown,giveback:mfe>0?(peak-bid)/(peak-entry):0,
  weak_families:weak,current,last_high_ms:lastHigh,market_deterioration_at:multi?(previous?.market_deterioration_at??capture?.end_ms):null,
  state_changed_at:previous?.state===state?previous.state_changed_at:at,data_valid:valid};
}
