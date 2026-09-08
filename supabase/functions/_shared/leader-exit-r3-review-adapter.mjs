import {R3_CANDIDATE,newR3State,nextR3Exit,restoreR3State,validateR3Policy} from './leader-exit-r3.mjs';

// Injectable event observer for offline replay / shadow integration. This adapter
// deliberately has no order submission or account mutation capability.
export function createR3ReviewObserver(position, {policy=R3_CANDIDATE,manualSymbols=[],checkpoint=null,now=null}={}) {
  validateR3Policy(policy);
  if (position.side!=='LONG' || position.metadata?.executionMode!=='LEADER_MOMENTUM_V17' ||
      manualSymbols.includes(position.symbol)) throw Error('NOT_EXCLUSIVELY_V17_OWNED');
  if (checkpoint && (checkpoint.positionId!==position.id || checkpoint.policyVersion!==policy.policyVersion))
    throw Error('CHECKPOINT_POSITION_MISMATCH');
  let state=checkpoint ? restoreR3State(checkpoint,now) : newR3State({positionId:position.id,
    entryPrice:Number(position.entry_price),entryAt:Date.parse(position.entry_at),
    quantity:Number(position.original_quantity),entryFee:Number(position.entry_fee_usdt)},policy);
  return {
    onMarketEvent(event) {const out=nextR3Exit(state,event,policy);state=out.state;return out;},
    checkpoint() {return structuredClone(state);},
    mode:'REVIEW_ONLY',
  };
}
