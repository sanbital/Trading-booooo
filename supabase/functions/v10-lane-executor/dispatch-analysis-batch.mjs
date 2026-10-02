/** Claim a bounded cohort before starting slow analysis. Each claimed dispatch uses
 * its own AsyncLocalStorage authority; only real mutations reacquire account writer.
 * Uncertain claims are never executed, and one failed analysis cannot cancel peers. */
export async function runDispatchAnalysisBatch({critical,claim,recover,execute,limit,signalId=null}){
 if(!Number.isInteger(limit)||limit<1||limit>10)throw Error('DISPATCH_BATCH_BOUND');
 const claimed=await critical(async()=>{
  if(!await recover())return {reason:'RECONCILIATION_FIRST_ENTRY_FROZEN',rows:[]};
  const rows=[];
  for(let i=0;i<(signalId?1:limit);i++){
   const result=await claim(signalId);
   if(result?.claimed!==true||!result.row)return {rows,reason:result?.reason??'NO_READY_EXECUTION'};
   rows.push(result);
  }
  return {rows};
 });
 if(claimed?.deferred||!claimed?.rows?.length)return {ok:true,skipped:claimed?.reason??'NO_READY_EXECUTION'};
 const outcomes=await Promise.allSettled(claimed.rows.map(execute));
 return {ok:outcomes.every(x=>x.status==='fulfilled'),executionDispatchBatch:outcomes.map((x,i)=>({
  signalId:claimed.rows[i].row.signal_id,...(x.status==='fulfilled'?{result:x.value}:{error:String(x.reason?.message??x.reason).slice(0,200)})}))};
}
