// A closed lifecycle is reconciled as absent, never relabeled "never submitted".
// Pure verifier: no network, clocks, credentials or mutations on import.
export const CLOSED_NATIVE_PROOF_VERSION='CLOSED_NATIVE_ABSENCE_1';
const close=(a,b)=>Number.isFinite(Number(a))&&Number.isFinite(Number(b))&&Math.abs(Number(a)-Number(b))<=Math.max(1e-8,Math.abs(Number(b))*1e-7);
const rows=(read,name)=>{if(read?.ok!==true||!Array.isArray(read.data)||(['ALGO_HISTORY','ORDER_HISTORY','TRADE_HISTORY'].includes(name)&&read.data.length>=1000))throw Error(name+'_INCOMPLETE');return read.data;};
export function verifyClosedNativeAbsence({ledger,proof,global,now}) {
 const fail=name=>{throw Error(name);},stop=ledger.stop;
 if(ledger.state!=='CLOSED'||Number(ledger.remaining_quantity)!==0||ledger.accounting_pending===true||ledger.entry_accounting_pending===true||ledger.execution_mode!=='LEADER_MOMENTUM_V17'||ledger.manual===true)fail('CLOSED_OWNED_SETTLED_POSITION_REQUIRED');
 if(stop.clientId!==proof.client_id||ledger.id!==proof.id||ledger.symbol!==proof.symbol||stop.terminal===true||stop.ackAt||stop.algoId||stop.actualOrderId||Number(stop.appliedQuantity??0)!==0||stop.accountingPending===true||stop.crossLifecycleExecution===true)fail('UNACKNOWLEDGED_STOP_IDENTITY_REQUIRED');
 if(stop.spec?.params?.symbol!==ledger.symbol||stop.spec.params.clientAlgoId!==stop.clientId||stop.spec.params.side!=='SELL'||stop.spec.params.positionSide!=='BOTH'||String(stop.spec.params.reduceOnly)!=='true'||stop.spec.params.type!=='STOP_MARKET')fail('NATIVE_STOP_SPEC_MISMATCH');
 const observed=Number(global.observed_at_ms);
 if(!Number.isFinite(observed)||now-observed>5000||observed-now>1000)fail('PROOF_STALE_OR_CLOCK_SKEW');
 if(!(Number.isSafeInteger(proof.start)&&Number.isSafeInteger(proof.end)&&proof.start<=Number(stop.submittedAt)-5000&&proof.end>=Number(stop.submittedAt)&&proof.end<=observed&&proof.end-proof.start<7*86400000))fail('PROOF_COVERAGE_INVALID');
 if(proof.lookup?.ok!==false||proof.lookup.http!==400||proof.lookup.data?.code!==-2013)fail('EXACT_NEGATIVE_LOOKUP_REQUIRED');
 const algos=rows(proof.history,'ALGO_HISTORY'),orders=rows(proof.orders,'ORDER_HISTORY'),trades=rows(proof.trades,'TRADE_HISTORY');
 if(algos.some(o=>o.symbol!==ledger.symbol||o.clientAlgoId===stop.clientId||!['CANCELED','EXPIRED','REJECTED'].includes(o.algoStatus)||String(o.actualOrderId??'').replace(/^0$/,'')!==''))fail('HISTORICAL_ALGO_OUTCOME_UNRESOLVED');
 if(rows(global.openAlgos,'OPEN_ALGOS').length||rows(global.openOrders,'OPEN_ORDERS').length||rows(global.positions,'POSITIONS').some(p=>!Number.isFinite(Number(p.positionAmt))||Number(p.positionAmt)!==0))fail('EXCHANGE_ACCOUNT_NOT_FLAT');
 const receipts=ledger.receipts??{},sell=trades.filter(t=>t.side==='SELL'),seen=new Set();
 for(const t of trades){if(t.symbol!==ledger.symbol||!['BUY','SELL'].includes(t.side)||seen.has(String(t.id)))fail('TRADE_IDENTITY_OR_DUPLICATE');seen.add(String(t.id));}
 let quantity=0,funds=0,fee=0;const receiptIds=[],tradeIds=[];
 for(const [id,r]of Object.entries(receipts)) {
  if(!(Number(r.quantity)>0))continue;
  if(r.detailsComplete!==true||!close(r.accountedQuantity,r.quantity)||r.status!=='FILLED'||!Array.isArray(r.tradeIds))fail('RECEIPT_ACCOUNTING_INCOMPLETE');
  const matches=orders.filter(o=>String(o.orderId)===String(r.exchangeOrderId)&&o.clientOrderId===r.clientOrderId&&o.symbol===ledger.symbol&&o.side==='SELL'&&o.positionSide==='BOTH'&&String(o.reduceOnly)==='true'&&o.status==='FILLED'&&close(o.executedQty,r.quantity));
  if(matches.length!==1)fail('EXIT_ORDER_RECEIPT_MISMATCH');
  const ts=sell.filter(t=>String(t.orderId)===String(r.exchangeOrderId));
  if(ts.length!==r.tradeIds.length||new Set(r.tradeIds.map(String)).size!==ts.length||ts.some(t=>!r.tradeIds.map(String).includes(String(t.id))||t.commissionAsset!=='USDT'))fail('EXIT_TRADE_RECEIPT_MISMATCH');
  const q=ts.reduce((s,t)=>s+Number(t.qty),0),f=ts.reduce((s,t)=>s+Number(t.quoteQty),0),c=ts.reduce((s,t)=>s+Number(t.commission),0);
  if(!close(q,r.quantity)||!close(f,r.funds)||!close(c,r.fee)||!close(f,matches[0].cumQuote))fail('EXIT_ACCOUNTING_AMOUNT_MISMATCH');
  quantity+=q;funds+=f;fee+=c;receiptIds.push(id);tradeIds.push(...ts.map(t=>String(t.id)));
 }
 if(!close(quantity,ledger.original_quantity)||sell.length!==tradeIds.length||!sell.every(t=>tradeIds.includes(String(t.id))))fail('UNATTRIBUTED_SELL_OR_POSITION_QUANTITY_MISMATCH');
 return {version:CLOSED_NATIVE_PROOF_VERSION,kind:'CLOSED_ABSENT_WITH_COMPLETE_ACCOUNTING',position_id:ledger.id,
  symbol:ledger.symbol,client_id:stop.clientId,submitted_at_ms:Number(stop.submittedAt),spec:stop.spec.params,
  expected_receipts:receipts,original_quantity:Number(ledger.original_quantity),observed_at_ms:observed,
  coverage_start_ms:proof.start,coverage_end_ms:proof.end,trade_count:tradeIds.length,trade_ids:tradeIds,
  receipt_ids:receiptIds,quantity,funds,fee,exact_negative_lookup:true,complete_history:true,account_flat:true};
}
