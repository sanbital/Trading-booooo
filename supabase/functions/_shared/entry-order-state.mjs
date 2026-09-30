/**
 * Exchange-order state is independent from position state.
 *
 * `evidenceExact` means that the venue's fills/fees are fully evidenced. It never
 * means that requested quantity was fully filled. Full fill is decided only from
 * requested/executed/remaining quantities, with the venue status and the freshly
 * reconciled position carried as evidence.
 */
const TERMINAL_REMAINDER_GONE=new Set([
  'EXPIRED','CANCELED','CANCELLED','REJECTED','PARTIALLY_FILLED_CANCELED',
]);
const LIVE=new Set(['NEW','PARTIALLY_FILLED']);
const n=value=>Number(value);
const finite=value=>Number.isFinite(n(value));

export function classifyEntryOrderState(input={}){
  const requestedQty=n(input.requestedQty),executedQty=n(input.executedQty),
    suppliedRemaining=n(input.remainingQty),rawStatus=String(input.rawStatus??'UNKNOWN').toUpperCase(),
    updateTime=n(input.updateTime),reconciledPositionQty=n(input.reconciledPositionQty),
    fills=Array.isArray(input.fills)?input.fills:[];
  if(!(requestedQty>0)||!(executedQty>=0)||executedQty>requestedQty||
    !finite(reconciledPositionQty)||reconciledPositionQty<0)
    return {state:'UNKNOWN',reason:'INVALID_QUANTITY_EVIDENCE'};

  const tolerance=Math.max(1e-12,requestedQty*1e-9),computedRemaining=Math.max(0,requestedQty-executedQty),
    remainingQty=finite(suppliedRemaining)?Math.max(0,suppliedRemaining):computedRemaining,
    quantityConsistent=Math.abs(remainingQty-computedRemaining)<=tolerance,
    full=executedQty+tolerance>=requestedQty&&remainingQty<=tolerance,
    partial=executedQty>tolerance&&!full,
    reconciliation={actualPositionQty:reconciledPositionQty,observed:input.positionReconciled===true},
    evidence={requestedQty,executedQty,remainingQty,rawStatus,fillCount:fills.length,
      updateTime:Number.isFinite(updateTime)?updateTime:null,quantityConsistent,reconciliation};

  if(!quantityConsistent)return {state:'UNKNOWN',reason:'REMAINING_QUANTITY_MISMATCH',...evidence};
  if(full){
    if(rawStatus!=='FILLED')return {state:'UNKNOWN',reason:'FULL_QUANTITY_WITH_NON_FILLED_STATUS',...evidence};
    return {state:'FILLED',reason:null,...evidence};
  }
  if(partial){
    if(TERMINAL_REMAINDER_GONE.has(rawStatus))
      return {state:'PARTIALLY_FILLED_CANCELED',reason:`PARTIAL_${rawStatus}`,...evidence};
    if(LIVE.has(rawStatus))return {state:'PARTIALLY_FILLED',reason:null,...evidence};
    return {state:'UNKNOWN',reason:'PARTIAL_WITH_UNKNOWN_STATUS',...evidence};
  }
  if(rawStatus==='EXPIRED')return {state:'EXPIRED',reason:'NO_FILL_EXPIRED',...evidence};
  if(['REJECTED','CANCELED','CANCELLED'].includes(rawStatus))
    return {state:'REJECTED',reason:`NO_FILL_${rawStatus}`,...evidence};
  return {state:'UNKNOWN',reason:'NO_FILL_STATUS_UNCONFIRMED',...evidence};
}
