/** FD1 ENTRY engine for the durable FinalReviewCoordinator (journal, budget ledger,
 * async request, ticket, yield). The coordinator's claim/ledger/TTL/ticket machinery is
 * unchanged; this object only replaces WHAT is asked and how the stored answer is
 * re-validated. The allowing decision is BUY; anything else places no order. */
import {computeFacts,modelJudgments} from './facts.mjs';
import {readSources} from './market.mjs';
import {buildDecisionPacket,callDecision,hash,MODEL,payloadFor,PRICING} from './api.mjs';
import {validateDecision,FD_VERSION,wireSchema} from './contract.mjs';
import {PROMPTS} from './prompt.mjs';
import {bookReference} from './recheck.mjs';
import {LIVE_CHASE_MODE,chaseContext} from '../leader-live-chase.mjs';
import {dualEntryDecision,ARBITRATION_PROMPT,DUAL_VERSION,revalidateArbitration} from './dual.mjs';
const num=x=>x!==null&&x!==undefined&&Number.isFinite(Number(x))?Number(x):null;
/** Immutable decision identity: the trigger and the evidence GPT is shown. A LIVE chase
 * trigger also binds its chase classification; an ordinary trigger's identity is unchanged. */
export function fd1EntryIdentity(s){
  const f=s?.features??{},t=f.v17Setup??{};
  const chase=t.triggerMode===LIVE_CHASE_MODE&&t.chase?JSON.parse(JSON.stringify(t.chase)):null;
  return {signal_id:String(s?.id??''),symbol:String(s?.symbol??'').toUpperCase(),trigger_at_ms:num(t.triggerAt),
    reference_close:num(f.referenceClose),day_return:num(f.dayReturn),rank:num(f.rank),judgments:modelJudgments(f),
    exit_policy:JSON.parse(JSON.stringify(f.exitPolicy??{})),...(chase?{chase}:{})};
}
/** Bounded trade-memory read: trades of this symbol closed before the trigger. Never throws. */
export async function readHistory(reader,identity,timeoutMs=1500){
  if(typeof reader!=='function')return {trades:null,error:null};
  let timer;
  try{
    const trades=await Promise.race([reader(identity.symbol,identity.trigger_at_ms),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('HISTORY_TIMEOUT')),timeoutMs);})]);
    if(!Array.isArray(trades))return {trades:null,error:'HISTORY_INVALID'};
    return {trades:trades.filter(t=>Number(t?.exit_at_ms)<Number(identity.trigger_at_ms)),error:null};
  }catch(e){return {trades:null,error:String(e?.message??e).slice(0,40)};}
  finally{clearTimeout(timer);}
}
export const FD1_ENTRY_ENGINE=Object.freeze({
  id:FD_VERSION+':ENTRY:'+DUAL_VERSION,
  allow:'BUY',
  // An initial BUY that aged past its answer validity while its trigger is still live is
  // not dropped: it may enter the order path only to be re-decided by a forced GPT FINAL
  // RECHECK on fresh data (never dispatched on the aged answer). See coordinator.check().
  agedRecheck:true,
  model:MODEL,
  // The binding covers the ENTRY prompt and the dual-AI arbitration addendum.
  promptText:PROMPTS.ENTRY+'\n['+DUAL_VERSION+']'+ARBITRATION_PROMPT,
  schema:wireSchema('ENTRY'),
  identity:fd1EntryIdentity,
  // Same-symbol trade memory reader (symbol, beforeMs) => closed trades; injected by the
  // executor adapter (DB). Absent or failing => the memory facts are unknown, never a block.
  history:null,
  async prepare(identity,{fetchFn,now,deadlineMs}){
    const asOf=now(),ms=Math.max(200,Math.min(2500,deadlineMs-asOf));
    const [{src,errors},history]=await Promise.all([readSources(identity.symbol,asOf,{mode:'LIVE',fetchFn,ms}),
      readHistory(this.history,identity,Math.min(ms,1500))]);
    const captured=now();
    const facts=computeFacts(src,{asOf:captured,referenceClose:identity.reference_close,dayReturn:identity.day_return,rank:identity.rank,
      ...(history.trades?{history:history.trades}:{})});
    if(history.error)errors.history=history.error;
    const chase=identity.chase?chaseContext(identity.chase,facts,{referencePrice:identity.reference_close,stopPct:identity.exit_policy?.stopPct}):null;
    const packet=await buildDecisionPacket({task:'ENTRY',subjectId:identity.signal_id,symbol:identity.symbol,dataMode:'LIVE',facts,judgments:identity.judgments,chase});
    packet.as_of_offset_ms=captured-identity.trigger_at_ms;packet.source_errors=errors;
    // FINAL RECHECK reference: the book price this BUY was judged on. Stored in the hashed
    // packet (not shown to GPT) so the pre-dispatch change detector compares like with like.
    const ref=src.book?bookReference(src.book,captured):null;
    packet.execution_ref=ref?{bid:ref.bid,ask:ref.ask,mid:ref.mid,at:captured}:null;
    packet.snapshot_hash='';packet.snapshot_hash=await hash({...packet,snapshot_hash:''});
    return {packet,captured};
  },
  async packetHash(packet){return hash({...packet,snapshot_hash:''});},
  // Dual-AI (2026-09-26): () => DeepSeek key, injected by the executor adapter; absent => GPT alone.
  deepseekKey:null,
  async call(packet,{apiKey,fetchFn,now,deadlineMs,identity}){
    const dsKey=typeof this.deepseekKey==='function'?this.deepseekKey():null;
    const r=await dualEntryDecision(packet,{apiKey,deepseekKey:dsKey,fetchFn,now,deadlineMs,snapshotAtMs:packet?.execution_ref?.at??now(),
      refreshPacket:identity?ms=>this.prepare(identity,{fetchFn,now,deadlineMs:now()+ms}):null});
    // Stored for re-validation: the exact wire the API returned (never re-generated).
    return {...r,origin:'OPENAI_API',model_requested:MODEL,raw_response:r.wire?{model:MODEL,wire:r.wire}:null,
      request_id:r.request_id??null,wire_profile:this.id};
  },
  revalidate(result,packet){
    if(result?.raw_response?.model!==MODEL||!result.raw_response.wire)throw Error('FD_NO_STORED_WIRE');
    return revalidateArbitration(result,packet);
  }
});
export {payloadFor,PRICING};
