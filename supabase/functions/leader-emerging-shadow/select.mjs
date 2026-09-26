/** LE-SHADOW-1 lanes and shortlist. Pure. Thresholds are PRE-REGISTERED
 * (research/leader-emerging-shadow-20260924/PREREGISTRATION.md) and must not be tuned on results. */
import {cycleNear,rankIn,velocityWindow,dayHistory,MIN} from './universe.mjs';

export const LANE_RULES=Object.freeze({
  version:'LE_LANES_1',
  top:30,
  leaderMaxRank:3,
  emergingMinRank:4,emergingMaxRank:30,
  emergingUp60:20,        // rank_60m - rank >= 20
  emergingUp15:10,        // rank_15m - rank >= 10
  leaderReentryGapMs:60*MIN,
  maxShortlist:3,maxLeader:1,maxEmerging:2,
  cooldownMs:30*MIN,
  overheatedRank:10,overheatedVr15:4,          // VOLUME_OVERHEATED: Top10 & vr15 >= 4
  extendedDayReturn:.20,extendedWindowMs:60*MIN, // EXTENDED_LEADER: day >= 20% & first Top10 within 1h
  fadingDrop15:-5,                              // RANK_FADING: rank_15m - rank <= -5
  costExceedsEdgeBps:35,                        // COST_EXCEEDS_EDGE: spread + slippage + fees >= 35 bps
});

/**
 * Classify the top30 of one cycle.
 * @param ranked [{symbol, rank, dayReturn, price}] full ranking of this cycle
 * @param t observed_at (ms) of this cycle
 * @param history {m15,m30,m60} reference cycles [{observedAt, rankOrder}], today [{observedAt, top10}]
 */
export function classify(ranked,t,history,R=LANE_RULES){
  const refs={m15:cycleNear(history.cycles,t-15*MIN),m30:cycleNear(history.cycles,t-30*MIN),m60:cycleNear(history.cycles,t-60*MIN)};
  const vw=velocityWindow(t,refs),day=dayHistory(history.today,t);
  return ranked.slice(0,R.top).map(r=>{
    const s=r.symbol,r15=vw.valid15?rankIn(refs.m15,s):null,r30=vw.valid30?rankIn(refs.m30,s):null,r60=vw.valid60?rankIn(refs.m60,s):null;
    const v15=r15===null?null:r15-r.rank,v60=r60===null?null:r60-r.rank;
    const velocityValid=!vw.blackout&&(v15!==null||v60!==null);
    const firstTop3=r.rank<=3&&!day.firstTop3.has(s);
    const last3=day.lastTop3.get(s);
    const reentry=r.rank<=3&&last3!==undefined&&t-last3>=R.leaderReentryGapMs;
    const firstTop10At=r.rank<=10?(day.firstTop10.get(s)??t):(day.firstTop10.get(s)??null);
    let lane='CONTROL';
    if(r.rank<=R.leaderMaxRank)lane='LEADER';
    else if(r.rank>=R.emergingMinRank&&r.rank<=R.emergingMaxRank&&velocityValid&&
      ((v60!==null&&v60>=R.emergingUp60)||(v15!==null&&v15>=R.emergingUp15)))lane='EMERGING';
    return {symbol:s,rank:r.rank,dayReturn:r.dayReturn,price:r.price,lane,
      rank15m:r15,rank30m:r30,rank60m:r60,velocity15:v15,velocity60:v60,
      velocity:v15===null&&v60===null?null:Math.max(v15??-Infinity,v60??-Infinity),
      velocityValid,minutesSinceMidnight:vw.minutesSinceMidnight,
      firstTop3Today:firstTop3,leaderReentry60m:reentry,
      firstTop10Today:r.rank<=10&&!day.firstTop10.has(s),firstTop10At,
      minutesInTop10Today:5*((day.top10Count.get(s)??0)+(r.rank<=10?1:0))};
  });
}

/**
 * Shortlist (<=3): LEADER <=1 (first Top3 entry today, or re-entry after >=60 min out of Top3),
 * EMERGING <=2 by velocity desc, ties by lower vr15, then rank, then symbol. Symbols
 * shortlisted within the last 30 minutes are cooled down. vr15 is unknown before the precise
 * read, so the tie-break uses the value passed in `vr15Of` (null sorts last).
 */
export function shortlist(rows,{recentShortlisted=new Set(),vr15Of=()=>null}={},R=LANE_RULES){
  const out=new Map(),reason=new Map();
  const leaders=rows.filter(r=>r.lane==='LEADER').sort((a,b)=>a.rank-b.rank);
  for(const r of leaders){
    if(!(r.firstTop3Today||r.leaderReentry60m)){reason.set(r.symbol,'LEADER_NOT_FIRST_ENTRY');continue;}
    if(recentShortlisted.has(r.symbol)){reason.set(r.symbol,'COOLDOWN_30M');continue;}
    if([...out.values()].filter(x=>x==='LEADER').length>=R.maxLeader){reason.set(r.symbol,'CAP_LEADER');continue;}
    out.set(r.symbol,'LEADER');reason.set(r.symbol,r.firstTop3Today?'LEADER_FIRST_TOP3_TODAY':'LEADER_REENTRY_AFTER_60M');
  }
  const vr=s=>{const v=vr15Of(s);return Number.isFinite(v)?v:Infinity;};
  const em=rows.filter(r=>r.lane==='EMERGING').sort((a,b)=>(b.velocity-a.velocity)||(vr(a.symbol)-vr(b.symbol))||(a.rank-b.rank)||(a.symbol<b.symbol?-1:1));
  for(const r of em){
    if(recentShortlisted.has(r.symbol)){reason.set(r.symbol,'COOLDOWN_30M');continue;}
    if([...out.values()].filter(x=>x==='EMERGING').length>=R.maxEmerging||out.size>=R.maxShortlist){reason.set(r.symbol,'CAP_EMERGING');continue;}
    out.set(r.symbol,'EMERGING');reason.set(r.symbol,'EMERGING_VELOCITY');
  }
  for(const r of rows)if(!reason.has(r.symbol))reason.set(r.symbol,'CONTROL');
  return {selected:[...out.keys()],reason};
}

/** SOFT categories (server-computed, citable by GPT, never a hard block). */
export function softCategories(c,{vr15,costBandBps},R=LANE_RULES,now=Date.now()){
  const top10=c.rank<=R.overheatedRank;
  return {
    VOLUME_OVERHEATED:top10&&Number.isFinite(vr15)&&vr15>=R.overheatedVr15,
    EXTENDED_LEADER:top10&&c.dayReturn>=R.extendedDayReturn&&c.firstTop10At!==null&&now-c.firstTop10At<=R.extendedWindowMs,
    RANK_FADING:c.velocity15!==null&&c.velocity15<=R.fadingDrop15,
    COST_EXCEEDS_EDGE:Number.isFinite(costBandBps)&&costBandBps>=R.costExceedsEdgeBps,
  };
}

/** Deterministic arms (stage 1). */
export function ruleBaseline(c,{vr15,hardBlock},R=LANE_RULES){
  if(hardBlock.length)return {decision:'SKIP_DETERMINISTIC',reasons:hardBlock};
  const overheated=c.rank<=R.overheatedRank&&Number.isFinite(vr15)&&vr15>=R.overheatedVr15;
  if(c.lane==='LEADER')return c.firstTop3Today&&!overheated?{decision:'BUY',reasons:['LEADER_FIRST_ENTRY_NOT_OVERHEATED']}
    :{decision:'SKIP',reasons:[c.firstTop3Today?'VOLUME_OVERHEATED':'LEADER_REENTRY_NOT_FIRST']};
  if(c.lane==='EMERGING')return overheated?{decision:'SKIP',reasons:['VOLUME_OVERHEATED']}:{decision:'BUY',reasons:['EMERGING_NOT_OVERHEATED']};
  return {decision:'SKIP',reasons:['NOT_A_SHORTLIST_LANE']};
}
export function takeAll(){return {decision:'BUY',reasons:['TAKE_ALL']};}
