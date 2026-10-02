/**
 * Research-only alternative entry ranker (V1, copied from PR #182 research/leader-score-gpt-v1 f6f3ec5; code unchanged, this header extended).
 * LE-SHADOW-1 records its output only; it never selects, admits or rejects a candidate.
 * No exchange access, no DB access, no order authority.
 * Purpose: convert FD1 facts + legacy judgments into evidence, never a hard trading verdict.
 */
export const ALT_ENTRY_SCORE_VERSION='ALT_LEADER_SCORE_GPT_V1';

const finite=v=>v!==null&&v!==undefined&&Number.isFinite(Number(v));
const n=(v,d=0)=>finite(v)?Number(v):d;
const clamp=(v,a=0,b=100)=>Math.max(a,Math.min(b,v));
const scale=(v,lo,hi)=>hi<=lo?0:clamp((v-lo)/(hi-lo),0,1);

export function scoreAlternativeEntry(packet){
  const f=packet?.facts?.values??{},j=packet?.model_judgments??packet?.judgments??{};
  // Four independent axes. Scores rank candidates; they DO NOT admit/reject.
  const leadership=100*(
    .30*(1-scale(n(f.signal_rank,11),1,11))+
    .25*scale(n(f.day_return),.03,.20)+
    .20*scale(n(f.relative_strength_15m),0,.05)+
    .25*scale(n(f.relative_strength_60m),0,.10)
  );
  const persistence=100*(
    .20*scale(n(f.return_5m),0,.02)+
    .20*scale(n(f.return_15m),0,.04)+
    .20*scale(n(f.return_60m),0,.08)+
    .15*scale(n(f.distance_sma20),0,.03)+
    .15*scale(n(f.distance_high_60m,-.05),-.05,0)+
    .10*scale(n(f.accel_5m_vs_15m,-.02),-.02,.02)
  );
  const flow=100*(
    .30*scale(n(f.taker_buy_ratio_5m,.5),.45,.65)+
    .20*scale(n(f.taker_buy_ratio_15m,.5),.45,.65)+
    .20*scale(n(f.buyer_share_change),-.08,.08)+
    .15*scale(n(f.volume_ratio_5m_vs_60m),.7,2.5)+
    .15*scale(n(f.oi_change_5m),-.02,.04)
  );
  const microKnown=['spread_bps','ask_depth_to_order','bid_depth_to_order','book_imbalance_25bps','est_buy_slippage_bps']
    .filter(k=>finite(f[k])).length;
  const execution=microKnown===5?100*(
    .25*(1-scale(n(f.spread_bps),2,25))+
    .25*scale(n(f.ask_depth_to_order),1.5,10)+
    .15*scale(n(f.bid_depth_to_order),1,8)+
    .20*scale(n(f.book_imbalance_25bps),-.5,.5)+
    .15*(1-scale(n(f.est_buy_slippage_bps),2,25))
  ):null;

  // volumeTails remains explicit protected evidence; legacy models are advisory only.
  const legacy={
    b06133:j?.b06133??null,v30:j?.v30??j?.v30Front??null,cec0040:j?.cec0040??null,
    volumeTails:j?.b06133?.factors?.volumeTails??null
  };
  const axes={leadership:clamp(leadership),persistence:clamp(persistence),flow:clamp(flow),execution:execution===null?null:clamp(execution)};
  const available=Object.values(axes).filter(finite);
  const composite=available.length?available.reduce((a,b)=>a+Number(b),0)/available.length:null;
  return {version:ALT_ENTRY_SCORE_VERSION,axes,composite,legacy,
    semantics:'RANKING_EVIDENCE_ONLY',hardReject:false,
    gptInstruction:'Use score axes and legacy model outputs as evidence. Decide BUY, WAIT, SKIP or ABSTAIN from current facts. A low score alone is never a hard reject.'};
}

export function compareAlternativeToCurrent(row){
  const score=scoreAlternativeEntry(row.packet??row);
  return {id:row.id??row.candidate_id??null,symbol:row.symbol??null,currentDecision:row.decision??null,score};
}
