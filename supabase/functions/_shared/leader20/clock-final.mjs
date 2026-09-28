import {clockCaptureValid,CLOCK_VERSION} from './clock.mjs';
import {entryCaptureSafety,DYNAMIC_VERSION} from '../gpt-final-decision/dynamic-flow.mjs';
import {canonical} from '../gpt-final-review/contract.mjs';

export const CLOCK_FINAL='TOP20_CLOCK_GPT_FINAL_3';
const windowKeys=['version','slot_ms','expires_at_ms','epoch_id','generation','capture_hash'];
/** The event, advisory and GPT must bind the exact frozen slot, not a later observation. */
export function validClockFinalPacket(p,at){
 const c=p?.facts?.capture_context,l=p?.leader20,w=c?.entry_window,e=l?.entry_window;
 return p?.task==='ENTRY'&&p.dynamic_policy===DYNAMIC_VERSION&&l?.version==='LEADER20_DYNAMIC_1'&&
  p.symbol===l.symbol&&w?.version===CLOCK_VERSION&&e&&windowKeys.every(k=>w[k]!=null&&w[k]===e[k])&&
  typeof l.event_id==='string'&&typeof l.batch_id==='string'&&l.epoch_id===w.epoch_id&&l.generation===w.generation&&
  l.expires_at_ms===w.expires_at_ms&&l.snapshot_end_ms===c.end_ms&&
  typeof c.trajectory_hash==='string'&&c.trajectory_hash===l.execution_snapshot_hash&&
  l.batch_advice?.id===p.symbol&&l.batch_advice.last_ms===c.end_ms&&
  (!l.batch_advice.entry_window||(windowKeys.every(k=>l.batch_advice.entry_window[k]===w[k])&&
   l.batch_advice.trajectory_hash===c.trajectory_hash))&&
  clockCaptureValid(c,at)&&entryCaptureSafety(c,at).ok;
}
/** Called only after the stored snapshot hash and original GPT wire are revalidated. */
export function clockFinalAuthority(packet,result,identity){
 const at=result?.completed_at_ms;
 if(result?.valid!==true||result.decision!=='BUY'||result.review_route!==CLOCK_FINAL||
   result.requires_final_recheck!==false||!validClockFinalPacket(packet,at)||
   result.final_packet?.snapshot_hash!==packet.snapshot_hash||
   identity?.symbol!==packet.symbol||canonical(identity.leader20)!==canonical(packet.leader20))return null;
 return {...packet.facts.capture_context.entry_window,
  // Authority version is distinct from the capture format version.
  authority_version:CLOCK_FINAL,snapshot_hash:packet.snapshot_hash,
  trajectory_hash:packet.facts.capture_context.trajectory_hash,candidate_id:packet.candidate_id,
  signal_id:identity.signal_id,completed_at_ms:at};
}
export function clockTicketCheck(ticket,identity,at){
 const a=ticket?.clockFinalAuthority,c=ticket?.initial?.capture_context,l=ticket?.initial?.leader20;
 if(!a||a.authority_version!==CLOCK_FINAL||ticket.decision!=='BUY'||
   a.snapshot_hash!==ticket.snapshotHash||a.candidate_id!==ticket.candidateId||
   a.signal_id!==identity?.signal_id||canonical(l)!==canonical(identity?.leader20)||
   a.trajectory_hash!==c?.trajectory_hash||l?.execution_snapshot_hash!==c?.trajectory_hash||
   !windowKeys.every(k=>a[k]===c?.entry_window?.[k]&&a[k]===l?.entry_window?.[k])||
   ticket.expires!==a.expires_at_ms||ticket.validUntil!==a.expires_at_ms)
  return {ok:false,reason:'CLOCK_FINAL_AUTHORITY_INVALID'};
 if(at>=a.expires_at_ms)return {ok:false,reason:'CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION'};
 if(at<a.completed_at_ms||!entryCaptureSafety(c,at).ok)return {ok:false,reason:'CLOCK_FINAL_SNAPSHOT_INVALID'};
 return {ok:true,reason:null};
}
/** No directional opinion, new capture, provider call or strategy retry after FINAL BUY.
 * The extreme displacement bound uses the existing native-stop distance, unchanged. */
export function clockExecutionSafety(ticket,identity,quote,at){
 const authority=clockTicketCheck(ticket,identity,at);if(!authority.ok)return authority;
 const bid=Number(quote?.best_bid),ask=Number(quote?.best_ask),received=quote?.timing?.received_at_ms;
 if(!(Number.isFinite(bid)&&Number.isFinite(ask)&&bid>0&&ask>=bid))return {ok:false,reason:'CLOCK_EXECUTION_QUOTE_INVALID'};
 if(!Number.isSafeInteger(received)||received<ticket.clockFinalAuthority.completed_at_ms||received>at||at-received>1000)
  return {ok:false,reason:'CLOCK_EXECUTION_QUOTE_STALE'};
 const mid=(bid+ask)/2,spread_bps=(ask-bid)/mid*10000,ref=ticket.initial?.executionRef?.mid,
  bound=identity?.exit_policy?.stopPct;
 if(!(Number.isFinite(ref)&&ref>0&&Number.isFinite(bound)&&bound>0&&bound<1))return {ok:false,reason:'CLOCK_EXECUTION_REFERENCE_INVALID'};
 const price_displacement=mid/ref-1;
 if(spread_bps>25||Math.abs(price_displacement)>=bound)
  return {ok:false,reason:'EXECUTION_ABORTED_MARKET_DISCONTINUITY',spread_bps,price_displacement};
 return {ok:true,reason:null,spread_bps,price_displacement};
}
