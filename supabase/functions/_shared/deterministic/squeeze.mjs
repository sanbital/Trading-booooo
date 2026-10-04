/** Pure short-squeeze setup detector. Funding shock is a trigger for review, never a BUY by itself. */
const finite=Number.isFinite;
const median=xs=>{const a=xs.filter(finite).sort((x,y)=>x-y);if(!a.length)return null;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;};
export const SHORT_SQUEEZE_POLICY=Object.freeze({
  minFundingSamples:12,
  minFundingDrop:0.00005,
  strongNegativeFunding:-0.00020,
  fundingMadMultiplier:3,
  minOiBuildPct:0.0015,
  maxOiFlushPct:-0.0015,
  maxShortBasisBps:0,
  minConfirmationScore:4,
});
function lastFinite(points,key){for(let i=points.length-1;i>=0;i--)if(finite(points[i]?.[key]))return points[i][key];return null;}
function oiChange(points){
  const rows=[];let seen=null;
  for(const p of points){
    if(!finite(p?.open_interest)||p.open_interest<0||!Number.isSafeInteger(p?.open_interest_at_ms))continue;
    if(p.open_interest_at_ms===seen)continue;seen=p.open_interest_at_ms;rows.push(p);
  }
  if(rows.length<2||!(rows[0].open_interest>0))return null;
  return rows.at(-1).open_interest/rows[0].open_interest-1;
}
export function shortSqueezeSignal({values={},capture={},profile=null}={}){
  const points=Array.isArray(capture?.trajectory)?capture.trajectory:[];
  const funding=points.map(p=>p?.funding_rate).filter(finite);
  const currentFunding=lastFinite(points,'funding_rate');
  const basisBps=lastFinite(points,'basis_bps');
  const oiChange120s=oiChange(points);
  if(funding.length<SHORT_SQUEEZE_POLICY.minFundingSamples||!finite(currentFunding)){
    return {watch:false,confirmed:false,reason:'DERIVATIVES_WARMUP',funding_rate:currentFunding,basis_bps:basisBps,oi_change_120s:oiChange120s,score:0};
  }
  const baselineSet=funding.slice(0,Math.max(1,funding.length-3)),baseline=median(baselineSet);
  const mad=median(baselineSet.map(x=>Math.abs(x-baseline)))??0;
  const fundingDrop=currentFunding-baseline;
  const abnormalDrop=currentFunding<0&&fundingDrop<=-Math.max(SHORT_SQUEEZE_POLICY.minFundingDrop,SHORT_SQUEEZE_POLICY.fundingMadMultiplier*mad);
  const strongNegative=currentFunding<=SHORT_SQUEEZE_POLICY.strongNegativeFunding&&fundingDrop<0;
  const fundingTrigger=abnormalDrop||strongNegative;
  const h=capture?.dynamics?.horizons??{},s15=h.s15??{},s30=h.s30??{};
  const trendIntact=finite(values.return_15m)&&finite(values.return_60m)&&finite(values.ema9_vs_ema20)&&
    values.return_15m>0&&values.return_60m>0&&values.ema9_vs_ema20>=0;
  const priceRising=finite(s15.return)&&finite(s30.return)&&s15.return>0&&s30.return>=0;
  const flowPositive=finite(s15.net_taker_flow)&&s15.net_taker_flow>0;
  const oiFuel=finite(oiChange120s)&&oiChange120s>=SHORT_SQUEEZE_POLICY.minOiBuildPct;
  const oiFlush=finite(oiChange120s)&&oiChange120s<=SHORT_SQUEEZE_POLICY.maxOiFlushPct&&priceRising;
  const oiSupport=oiFuel||oiFlush;
  const basisShort=finite(basisBps)&&basisBps<=SHORT_SQUEEZE_POLICY.maxShortBasisBps;
  const macdBull=finite(values.macd_hist_1m)&&finite(values.macd_hist_delta_1m)&&values.macd_hist_1m>0&&values.macd_hist_delta_1m>=0;
  const obvBull=finite(values.obv_delta_5m)&&values.obv_delta_5m>0;
  const normalVolume=Number(profile?.bands?.volume?.normal);
  const volumeSupport=finite(values.volume_ratio_5m_vs_60m)&&values.volume_ratio_5m_vs_60m>=(finite(normalVolume)?normalVolume:1);
  const candleSupport=finite(values.last_body)&&finite(values.close_location_value)&&finite(values.last_upper_wick)&&
    values.last_body>0&&values.close_location_value>=0.5&&values.last_upper_wick<=Math.abs(values.last_body)+(Number(values.last_lower_wick)||0);
  const hardReject=values.failed_breakout_candle===true||values.sell_volume_expansion===true||values.volume_climax_decline===true;
  const confirmations={basis_short:basisShort,oi_support:oiSupport,macd_bull:macdBull,obv_bull:obvBull,volume_support:volumeSupport,candle_support:candleSupport};
  const score=Object.values(confirmations).filter(Boolean).length;
  const watch=fundingTrigger&&trendIntact&&priceRising&&!hardReject;
  const confirmed=watch&&flowPositive&&oiSupport&&score>=SHORT_SQUEEZE_POLICY.minConfirmationScore;
  return {watch,confirmed,reason:confirmed?'SHORT_SQUEEZE_CONFIRMED':watch?'SHORT_SQUEEZE_REVIEW':'NO_SQUEEZE',
    funding_rate:currentFunding,funding_baseline:baseline,funding_drop:fundingDrop,funding_mad:mad,abnormal_funding_drop:abnormalDrop,strong_negative_funding:strongNegative,
    basis_bps:basisBps,oi_change_120s:oiChange120s,oi_mode:oiFuel?'BUILD':oiFlush?'FLUSH':'NONE',score,confirmations};
}
