/** Entry lifecycle terminal accounting (2026-09-25). Pure: no DB, exchange, GPT or clock.
 *
 * Every V17 candidate that reaches the entry queue ends in exactly one terminal class. The
 * existing reject_reason strings are kept (dashboards and the missed-opportunity journal
 * match on them); the class is derived from them, and the few paths that used to end with
 * no reason at all now write one:
 *  - a GPT BUY whose 60 s trigger window closed untried (ONDO/BROCCOLI/PLUME/CHIP/TRB on
 *    2026-09-24) used to sit TRIGGERED until the 15 min setup TTL and was then mislabeled
 *    V17_SETUP_EXPIRED;
 *  - a claimed candidate refused for a full book of slots or an open duplicate stayed
 *    CLAIMED with no reason;
 *  - rows that dropped out of the queue's look-back stayed NEW forever.
 * A TRIGGERED setup never re-arms (leader-pullback-reaccel.mjs), and GPT refuses a trigger
 * inside its execution reserve, so retiring it once its window has closed changes no
 * entry: it only names why there was none. */
export const ENTRY_LIFECYCLE_VERSION='ENTRY_LIFECYCLE_1';
export const TERMINAL_CLASS=Object.freeze({
  FILLED:'FILLED',PARTIAL_FILLED:'PARTIAL_FILLED',GPT_REJECTED:'GPT_REJECTED',EXECUTION_REJECTED:'EXECUTION_REJECTED',
  IOC_NO_FILL:'IOC_NO_FILL',SLOT_UNAVAILABLE:'SLOT_UNAVAILABLE',STALE:'STALE',ERROR:'ERROR',
  // Not an execution path: the V17 / V30 / B06133 front refused the candidate before GPT.
  STRATEGY_REJECTED:'STRATEGY_REJECTED'});
const C=TERMINAL_CLASS;
/** First match wins. Mirrored exactly by public.entry_terminal_class() (migration
 * 20260925090000); a parity test pins the two together. */
export const TERMINAL_RULES=Object.freeze([
  [C.PARTIAL_FILLED,'^PARTIAL_FILL'],
  [C.IOC_NO_FILL,'^(IOC_NO_FILL|IOC_RETRY_EXHAUSTED)'],
  [C.SLOT_UNAVAILABLE,'^(SLOT_UNAVAILABLE|V11_SLOT_FULL|DUPLICATE_SYMBOL_OPEN|PORTFOLIO_CHANGED|V17_SETUP_POLICY_SLOT_LIMIT|ENTRY_MARGIN_INSUFFICIENT|EXECUTION_SAFETY_REJECT:INSUFFICIENT_MARGIN|MAX_SLOTS_REACHED|INSUFFICIENT_MARGIN|PENDING_CAPITAL_RESERVED)'],
  [C.GPT_REJECTED,'^(GPT_REJECTED|GPT_SKIP|GPT_ABSTAIN|GPT_TIMEOUT|GPT_FINAL_RECHECK_(SKIP|ABSTAIN)|GPT_NO_VALID_API_RESPONSE)'],
  [C.STRATEGY_REJECTED,'^(V17_SETUP_EXPIRED|V17_CHASE_EXPIRED|V30_FRONT_REJECT|B06133_TRIGGER_REQUIRED|B06133_MARKET_UNAVAILABLE|V17_SETUP_INVALID|V17_SETUP_NOT_TRIGGERED|WRONG_STRATEGY)'],
  [C.STALE,'^(STALE|GPT_BUY_NOT_EXECUTED|GPT_REVIEW_EXPIRED|GPT_STALE_OR_FUTURE_REVIEW|GPT_REVIEW_PENDING|GPT_TRIGGER_EXPIRED|V17_TRIGGER_STALE|V17_TRIGGER_FUTURE|E1_DISPATCH_QUOTE_AGED|ENTRY_ATTEMPTS_EXHAUSTED|ENTRY_RUN_BUDGET_EXHAUSTED|V17_SETUP_BUDGET_EXHAUSTED|SIGNAL_STALE_OR_FUTURE|ENTRY_PER_RUN_LIMIT|IOC_RETRY_AUTHORITY|SUPERSEDED_BY_FRESHER_SIGNAL|EXECUTION_SAFETY_REJECT:(CYCLE_BUDGET_RESERVE|ENTRY_RUN_BUDGET_EXHAUSTED))'],
  [C.ERROR,'^(ERROR|ACCOUNT_SAFETY_BLOCK|GPT_REVIEW_STORAGE|GPT_CONTROL_UNREADABLE|GPT_REVIEW_NOT_|GPT_NOT_ENFORCING|GPT_API_BUDGET|GPT_BINDING_MISMATCH|GPT_SNAPSHOT_|V17_CONTROLS_UNAVAILABLE|V17_RUNTIME_BLOCKED|V17_ENTRY_KILL_SWITCH|V17_OPERATOR_CUTOVER|V17_MARGIN_CONFIG|SIZING_CONTRACT_STALE|B06133_SELECTION_INVALID|V30_SELECTION_INVALID|CEC0040_(SELECTION|INPUT)_INVALID|CEC0040_DECISION|CEC0040_WRITE|B06133_WRITE|SETUP_WRITE|CLAIM:|ORDER_INTENT|ENTRY_AVAILABLE_BALANCE_UNREADABLE|.*_WRITE$)'],
  [C.EXECUTION_REJECTED,'.'],
]);
const RULE_RE=TERMINAL_RULES.map(([cls,src])=>[cls,new RegExp(src)]);
/** @param filled a position exists for the signal; @param partial it holds less than its target. */
export function terminalClassOf(reason,{filled=false,partial=false}={}){
  if(filled)return partial?C.PARTIAL_FILLED:C.FILLED;
  const r=String(reason??'');
  if(!r)return C.STALE;
  for(const [cls,re] of RULE_RE)if(re.test(r))return cls;
  return C.EXECUTION_REJECTED;
}
const clip=x=>String(x??'').slice(0,500);
/** The last execution-path outcome of a candidate that is still NEW, stored on the signal
 * row (features.entryLifecycle) so the eventual terminal reason can name it. */
export function lifecycleNote({at,stage,reason,gptDecision=null}){
  return {version:ENTRY_LIFECYCLE_VERSION,at:Number.isSafeInteger(at)?at:null,stage:String(stage??'UNKNOWN').slice(0,40),
    reason:clip(reason).slice(0,200),gptDecision:['BUY','SKIP','ABSTAIN'].includes(gptDecision)?gptDecision:null};
}
/** Only rewrite when the recorded outcome changes (bounded writes per candidate). */
export function noteChanged(prev,next){
  return !prev||prev.stage!==next.stage||prev.reason!==next.reason||prev.gptDecision!==next.gptDecision;
}
/** Signal status machine (R181, 2026-09-26). NEW/CLAIMED/ORDERED are active; REJECTED, FILLED
 * and CLOSED are terminal, and FILLED -> CLOSED is the only move out of a terminal state. Every
 * REJECTED write is a compare-and-set on SIGNAL_ACTIVE, so no later worker, retry or settlement
 * can overwrite a terminal row (a FILLED signal that owns a position can never become REJECTED). */
export const SIGNAL_ACTIVE=Object.freeze(['NEW','CLAIMED','ORDERED']);
export const SIGNAL_TERMINAL=Object.freeze(['REJECTED','FILLED','CLOSED']);
const SIGNAL_MOVES=Object.freeze({NEW:['CLAIMED','REJECTED'],CLAIMED:['NEW','ORDERED','FILLED','CLOSED','REJECTED'],
  ORDERED:['FILLED','CLOSED','REJECTED'],FILLED:['CLOSED'],CLOSED:[],REJECTED:[]});
export function signalTransitionAllowed(from,to){return from===to?SIGNAL_ACTIVE.includes(from):(SIGNAL_MOVES[from]??[]).includes(to);}
/** Where a stored GPT result came from. Only GPT_VALID is a GPT judgment about the market;
 * every other source is a failure that was mapped to ABSTAIN (no order) and must never be
 * counted as "GPT looked and abstained" (R181: HTTP_429 quota failures were). */
export const GPT_DECISION_SOURCE=Object.freeze({GPT_VALID:'GPT_VALID',PROVIDER_ERROR:'PROVIDER_ERROR',TIMEOUT:'TIMEOUT',
  PARSE_ERROR:'PARSE_ERROR',SAFETY_FALLBACK:'SAFETY_FALLBACK',SYSTEM_ABORT:'SYSTEM_ABORT'});
const S=GPT_DECISION_SOURCE;
export function gptDecisionSource(result){
  if(result?.valid===true&&(result.origin===undefined||result.origin==='OPENAI_API'))return S.GPT_VALID;
  const e=String(result?.error??'');
  if(e==='API_TIMEOUT')return S.TIMEOUT;
  if(result?.origin==='LOCAL_DATA_ERROR'||/^(REVIEW_PREPARATION_FAILED|COUNTER_PREPARATION_FAILED|HISTORY_INVALID)$/.test(e))return S.SYSTEM_ABORT;
  if(/^HTTP_\d+$/.test(e)||/^FD_(API_KEY_MISSING|API_OR_VALIDATION_ERROR|API_INCOMPLETE|MODEL_MISMATCH)$/.test(e))return S.PROVIDER_ERROR;
  if(/^FD_(RESPONSE_NOT_JSON|RESPONSE_TOO_LARGE|API_OUTPUT_COUNT|UNEXPECTED_TOOL)$/.test(e)||/^(TYPE|ENUM|STRING|REQUIRED|EXTRA|ARRAY):/.test(e))return S.PARSE_ERROR;
  return S.SAFETY_FALLBACK;
}
/** Terminal reason for an answer that is not a valid GPT judgment. Keeps the GPT_REJECTED terminal
 * class (public.entry_terminal_class matches ^GPT_TIMEOUT / ^GPT_NO_VALID_API_RESPONSE) while the
 * reason names the source, so a provider failure never reads as a GPT ABSTAIN. */
function failedAnswerReason(error){
  const e=String(error??''),src=gptDecisionSource({valid:false,error:e});
  return src===S.TIMEOUT?'GPT_TIMEOUT':clip(`GPT_NO_VALID_API_RESPONSE:${src}`+(e?':'+e.slice(0,60):''));
}
/** Terminal reason for a GPT review that can never become an entry for this trigger: a
 * valid SKIP or ABSTAIN, or a failed answer (the coordinator never re-asks one identity).
 * Anything transient (pending, not configured, budget, storage, aged) returns null. */
export function gptTerminalReason(review){
  const reason=String(review?.reason??''),decision=review?.decision,detail=String(review?.detail??'').slice(0,160);
  if(review?.allowed===true)return null;
  if(/^GPT_SKIP(_AGED)?$/.test(reason)&&decision==='SKIP')return clip('GPT_SKIP'+(detail?':'+detail:''));
  if(/^GPT_ABSTAIN(_AGED)?$/.test(reason)&&decision==='ABSTAIN')return clip('GPT_ABSTAIN'+(detail?':'+detail:''));
  if(reason==='GPT_NO_VALID_API_RESPONSE')return failedAnswerReason(review?.error);
  return null;
}
/** The same terminal reason, read straight from a DURABLE initial-entry review record instead of
 * from a live consider() call. Used where the cycle that asked GPT is no longer the one looking at
 * the signal: the coordinator's completion hook and the lifecycle sweep (JELLYJELLYUSDT
 * 2026-09-26 09:06:09: a valid SKIP landed after its cycle, the signal stayed NEW, and the sweep
 * then retired it as STALE:GPT_REVIEW_PENDING). Returns null for a BUY, an unfinished record, or
 * a record not bound to exactly this signal and trigger (a stale answer never labels another row).
 * Label only: nothing here can admit, price or order. */
export function storedTerminalReason(record,{signalId,triggerAtMs=null}={}){
  const r=record&&typeof record==='object'?record:null,z=r?.result;
  if(!r||!z||typeof z!=='object')return null;
  if(r.purpose!=='PRODUCTION'||r.kind!==undefined&&r.kind!==null)return null;
  if(String(r.identity?.signal_id??'')!==String(signalId??'')||!signalId)return null;
  if(triggerAtMs!==null&&Number(r.identity?.trigger_at_ms)!==Number(triggerAtMs))return null;
  if(gptDecisionSource(z)!==S.GPT_VALID)return failedAnswerReason(z.error);
  const a=z.answer??{},decision=a.decision??z.decision;
  if(decision==='SKIP')return gptTerminalReason({reason:'GPT_SKIP',decision,detail:(a.reasons??[]).map(x=>x?.category).filter(Boolean).join(',')});
  if(decision==='ABSTAIN')return gptTerminalReason({reason:'GPT_ABSTAIN',decision,detail:String(a.abstain_reason??'')});
  return null;
}
/** Reason for a TRIGGERED setup whose execution window has closed without an order. The
 * last recorded outcome decides the class; with none, the window simply ran out. */
export function expiredTriggerReason(note){
  const n=note&&typeof note==='object'?note:null,last=String(n?.reason??'');
  if(!last)return 'STALE:TRIGGER_WINDOW_CLOSED';
  const cls=terminalClassOf(last);
  const buy=n?.gptDecision==='BUY'?'GPT_BUY_NOT_EXECUTED:':'';
  if(cls===C.SLOT_UNAVAILABLE)return clip(`SLOT_UNAVAILABLE:${buy}${last}`);
  if(cls===C.GPT_REJECTED)return clip(last);
  if(cls===C.EXECUTION_REJECTED)return clip(`EXECUTION_REJECTED:${buy}${last}`);
  if(cls===C.ERROR)return clip(`ERROR:${buy}${last}`);
  return clip(`STALE:${buy}${last}`);
}
/** Reason for a NEW row that fell out of the queue's look-back (entry_bar_at older than
 * SIGNAL_MAX) without ever being concluded. */
export function agedOutReason(setupState,note){
  if(setupState==='TRIGGERED')return expiredTriggerReason(note);
  if(setupState==='ARMED'||setupState==='PULLBACK_OBSERVED')return 'V17_SETUP_EXPIRED:AGED_OUT_UNCONCLUDED';
  return 'STALE:SIGNAL_AGED_OUT';
}
