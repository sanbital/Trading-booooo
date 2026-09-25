/** LE-SHADOW-1 WAIT state machine. Pure. A WAIT is PENDING until exactly one terminal event:
 * EXPIRED (fixed 10-minute TTL), INVALIDATED (price outside +-1% of the snapshot mid, rank down
 * >= 10, or RANK_CONFIRM failing), or TRIGGERED (its one enumerated trigger fired on data that
 * completed AFTER the snapshot). A trigger produces a WAIT_MECHANICAL hypothetical entry and at
 * most one GPT re-ask (attempt 2), which cannot answer WAIT. */
import {WAIT_TTL_MS,WAIT_INVALIDATION,WAIT_TRIGGERS} from './contract.mjs';
import {bookFacts} from '../_shared/gpt-final-decision/facts.mjs';
const MIN=60_000;

/** Completed 1m bars that opened at/after the first full minute after the snapshot and closed before `now`. */
export function barsAfter(raw,snapshotAt,now){
  const from=Math.ceil(snapshotAt/MIN)*MIN;
  return (Array.isArray(raw)?raw:[]).map(r=>({t:Number(r[0]),o:Number(r[1]),h:Number(r[2]),l:Number(r[3]),c:Number(r[4]),end:Number(r[6]),
    q:Number(r[7]),buy:Number(r[10])})).filter(b=>b.t>=from&&b.end<now&&b.c>0).sort((a,b)=>a.t-b.t);
}

/**
 * @param w  {trigger, param, snapshot_at_ms, expires_at_ms, mid, high60, spread_bps, rank}
 * @param cur {now, bars (raw 1m rows), book (depth), rankFirst/rankLatest: {observedAt, rank}|null (scan cycles after the snapshot)}
 */
export function evaluateWait(w,cur){
  const now=cur.now;
  if(!(w&&WAIT_TRIGGERS[w.trigger]))return {state:'INVALIDATED',reason:'WAIT_SPEC_INVALID'};
  if(now>=w.expires_at_ms||now-w.snapshot_at_ms>=WAIT_TTL_MS)return {state:'EXPIRED',reason:'TTL_10M'};
  const bf=cur.book?bookFacts(cur.book):null;
  const bid=Number(cur.book?.bids?.[0]?.[0]),ask=Number(cur.book?.asks?.[0]?.[0]);
  const mid=bid>0&&ask>=bid?(bid+ask)/2:null;
  const bars=barsAfter(cur.bars,w.snapshot_at_ms,now);
  const price=mid??bars.at(-1)?.c??null;
  if(price!==null){
    if(price<w.mid*(1-WAIT_INVALIDATION.priceBand))return {state:'INVALIDATED',reason:'PRICE_DOWN_1PCT',price};
    if(price>w.mid*(1+WAIT_INVALIDATION.priceBand))return {state:'INVALIDATED',reason:'PRICE_UP_1PCT',price};
  }
  const after=x=>x&&x.observedAt>w.snapshot_at_ms?x:null;
  const ra=after(cur.rankFirst),rl=after(cur.rankLatest)??ra;
  // a symbol that left the ranking entirely counts as a drop
  if(rl&&(rl.rank===null||rl.rank-w.rank>=WAIT_INVALIDATION.rankDrop))return {state:'INVALIDATED',reason:'RANK_DROP_10',price,rank:rl.rank};
  let hit=false,detail={};
  switch(w.trigger){
    case 'PULLBACK_HOLD':{
      const lvl=w.mid*(1-w.param/1e4),i=bars.findIndex(b=>b.l<=lvl);
      const j=i<0?-1:bars.findIndex((b,k)=>k>=i&&b.c>w.mid);
      hit=j>=0;detail={touch_level:lvl,touched:i>=0};break;}
    case 'BREAKOUT_CONFIRM':{
      const lvl=Math.max(Number(w.high60)||0,w.mid*(1+w.param/1e4));
      const b=bars.find(x=>x.c>lvl&&x.q>0&&x.buy/x.q>.5);hit=!!b;detail={level:lvl};break;}
    case 'SPREAD_NORMALIZE':{
      const s=bf?.spread_bps;hit=Number.isFinite(s)&&s<=Math.min(10,w.spread_bps/2);detail={spread_bps:s??null};break;}
    case 'BOOK_IMPROVE':{
      hit=Number.isFinite(bf?.ask_depth_to_order)&&bf.ask_depth_to_order>=5&&Number.isFinite(bf?.book_imbalance_25bps)&&bf.book_imbalance_25bps>=-.2;
      detail={ask_depth_to_order:bf?.ask_depth_to_order??null,imbalance:bf?.book_imbalance_25bps??null};break;}
    case 'FLOW_TURN':{
      const last=bars.slice(-3),q=last.reduce((s,b)=>s+b.q,0),buy=last.reduce((s,b)=>s+b.buy,0);
      hit=last.length===3&&q>0&&buy/q>=.55;detail={buy_share_3m:last.length===3&&q>0?buy/q:null};break;}
    case 'RANK_CONFIRM':{
      if(!ra)break;
      if(ra.rank!==null&&ra.rank<=w.rank){hit=true;detail={rank_after:ra.rank};}
      else return {state:'INVALIDATED',reason:'RANK_NOT_CONFIRMED',price,rank:ra.rank};
      break;}
  }
  return hit?{state:'TRIGGERED',reason:w.trigger,price,detail}:{state:'PENDING',reason:null,price,detail};
}

/** Re-ask context: INITIAL (what GPT saw), CURRENT (now), DELTA. */
export function recheckContext(initialPacket,currentFacts,{price,snapshotMid,elapsedMs,trigger}){
  const iv=initialPacket.facts??{},cv=currentFacts?.values??{},delta={};
  for(const k of ['return_5m','return_15m','taker_buy_ratio_5m','spread_bps','ask_depth_to_order','book_imbalance_25bps','est_buy_slippage_bps'])
    delta[k]=Number.isFinite(iv[k])&&Number.isFinite(cv[k])?cv[k]-iv[k]:null;
  delta.price_change_since_initial=Number.isFinite(price)&&snapshotMid>0?price/snapshotMid-1:null;
  delta.elapsed_minutes=elapsedMs/MIN;delta.trigger=trigger;
  return {initial:{facts:iv,cost:initialPacket.cost,soft:initialPacket.soft,rank_now:initialPacket.rank_now},
    current:Object.fromEntries(Object.entries(cv).filter(([k])=>!k.startsWith('position_'))),delta};
}
