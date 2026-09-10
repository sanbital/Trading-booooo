import {portfolioMatches} from './leader-momentum-v17.mjs';
/** Called only AFTER a real entry has been durably recorded by the host.
 * Never dispatches an entry or reclassifies an acknowledged fill as a failed entry.
 * Dependencies are the host's existing read and position-management functions.
 */
export async function protectNewLeaderPosition({enabled,position,manualSymbols=[],readPortfolio,manage,clock=Date.now}){
  if(!enabled)return {status:'DISABLED'};
  const startedAt=clock();
  try{
    if(manualSymbols.includes(position.symbol))throw Error('MANUAL_SYMBOL_CONFLICT');
    const pf=await readPortfolio();
    if(!Array.isArray(pf?.positions)||pf.positions_complete===false)throw Error('INCOMPLETE_PORTFOLIO');
    const rows=pf.positions.filter(x=>String(x.market??x.symbol??'').toUpperCase()===position.symbol);
    const match=portfolioMatches([position],{positions:rows});
    if(!match.ok)throw Error(`ENTRY_PROTECTION_OWNERSHIP:${match.reason}`);
    const result=await manage({manualSymbols,exchangeQuantity:new Map([[position.symbol,Number(position.remaining_quantity)]]),quoteRetryBudget:{remaining:1}});
    const status=result.action==='CLOSE'?'CLOSED':result.nativeStop?.status??'RECONCILIATION_PENDING';
    return {status,startedAt,finishedAt:clock(),softwareMonitorRequired:!['CLOSED','PROTECTED'].includes(status)};
  }catch(error){return {status:'RECONCILIATION_PENDING',startedAt,finishedAt:clock(),softwareMonitorRequired:true,error:String(error?.message??error)};}
}
