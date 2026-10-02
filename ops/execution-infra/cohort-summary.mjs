const STAGES=['dispatch_persisted','executor_claimed','validation_pass','submit_attempted',
  'exchange_acknowledged','partial_or_filled','position_attributed','protection_installed'];
const ratio=(n,total)=>total?Number((n*100/total).toFixed(2)):null;
const invalid=()=>{throw Error('COHORT_EVIDENCE_INVALID');};
/** Summarize one query snapshot. Counts never borrow another window's denominator.
 * Missing upstream evidence remains visible even when downstream trading succeeded.
 */
export function summarizeCohort(rows) {
  if(!Array.isArray(rows))invalid();
  if(!rows.length)return {status:'NO_COHORT_ROWS',success_rate:null,periods:{}};
  const periods={},seen=new Set();let cutoff;
  for(const row of rows){
    if(!['24h','7d'].includes(row.period)||typeof row.decision_id!=='string'||
      typeof row.reason!=='string'||typeof row.outcome_class!=='string')invalid();
    const end=new Date(row.utc_cutoff).toISOString(),start=new Date(row.utc_start).toISOString();
    if(cutoff&&cutoff!==end)invalid();cutoff=end;
    const key=JSON.stringify([row.period,row.decision_id]);if(seen.has(key))invalid();seen.add(key);
    const p=periods[row.period]??={utc_start:start,utc_cutoff:end,kst_start:row.kst_start,kst_cutoff:row.kst_cutoff,
      final_buy:0,stages:Object.fromEntries(STAGES.map(s=>[s,0])),reasons:{},outcomes:{},evidence_gaps:{}};
    if(p.utc_start!==start)invalid();p.final_buy++;
    for(const s of STAGES){if(typeof row[s]!=='boolean')invalid();if(row[s])p.stages[s]++;}
    p.reasons[row.reason]=(p.reasons[row.reason]??0)+1;
    p.outcomes[row.outcome_class]=(p.outcomes[row.outcome_class]??0)+1;
    for(let i=1;i<STAGES.length;i++)if(row[STAGES[i]]&&!row[STAGES[i-1]]){
      const gap=STAGES[i]+'_WITHOUT_'+STAGES[i-1];p.evidence_gaps[gap]=(p.evidence_gaps[gap]??0)+1;
    }
  }
  for(const p of Object.values(periods)){
    p.reason_percent=Object.fromEntries(Object.entries(p.reasons).map(([key,count])=>[key,ratio(count,p.final_buy)]));
    p.outcome_percent=Object.fromEntries(Object.entries(p.outcomes).map(([key,count])=>[key,ratio(count,p.final_buy)]));
    p.system_failure_or_unresolved_rate=ratio(p.outcomes.SYSTEM_FAILURE_OR_UNRESOLVED??0,p.final_buy);
    p.unclassified_rate=ratio(p.outcomes.UNCLASSIFIED??0,p.final_buy);
  }
  return {status:'OBSERVED_QUERY_SNAPSHOT',periods};
}
