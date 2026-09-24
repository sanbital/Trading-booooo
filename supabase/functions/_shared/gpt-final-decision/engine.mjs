/** FD1 ENTRY engine for the durable FinalReviewCoordinator (journal, budget ledger,
 * async request, ticket, yield). The coordinator's claim/ledger/TTL/ticket machinery is
 * unchanged; this object only replaces WHAT is asked and how the stored answer is
 * re-validated. The allowing decision is BUY; anything else places no order. */
import {computeFacts,modelJudgments} from './facts.mjs';
import {readSources} from './market.mjs';
import {buildDecisionPacket,callDecision,hash,MODEL,payloadFor,PRICING} from './api.mjs';
import {validateDecision,FD_VERSION,wireSchema} from './contract.mjs';
import {PROMPTS} from './prompt.mjs';
const num=x=>x!==null&&x!==undefined&&Number.isFinite(Number(x))?Number(x):null;
/** Immutable decision identity: the trigger and the evidence GPT is shown. */
export function fd1EntryIdentity(s){
  const f=s?.features??{},t=f.v17Setup??{};
  return {signal_id:String(s?.id??''),symbol:String(s?.symbol??'').toUpperCase(),trigger_at_ms:num(t.triggerAt),
    reference_close:num(f.referenceClose),day_return:num(f.dayReturn),rank:num(f.rank),judgments:modelJudgments(f),
    exit_policy:JSON.parse(JSON.stringify(f.exitPolicy??{}))};
}
export const FD1_ENTRY_ENGINE=Object.freeze({
  id:FD_VERSION+':ENTRY',
  allow:'BUY',
  model:MODEL,
  promptText:PROMPTS.ENTRY,
  schema:wireSchema('ENTRY'),
  identity:fd1EntryIdentity,
  async prepare(identity,{fetchFn,now,deadlineMs}){
    const asOf=now(),{src,errors}=await readSources(identity.symbol,asOf,{mode:'LIVE',fetchFn,ms:Math.max(200,Math.min(2500,deadlineMs-asOf))});
    const captured=now();
    const facts=computeFacts(src,{asOf:captured,referenceClose:identity.reference_close,dayReturn:identity.day_return,rank:identity.rank});
    const packet=await buildDecisionPacket({task:'ENTRY',subjectId:identity.signal_id,symbol:identity.symbol,dataMode:'LIVE',facts,judgments:identity.judgments});
    packet.as_of_offset_ms=captured-identity.trigger_at_ms;packet.source_errors=errors;
    packet.snapshot_hash='';packet.snapshot_hash=await hash({...packet,snapshot_hash:''});
    return {packet,captured};
  },
  async packetHash(packet){return hash({...packet,snapshot_hash:''});},
  async call(packet,{apiKey,fetchFn,now,deadlineMs}){
    const r=await callDecision(packet,{apiKey,fetchFn,now,timeoutMs:Math.max(1,Math.min(8000,deadlineMs-now()))});
    // Stored for re-validation: the exact wire the API returned (never re-generated).
    return {...r,origin:'OPENAI_API',model_requested:MODEL,raw_response:r.wire?{model:MODEL,wire:r.wire}:null,
      request_id:r.request_id??null,wire_profile:FD_VERSION+':ENTRY'};
  },
  revalidate(result,packet){
    if(result?.raw_response?.model!==MODEL||!result.raw_response.wire)throw Error('FD_NO_STORED_WIRE');
    return validateDecision(result.raw_response.wire,packet);
  }
});
export {payloadFor,PRICING};
