/** Explicit economic authority. Policy calculators remain evidence generators. No IO. */
export const EXIT_AUTHORITY_VERSION='AI_EXIT_AUTHORITY_2';
export const EXIT_CLASS=Object.freeze({HARD_SAFETY:'HARD_SAFETY',SOFT_PROTECTION:'SOFT_PROTECTION',AI_STRATEGIC:'AI_STRATEGIC'});
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
 FD1_GPT_EXIT:A,
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
export function exitContext(p,hard,soft,bid,now){
 return {version:EXIT_AUTHORITY_VERSION,position_id:String(p.id),generation:hard.generation,
   snapshot_at_ms:now,entry_price:Number(p.entry_price),current_price:bid,hard_floor:hard.hardFloor,
   initial_floor:hard.initialFloor,hard_hit:hard.hardHit,soft_trigger:soft,peak:hard.peak,
   mfe:hard.mfe,mae:hard.mae,mae_scope:hard.maeScope,mfe_giveback:hard.giveback,drawdown:hard.drawdown,
   authority:'HARD_IMMEDIATE;SOFT_REQUIRES_GPT_FINAL',exposure_increase_allowed:false};
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
 const kind=exitClass(reason);
 if(kind===H)return kind;
 if(kind===S)throw Error('SOFT_DIRECT_CLOSE_FORBIDDEN:'+reason);
 if(approval?.authority!=='GPT_FINAL_ONLY'||approval?.decision!=='EXIT'||approval.valid!==true||
   approval.positionId!==String(p.id)||approval.generation!==positionGeneration(p)||!approval.jobKey||
   !Number.isSafeInteger(approval.completedAt)||approval.completedAt>now||now-approval.completedAt>25000||
   !Number.isSafeInteger(approval.snapshotAt)||approval.snapshotAt>now||now-approval.snapshotAt>25000||
   approval.refreshError)throw Error('FRESH_GPT_FINAL_EXIT_REQUIRED');
 return kind;
}

