import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {analyzeDbOnlyExit} from '../../supabase/functions/_shared/leader-db-only-reconciliation.mjs';
import {harness,position} from './harness.mjs';

// Deliberately synthetic identifiers and economics. The topology mirrors the live
// incident without publishing account records in a public repository or CI log.
const TARGET='22222222-2222-4222-8222-222222222222';
const SOURCE='33333333-3333-4333-8333-333333333333';
const SIGNAL='44444444-4444-4444-8444-444444444444';
const CURRENT_CLIENT='tb-v17s-current000000000000000001';
const STALE_CLIENT='tb-v17s-stale0000000000000000001';
const ALGO='80000000001',ENTRY_ORDER='90000000001',EXIT_ORDER='90000000002';
const ENTRY_AT=Date.parse('2026-01-01T00:10:11.311Z'),EXIT_AT=Date.parse('2026-01-01T00:19:51.019Z');

function fixture(){
  const target=position('CASEUSDT',100,.01534);Object.assign(target,{id:TARGET,signal_id:SIGNAL,entry_at:new Date(ENTRY_AT).toISOString(),
    updated_at:'2026-01-01T00:19:05.334Z',last_evaluated_at:'2026-01-01T00:19:05.334Z',entry_fee_usdt:.000767,realized_pnl_usdt:-.000767});
  target.metadata={...target.metadata,entryOrderId:ENTRY_ORDER,v18SettledPnl:-.000767,qv3:{version:'QV3_ENTRY_EXIT_TWO_1'},
    exitProtection:{version:4,generation:1,health:'PROTECTED',orders:[{clientId:CURRENT_CLIENT,algoId:'80000000002',
      status:'REJECTED',terminal:true,spec:{params:{clientAlgoId:CURRENT_CLIENT,symbol:'CASEUSDT',side:'SELL',positionSide:'BOTH',
        reduceOnly:'true',type:'STOP_MARKET',quantity:100,triggerPrice:.01496}}}]}};
  const source=position('CASEUSDT',120,.01544);Object.assign(source,{id:SOURCE,signal_id:'11111111-1111-4111-8111-111111111111',
    state:'CLOSED',remaining_quantity:0,entry_at:'2026-01-01T00:00:00.000Z',closed_at:'2026-01-01T00:05:09.403Z',
    updated_at:'2026-01-01T00:05:09.403Z',realized_pnl_usdt:-1.1});
  source.metadata={...source.metadata,exitProtection:{version:8,generation:2,health:'RECONCILIATION_PENDING',orders:[{
    clientId:STALE_CLIENT,algoId:ALGO,status:'CANCEL_PENDING',terminal:false,cancelError:'V18_API_BUDGET_EXHAUSTED',
    spec:{params:{clientAlgoId:STALE_CLIENT,symbol:'CASEUSDT',side:'SELL',positionSide:'BOTH',reduceOnly:'true',
      type:'STOP_MARKET',quantity:120,triggerPrice:.01503}}}]}};
  const entry={id:'55555555-5555-4555-8555-555555555555',signal_id:SIGNAL,position_id:TARGET,symbol:'CASEUSDT',intent:'OPEN_LONG',state:'FILLED',
    exchange_order_id:ENTRY_ORDER,client_order_id:'tb-v11e-case',created_at:new Date(ENTRY_AT).toISOString(),updated_at:new Date(ENTRY_AT).toISOString(),
    request_payload:{order:{side:'BUY',position_side:'LONG',position_effect:'OPEN'}}};
  const trades=[
    {symbol:'CASEUSDT',id:700000001,orderId:Number(ENTRY_ORDER),price:'0.01534',qty:'100',quoteQty:'1.534',commission:'0.000767',commissionAsset:'USDT',realizedPnl:'0',time:ENTRY_AT,isBuyer:true},
    {symbol:'CASEUSDT',id:700000002,orderId:Number(EXIT_ORDER),price:'0.01503',qty:'40',quoteQty:'0.6012',commission:'0.0003006',commissionAsset:'USDT',realizedPnl:'-0.0124',time:EXIT_AT,isBuyer:false},
    {symbol:'CASEUSDT',id:700000003,orderId:Number(EXIT_ORDER),price:'0.01503',qty:'60',quoteQty:'0.9018',commission:'0.0004509',commissionAsset:'USDT',realizedPnl:'-0.0186',time:EXIT_AT,isBuyer:false}
  ];
  const ledger=trades.slice(1).map(t=>({exchange:'binance_futures',account_scope:'futures',market:t.symbol,exchange_trade_id:t.id,
    exchange_order_id:String(t.orderId),client_order_id:null,side:'SELL',price:Number(t.price),quantity:Number(t.qty),quote_amount:Number(t.quoteQty),
    fee_quote_amount:Number(t.commission),realized_pnl_quote:Number(t.realizedPnl),accounting_status:'UNMATCHED_INVENTORY',source:'UNCLASSIFIED',
    v17_order_id:null,v17_position_id:null,executed_at:new Date(t.time).toISOString()}));
  const order={symbol:'CASEUSDT',orderId:Number(EXIT_ORDER),clientOrderId:STALE_CLIENT,side:'SELL',positionSide:'BOTH',reduceOnly:true,
    type:'MARKET',origType:'MARKET',status:'FILLED',origQty:'100',executedQty:'100',avgPrice:'0.01503',cumQuote:'1.503',time:EXIT_AT,updateTime:EXIT_AT};
  const algo={symbol:'CASEUSDT',clientAlgoId:STALE_CLIENT,algoId:ALGO,algoStatus:'FINISHED',actualOrderId:EXIT_ORDER,
    side:'SELL',positionSide:'BOTH',reduceOnly:true,actualQty:'100'};
  const now=EXIT_AT+1000,portfolio={exchange:'binance_futures',account_scope:'futures',positions_complete:true,positions:[],
    observation:{id:'fresh-case-flat',source:'BINANCE_ACCOUNT_REST',requested_at_ms:now,received_at_ms:now}};
  const openOrders={complete:true,orders:[],algos:[],observed_at_ms:now};
  return {target,source,entry,trades,ledger,order,algo,portfolio,openOrders,now};
}
function analyze(f,overrides={}){return analyzeDbOnlyExit({position:f.target,lifecyclePositions:[f.source,f.target],laneOrders:[f.entry],
  ledgerFills:f.ledger,accountTrades:f.trades,orderHistory:[f.order],algo:f.algo,portfolio:f.portfolio,openOrders:f.openOrders,
  tradeHistoryComplete:true,orderHistoryComplete:true,now:f.now,...overrides});}

test('01 sanitized production-shaped run -> classify -> stale-stop reconcile -> generation-fenced recovery',async()=>{
  const f=fixture(),h=harness({positions:[f.source,f.target],signal:false,now:f.now});
  h.state.exchange=[];h.state.tables.v11_long_regime_orders=[f.entry];h.state.tables.exchange_trade_fills=structuredClone(f.ledger);
  h.state.tables.v11_long_regime_signals=[{id:SIGNAL,position_id:TARGET,status:'FILLED'}];
  h.state.tradeHistory.CASEUSDT=structuredClone(f.trades);h.state.orderHistory.CASEUSDT=[structuredClone(f.order)];
  h.state.stopFills.CASEUSDT={orderId:EXIT_ORDER,exact:true,quantity:100,funds:1.503,fee:.0007515,status:'FILLED',
    lastFillAt:EXIT_AT,tradeIds:['700000002','700000003']};
  const first=await h.ctx.runCycle(),target=h.state.tables.v11_long_regime_positions.find(p=>p.id===TARGET),source=h.state.tables.v11_long_regime_positions.find(p=>p.id===SOURCE);
  assert.equal(first.reconciliation.find(x=>x.positionId===TARGET).classification,'VERIFIED_STALE_NATIVE_STOP',JSON.stringify(first.reconciliation));
  assert.equal(target.state,'CLOSED');assert.equal(target.remaining_quantity,0);assert.ok(Math.abs(target.exit_price-.01503)<1e-12);
  assert.equal(target.closed_at,new Date(EXIT_AT).toISOString());assert.ok(Math.abs(target.realized_pnl_usdt-(-.0325185))<1e-12);
  assert.equal(target.metadata.qv3.version,'QV3_ENTRY_EXIT_TWO_1');assert.equal(source.realized_pnl_usdt,-1.1);
  assert.equal(source.metadata.exitProtection.health,'CROSS_LIFECYCLE_EXECUTION');
  assert.deepEqual(h.state.tables.exchange_trade_fills.map(x=>[x.v17_position_id,x.accounting_status]),[[TARGET,'ACCOUNTED'],[TARGET,'ACCOUNTED']]);
  assert.equal(h.state.tables.v11_long_regime_runtime[0].circuit_open,false);assert.equal(first.protectionHealth,'FLAT');
  assert.equal(first.symbolRecovery[0].resolved,false);assert.equal(first.symbolRecovery[0].checks,1);
  assert.ok(!h.state.calls.some(c=>c.action==='create_order'));
  const reconciliationSuccess=h.state.tables.v11_long_regime_runtime[0].last_reconciliation_success_at;
  h.advance();const second=await h.ctx.runCycle();assert.equal(second.symbolRecovery[0].resolved,true);
  h.advance();await h.ctx.runCycle();
  assert.equal(h.state.tables.v11_long_regime_runtime[0].circuit_open,false);
  assert.equal(h.state.tables.v11_long_regime_runtime[0].entry_block_reason,'NO_FRESH_BULL_SIGNAL');
  assert.equal(h.state.tables.v11_long_regime_runtime[0].last_reconciliation_success_at,reconciliationSuccess);
});

test('02 same fills without exact algo attribution stay unresolved and do not permit settlement',()=>{
  const f=fixture(),r=analyze(f,{algo:null});assert.equal(r.outcome,'UNRESOLVED');
  assert.equal(r.reason,'NATIVE_ALGO_IDENTITY_UNPROVEN');assert.equal(r.settlementPermitted,false);
});
test('03 exact existing bot exit with a missing exchange-order link is attributable without fabricating an intent',()=>{
  const f=fixture(),client='tb-v11x-existing';f.order.clientOrderId=client;
  const close={id:'66666666-6666-4666-8666-666666666666',position_id:TARGET,client_order_id:client,exchange_order_id:null,
    intent:'CLOSE_LONG',request_payload:{order:{side:'SELL',position_side:'LONG',position_effect:'CLOSE'}}};
  const r=analyze(f,{laneOrders:[f.entry,close],algo:null});assert.equal(r.classification,'VERIFIED_BOT_EXIT');
  assert.equal(r.evidence.laneOrderId,close.id);assert.equal(r.recoveryEligible,true);
});
test('04 verified external close records a non-strategy class but is never auto-recovery evidence',()=>{
  const f=fixture();f.order.clientOrderId='web-manual-123';const r=analyze(f,{lifecyclePositions:[f.target],algo:null});
  assert.equal(r.classification,'VERIFIED_EXTERNAL_OR_UNATTRIBUTED_CLOSE');assert.equal(r.evidence.strategyExit,false);
  assert.equal(r.recoveryEligible,false);assert.equal(r.settlementPermitted,true);
});
test('05 partial SELL cannot close the whole position',()=>{
  const f=fixture();const sells=f.trades.slice(1);sells[1].qty='10';sells[1].quoteQty='0.1503';
  const r=analyze(f,{accountTrades:[f.trades[0],...sells]});assert.equal(r.outcome,'UNRESOLVED');assert.equal(r.reason,'PARTIAL_EXIT_ONLY');
});
test('06 same-symbol lifecycle overlap and a later BUY cannot borrow another lifecycle fill',()=>{
  const f=fixture(),later={...f.trades[0],id:700000010,orderId:90000000010,time:EXIT_AT-1000};
  const r=analyze(f,{accountTrades:[...f.trades,later]});assert.equal(r.reason,'INTERVENING_BUY_LIFECYCLE');
});
test('07 REJECTED stop with a still-live exchange position is not treated as flat',()=>{
  const f=fixture(),portfolio={...f.portfolio,positions:[{market:'CASEUSDT',side:'LONG',quantity:100}]};
  const r=analyze(f,{portfolio});assert.equal(r.reason,'FRESH_FLAT_UNPROVEN');assert.equal(r.settlementPermitted,false);
});
test('08 reverse arrival order and duplicate identical events yield one canonical receipt; conflicting duplicate blocks',()=>{
  const f=fixture(),reversed=analyze(f,{accountTrades:[...f.trades].reverse(),ledgerFills:[...f.ledger].reverse()});
  const duplicate=analyze(f,{accountTrades:[...f.trades,f.trades[2]],ledgerFills:[...f.ledger,f.ledger[0]]});
  assert.deepEqual(reversed.evidence.tradeIds,['700000002','700000003']);assert.deepEqual(duplicate.evidence.tradeIds,reversed.evidence.tradeIds);
  const bad={...f.trades[2],qty:'61'};assert.equal(analyze(f,{accountTrades:[...f.trades,bad]}).reason,'CONFLICTING_DUPLICATE_TRADE');
});
test('14 incomplete/stale account evidence cannot become a successful reconciliation',()=>{
  const f=fixture(),stale={...f.portfolio,observation:{...f.portfolio.observation,requested_at_ms:f.now-10000,received_at_ms:f.now-10000}};
  assert.equal(analyze(f,{portfolio:stale}).reason,'FRESH_FLAT_UNPROVEN');
  assert.equal(analyze(f,{tradeHistoryComplete:false}).reason,'HISTORY_INCOMPLETE');
});
test('15 QV3 implementation and rules are byte-identical to the production-v36 basis',()=>{
  const cwd=new URL('../../',import.meta.url);execFileSync('git',['diff','--exit-code','98131bbfe3854545d07037e39fd52a3ce87a7ccd','--',
    'supabase/functions/_shared/leader-qv3-runtime.mjs','supabase/functions/_shared/leader-qv3-rules.mjs'],{cwd});
});
