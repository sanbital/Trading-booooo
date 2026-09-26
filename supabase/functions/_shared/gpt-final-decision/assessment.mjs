/** FD1 ENTRY assessment (2026-09-26). Pure, no I/O, and never a gate.
 *
 * The same point-in-time facts, restructured into the three questions the ENTRY decision
 * must keep apart:
 *  - TREND_STRENGTH: how strong the move has been (day, 15m..4h, rank, relative strength);
 *  - CURRENT_PROPULSION: what is pushing a NEW long right now (1m/5m, acceleration, taker
 *    flow, participation, open interest, book, distance/time from the 60m high);
 *  - FATIGUE: independent axes on which propulsion is fading while the trend still looks
 *    strong. Correlated facts are grouped into one axis so one price fact is never counted
 *    twice (phi(taker_buy_ratio_5m<0.5, buyer_share_change<0)=0.62 -> one FLOW axis;
 *    both acceleration facts and failure to renew the high -> one PRICE axis).
 *
 * Replay 2026-09-02..09-26 (3,092 V17 candidates, see research/fd1-exhaustion-20260926):
 * no single axis nor any pair of axes changed per-trade expected value consistently in
 * both halves; fatigue raises the low-MFE failure rate modestly. The assessment is
 * therefore evidence for GPT's judgment, not a deterministic reject. Open-interest decline
 * is shown as propulsion context but is NOT a fatigue axis: in both halves candidates with
 * falling 5m OI did better than the rest, so calling it weakness would contradict the data. */
export const ASSESSMENT_VERSION='FD1_ENTRY_ASSESSMENT_1';
export const TREND_KEYS=Object.freeze(['day_return','return_15m','return_30m','return_60m','return_4h','relative_strength_60m','signal_rank','distance_high_4h']);
export const PROPULSION_KEYS=Object.freeze(['return_1m','return_5m','accel_5m_vs_15m','accel_15m_vs_60m','minutes_since_high_60m','distance_high_60m',
  'taker_buy_ratio_5m','buyer_share_change','volume_ratio_5m_vs_60m','oi_change_5m','book_imbalance_25bps']);
const has=(m,...ks)=>ks.every(k=>m?.[k]!==null&&m?.[k]!==undefined&&Number.isFinite(m[k]));
/** Published fatigue axes. weak(m): true/false; null when its facts are unavailable. */
export const FATIGUE_AXES=Object.freeze({
  PRICE:{facts:['accel_5m_vs_15m','accel_15m_vs_60m','minutes_since_high_60m','distance_high_60m'],
    text:'(accel_5m_vs_15m<0 AND accel_15m_vs_60m<0) OR (minutes_since_high_60m>=10 AND distance_high_60m<=-0.005)',
    weak:m=>{const a=has(m,'accel_5m_vs_15m','accel_15m_vs_60m'),h=has(m,'minutes_since_high_60m','distance_high_60m');
      if(!a&&!h)return null;
      return (a&&m.accel_5m_vs_15m<0&&m.accel_15m_vs_60m<0)||(h&&m.minutes_since_high_60m>=10&&m.distance_high_60m<=-0.005);}},
  FLOW:{facts:['taker_buy_ratio_5m','buyer_share_change'],text:'taker_buy_ratio_5m<0.5 AND buyer_share_change<0',
    weak:m=>has(m,'taker_buy_ratio_5m','buyer_share_change')?m.taker_buy_ratio_5m<0.5&&m.buyer_share_change<0:null},
  PARTICIPATION:{facts:['volume_ratio_5m_vs_60m'],text:'volume_ratio_5m_vs_60m<0.8',
    weak:m=>has(m,'volume_ratio_5m_vs_60m')?m.volume_ratio_5m_vs_60m<0.8:null},
  BOOK:{facts:['book_imbalance_25bps'],text:'book_imbalance_25bps<=-0.2 (live order book only)',
    weak:m=>has(m,'book_imbalance_25bps')?m.book_imbalance_25bps<=-0.2:null}
});
export const FATIGUE_FACTS=Object.freeze([...new Set(Object.values(FATIGUE_AXES).flatMap(a=>a.facts))]);
/** {axes:{PRICE:'WEAK'|'OK'|'UNKNOWN',..}, weak:[..], known:n} */
export function fatigueAxes(m){
  const axes={},weak=[];let known=0;
  for(const [k,a] of Object.entries(FATIGUE_AXES)){const w=a.weak(m);axes[k]=w===null?'UNKNOWN':w?'WEAK':'OK';if(w!==null)known++;if(w)weak.push(k);}
  return {axes,weak,known};
}
const round=v=>v===null||v===undefined||!Number.isFinite(v)?null:Number(Number(v).toPrecision(5));
const pick=(m,ks)=>Object.fromEntries(ks.filter(k=>has(m,k)).map(k=>[k,round(m[k])]));
/** What GPT sees as entry_assessment. */
export function entryAssessment(m){
  const f=fatigueAxes(m);
  return {version:ASSESSMENT_VERSION,trend_strength:pick(m,TREND_KEYS),current_propulsion:pick(m,PROPULSION_KEYS),
    fatigue:{axes:f.axes,weak_axes:f.weak,weak_count:f.weak.length,known_axes:f.known}};
}
