/** Read-only account-mode evidence; does not use the order path's lifetime cache. */
import { randomUUID } from 'node:crypto';
export async function readFuturesModeEvidence(request, clock=Date.now) {
  const requestedAt=clock();
  const data=await request('GET','/fapi/v1/positionSide/dual',{}, {timeoutMs:1500});
  const receivedAt=clock();
  // Boolean(undefined) and Boolean('false') are both unsafe here.
  if (typeof data?.dualSidePosition!=='boolean' || !Number.isSafeInteger(requestedAt) ||
      !Number.isSafeInteger(receivedAt) || requestedAt<=0 || receivedAt<requestedAt)
    throw Error('FUTURES_POSITION_MODE_UNREADABLE');
  return {exchange:'binance_futures',account_scope:'futures',
    dual_side_position:data.dualSidePosition,
    position_mode:data.dualSidePosition?'HEDGE':'ONE_WAY',
    observation:{id:randomUUID(),source:'BINANCE_POSITION_MODE_REST',
      requested_at_ms:requestedAt,received_at_ms:receivedAt}};
}
