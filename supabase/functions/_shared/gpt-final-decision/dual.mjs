/** Dual-AI ENTRY decision (2026-09-26). Sensors prepare the packet; two AIs judge it.
 *
 *  1. GPT (FD1 ENTRY contract) and DeepSeek (independent counter schema) read the SAME
 *     immutable packet in parallel. Neither sees the other's answer.
 *  2. Agreement, or a DeepSeek UNCERTAIN / failure  -> GPT's validated answer stands.
 *  3. Disagreement (GPT BUY vs DeepSeek OPPOSE_BUY, or GPT SKIP vs DeepSeek SUPPORT_BUY)
 *     -> one GPT arbitration call that sees both independent reviews and must decide on
 *     the facts (same ENTRY schema and server validation).
 *  4. An unresolved BUY disagreement (arbitration invalid or out of time) places no order.
 * The final answer is always a GPT-format wire validated against the same packet, so the
 * coordinator's stored-answer revalidation, TTL and ticket rules are unchanged.
 * Execution/account safety never depends on either AI. */
import {callDecision,payloadFor,modelInput} from './api.mjs';
import {sharedReview,callCounter,MODEL_CANDIDATES} from './parallel.mjs';
import {flashCostCeiling} from './hold-shadow.mjs';
import {PROMPTS} from './prompt.mjs';
export const DUAL_VERSION='FD1_DUAL_AI_ENTRY_1';
export const ARBITRATION_PROMPT=`
[중재 과제] 같은 입력을 GPT와 DeepSeek가 서로의 답을 보지 않고 독립적으로 판단했고 결론이 엇갈렸다(independent_reviews).
너는 두 검토의 근거를 입력 facts와 직접 대조해 최종 결정을 내린다.
- 다수결, 신뢰도 숫자, 모델 이름으로 정하지 마라. 어느 쪽 근거가 지금 facts와 더 맞는지로 판단하라.
- 한쪽이 지적한 위험이 facts로 확인되면 반영하고, facts와 맞지 않는 주장은 버려라.
- 출력 형식과 규칙은 위 ENTRY와 똑같다(support/bearish/…/d). 결정이 곧 실행된다.`;
const pick=(o,ks)=>Object.fromEntries(ks.filter(k=>o?.[k]!==undefined).map(k=>[k,o[k]]));
/** The two independent opinions as shown to the arbiter (schema fields only, no free chain-of-thought). */
export function reviewsFor(gpt,ds){
  const a=gpt?.answer??{},d=ds?.answer??{};
  return {gpt:{decision:gpt?.decision??'ABSTAIN',summary:a.summary??null,support:(a.support??[]).map(e=>e.key),
      reasons:(a.reasons??[]).map(r=>({category:r.category,facts:(r.evidence??[]).map(e=>e.key)})),
      expected_value_bias:a.expected_value_bias??null,expected_upside_pct:a.expected_upside_pct??null,expected_downside_pct:a.expected_downside_pct??null},
    deepseek:pick(d,['decision','failure_risk','continuation_strength','chase_risk','expected_value','evidence','summary'])};
}
export function arbitrationPayload(packet,reviews){
  const base=payloadFor(packet);
  return {...base,prompt_cache_key:'boo-fd1-entry-arbitration',
    input:[{role:'system',content:PROMPTS.ENTRY+ARBITRATION_PROMPT},{role:'user',content:JSON.stringify({...modelInput(packet),independent_reviews:reviews})}]};
}
/** GPT answer + DeepSeek answer -> does this pair need arbitration? */
export function disagreement(gpt,ds){
  if(gpt?.valid!==true||ds?.valid!==true)return null;
  const d=ds.answer?.decision;
  if(gpt.decision==='BUY'&&d==='OPPOSE_BUY')return 'GPT_BUY_DEEPSEEK_OPPOSE';
  if(gpt.decision!=='BUY'&&d==='SUPPORT_BUY')return 'GPT_'+gpt.decision+'_DEEPSEEK_SUPPORT';
  return null;
}
/**
 * @returns the FINAL call result in callDecision's shape (+ .dual record). Never throws.
 */
export async function dualEntryDecision(packet,{apiKey,deepseekKey,fetchFn=fetch,now=Date.now,deadlineMs,
  gptCall=callDecision,counterCall=callCounter,snapshotAtMs}){
  const started=now(),budget=()=>Math.max(1,Math.min(8000,deadlineMs-now()));
  let ds={valid:false,error:deepseekKey?'COUNTER_NOT_RUN':'COUNTER_KEY_MISSING'};
  const dsWork=deepseekKey?(async()=>{try{
      const shared=await sharedReview(packet,{snapshotAtMs:Number.isSafeInteger(snapshotAtMs)?snapshotAtMs:started});
      return await counterCall(shared,{...MODEL_CANDIDATES[0],apiKey:deepseekKey,fetchFn,now,timeoutMs:budget()});
    }catch{return {valid:false,error:'COUNTER_PREPARATION_FAILED'};}})():Promise.resolve(ds);
  const [gpt,dsOut]=await Promise.all([gptCall(packet,{apiKey,fetchFn,now,timeoutMs:budget()}),dsWork]);ds=dsOut;
  const split=disagreement(gpt,ds);
  const record={version:DUAL_VERSION,path:ds.valid!==true?'GPT_ONLY_DEEPSEEK_UNAVAILABLE':split?'ARBITRATION':'AGREED_OR_DEEPSEEK_UNCERTAIN',
    disagreement:split,gpt:{decision:gpt.decision,valid:gpt.valid===true,error:gpt.error??null,request_id:gpt.request_id??null,latency_ms:gpt.latency_ms??null},
    deepseek:{valid:ds.valid===true,error:ds.error??null,answer:ds.answer??null,latency_ms:ds.latency_ms??null,model:ds.model??null,cost_ceiling_usd:flashCostCeiling(ds)},
    arbitration:null,started_at_ms:started};
  const cost=x=>Number.isFinite(x?.api_cost_usd)?x.api_cost_usd:0;
  if(!split){record.final='GPT';return {...gpt,dual:record,api_cost_usd:cost(gpt)+(record.deepseek.cost_ceiling_usd??0)};}
  const remaining=deadlineMs-now();
  let arb={valid:false,decision:'ABSTAIN',error:'ARBITRATION_NO_TIME'};
  if(remaining>750){
    const reviews=reviewsFor(gpt,ds);
    arb=await gptCall(packet,{apiKey,fetchFn,now,timeoutMs:Math.min(8000,remaining),payloadFn:p=>arbitrationPayload(p,reviews)});
  }
  record.arbitration={decision:arb.decision,valid:arb.valid===true,error:arb.error??null,request_id:arb.request_id??null,latency_ms:arb.latency_ms??null};
  const total=cost(gpt)+cost(arb)+(record.deepseek.cost_ceiling_usd??0);
  if(arb.valid===true){record.final='ARBITRATION';return {...arb,dual:record,api_cost_usd:total};}
  // Unresolved: a BUY without consensus places no order; a GPT SKIP/ABSTAIN stands.
  record.final=gpt.decision==='BUY'?'UNRESOLVED_NO_ENTRY':'GPT';
  return gpt.decision==='BUY'?{...gpt,valid:false,decision:'ABSTAIN',answer:null,error:'DUAL_UNRESOLVED_DISAGREEMENT',dual:record,api_cost_usd:total}
    :{...gpt,dual:record,api_cost_usd:total};
}
