/** LE-SHADOW-2 WAIT lifecycle. Pure.
 * A WAIT is PENDING until exactly one terminal event:
 *   TRIGGERED   its one recheck trigger fired on data that completed AFTER the snapshot
 *               -> exactly one GPT re-ask (BUY / SKIP / ABSTAIN; WAIT impossible)
 *   EXPIRED     TTL (5..15 min, chosen by GPT, server range-checked) reached without a trigger
 *               -> deterministic SKIP (WAIT_TTL_NO_TRIGGER); time alone never becomes a BUY
 *   INVALIDATED price left [-1.2%, +2%] of the snapshot mid, rank fell >= 10, or RANK_HOLD failed
 *               -> deterministic SKIP (WAIT_INVALIDATED:<why>) */
import {TRIGGERS,WAIT_INVALIDATION,TTL_MIN} from './contract.mjs';
import {bookFacts} from '../../_shared/gpt-final-decision/facts.mjs';
const MIN=60_000;
const fin=x=>typeof x==='number'&&Number.isFinite(x);

export function ttlMs(ttlMin){
  const m=Math.round(Number(ttlMin));
  if(!(m>=TTL_MIN[0]&&m<=TTL_MIN[1]))throw Error('WAIT_TTL_RANGE');
  return m*MIN;
}

/** Completed 1m bars that opened at/after the first full minute after the snapshot and closed before now. */
export function barsAfter(raw,snapshotAt,now){
  const from=Math.ceil(snapshotAt/MIN)*MIN;
  return (Array.isArray(raw)?raw:[]).map(r=>({t:Number(r[0]),o:Number(r[1]),h:Number(r[2]),l:Number(r[3]),c:Number(r[4]),end:Number(r[6]),
    q:Number(r[7]),buy:Number(r[10])})).filter(b=>b.t>=from&&b.end<now&&b.c>0).sort((a,b)=>a.t-b.t);
}

/**
 * @param w   {trigger, param, snapshot_at_ms, expires_at_ms, mid, high60, rank, init:{spread_bps, est_buy_slippage_bps,
 *             ask_depth_to_order, book_imbalance_25bps}, oi_last:{t, v}}
 * @param cur {now, bars (raw 1m), book (depth), rankFirst/rankLatest {observedAt, rank}|null, oiHist (raw 5m OI rows)}
 */
export function evaluateWaitV2(w,cur){
  const now=cur.now;
  if(!(w&&TRIGGERS[w.trigger]))return {state:'INVALIDATED',reason:'WAIT_SPEC_INVALID'};
  if(!(fin(w.expires_at_ms)&&fin(w.snapshot_at_ms)&&w.expires_at_ms>w.snapshot_at_ms))return {state:'INVALIDATED',reason:'WAIT_SPEC_INVALID'};
  if(now>=w.expires_at_ms)return {state:'EXPIRED',reason:'WAIT_TTL_NO_TRIGGER'};
  const bf=cur.book?bookFacts(cur.book):null;
  const bid=Number(cur.book?.bids?.[0]?.[0]),ask=Number(cur.book?.asks?.[0]?.[0]);
  const mid=bid>0&&ask>=bid?(bid+ask)/2:null;
  const bars=barsAfter(cur.bars,w.snapshot_at_ms,now);
  const price=mid??bars.at(-1)?.c??null;
  if(price!==null&&fin(w.mid)){
    if(price<w.mid*(1-WAIT_INVALIDATION.priceDown))return {state:'INVALIDATED',reason:'PRICE_DOWN',price};
    if(price>w.mid*(1+WAIT_INVALIDATION.priceUp))return {state:'INVALIDATED',reason:'PRICE_RAN_AWAY',price};
  }
  const after=x=>x&&x.observedAt>w.snapshot_at_ms?x:null;
  const ra=after(cur.rankFirst),rl=after(cur.rankLatest)??ra;
  if(fin(w.rank)&&rl&&(rl.rank===null||rl.rank-w.rank>=WAIT_INVALIDATION.rankDrop))return {state:'INVALIDATED',reason:'RANK_DROP',price,rank:rl.rank};
  const i=w.init??{};let hit=false,detail={};
  switch(w.trigger){
    case 'SPREAD_IMPROVE':{const s=bf?.spread_bps;hit=fin(s)&&fin(i.spread_bps)&&s<=Math.min(8,i.spread_bps/2);detail={spread_bps:s??null};break;}
    case 'SLIPPAGE_DROP':{const s=bf?.est_buy_slippage_bps;hit=fin(s)&&fin(i.est_buy_slippage_bps)&&s<=Math.max(3,i.est_buy_slippage_bps*.6);detail={slip_bps:s??null};break;}
    case 'ASK_DEPTH_IMPROVE':{const d=bf?.ask_depth_to_order,wall=bf?.max_ask_wall_to_order;
      hit=fin(d)&&d>=Math.max(5,fin(i.ask_depth_to_order)?i.ask_depth_to_order*1.5:5)&&(!fin(wall)||wall<10);detail={ask_depth_to_order:d??null,wall:wall??null};break;}
    case 'BID_SUPPORT_UP':{const m=bf?.book_imbalance_25bps;hit=fin(m)&&m>=Math.max(.1,fin(i.book_imbalance_25bps)?i.book_imbalance_25bps+.2:.1);detail={imbalance:m??null};break;}
    case 'TAKER_BUY_RETURN':{const last=bars.slice(-3),q=last.reduce((s,b)=>s+b.q,0),buy=last.reduce((s,b)=>s+b.buy,0);
      const r3=last.length===3&&last[0].o>0?last[2].c/last[0].o-1:null;
      hit=last.length===3&&q>0&&buy/q>=.55&&fin(r3)&&r3>0;detail={buy_share_3m:last.length===3&&q>0?buy/q:null,r3};break;}
    case 'PULLBACK_REACCEL':{const lvl=w.mid*(1-w.param/1e4),k=bars.findIndex(b=>b.l<=lvl);const j=k<0?-1:bars.findIndex((b,x)=>x>=k&&b.c>w.mid);
      hit=j>=0;detail={touch_level:lvl,touched:k>=0};break;}
    case 'NEW_HIGH_BREAK':{const lvl=Math.max(Number(w.high60)||0,w.mid*(1+w.param/1e4));const b=bars.find(x=>x.c>lvl&&x.q>0&&x.buy/x.q>.5);
      hit=!!b;detail={level:lvl};break;}
    case 'RANK_HOLD':{if(!ra)break;
      if(ra.rank!==null&&ra.rank<=w.rank){hit=true;detail={rank_after:ra.rank};}
      else return {state:'INVALIDATED',reason:'RANK_NOT_HELD',price,rank:ra.rank};
      break;}
    case 'OI_CONFIRM':{const rows=(Array.isArray(cur.oiHist)?cur.oiHist:[]).map(r=>({t:Number(r.timestamp),v:Number(r.sumOpenInterestValue)}))
        .filter(r=>fin(r.t)&&r.v>0&&r.t>w.snapshot_at_ms&&r.t<=now).sort((a,b)=>a.t-b.t);
      const base=Number(w.oi_last?.v);hit=rows.length>0&&base>0&&rows.at(-1).v>base&&price!==null&&price>=w.mid;
      detail={oi_after:rows.at(-1)?.v??null,oi_before:base||null};break;}
  }
  return hit?{state:'TRIGGERED',reason:w.trigger,price,detail}:{state:'PENDING',reason:null,price,detail};
}

/** Deterministic terminal decision for EXPIRED / INVALIDATED (never BUY). */
export function terminalResolution(ev){
  if(ev.state==='EXPIRED')return {decision:'SKIP',reasons:['WAIT_TTL_NO_TRIGGER']};
  if(ev.state==='INVALIDATED')return {decision:'SKIP',reasons:['WAIT_INVALIDATED:'+ev.reason]};
  throw Error('NOT_TERMINAL_WITHOUT_GPT');
}

/** Re-ask context: INITIAL (what GPT saw), CURRENT (now), DELTA. */
export function recheckContextV2(initialPacket,currentFacts,{price,snapshotMid,elapsedMs,trigger}){
  const iv=initialPacket.facts??{},cv=currentFacts?.values??{},delta={};
  for(const k of ['return_5m','return_15m','taker_buy_ratio_5m','volume_ratio_5m_vs_60m','oi_change_5m','distance_high_60m',
    'spread_bps','ask_depth_to_order','book_imbalance_25bps','est_buy_slippage_bps'])
    delta[k]=fin(iv[k])&&fin(cv[k])?cv[k]-iv[k]:null;
  delta.price_change_since_initial=fin(price)&&snapshotMid>0?price/snapshotMid-1:null;
  delta.elapsed_minutes=elapsedMs/MIN;
  return {initial:{facts:iv,axes:initialPacket.axes,cost:initialPacket.cost,rank_context:initialPacket.rank_context},
    current:Object.fromEntries(Object.entries(cv).filter(([k])=>!k.startsWith('position_'))),delta,trigger};
}
