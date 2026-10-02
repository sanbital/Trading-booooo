import {portfolioMatches} from './leader-momentum-v17.mjs';
/** Called only AFTER a real entry has been durably recorded by the host.
 * Never dispatches an entry or reclassifies an acknowledged fill as a failed entry.
 * Dependencies are the host's existing read and position-management functions.
 */
export async function protectNewLeaderPosition({enabled,position,manualSymbols=[],readPortfolio,installNative=null,manage,clock=Date.now}){
  if(!enabled)return {status:'DISABLED'};
  const startedAt=clock();let initial=null;
  try{
    if(manualSymbols.includes(position.symbol))throw Error('MANUAL_SYMBOL_CONFLICT');
    const pf=await readPortfolio();
    if(!Array.isArray(pf?.positions)||pf.positions_complete===false)throw Error('INCOMPLETE_PORTFOLIO');
    const rows=pf.positions.filter(x=>String(x.market??x.symbol??'').toUpperCase()===position.symbol);
    const match=portfolioMatches([position],{positions:rows});
    if(!match.ok)throw Error(`ENTRY_PROTECTION_OWNERSHIP:${match.reason}`);
    // Market data reads can stall. Install the existing hard protection first.
    // The host returns the fresh CAS snapshot; never give the manager a pre-install row.
    if(installNative){
      try{initial=await installNative(position,{manualSymbols});}
      catch(error){
        if(/LEASE|FENCED/.test(String(error?.message??error)))throw error;
        // Preserve the existing immediate software management fallback.
        initial={status:'INSTALL_FAILED',error:String(error?.message??error)};
      }
      if(initial?.position)position=initial.position;
      if(position.state==='CLOSED')return {status:'CLOSED',startedAt,finishedAt:clock(),softwareMonitorRequired:false};
    }
    const result=await manage({positionSnapshot:position,manualSymbols,exchangeQuantity:new Map([[position.symbol,Number(position.remaining_quantity)]]),quoteRetryBudget:{remaining:1}});
    const status=result.action==='CLOSE'&&result.result?.closed===true?'CLOSED':
      result.nativeStop?.status??'RECONCILIATION_PENDING';
    return {status,startedAt,finishedAt:clock(),softwareMonitorRequired:!['CLOSED','PROTECTED'].includes(status)};
  }catch(error){return {status:initial?.status==='PROTECTED'?'PROTECTED':'RECONCILIATION_PENDING',managementStatus:'FAILED',startedAt,finishedAt:clock(),softwareMonitorRequired:true,error:String(error?.message??error)};}
}
