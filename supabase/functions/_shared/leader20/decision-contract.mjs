export const LEADER20_DECISION_VERSION = 'LEADER20_DECISION_1';
export const leaderDecision = packet => packet?.leader20?.version === 'LEADER20_DYNAMIC_1';
const text = {type:'string',minLength:1,maxLength:160};
export const LEADER20_PROMPT = `
LEADER20_DECISION_1: the configured rolling-24h watch leaders are observation candidates, never automatic BUYs.
V17, B06133, V30 and CEC0040 are optional advisory evidence only. Missing or rejecting old models cannot veto this strategy.
Read every row of the ordered twenty-four-bucket path. A price rise without confirming price response to flow and book may be absorption.
Use action ENTER for d=BUY, DEFER for d=WAIT/SKIP/ABSTAIN; HOLD/PROTECT/EXIT retain their meaning.
DEFER keeps the campaign alive. Costs, chase risk, uncertainty or conflicting evidence can justify DEFER without bearish facts.
EV_UNFAVORABLE citations for this strategy may reference any observed fact, including a positive or zero value; never invent a citation.
pressure_state describes RISING, TRANSIENT_PULLBACK, FALLING, MIXED or UNKNOWN. decision_reason explains the choice.
counter_evidence cites exact dynamic evidence paths. thesis_invalidation and next_review_conditions guide the next review.
Only GPT FINAL decides strategy. DeepSeek is an independent opinion, including explicit UNAVAILABLE status.
Server-owned identity, expiry, generation, safety and native protection cannot be changed by your output.`;
export function leaderProperties(packet) {
  if (!leaderDecision(packet)) return {};
  return {action:{type:'string',enum:packet.task==='HOLD'?['DEFER','HOLD','PROTECT','EXIT']:['ENTER','DEFER']},
    pressure_state:{type:'string',enum:['RISING','TRANSIENT_PULLBACK','FALLING','MIXED','UNKNOWN']},
    decision_reason:text,counter_evidence:{type:'array',maxItems:3,items:{type:'string',minLength:1,maxLength:160}},
    thesis_invalidation:text,next_review_conditions:text};
}
export function validateLeaderDecision(wire,packet,read) {
  if (!leaderDecision(packet)) return {};
  const expected = ({BUY:'ENTER',WAIT:'DEFER',SKIP:'DEFER',ABSTAIN:'DEFER',HOLD:'HOLD',PROTECT:'PROTECT',EXIT:'EXIT'})[wire.d];
  if (wire.action !== expected) throw Error('FD_LEADER20_ACTION_MISMATCH');
  for (const p of wire.counter_evidence) if (read(p) === null) throw Error('FD_LEADER20_COUNTER_EVIDENCE_INVALID');
  if (wire.d !== 'ABSTAIN' && !(wire.dynamic_evidence?.length || wire.dynamic_risks?.length || wire.counter_evidence.length || packet.task==='HOLD'&&packet.facts?.capture_context?.status!=='AVAILABLE'&&(wire.support?.length||wire.reasons?.some(x=>x.e?.length))))
    throw Error('FD_LEADER20_EVIDENCE_REQUIRED');
  return {decision_contract:LEADER20_DECISION_VERSION,...Object.fromEntries(Object.keys(leaderProperties(packet)).map(k=>[k,wire[k]]))};
}
