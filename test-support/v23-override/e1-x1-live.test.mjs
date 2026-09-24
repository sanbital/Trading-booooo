import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {managerBindings} from '../current-manager-bindings.mjs';
import {readFileSync} from 'node:fs';
import {E1_POLICY,aggregateAggTrades,advanceE1,depthVwap,e1QuoteEvidence,isFastWeak,startE1}
  from '../../supabase/functions/_shared/leader-e1-runtime.mjs';
import {POLICY,STRATEGY} from '../../supabase/functions/_shared/leader-momentum-v17.mjs';
import {EXIT_REVIEW_CANDIDATE,EXIT_REVIEW_R5,nextExitReviewed}
  from '../../supabase/functions/_shared/leader-exit-review.mjs';
import {harness} from '../v18-ops/harness.mjs';

const t0=1_800_000_000_000;
const agg=(id,time,price,quantity,m)=>({a:id,T:time,p:String(price),q:String(quantity),m});
const quote=(at,bid=99.9,ask=100.1)=>({bid,ask,receivedAt:at-20,bookGap:false,
  expectedEntryVWAP:ask,expectedExitVWAP:bid,expectedCostBps:20,quoteAgeMs:20,sourceTier:'TEST'});

test('production E1 preserves strict fast-weak decimals and Binance m direction',()=>{
  const tape=aggregateAggTrades([agg(1,t0-9000,100,2,true),agg(2,t0-100,99.7,3,false)],t0-10000,t0);
  assert.equal(tape.available,true);assert.equal(tape.tradeCount,2);
  assert.equal(tape.takerBuyQuoteShare,(99.7*3)/(100*2+99.7*3));
  assert.equal(isFastWeak(-.002,.449),false);assert.equal(isFastWeak(-.0021,.45),false);
  assert.equal(isFastWeak(-.0021,.449),true);
});

test('production E1 refuses max-page tape and insufficient depth',()=>{
  const rows=Array.from({length:E1_POLICY.aggregateTradeLimit},(_,i)=>agg(i,t0-9999+i,100,1,false));
  assert.equal(aggregateAggTrades(rows,t0-10000,t0).reason,'E1_TAPE_TRUNCATED');
  assert.equal(depthVwap([{price:100,size:1}],2),null);
  const evidence=e1QuoteEvidence({best_bid:99,best_ask:100,bids:[{price:99,size:1}],asks:[{price:100,size:1}],
    timing:{received_at_ms:t0-10}},2,t0);
  assert.equal(evidence.valid,true);assert.equal(evidence.fullDepth,false);
});

test('production E1 confirms exactly two non-overlapping blocks without extending TTL',()=>{
  const initialTape={available:true,startAt:t0-10000,endAt:t0,tradeCount:2,last10sReturn:-.003,
    takerBuyQuoteShare:.4};
  let state=startE1({decisionAt:t0,signalId:'s1',symbol:'TESTUSDT',signalExpiresAt:t0+12000,
    baselineEligible:true,tape:initialTape,quote:quote(t0)});
  assert.equal(state.confirmationState,'WATCH_FAST_WEAK');assert.equal(state.expiresAt,t0+12000);
  const block=start=>({available:true,startAt:start,endAt:start+5000,tradeCount:2,
    last10sReturn:0,takerBuyQuoteShare:.5});
  state=advanceE1(state,{observedAt:t0+5100,tape:block(t0),quote:quote(t0+5100),
    entryGuardPassed:true,liquidityPassed:true});
  state=advanceE1(state,{observedAt:t0+10100,tape:block(t0+5000),quote:quote(t0+10100,100,100.1),
    entryGuardPassed:true,liquidityPassed:true});
  assert.equal(state.confirmationState,'RECOVERY_CONFIRMED');assert.equal(state.allowed,true);
  assert.equal(state.expiresAt,t0+12000);assert.equal(state.parametersValidatedByBacktest,false);
  assert.equal(state.activationBasis,'OPERATOR_OVERRIDE_UNVALIDATED');
});

test('enabled E1 is in the real open path and dispatches only at the post-recovery current price',async()=>{
  const tape=async(_symbol,start,end)=>{const initial=end-start===10000,price=initial?.004:.00401;
    return{available:true,startAt:start,endAt:end,tradeCount:2,last10sReturn:initial?-.003:.001,
      takerBuyQuoteShare:initial?.4:.6,raw:[{a:1,T:start+1,p:String(price),q:'1',m:true},
        {a:2,T:end-1,p:String(price*(initial?.997:1.001)),q:'1',m:false}]};};
  const h=harness({e1Enabled:true,e1Tape:tape,advanceTimers:true});
  // Exercise the legacy E1 watcher; current setup-governed entries record fast-weak
  // as evidence and intentionally do not wait through this recovery branch.
  h.ctx.setupGoverns=()=>false;
  h.state.entryQuote=state=>({best_bid:.004009,best_ask:.00401,
    bids:[{price:.004009,size:1_000_000}],asks:[{price:.00401,size:1_000_000}],
    timing:{requested_at_ms:state.now-20,received_at_ms:state.now-10,source:'GATEWAY_RECEIPT'}});
  h.state.createOrder=(cmd,state)=>({order:{orderId:'e1-no-fill',clientOrderId:cmd.order.identifier,
    symbol:cmd.order.market,side:'BUY',positionSide:'BOTH',reduceOnly:false,origQty:String(cmd.order.quantity),
    executedQty:'0',status:'EXPIRED',avgPrice:'0',updateTime:state.now,fills:[]}});
  const signal=h.state.tables.v11_long_regime_signals[0],result=await h.ctx.open(signal,[],[]),
    intent=h.state.tables.v11_long_regime_orders.find(o=>o.signal_id===signal.id);
  assert.equal(result.entered,false);assert.equal(result.e1.confirmationState,'RECOVERY_CONFIRMED');
  assert.equal(intent.request_payload.e1.policyVersion,E1_POLICY.policyVersion);
  assert.equal(intent.request_payload.e1.dispatchRecheck.currentQuantity,intent.requested_quantity);
  assert.equal(intent.request_payload.operator_override.priorPerformanceVerdict,'DEFER');
  assert.equal(h.state.calls.filter(c=>c.action==='create_order').length,2);
  assert.equal(result.reason,'IOC_RETRY_EXHAUSTED');
});

test('a newly filled and protected E1/X1 position is never reported FLAT in the same cycle',async()=>{
  const tape=async(_symbol,start,end)=>({available:true,startAt:start,endAt:end,tradeCount:2,
    last10sReturn:.001,takerBuyQuoteShare:.6,raw:[agg(1,start+1,.004,10,true),agg(2,end-1,.004004,10,false)]});
  const h=harness({e1Enabled:true,x1Enabled:true,e1Tape:tape,advanceTimers:true});
  h.state.entryQuote=state=>({best_bid:.004,best_ask:.004001,
    bids:[{price:.004,size:1_000_000}],asks:[{price:.004001,size:1_000_000}],raw:{test:true},
    timing:{requested_at_ms:state.now-20,received_at_ms:state.now-10,source:'GATEWAY_RECEIPT'}});
  h.state.createOrder=(cmd,state)=>{
    const quantity=cmd.order.quantity,price=.004001;
    state.exchange=[{market:cmd.order.market,side:'LONG',quantity,entry_price:price,leverage:3}];
    return{order:{orderId:'e1-filled',clientOrderId:cmd.order.identifier,symbol:cmd.order.market,side:'BUY',
      positionSide:'BOTH',reduceOnly:false,origQty:String(quantity),executedQty:String(quantity),status:'FILLED',
      avgPrice:String(price),updateTime:state.now,fills:[{tradeId:'e1-buy',qty:String(quantity),price:String(price),
        commission:'.06',commissionAsset:'USDT',time:state.now}]}};
  };
  const result=await h.ctx.runCycle(),runtime=h.state.tables.v11_long_regime_runtime[0],
    position=h.state.tables.v11_long_regime_positions.find(p=>p.state==='OPEN');
  assert.equal(result.entry.entered,true);assert.equal(result.entry.entryProtection.status,'PROTECTED');
  assert.equal(result.protectionHealth,'PROTECTED');assert.equal(runtime.protection_health,'PROTECTED');
  assert.equal(position.metadata.entryConfirmationPolicyVersion,E1_POLICY.policyVersion);
  assert.equal(position.metadata.exitObservationPolicyVersion,'X1_FAST_OBSERVATION_OVERRIDE_1');
});

const executorSource=readFileSync(new URL('../../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8');
const managerCode=executorSource.slice(executorSource.indexOf('async function leaderQuote('),
  executorSource.indexOf('const exchangeGateway='));

function managerHarness(){
  const writes=[],gatewayCalls=[];
  const position={id:'p1',symbol:'TESTUSDT',entry_price:100,entry_at:new Date(t0).toISOString(),
    original_quantity:1.2,remaining_quantity:1.2,entry_fee_usdt:.06,peak_price:100,hard_stop_price:97.5,
    updated_at:new Date(t0).toISOString(),last_evaluated_at:new Date(t0).toISOString(),state:'OPEN',
    metadata:{executionMode:STRATEGY,leaderExitPolicyVersion:EXIT_REVIEW_R5.policyVersion,
      leaderExitPolicy:{...POLICY},leaderLastHighAt:new Date(t0).toISOString(),
      exitObservationPolicyVersion:'X1_FAST_OBSERVATION_OVERRIDE_1',
      entryMarketRules:{priceTick:.01,quantityStep:.1},x1Observation:{observedBidPeak:100}}};
  const builder={patch:null,update(p){this.patch=p;writes.push(p);return this},eq(){return this},select(){return this},
    async single(){return{data:{...position,...this.patch}}},async insert(){return{error:null}}};
  const context={console,Date,Number,Array,Error,Math,JSON,Map,Set,Promise,POLICY,STRATEGY,
    EXIT_REVIEW_CANDIDATE,EXIT_REVIEW_R5,nextExitReviewed,NATIVE_STOP_ENABLED:false,QV3_LIVE_CUTOVER:null,
    ENTRY_EXECUTION_POLICY_VERSION:'V21_POST_FILL_DRIFT_GUARD_1',X1_POLICY_VERSION:'X1_FAST_OBSERVATION_OVERRIDE_1',
    OPERATOR_OVERRIDE:{basis:'OPERATOR_OVERRIDE_UNVALIDATED'},rec:x=>x&&typeof x==='object'?x:{},
    N:(v,d=0)=>Number.isFinite(Number(v))?Number(v):d,classifyFailure:()=>({fatal:false}),
    verifyExecutionLease:async()=>{},audit:async()=>{},closePos:async()=>({closed:true}),
    createGatewayProtection:()=>{throw Error('native protection must be disabled in this test')},
    qv3AfterProtection:async()=>null,exchangeGateway:async c=>{gatewayCalls.push(c);throw Error('unexpected gateway')},
  };
  Object.assign(context,managerBindings);vm.createContext(context);vm.runInContext(managerCode+';this.manage=manageLeader;',context);
  return{position,writes,gatewayCalls,manage:context.manage,db:{from:()=>builder}};
}

test('X1 injected one-second observation reuses R5, persists executable peak, and performs no quote REST',async()=>{
  const h=managerHarness(),at=t0+60000;
  const result=await h.manage(h.db,h.position,{fastObservation:true,evaluateQv3:false,gateway:async c=>{
    h.gatewayCalls.push(c);throw Error('unexpected gateway');},exchangeQuantity:new Map([['TESTUSDT',1.2]]),
    observedQuote:{bid:101.4,ask:101.41,bidSize:2,requestedAtMs:at-30,receivedAtMs:at-20,
      detectedAtMs:at,source:'P10_TOP_OF_BOOK_BATCH',observationId:'x1-o1',fullQuantityExecutable:true,
      observedBidPeak:102.5,observedBidPeakAt:at-1000,executableVwapPeak:102.5}});
  assert.equal(result.action,'HOLD');assert.equal(result.protectionStage,'PROFIT_LOCK');
  assert.equal(result.stopPrice,101.25);assert.equal(h.gatewayCalls.length,0);
  const saved=h.writes.at(-1);assert.equal(saved.peak_price,102.5);
  assert.equal(saved.metadata.x1Observation.executableVwapPeak,102.5);
  assert.equal(saved.metadata.exitObservationPolicyVersion,'X1_FAST_OBSERVATION_OVERRIDE_1');
});

test('X1 refuses an observation that cannot execute the full protected quantity',async()=>{
  const h=managerHarness(),at=t0+60000;
  await assert.rejects(()=>h.manage(h.db,h.position,{fastObservation:true,evaluateQv3:false,
    observedQuote:{bid:102,ask:102.01,bidSize:.5,requestedAtMs:at-30,receivedAtMs:at-20,
      // The producer flag is deliberately wrong. The order path must independently
      // compare top-bid size with the protected quantity before accepting the quote.
      detectedAtMs:at,source:'P10_TOP_OF_BOOK_BATCH',observationId:'x1-o2',fullQuantityExecutable:true}}),
    /X1_EXIT_QUOTE_INVALID_STALE_OR_SHALLOW/);
  assert.equal(h.writes.length,0);
});
