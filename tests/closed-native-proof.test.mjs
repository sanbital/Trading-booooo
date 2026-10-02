import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyClosedNativeAbsence} from '../ops/execution-infra/closed-native-proof.mjs';
const now=1790920000000,ok=data=>({ok:true,data});
export function fixture(){
 const clientId='tb-v17s-'+ 'a'.repeat(27),params={clientAlgoId:clientId,symbol:'ABCUSDT',side:'SELL',positionSide:'BOTH',reduceOnly:'true',type:'STOP_MARKET',quantity:10,triggerPrice:97};
 const ledger={id:'00000000-0000-0000-0000-000000000001',symbol:'ABCUSDT',state:'CLOSED',remaining_quantity:0,original_quantity:10,accounting_pending:false,execution_mode:'LEADER_MOMENTUM_V17',
  stop:{clientId,submittedAt:now-3600000,terminal:false,status:'CANCEL_PENDING',spec:{params}},
  receipts:{'00000000-0000-0000-0000-000000000002':{quantity:10,accountedQuantity:10,detailsComplete:true,status:'FILLED',tradeIds:['1'],exchangeOrderId:'20',clientOrderId:'close-1',funds:1000,fee:.5}}};
 const proof={id:ledger.id,client_id:clientId,symbol:'ABCUSDT',start:ledger.stop.submittedAt-5000,end:now-10,
  lookup:{ok:false,http:400,data:{code:-2013}},history:ok([]),
  orders:ok([{orderId:'20',clientOrderId:'close-1',symbol:'ABCUSDT',side:'SELL',positionSide:'BOTH',reduceOnly:true,status:'FILLED',executedQty:10,cumQuote:1000}]),
  trades:ok([{id:'1',orderId:'20',symbol:'ABCUSDT',side:'SELL',qty:10,quoteQty:1000,commission:.5,commissionAsset:'USDT'}])};
 return {ledger,proof,global:{observed_at_ms:now,openAlgos:ok([]),openOrders:ok([]),positions:ok([])},now};
}
test('exact closed-position receipts reconcile absence without asserting never-submitted',()=>{
 const result=verifyClosedNativeAbsence(fixture());assert.equal(result.kind,'CLOSED_ABSENT_WITH_COMPLETE_ACCOUNTING');assert.equal(result.quantity,10);assert.equal(result.trade_count,1);
 assert.equal(result.never_submitted,undefined);
});
for(const [name,change,error]of [
 ['open position',f=>{f.ledger.state='OPEN'},/CLOSED_OWNED/],
 ['pending accounting',f=>{f.ledger.accounting_pending=true},/CLOSED_OWNED/],
 ['acknowledged stop',f=>{f.ledger.stop.algoId='55'},/UNACKNOWLEDGED/],
 ['lookup timeout',f=>{f.proof.lookup={ok:false,error:'TIMEOUT'}},/EXACT_NEGATIVE/],
 ['history truncated',f=>{f.proof.history.data=Array(1000).fill({})},/INCOMPLETE/],
 ['unsettled receipt',f=>{Object.values(f.ledger.receipts)[0].detailsComplete=false},/ACCOUNTING_INCOMPLETE/],
 ['wrong fee',f=>{f.proof.trades.data[0].commission=.8},/AMOUNT_MISMATCH/],
 ['unattributed SELL',f=>{f.proof.trades.data.push({...f.proof.trades.data[0],id:'2',orderId:'30'})},/UNATTRIBUTED/],
 ['duplicate trade',f=>{f.proof.trades.data.push(f.proof.trades.data[0])},/TRADE_IDENTITY/],
 ['current native stop',f=>{f.global.openAlgos.data=[{clientAlgoId:'other'}]},/NOT_FLAT/],
 ['current ordinary order',f=>{f.global.openOrders.data=[{orderId:'30'}]},/NOT_FLAT/],
 ['stale proof',f=>{f.now+=5001},/PROOF_STALE/],
 ['clock skew',f=>{f.now-=1001},/CLOCK_SKEW/],
 ['different client ID',f=>{f.proof.client_id='wrong'},/IDENTITY/],
 ['filled historical algo',f=>{f.proof.history.data=[{symbol:'ABCUSDT',algoStatus:'FINISHED',actualOrderId:'20'}]},/OUTCOME_UNRESOLVED/],
 ['short coverage',f=>{f.proof.start+=1},/COVERAGE_INVALID/],
])test(`blocks ${name}`,()=>{const f=fixture();change(f);assert.throws(()=>verifyClosedNativeAbsence(f),error)});
