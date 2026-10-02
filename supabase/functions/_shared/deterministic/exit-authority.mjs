/** Exchange-resident protection and fresh deterministic thesis are the only exit authorities. */
import {ENGINE,decidePosition} from './market-state.mjs';
export const EXIT_AUTHORITY_VERSION=ENGINE;
export const EXIT_CLASS=Object.freeze({HARD_SAFETY:'HARD_SAFETY',SOFT_PROTECTION:'SOFT_PROTECTION',DETERMINISTIC:'DETERMINISTIC'});
export function exitClass(reason){
 if(['V17_NATIVE_STOP','NATIVE_HARD_STOP','DETERMINISTIC_RESIDENT_STOP','R5_RISK_CUT','V17_HARD_STOP'].includes(reason))return EXIT_CLASS.HARD_SAFETY;
 if(reason==='DETERMINISTIC_PROFIT_PROTECTION')return EXIT_CLASS.SOFT_PROTECTION;
 if(reason==='DETERMINISTIC_THESIS_FAILURE')return EXIT_CLASS.DETERMINISTIC;
 throw Error('UNCLASSIFIED_EXIT_REASON:'+reason);
}
export const positionGeneration=p=>String(p.id)+':'+String(p.entry_at);
export function hardSafetyState(p,{bid,now,peak,policy,priceTick=0}){
 const entry=Number(p.entry_price),initialFloor=priceTick>0?Math.ceil(entry*(1-policy.stopPct)/priceTick-1e-10)*priceTick:entry*(1-policy.stopPct),old=p.metadata?.exitAuthority;
 if(![entry,bid,now,peak,initialFloor].every(Number.isFinite)||entry<=0||bid<=0||Date.parse(p.entry_at)>now||peak<entry)throw Error('INVALID_POSITION_STATE');
 const native=(p.metadata?.exitProtection?.orders??[]).filter(o=>!o.terminal&&o.exitClass===EXIT_CLASS.HARD_SAFETY).map(o=>Number(o.spec?.params?.triggerPrice)).filter(Number.isFinite);
 const carried=Number(p.hard_stop_price),hardFloor=Math.max(initialFloor,Number(old?.hardFloor)||0,carried>0&&carried<entry?carried:0,...native);
 return {version:ENGINE,generation:positionGeneration(p),initialFloor:old?.initialFloor??initialFloor,hardFloor,hardReason:hardFloor>initialFloor+entry*1e-10?'R5_RISK_CUT':'NATIVE_HARD_STOP',
  hardHit:bid<=hardFloor,peak,mfe:peak/entry-1,mae:Math.min(Number(old?.mae)||0,bid/entry-1),lowestObservedBid:Math.min(Number(old?.lowestObservedBid)||entry,bid)};
}
export function approvedProtection(p,hard,bid,{residentLevel=0,candidate=null}={}){
 const old=p.metadata?.exitAuthority,level=Math.max(hard.hardFloor,Number(p.hard_stop_price)||0,Number(residentLevel)||0,
  Number(old?.approvedSoftLevel)||0,Number(old?.residentLevel)||0,Number(candidate)||0);
 return {active:true,level,crossed:bid<=level,reason:level>hard.hardFloor?'DETERMINISTIC_PROFIT_PROTECTION':hard.hardReason,
  exitClass:level>hard.hardFloor?EXIT_CLASS.SOFT_PROTECTION:EXIT_CLASS.HARD_SAFETY};
}
// Resident orders are carried, never retired merely because ownership changed.
export const legacySoftOrders=()=>[];
export function assertExitAuthority(reason,p,proof,at=Date.now()){
 const kind=exitClass(reason);if(kind===EXIT_CLASS.HARD_SAFETY)return kind;
 if(proof?.authority!==ENGINE||proof.positionId!==String(p.id)||proof.generation!==positionGeneration(p)||!Number.isSafeInteger(proof.at)||proof.at>at||at-proof.at>5000)throw Error('DETERMINISTIC_EXIT_PROOF_REQUIRED');
 const result=decidePosition({...proof.input,position:p,at});
 if(result.action!=='EXIT'||result.reason!==reason)throw Error('DETERMINISTIC_EXIT_THESIS_CHANGED');return kind;
}
