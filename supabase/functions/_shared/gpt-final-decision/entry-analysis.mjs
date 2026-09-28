/** Initial campaign opinions never grant dispatch authority. Keep the complete frozen
 * path for both analysts and FINAL, then require a new, execution-fresh FINAL RECHECK. */
import {DYNAMIC_VERSION} from './dynamic-flow.mjs';
import {validClockFinalPacket} from '../leader20/clock-final.mjs';
export const ENTRY_ANALYSIS = Object.freeze({version:'LEADER_ENTRY_ANALYSIS_1',maxMs:30000,
  preliminaryMs:8000,finalMs:20000,minMs:15000,recheckReserveMs:15000});
export const isEntryAnalysis = packet => packet?.task==='ENTRY' && packet.dynamic_policy===DYNAMIC_VERSION &&
  packet.leader20?.version==='LEADER20_DYNAMIC_1';
export function entryAnalysisDeadline(packet,{now,executionDeadline,ordinaryDeadline}){
  if(!isEntryAnalysis(packet))return ordinaryDeadline;
  const deadline=Math.min(now+ENTRY_ANALYSIS.maxMs,executionDeadline-(validClockFinalPacket(packet,now)?0:ENTRY_ANALYSIS.recheckReserveMs));
  return deadline-now>=ENTRY_ANALYSIS.minMs?deadline:null;
}
