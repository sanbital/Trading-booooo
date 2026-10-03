export function cancellationCategory(reason,latest=null){
 if(latest?.gates?.data===false||latest?.gates?.technical===false||/DATA|STALE|INCOMPLETE|CAPTURE|CONTEXT_UNAVAILABLE|UNIVERSE_REFRESH/.test(reason??''))return 'DATA_UNAVAILABLE';
 if(latest?.gates?.execution===false||/BOOK|LIQUIDITY|COST|SPREAD/.test(reason??''))return 'EXECUTION_COST';
 if(/MARGIN|CAPACITY|ACCOUNT_FEE|POSITION_MODE|ACCOUNT_ENTRY_HOLD/.test(reason??''))return 'ACCOUNT_CONSTRAINT';
 if(/LATE_EXECUTION|FAILED_BREAKOUT|LATEST_PRICE/.test(reason??''))return 'PRICE_OR_BREAKOUT';
 if(/WRITER|LEASE|FENCE|GENERATION|AUTHORITY|SIGNAL_STATE|OWNERSHIP|ORDER_IDENTITY|SUBMIT/.test(reason??''))return 'AUTHORITY_OR_STATE';
 return 'MARKET_CANCEL';
}
const decision=d=>d?{at:d.at,capture_end_ms:d.capture_end_ms,decision:d.decision,phase:d.phase,setup:d.setup,trigger:d.trigger,confirmation:d.confirmation,gates:d.gates,reasons:d.reasons,reference_price:d.reference_price}:null;
export function entryEvidence(signal,{check=null,quote=null,authority=null,timing={},orderId=null,reason=null,phase='PRE_SEND',writer=null}={}){
 const seed=signal.features?.deterministic,latest=check?.latest;
 return {version:'ENTRY_BOUNDARY_EVIDENCE_1',signal_id:signal.id,order_id:orderId,initial:decision(seed?.decision),latest:decision(latest),
  initial_price:seed?.decision?.reference_price??null,latest_price:check?.input?.price??latest?.reference_price??null,price_change:check?.drift??null,
  capture_ref:latest?.capture_end_ms?{symbol:signal.symbol,end_ms:latest.capture_end_ms}:null,
  data_quality:check?.input?.facts?.quality??null,capture_status:check?.input?.capture?.status??null,capture_reason:check?.input?.capture?.reason??null,
  quote:quote?{requested_at_ms:quote.timing?.requested_at_ms??null,received_at_ms:quote.timing?.received_at_ms??null,exchange_at_ms:quote.timing?.exchange_at_ms??quote.exchange_at_ms??null,validated_at_ms:latest?.at??Date.now(),best_bid:quote.best_bid,best_ask:quote.best_ask}:null,
  universe:authority??null,writer,phase,timing:{...timing},reason,category:reason?cancellationCategory(reason,latest):null};
}
