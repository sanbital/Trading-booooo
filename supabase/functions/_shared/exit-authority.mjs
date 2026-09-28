import {emergencyProtection} from './gpt-final-decision/emergency-protection.mjs';
/** Explicit economic authority. Policy calculators remain evidence generators. No IO. */
export const EXIT_AUTHORITY_VERSION='AI_EXIT_AUTHORITY_2';
/** Protection arbitration: the deterministic engine proposes a protection level, the AI
 *  reviewer approves it. Hard safety is unchanged and still executes without any model. */
export const PROTECTION_ARBITRATION_VERSION='AI_PROTECTION_ARBITRATION_1';
/** The only actions the reviewer may take on an open position's protection. */
export const PROTECTION_ACTIONS=Object.freeze(['HOLD','RAISE_PROTECTION','EXIT']);
/** RAISE_PROTECTION as it is named in the existing FD1 HOLD decision contract. */
export const RAISE_PROTECTION_DECISION='PROTECT';
export const EXIT_CLASS=Object.freeze({HARD_SAFETY:'HARD_SAFETY',SOFT_PROTECTION:'SOFT_PROTECTION',AI_STRATEGIC:'AI_STRATEGIC',EMERGENCY_PROTECTION:'EMERGENCY_PROTECTION'});
const H=EXIT_CLASS.HARD_SAFETY,S=EXIT_CLASS.SOFT_PROTECTION,A=EXIT_CLASS.AI_STRATEGIC;
export const EXIT_REASONS=Object.freeze({
 NATIVE_HARD_STOP:H,V17_HARD_STOP:H,R5_RISK_CUT:H,V17_RISK_CUT:H,RISK_CUT:H,V17_NATIVE_STOP:H,
 LIQUIDATION_SAFETY:H,ACCOUNT_RISK_VIOLATION:H,RECONCILIATION_CORRUPTION:H,
 INVALID_POSITION_STATE:H,EXCHANGE_CRITICAL_FAILURE:H,OPERATOR_EMERGENCY:H,ACCOUNT_CIRCUIT_BREAKER:H,
 V21_POST_FILL_ENTRY_INPUT_INVALID:H,BULL_HARD_STOP:H,BULL_30D_SAFETY_DEADLINE:H,
 retestAnchor_TRAIL:S,retestAnchor_LOCK:S,rangeFloor_SUPPORT:S,pivotFloor_SUPPORT:S,
 P142_LOCK:S,TRAILING:S,PROFIT_LOCK:S,V17_TRAILING_STOP:S,V17_RATCHET_STOP:S,
 V17_PROFIT_LOCK:S,V17_COST_BREAKEVEN:S,V17_MOMENTUM_STALE:S,V17_MAX_HOLD:S,
 QV3_TWO_BEARISH_CLOSED:S,BULL_TRAIL_PROTECTION:S,BULL_T1:S,
 REGIME_BULL_TO_RANGE_REALIZE:S,REGIME_BULL_TO_BEAR_REALIZE:S,AI_PROTECT_LEVEL:S,
 FD1_GPT_EXIT:A,FD1_DEEPSEEK_EXIT:A,THESIS_REVIEW_PROTECTION:S,EMERGENCY_THESIS_PROTECTION:S,EMERGENCY_EXIT_THESIS_FAILURE:EXIT_CLASS.EMERGENCY_PROTECTION,
});
export function exitClass(reason){if(!Object.hasOwn(EXIT_REASONS,reason))throw Error('UNCLASSIFIED_EXIT_REASON:'+reason);return EXIT_REASONS[reason];}
const finite=x=>Number.isFinite(Number(x)),ceil=(x,t)=>t>0?Math.ceil(x/t-1e-10)*t:x;
export function positionGeneration(p){return String(p.id)+':'+String(p.entry_at??p.entryAt);}
export function hardSafetyState(p,{bid,now,peak,policy,r5=false,priceTick=0}){
 const meta=p.metadata??{},old=meta.exitAuthority,entry=Number(p.entry_price),entryAt=Date.parse(p.entry_at),generation=positionGeneration(p);
 if(![entry,entryAt,bid,now,peak,policy.stopPct].every(Number.isFinite)||entry<=0||bid<=0||entryAt>now||peak<entry)
   throw Error('INVALID_POSITION_STATE');
 if(old&&old.generation!==generation)throw Error('EXIT_GENERATION_MISMATCH');
 const initial=ceil(entry*(1-policy.stopPct),priceTick);
 // Loss floors never ratchet down. Legacy profit stops above entry are NOT loss floors.
 const carried=Number(p.hard_stop_price);
 const knownHard=(meta.exitProtection?.orders??[]).filter(o=>o.exitClass===H||Number(o.spec?.params?.triggerPrice)<entry).map(o=>Number(o.spec?.params?.triggerPrice)).filter(Number.isFinite);
 const prior=old?.hardFloor??(carried>0&&carried<entry?carried:initial);
 if(!(prior>0)||old&&old.initialFloor!==initial&&Math.abs(old.initialFloor-initial)>Math.max(priceTick,entry*1e-10))
   throw Error('INVALID_HARD_FLOOR');
 const riskArmed=r5&&((peak/entry-1+1e-12>=policy.riskCutArmPct)||(now-entryAt>=policy.failCutAfterMs));
 const risk=riskArmed?ceil(entry*(1-policy.riskCutLevelPct),priceTick):initial;
 const hardFloor=Math.max(initial,prior,risk,...knownHard);
 const lowest=old?.lowestObservedBid?Math.min(old.lowestObservedBid,bid):Math.min(entry,bid);
 return {version:EXIT_AUTHORITY_VERSION,generation,initialFloor:old?.initialFloor??initial,hardFloor,
   hardReason:hardFloor>initial+entry*1e-10?'R5_RISK_CUT':'NATIVE_HARD_STOP',
   lowestObservedBid:lowest,maeScope:old?.maeScope??(now-entryAt<10000?'SINCE_ENTRY':'SINCE_V2_ATTACH'),
   attachedAt:old?.attachedAt??now,peak,mae:lowest/entry-1,mfe:peak/entry-1,
   giveback:peak>entry?(peak-bid)/(peak-entry):0,drawdown:bid/peak-1,hardHit:bid<=hardFloor};
}
/** Deterministic protection CANDIDATE. A proposal only: it is review evidence and it never
 *  moves the resident stop or closes the position by itself. Monotonic, as before: the
 *  accepted candidate is max(previous, new) and is never widened. `approvedProtection` decides
 *  what is actually in force. */
export function softCandidate(raw,hard,p,bid){
 const old=p.metadata?.exitAuthority,entry=Number(p.entry_price);
 let level=raw.stopPrice>hard.hardFloor?raw.stopPrice:null,reason=null;
 if(level!==null){
   const stage=raw.protectionStage;
   reason=['retestAnchor_TRAIL','retestAnchor_LOCK','rangeFloor_SUPPORT','pivotFloor_SUPPORT'].includes(stage)?stage:
     stage==='PROFIT_LOCK'?'V17_PROFIT_LOCK':stage==='COST_BREAKEVEN'?'V17_COST_BREAKEVEN':'V17_TRAILING_STOP';
 }
 const legacy=Number(p.hard_stop_price);
 if(!old&&legacy>=entry&&legacy>(level??0)){level=legacy;reason=p.metadata?.p142State?.stage;
   if(!Object.hasOwn(EXIT_REASONS,reason)||EXIT_REASONS[reason]!==S)reason='V17_RATCHET_STOP';}
 if(old?.softLevel>(level??0)){level=old.softLevel;reason=old.softReason;}
 if(p.metadata?.fd1Hold?.protectLevel>(level??0)){level=p.metadata.fd1Hold.protectLevel;reason='AI_PROTECT_LEVEL';}
 const crossed=level!==null&&bid<=level;
 if(!crossed&&raw.action==='CLOSE'&&exitClass(raw.reason)===S)reason=raw.reason;
 const queued=p.metadata?.strategicExitCandidate;
 const active=crossed||raw.action==='CLOSE'&&exitClass(raw.reason)===S||queued?.generation===hard.generation;
 if(queued?.generation===hard.generation&&!crossed)reason=queued.reason;
 if(active)exitClass(reason); // unknown provenance cannot gain authority
 return {level,reason,active,crossed,key:active?reason+':'+String(level??'EVENT'):null,
   distance:level?bid/level-1:null,exitClass:S};
}
export function exitContext(p,hard,soft,bid,now,approved=null){
 const eps=Math.max(1e-12,Number(p.entry_price)*1e-10),candidate=Number(soft?.level),
   standing=Number(approved?.level);
 return {version:EXIT_AUTHORITY_VERSION,position_id:String(p.id),generation:hard.generation,
   snapshot_at_ms:now,entry_price:Number(p.entry_price),current_price:bid,hard_floor:hard.hardFloor,
   initial_floor:hard.initialFloor,hard_hit:hard.hardHit,soft_trigger:soft,peak:hard.peak,
   mfe:hard.mfe,mae:hard.mae,mae_scope:hard.maeScope,mfe_giveback:hard.giveback,drawdown:hard.drawdown,
   // Protection arbitration. The deterministic engine only proposes; every raise of the
   // resident soft stop, and every strategic exit, is the reviewer's decision.
   protection:{arbitration:PROTECTION_ARBITRATION_VERSION,
     approved_soft_stop:Number.isFinite(standing)&&standing>0?standing:null,
     approved_soft_reason:approved?.reason??null,approved_soft_source:approved?.source??null,
     approved_crossed:approved?.crossed===true,
     candidate_soft_stop:Number.isFinite(candidate)&&candidate>0?candidate:null,
     candidate_reason:soft?.reason??null,candidate_crossed:soft?.crossed===true,
     candidate_above_approved:Number.isFinite(candidate)&&candidate>(Number.isFinite(standing)?standing:0)+eps,
     actions:PROTECTION_ACTIONS,
     raise_binds_to:'EXACTLY_THE_OFFERED_CANDIDATE_SOFT_STOP_NEVER_A_MODEL_SUPPLIED_PRICE',
     lowering_possible:false,on_reviewer_failure:'KEEP_LAST_APPROVED_PROTECTION',
     hard_floor_independent_of_reviewer:true},
   authority:'HARD_IMMEDIATE;SOFT_REQUIRES_GPT_FINAL',exposure_increase_allowed:false};
}
/** Resident soft protection actually in force. Append-only, monotonic and AI-authorized:
 *  the level that binds is max(everything this position ever had approved, the level the
 *  exchange already acknowledges, this tick's reviewer approval). A deterministic candidate
 *  by itself NEVER appears here; the same P142_STOP_WIDENED invariant is extended to it, so a
 *  request below the standing level is ignored and reported instead of applied.
 *  A reviewer failure yields no approval, which keeps exactly the last approved level. */
export function approvedProtection(p,hard,bid,{aiApproved=null,aiReason=null,residentLevel=0,candidate=null}={}){
 const meta=p.metadata??{},old=meta.exitAuthority,entry=Number(p.entry_price),
   eps=Math.max(1e-12,entry*1e-10),hardFloor=Number(hard.hardFloor);
 let level=0,reason=null,source=null;
 const take=(value,r,s)=>{const v=Number(value);if(!(Number.isFinite(v)&&v>level+eps))return;
   level=v;source=s;reason=Object.hasOwn(EXIT_REASONS,r)&&EXIT_REASONS[r]===S?r:'V17_RATCHET_STOP';};
 // 1. Anything this position ever had approved stays approved.
 take(old?.approvedSoftLevel,old?.approvedSoftReason,'APPROVED_CARRIED');
 // 2. Protection the position already carries from before arbitration existed: the level this
 //    executor last made resident and the level the exchange currently acknowledges. Dropping
 //    either would lower live protection, so both are grandfathered as approved.
 take(old?.residentLevel,old?.residentReason,'PRE_ARBITRATION_RESIDENT');
 take(residentLevel,old?.residentReason??old?.softReason,'EXCHANGE_ACKNOWLEDGED');
 if(!old&&Number(p.hard_stop_price)>=entry)take(p.hard_stop_price,meta.p142State?.stage,'LEGACY_PROFIT_STOP');
 const standing=level,requested=Number(aiApproved);
 // 3. This tick's reviewer approval. It may only ever raise.
 take(aiApproved,aiReason,aiReason==='EMERGENCY_THESIS_PROTECTION'?'DETERMINISTIC_EMERGENCY':'AI_APPROVED');
 const ignoredRequest=Number.isFinite(requested)&&requested>0&&!['AI_APPROVED','DETERMINISTIC_EMERGENCY'].includes(source)?
   {requestedLevel:requested,requestedReason:aiReason??null,standingLevel:standing||null,
    verdict:requested<standing-eps?'BELOW_APPROVED_IGNORED':'EQUAL_TO_APPROVED_NO_OP'}:null;
 const candidateLevel=Number(candidate)>0?Number(candidate):null;
 const base={exitClass:EXIT_CLASS.SOFT_PROTECTION,candidateLevel,ignoredRequest,
   candidateAboveApproved:candidateLevel!==null&&candidateLevel>level+eps,
   raised:['AI_APPROVED','DETERMINISTIC_EMERGENCY'].includes(source)&&level>Math.max(standing,hardFloor)+eps};
 // Below the hard floor there is nothing to add: hard safety already protects that level.
 if(!(level>hardFloor+eps))
   return {...base,level:null,reason:null,source:null,active:false,crossed:false,key:null,
     distance:null,coveredByHardFloor:true,standingLevel:standing||null};
 return {...base,level,reason,source,active:true,crossed:Number(bid)<=level,
   key:reason+':'+String(level),distance:Number(bid)/level-1,coveredByHardFloor:false,
   standingLevel:standing||null};
}
/** Only pre-v2 profit protection may be replaced by a separately ACKed hard order. */
export function legacySoftOrders(p,hard){
 if(p.metadata?.exitAuthority?.version===EXIT_AUTHORITY_VERSION)return p.metadata.exitAuthority.legacySoftOrderIds??[];
 const version=p.metadata?.leaderExitPolicyVersion??'';
 if(!['P142_COMPLETED_PRICE_BRANCH_1','V17_EXIT_R5_TAIL'].includes(version))return [];
 return (p.metadata?.exitProtection?.orders??[]).filter(o=>!o.terminal&&o.exitClass!==H&&
   Number(o.spec?.params?.triggerPrice)>=Number(p.entry_price)&&Number(o.spec?.params?.triggerPrice)>hard.hardFloor).map(o=>o.clientId);
}
export function assertExitAuthority(reason,p,approval,now=Date.now()){
 const kind=exitClass(reason),generation=positionGeneration(p);
 if(kind===EXIT_CLASS.EMERGENCY_PROTECTION){
   if(approval?.authority!=='DETERMINISTIC_TECHNICAL_PROTECTION'||approval.valid!==true||approval.positionId!==String(p.id)||approval.generation!==generation||
      !Number.isSafeInteger(approval.observedAt)||approval.observedAt>now||now-approval.observedAt>5000||p.state!=='OPEN'||!(Number(p.remaining_quantity)>0))throw Error('EMERGENCY_PROOF_REQUIRED');
   if(approval.capture?.position_id&&approval.capture.position_id!==String(p.id)||!Number.isSafeInteger(approval.technicalFailure?.at)||approval.technicalFailure.at>now)throw Error('EMERGENCY_PROOF_INVALID');
   const check=emergencyProtection({...approval,now});
   if(check?.action!=='EMERGENCY_EXIT_THESIS_FAILURE'||check.level!==approval.level)throw Error('EMERGENCY_PROOF_INVALID');
   return kind;
 }
 if(kind===H)return kind;
 if(kind===S){
   if(approval?.authority!=='RESIDENT_PROTECTION'||approval?.valid!==true||
      approval.positionId!==String(p.id)||approval.generation!==generation||approval.reason!==reason||
      !finite(approval.level)||approval.level<=0||!Number.isSafeInteger(approval.observedAt)||
      approval.observedAt>now||now-approval.observedAt>5000)
     throw Error('SOFT_DIRECT_CLOSE_FORBIDDEN:'+reason);
   return kind;
 }
 if(reason==='FD1_DEEPSEEK_EXIT'){
   if(approval?.authority!=='DEEPSEEK_EMERGENCY_EXIT_ONLY'||approval?.decision!=='EXIT'||approval.valid!==true||
      approval.positionId!==String(p.id)||approval.generation!==generation||
      !/^[a-f0-9]{64}$/.test(String(approval.snapshotHash??''))||
      !Number.isSafeInteger(approval.completedAt)||approval.completedAt>now||now-approval.completedAt>25000||
      !Number.isSafeInteger(approval.snapshotAt)||approval.snapshotAt>now||now-approval.snapshotAt>25000)
     throw Error('FRESH_DEEPSEEK_EMERGENCY_EXIT_REQUIRED');
   return kind;
 }
 if(approval?.authority!=='GPT_FINAL_ONLY'||approval?.decision!=='EXIT'||approval.valid!==true||
   approval.positionId!==String(p.id)||approval.generation!==generation||!approval.jobKey||
   !Number.isSafeInteger(approval.completedAt)||approval.completedAt>now||now-approval.completedAt>25000||
   !Number.isSafeInteger(approval.snapshotAt)||approval.snapshotAt>now||now-approval.snapshotAt>25000||
   approval.refreshError)throw Error('FRESH_GPT_FINAL_EXIT_REQUIRED');
 return kind;
}

