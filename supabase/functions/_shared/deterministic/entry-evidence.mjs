export function cancellationCategory(reason,latest=null){
 if(/WRITER|LEASE|FENCE|HEARTBEAT/.test(reason??''))return 'AUTHORITY_OR_STATE';
 if(/aborted|AbortError|DEPENDENCY_TIMEOUT/i.test(reason??''))return 'DATA_UNAVAILABLE';
 if(/GW_(418|429|5\d\d|408)|BINANCE_(IP_BANNED|RATE_LIMITED|WEIGHT_BUDGET)|STREAM_|LOCAL_RATE_GUARD|UNIVERSE_HTTP_(418|429|5\d\d)|TIMEOUT|timed out|fetch failed/.test(reason??''))return 'DATA_UNAVAILABLE';
 if(reason==='CURRENT_EXECUTION_COST_INVALID')return 'EXECUTION_COST';
 if(latest?.gates?.data===false||latest?.gates?.technical===false||/DATA|STALE|INCOMPLETE|CAPTURE|CONTEXT_UNAVAILABLE|UNIVERSE_REFRESH|TOP20_REFRESH|TOP20_SNAPSHOT/.test(reason??''))return 'DATA_UNAVAILABLE';
 if(latest?.gates?.execution===false||/BOOK|LIQUIDITY|COST|SPREAD/.test(reason??''))return 'EXECUTION_COST';
 if(/MARGIN|CAPACITY|ACCOUNT_FEE|POSITION_MODE|ACCOUNT_ENTRY_HOLD/.test(reason??''))return 'ACCOUNT_CONSTRAINT';
 if(/LATE_EXECUTION|FAILED_BREAKOUT|BREAKOUT_FAILED|LATEST_PRICE/.test(reason??''))return 'PRICE_OR_BREAKOUT';
 if(/WRITER|LEASE|FENCE|GENERATION|AUTHORITY|SIGNAL_STATE|OWNERSHIP|ORDER_IDENTITY|SUBMIT|CONTRACT_CHANGED|RETIRED/.test(reason??''))return 'AUTHORITY_OR_STATE';
 if(/TOP20_LEFT/.test(reason??''))return 'UNIVERSE_CANCEL';
 return 'MARKET_CANCEL';
}
const decision=d=>d?{at:d.at,capture_end_ms:d.capture_end_ms,decision:d.decision,phase:d.phase,setup:d.setup,trigger:d.trigger,confirmation:d.confirmation,gates:d.gates,reasons:d.reasons,reference_price:d.reference_price}:null;
export function entryEvidence(signal,{check=null,quote=null,authority=null,timing={},orderId=null,reason=null,phase='PRE_SEND',writer=null}={}){
 const seed=signal.features?.deterministic,latest=check?.latest;
 return {version:'ENTRY_BOUNDARY_EVIDENCE_1',signal_id:signal.id,order_id:orderId,initial:decision(seed?.decision),latest:decision(latest),
  initial_price:seed?.decision?.reference_price??null,latest_price:check?.input?.price??latest?.reference_price??null,price_change:check?.drift??null,
  capture_ref:latest?.capture_end_ms?{symbol:signal.symbol,end_ms:latest.capture_end_ms}:null,
  data_quality:check?.input?.facts?.quality??null,capture_status:check?.input?.capture?.status??null,capture_reason:check?.input?.capture?.reason??null,
  book_validation:check?.input?.execution_book??null,
  quote:quote?{requested_at_ms:quote.timing?.requested_at_ms??null,received_at_ms:quote.timing?.received_at_ms??null,exchange_at_ms:quote.timing?.book_captured_at_ms??quote.timing?.exchange_at_ms??quote.exchange_at_ms??null,validated_at_ms:latest?.at??Date.now(),source:quote.timing?.source??null,book_update_id:quote.raw?.book_update_id??null,book_generation:quote.raw?.book_generation??null,best_bid:quote.best_bid,best_ask:quote.best_ask}:null,
  execution_authority:check?.authority??null,execution_state:decision(check?.execution_state),
  universe:authority??null,writer,phase,timing:{...timing},reason,category:reason?cancellationCategory(reason,latest):null};
}
