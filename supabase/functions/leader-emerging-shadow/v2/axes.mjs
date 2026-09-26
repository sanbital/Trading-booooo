/** LE-SHADOW-2 evidence axes (ALT SCORE V2). Pure. RECORD / GPT EVIDENCE ONLY.
 *
 * The overnight LE-SHADOW-1 sample (2026-09-24 09:45Z ~ 09-25 00:25Z, RULE_BASELINE ALT-only BUY
 * n=152) showed the big losers (net60 <= -100 bps, n=58) had a HIGHER 15m rank velocity (41.5 vs
 * 27.2) and 5m volume ratio (3.23 vs 2.53) than the big winners (net60 >= +100 bps, n=33). So no
 * axis here is monotone in "strength": every raw feature is put in a PHASE band, and the extreme
 * band of a strength feature is reported as late-chase / blow-off risk on the separate OVERHEAT
 * axis. Nothing is summed into one composite: GPT receives the six axes side by side and must
 * weigh conflicting evidence itself. Nothing here admits or rejects a candidate.
 *
 * Bands are fixed in LE_AXES_2_BANDS (pre-registered with LE-SHADOW-2; change = new version). */
export const AXES_VERSION='LE_AXES_2';
const fin=x=>typeof x==='number'&&Number.isFinite(x);
const n=x=>x===null||x===undefined||x===''?null:(Number.isFinite(Number(x))?Number(x):null);

export const BANDS=Object.freeze({
  version:'LE_AXES_2_BANDS',
  // EMERGENCE: 15m rank improvement (steps)
  v15:{slow:3,fast:20,extreme:40},
  // rank improvement over 60m (steps)
  v60:{extreme:150},
  // FLOW: 5m vs 60m volume ratio and V17 vr15
  volume:{thin:.8,hot:2.5,spike:4},
  vr15:{spike:4},
  // taker buy ratio
  taker:{weak:.48,extreme:.62},
  stallReturn5m:.002,
  // CONTINUATION
  nearHigh:-.005,pullbackDeep:-.03,fadeFromHigh:-.02,
  wick:.006,
  // OVERHEAT
  dayReturnExtreme:.25,parabolic15m:.08,parabolic5m:.04,extendedSma20:.03,
  oiSpike5m:.02,fundingHot:.0005,premiumHot:.002,
  // EXECUTION
  spreadGood:5,spreadPoor:15,slipGood:8,slipPoor:18,askDepthGood:5,askDepthPoor:2,askWallHeavy:10,
});

function band(x,lo,hi,labels){if(!fin(x))return 'UNKNOWN';return x<lo?labels[0]:x<hi?labels[1]:labels[2];}

/**
 * @param f     FD1 facts values (point-in-time, all bars closed before the snapshot)
 * @param ctx   {lane, rank, rank15m, rank30m, rank60m, velocity15, velocity60, firstTop10Today,
 *               minutesInTop10Today, vr15, cost:{roundtrip_cost_bps_real}}
 */
export function computeAxes(f={},ctx={},B=BANDS){
  const v=Object.fromEntries(Object.entries(f??{}).map(([k,x])=>[k,n(x)]));
  const rank=n(ctx.rank),r15=n(ctx.rank15m),r30=n(ctx.rank30m),r60=n(ctx.rank60m);
  const d15=fin(r15)&&fin(rank)?r15-rank:n(ctx.velocity15),d30=fin(r30)&&fin(rank)?r30-rank:null,d60=fin(r60)&&fin(rank)?r60-rank:n(ctx.velocity60);
  const vr15=n(ctx.vr15);

  // A. LEADERSHIP
  const leadership={
    rank,rank_bucket:!fin(rank)?'UNKNOWN':rank<=3?'TOP3':rank<=10?'TOP4_10':rank<=20?'RANK11_20':rank<=30?'RANK21_30':'OUTSIDE_TOP30',
    relative_strength_15m:v.relative_strength_15m??null,relative_strength_60m:v.relative_strength_60m??null,
    minutes_in_top10_today:n(ctx.minutesInTop10Today),first_top10_today:ctx.firstTop10Today===true,
    state:!fin(v.relative_strength_60m)?'UNKNOWN':v.relative_strength_60m<=0?'NO_RELATIVE_STRENGTH':
      fin(rank)&&rank<=10&&n(ctx.minutesInTop10Today)>=60?'PERSISTENT_LEADER':'RELATIVE_STRENGTH'};

  // B. EMERGENCE (rank acceleration = last-15m improvement minus the average 15m improvement over 60m)
  const accel=fin(d15)&&fin(d60)?d15-d60/4:null;
  const speed=band(d15,B.v15.slow,B.v15.fast,['SLOW','HEALTHY','FAST']);
  const emergence={rank_delta_15m:d15,rank_delta_30m:d30,rank_delta_60m:d60,rank_acceleration:accel,
    new_top30_60m:fin(rank)&&rank<=30&&(r60===null||r60>30),
    top10_approach_steps_per_15m:fin(rank)&&rank>10&&fin(d15)?d15:null,
    state:!fin(d15)&&!fin(d60)?'UNKNOWN':fin(d15)&&d15>=B.v15.extreme?'EXTREME_CHASE':fin(d15)&&d15<0?'LOSING_RANK':speed==='UNKNOWN'?'UNKNOWN':speed};

  // C. CONTINUATION QUALITY (holding the high vs failing at it)
  const dh=v.distance_high_60m,msh=v.minutes_since_high_60m,r5=v.return_5m,a5=v.accel_5m_vs_15m;
  let cont='UNKNOWN';
  if(fin(dh)){
    if(fin(v.last_upper_wick)&&v.last_upper_wick>=B.wick&&fin(v.last_body)&&v.last_body<=0&&dh>B.fadeFromHigh)cont='FAILED_BREAKOUT_WICK';
    else if(dh>=B.nearHigh&&fin(msh)&&msh<=5)cont='HOLDING_NEAR_HIGH';
    else if(dh<B.fadeFromHigh&&fin(r5)&&r5<0)cont='FADING_FROM_HIGH';
    else if(dh>=B.pullbackDeep&&dh<B.nearHigh&&fin(r5)&&r5>0&&fin(a5)&&a5>0)cont='PULLBACK_REACCELERATING';
    else if(dh>=B.pullbackDeep&&dh<B.nearHigh)cont='PULLBACK_UNRESOLVED';
    else if(dh<B.pullbackDeep)cont='DEEP_PULLBACK';
    else cont='NEAR_HIGH_STALE';
  }
  const continuation={return_1m:v.return_1m??null,return_5m:r5??null,return_15m:v.return_15m??null,return_30m:v.return_30m??null,
    return_60m:v.return_60m??null,distance_high_60m:dh??null,minutes_since_high_60m:msh??null,distance_low_15m:v.distance_low_15m??null,
    accel_5m_vs_15m:a5??null,accel_15m_vs_60m:v.accel_15m_vs_60m??null,state:cont};

  // D. FLOW QUALITY
  const vol=v.volume_ratio_5m_vs_60m,tb5=v.taker_buy_ratio_5m;
  const volumePhase=!fin(vol)?'UNKNOWN':vol<B.volume.thin?'THIN':vol<B.volume.hot?'HEALTHY_EXPANSION':vol<B.volume.spike?'HOT':'SPIKE';
  const takerPhase=!fin(tb5)?'UNKNOWN':tb5<B.taker.weak?'SELLERS_OR_WEAK':tb5<B.taker.extreme?'SUSTAINED_BUYING':'EXTREME_BUY_CONCENTRATION';
  const oi5=v.oi_change_5m,oi60=v.oi_change_60m,ret60=v.return_60m;
  let priceOi='UNKNOWN';
  if(fin(oi5)&&fin(r5)&&oi5>=B.oiSpike5m&&r5<=B.stallReturn5m)priceOi='OI_SPIKE_PRICE_STALL';
  else if(fin(oi60)&&fin(ret60))priceOi=ret60>0&&oi60>0?'PRICE_UP_OI_UP':ret60>0&&oi60<=0?'PRICE_UP_OI_DOWN':ret60<=0&&oi60>0?'PRICE_DOWN_OI_UP':'PRICE_DOWN_OI_DOWN';
  const flow={taker_buy_ratio_5m:tb5??null,taker_buy_ratio_15m:v.taker_buy_ratio_15m??null,taker_buy_ratio_60m:v.taker_buy_ratio_60m??null,
    buyer_share_change:v.buyer_share_change??null,volume_ratio_5m_vs_60m:vol??null,vr15,volume_phase:volumePhase,taker_phase:takerPhase,
    absorption_risk:fin(tb5)&&tb5>=B.taker.extreme&&fin(r5)&&r5<=B.stallReturn5m,
    oi_change_5m:oi5??null,oi_change_60m:oi60??null,price_oi:priceOi};

  // E. EXECUTION QUALITY
  const sp=v.spread_bps,sl=v.est_buy_slippage_bps,ad=v.ask_depth_to_order,aw=v.max_ask_wall_to_order;
  const poor=(fin(sp)&&sp>B.spreadPoor)||(fin(sl)&&sl>B.slipPoor)||(fin(ad)&&ad<B.askDepthPoor);
  const good=fin(sp)&&sp<=B.spreadGood&&fin(sl)&&sl<=B.slipGood&&fin(ad)&&ad>=B.askDepthGood;
  const execution={spread_bps:sp??null,bid_depth_25bps_usdt:v.bid_depth_25bps_usdt??null,ask_depth_25bps_usdt:v.ask_depth_25bps_usdt??null,
    bid_depth_to_order:v.bid_depth_to_order??null,ask_depth_to_order:ad??null,book_imbalance_25bps:v.book_imbalance_25bps??null,
    max_bid_wall_to_order:v.max_bid_wall_to_order??null,max_ask_wall_to_order:aw??null,estimated_buy_slippage_bps:sl??null,
    ask_wall_heavy:fin(aw)&&aw>=B.askWallHeavy,roundtrip_cost_bps:n(ctx.cost?.roundtrip_cost_bps_real),
    state:![sp,sl,ad].every(fin)?'UNKNOWN':poor?'POOR':good?'GOOD':'ACCEPTABLE'};

  // F. OVERHEAT RISK (independent axis; flags, not a score)
  const flags=[];
  const flag=(k,cond,val)=>{if(cond)flags.push({k,v:val});};
  flag('EXTREME_DAY_RETURN',fin(v.day_return)&&v.day_return>=B.dayReturnExtreme,v.day_return);
  flag('EXTREME_RANK_VELOCITY',(fin(d15)&&d15>=B.v15.extreme)||(fin(d60)&&d60>=B.v60.extreme),{d15,d60});
  flag('VOLUME_BLOWOFF',(fin(vol)&&vol>=B.volume.spike)||(fin(vr15)&&vr15>=B.vr15.spike),{vol,vr15});
  flag('TAKER_EXTREME_PRICE_STALL',flow.absorption_risk,{tb5,r5});
  flag('UPPER_WICK_FAILED_BREAKOUT',cont==='FAILED_BREAKOUT_WICK',v.last_upper_wick);
  flag('FADING_AFTER_HIGH',cont==='FADING_FROM_HIGH',dh);
  flag('EXTENDED_FROM_SMA20',fin(v.distance_sma20)&&v.distance_sma20>=B.extendedSma20,v.distance_sma20);
  flag('SHORT_TERM_PARABOLIC',(fin(v.return_15m)&&v.return_15m>=B.parabolic15m)||(fin(r5)&&r5>=B.parabolic5m),{r5,r15:v.return_15m});
  flag('OI_SPIKE_WITHOUT_PRICE',priceOi==='OI_SPIKE_PRICE_STALL',oi5);
  flag('CROWDED_LONG_FUNDING',(fin(v.funding_rate)&&v.funding_rate>=B.fundingHot)||(fin(v.premium_index)&&v.premium_index>=B.premiumHot),
    {funding:v.funding_rate,premium:v.premium_index});
  const overheat={flags,count:flags.length,level:flags.length===0?'NONE':flags.length===1?'LOW':flags.length===2?'ELEVATED':'HIGH'};

  return {version:AXES_VERSION,bands:B.version,semantics:'EVIDENCE_ONLY_NO_COMPOSITE',
    leadership,emergence,continuation,flow,execution,overheat};
}

/**
 * DISCOVERY GPT compression (deterministic, NOT a trading verdict): of the shortlisted rows, at most
 * one LEADER and one EMERGING go to GPT. Order: fewer overheat flags, then better continuation
 * state, then execution state, then rank. Raw strength (velocity, volume) is deliberately NOT
 * a positive sort key.
 */
const CONT_ORDER=['PULLBACK_REACCELERATING','HOLDING_NEAR_HIGH','PULLBACK_UNRESOLVED','NEAR_HIGH_STALE','UNKNOWN','DEEP_PULLBACK','FADING_FROM_HIGH','FAILED_BREAKOUT_WICK'];
const EXEC_ORDER=['GOOD','ACCEPTABLE','UNKNOWN','POOR'];
export function prescoreKey(axes){
  return [axes.overheat.count,CONT_ORDER.indexOf(axes.continuation.state),EXEC_ORDER.indexOf(axes.execution.state),axes.leadership.rank??99];
}
export function pickForGpt(items,limits={LEADER:1,EMERGING:1}){
  const cmp=(a,b)=>{const x=prescoreKey(a.axes),y=prescoreKey(b.axes);for(let i=0;i<x.length;i++)if(x[i]!==y[i])return x[i]-y[i];return a.symbol<b.symbol?-1:1;};
  const out=[],skipped=[];
  for(const lane of Object.keys(limits)){
    const xs=items.filter(i=>i.lane===lane).sort(cmp);
    xs.forEach((x,i)=>(i<limits[lane]?out:skipped).push({...x,prescore:prescoreKey(x.axes),prescore_rank:i+1}));
  }
  return {selected:out,skipped};
}
