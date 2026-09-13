import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {evaluateEntryDecision,operationalIssue,accountingIssue,CONTROL_SCOPE,
  ENTRY_CONTROL_VERSION} from '../../supabase/functions/_shared/leader-entry-control.mjs';
import {canonicalOrderFills,cumulativeFillDelta} from '../../supabase/functions/_shared/leader-fill-evidence.mjs';
import {createNativeProtection} from '../../supabase/functions/_shared/leader-native-protection.mjs';
import {classifyPortfolio} from '../../supabase/functions/_shared/leader-ops-isolation.mjs';
import {harness,position,PRODUCTION_BASIS} from '../v18-ops/harness.mjs';

const NOW=Date.parse('2026-06-01T00:00:00Z');
const controls={runtime:{live_enabled:true,circuit_open:false},operator:{entry_enabled:true,legacy_entries_retired:true},
  settings:{mode:'LIVE_LIMITED',pause_new_entries:false,withdrawal_mode:false,manual_intervention_required:false,
    scalp_kill_switch:false,emergency_liquidation:false,pause_lock_reason:null}};
const portfolio=(positions=[])=>({exchange:'binance_futures',account_scope:'futures',positions_complete:true,
  positions,total_equity_quote:120,available_quote:100,total_initial_margin_quote:positions.reduce((s,x)=>s+Number(x.initial_margin_quote),0),
  observation:{id:'account-'+Math.random(),source:'BINANCE_ACCOUNT_REST',requested_at_ms:NOW,received_at_ms:NOW}});
const openOrders=(orders=[],algos=[])=>({complete:true,orders,algos,observed_at_ms:NOW});
const base=extra=>({candidateSymbol:'NEXTUSDT',classification:{issues:[],accounting:[]},portfolio:portfolio(),
  openOrders:openOrders(),positions:[],orders:[],quarantines:[],manualSymbols:[],maxSlots:10,proposedMargin:40,
  cashBuffer:.1,requireNativeProtection:true,now:NOW,...controls,...extra});

test('01 exposure-final close with delayed raw fills is symbol accounting work, never an account circuit',()=>{
  const delayed=accountingIssue({id:'close-1',symbol:'OLDUSDT',state:'RECONCILIATION_PENDING',
    response_payload:{v18ExposureFinal:true}},[]),d=evaluateEntryDecision(base({classification:{issues:[],accounting:[delayed]}}));
  assert.equal(delayed.exposureState,'FLAT');assert.equal(delayed.accountingState,'FILL_DETAILS_PENDING');
  assert.equal(d.allowed,true);assert.equal(d.scope,CONTROL_SCOPE.NORMAL);
});

test('02 quantity/exposure and fee settlement are independently representable',()=>{
  const delayed=accountingIssue({id:'fee-1',symbol:'HELDUSDT',state:'RECONCILIATION_PENDING',
    response_payload:{v18ExposureFinal:true}},[{market:'HELDUSDT',quantity:5}]);
  assert.deepEqual([delayed.exposureState,delayed.accountingState],['HELD','FILL_DETAILS_PENDING']);
});

test('03 an unrelated candidate passes a bounded active symbol quarantine',()=>{
  const q={id:'q1',generation:1,kind:'DB_ONLY_POSITION',symbol:'OLDUSDT',status:'OPEN',
    control_scope:'SYMBOL_QUARANTINE',recheck_conditions:['PROVE_EXIT_ATTRIBUTION']};
  const d=evaluateEntryDecision(base({quarantines:[q]}));assert.equal(d.allowed,true);
  assert.deepEqual(d.risk.quarantinedSymbols,['OLDUSDT']);
  const reduceOnly=evaluateEntryDecision(base({openOrders:openOrders([], [{clientAlgoId:'external-stop',symbol:'OLDUSDT',
    side:'SELL',positionSide:'BOTH',reduceOnly:true,orderType:'STOP_MARKET',quantity:4,algoStatus:'NEW'}])}));
  assert.equal(reduceOnly.allowed,true);assert.equal(reduceOnly.discoveredQuarantines[0].symbol,'OLDUSDT');
});

test('04 the quarantined symbol cannot re-enter its unresolved lifecycle',()=>{
  const q={id:'q1',generation:1,kind:'DB_ONLY_POSITION',symbol:'OLDUSDT',status:'OPEN'};
  const d=evaluateEntryDecision(base({candidateSymbol:'OLDUSDT',quarantines:[q]}));
  assert.equal(d.allowed,false);assert.equal(d.scope,CONTROL_SCOPE.SYMBOL_QUARANTINE);
});

test('05 an apparently local mismatch becomes an account hold when exposure cannot be bounded',()=>{
  const issue={kind:'INCOMPLETE_OR_STALE_SNAPSHOT',symbol:'',...operationalIssue({kind:'INCOMPLETE_OR_STALE_SNAPSHOT'})};
  const d=evaluateEntryDecision(base({classification:{issues:[issue],accounting:[]}}));
  assert.equal(d.allowed,false);assert.equal(d.scope,CONTROL_SCOPE.ACCOUNT_ENTRY_HOLD);
  const p=position('RISKUSDT',3,10);p.metadata.exitProtection.orders=[];
  const live=portfolio([{market:'RISKUSDT',side:'LONG',quantity:3,entry_price:10,leverage:3,initial_margin_quote:10}]);
  const unmanaged=evaluateEntryDecision(base({portfolio:live,positions:[p],managementFailures:[{id:p.id,symbol:p.symbol,error:'timeout'}],
    requireNativeProtection:false}));
  assert.equal(unmanaged.allowed,false);assert.equal(unmanaged.scope,CONTROL_SCOPE.ACCOUNT_RISK_BLOCK);
});

test('06 flat positions plus an uncertain entry intent is not flat risk',()=>{
  const order={id:'pending-entry',symbol:'PENDUSDT',intent:'OPEN_LONG',state:'RECONCILIATION_FAILED',response_payload:{}};
  const d=evaluateEntryDecision(base({orders:[order]}));assert.equal(d.allowed,false);
  assert.match(d.reasons[0],/PENDING_ORDER_IDENTITY/);
});

test('07 a terminal native order with pending accounting is actually queried and settled',async()=>{
  let state={version:1,position:{id:'p',strategy:'LEADER_MOMENTUM_V17',symbol:'TERMUSDT',side:'LONG',manual:false,
    remainingQuantity:0,state:'CLOSED',entryPrice:10,settledPnl:-1,realizedPnl:null,accountingPending:true},
    protection:{health:'FILL_ACCOUNTING_PENDING',orders:[{clientId:'stop-1',algoId:'algo-1',status:'FINISHED',terminal:true,
      actualOrderId:'order-1',accountingPending:true,appliedQuantity:5,accountedQuantity:0,appliedFunds:0,appliedFee:0,
      spec:{params:{clientAlgoId:'stop-1',symbol:'TERMUSDT',side:'SELL',positionSide:'BOTH',reduceOnly:'true',
        type:'STOP_MARKET',quantity:5,triggerPrice:9}}}]}};let queried=0;
  const manager=createNativeProtection({clock:()=>NOW,store:{load:async()=>structuredClone(state),
    compareAndSwap:async(_id,v,next)=>{if(v!==state.version)return false;state=structuredClone(next);return true;}},exchange:{
      queryStop:async()=>({clientAlgoId:'stop-1',symbol:'TERMUSDT',side:'SELL',positionSide:'BOTH',reduceOnly:'true',
        orderType:'STOP_MARKET',quantity:5,triggerPrice:9,algoId:'algo-1',algoStatus:'FINISHED',actualOrderId:'order-1'}),
      getFill:async()=>{queried++;return{exact:true,quantity:5,funds:50,fee:.1,status:'FILLED',lastFillAt:NOW,tradeIds:['t1']};}}});
  await manager.refresh('p');assert.equal(queried,1);assert.equal(state.protection.orders[0].accountingPending,false);
  assert.equal(state.position.realizedPnl,-1.1);
});

test('07b a terminal cross-lifecycle order stops polling after exact target attribution',async()=>{
  let state={version:1,position:{id:'source',strategy:'LEADER_MOMENTUM_V17',symbol:'LATEUSDT',side:'LONG',manual:false,
    remainingQuantity:0,state:'CLOSED',entryPrice:10,settledPnl:-1,realizedPnl:-1,accountingPending:false},
    protection:{health:'CROSS_LIFECYCLE_EXECUTION',orders:[{clientId:'late-stop',status:'FINISHED',terminal:true,
      accountingPending:false,crossLifecycleExecution:true,crossLifecycleEvidencePending:true,
      crossLifecycleTargetPositionId:'target',spec:{params:{clientAlgoId:'late-stop',symbol:'LATEUSDT',quantity:5}}}]}};
  let queried=0;const manager=createNativeProtection({clock:()=>NOW,store:{load:async()=>structuredClone(state),
    compareAndSwap:async(_id,v,next)=>{if(v!==state.version)return false;state=structuredClone(next);return true;}},
    exchange:{queryStop:async()=>{queried++;throw Error('must not poll settled lifecycle');}}});
  await manager.refresh('source');assert.equal(queried,0);
});

test('08 unknown/external source is not upgraded to a bot source or fabricated PnL',()=>{
  const issue=operationalIssue({kind:'IDENTITY_OR_SIDE_MISMATCH',symbol:'EXTUSDT',exchangeQuantity:2});
  assert.equal(issue.orderSource,'UNKNOWN');assert.equal(issue.accountingState,'CONFLICT');
  assert.ok(!('realizedPnl' in issue));
});

test('09 partial execution keeps actual residual exposure in the risk model',()=>{
  const p=position('PARTUSDT',7,10),pf=portfolio([{market:'PARTUSDT',side:'LONG',quantity:3,entry_price:10,leverage:3,initial_margin_quote:10}]);
  const c=classifyPortfolio([p],pf,{orders:[{...({id:'entry',signal_id:p.signal_id,position_id:p.id,symbol:p.symbol,
    intent:'OPEN_LONG',state:'FILLED',exchange_order_id:p.metadata.entryOrderId,request_payload:{order:{side:'BUY',position_side:'LONG',position_effect:'OPEN'}}})}],now:NOW});
  assert.equal(c.issues[0].kind,'QUANTITY_MISMATCH');assert.equal(c.issues[0].exchangeQuantity,3);
});

test('10 native/software exit competition has one durable order identity boundary',()=>{
  const source=readFileSync(new URL('../../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8');
  const close=source.slice(source.indexOf('async function closePos('),source.indexOf('async function manageBull('));
  assert.ok(close.indexOf('reconcileNativeCloseBeforeDispatch')<close.indexOf('v11_long_regime_orders").insert'));
});

test('11 timeout risk requires same-order lookup and never authorizes a replacement identity',()=>{
  const issue={kind:'UNKNOWN_ORDER_OUTCOME',symbol:'WAITUSDT',orderId:'o1',...operationalIssue({kind:'UNKNOWN_ORDER_OUTCOME',symbol:'WAITUSDT',orderId:'o1'})};
  assert.equal(issue.controlScope,CONTROL_SCOPE.ACCOUNT_ENTRY_HOLD);
  assert.ok(issue.recheck.includes('QUERY_SAME_ORDER_IDENTITY'));
});

test('12 duplicate, reverse-order and conflicting fills converge or fail deterministically',()=>{
  const a={tradeId:'2',qty:'2',price:'10',commission:'.02',commissionAsset:'USDT',time:2,side:'SELL'},
    b={tradeId:'1',qty:'3',price:'10',commission:'.03',commissionAsset:'USDT',time:1,side:'SELL'};
  const normal=canonicalOrderFills([a,b,a],{expectedQuantity:5,expectedSide:'SELL'}),
    reverse=canonicalOrderFills([b,a],{expectedQuantity:5,expectedSide:'SELL'});
  assert.deepEqual(normal,reverse);assert.equal(normal.exact,true);
  assert.equal(canonicalOrderFills([a,{...a,qty:'4'}],{expectedQuantity:5}).reason,'CONFLICTING_DUPLICATE_TRADE');
});

test('13 cumulative settlement rejects stale-writer regression and quantity overflow',()=>{
  assert.deepEqual(cumulativeFillDelta({previousQuantity:2,previousFunds:20,previousFee:.02,quantity:3,funds:30,fee:.03,maxQuantity:5,maxDelta:3}),
    {quantity:1,funds:10,fee:.009999999999999998});
  assert.throws(()=>cumulativeFillDelta({previousQuantity:3,previousFunds:30,previousFee:.03,quantity:2,funds:20,fee:.02,maxQuantity:5}),/REGRESSION/);
});

test('14 stale/incomplete account response cannot pass as flat',()=>{
  const stale=portfolio();stale.observation.requested_at_ms=NOW-10000;stale.observation.received_at_ms=NOW-10000;
  const d=evaluateEntryDecision(base({portfolio:stale}));assert.equal(d.allowed,false);
  assert.match(d.reasons[0],/INCOMPLETE_OR_STALE/);
});

test('15 an old symbol recovery cannot resolve a superseding incident and never changes operator halt',async()=>{
  const h=harness({signal:false,settings:{pause_new_entries:true}});h.ctx.setLease();
  const one=await h.db.rpc('v19_record_incident',{p_owner:'test-owner',p_kind:'DB_ONLY_POSITION',p_reason:'one',
    p_control_scope:'SYMBOL_QUARANTINE',p_symbol:'CASEUSDT',p_state:{exposureState:'FLAT',accountingState:'ATTRIBUTION_INVESTIGATING',orderSource:'UNKNOWN',recheck:[]},
    p_evidence:{},p_evidence_version:ENTRY_CONTROL_VERSION});
  await h.db.rpc('v19_record_incident',{p_owner:'test-owner',p_kind:'QUANTITY_MISMATCH',p_reason:'two',
    p_control_scope:'SYMBOL_QUARANTINE',p_symbol:'CASEUSDT',p_state:{exposureState:'HELD',accountingState:'CONFLICT',orderSource:'UNKNOWN',recheck:[]},
    p_evidence:{},p_evidence_version:ENTRY_CONTROL_VERSION});
  const old=await h.db.rpc('v19_symbol_recovery_observation',{p_owner:'test-owner',p_incident_id:one.data.id,
    p_generation:one.data.generation,p_evidence_version:ENTRY_CONTROL_VERSION,p_evidence:{}});
  assert.equal(old.data.reason,'INCIDENT_CAS_MISS');assert.equal(h.state.tables.trading_settings[0].pause_new_entries,true);
});

test('16 local settlement delays and a bounded manager error do not consume protection or entry work',async()=>{
  const live=position('SAFEUSDT',3,10),h=harness({positions:[live]});h.state.quotes.SAFEUSDT=Error('quote timeout');
  for(let n=0;n<8;n++)h.state.tables.v11_long_regime_orders.push({id:'fee-'+n,symbol:`OLD${n}USDT`,intent:'CLOSE_LONG',
    state:'RECONCILIATION_PENDING',response_payload:{v18ExposureFinal:true},updated_at:new Date(NOW+n).toISOString(),created_at:new Date(NOW+n).toISOString()});
  h.state.createOrder=(cmd,state)=>({order:{orderId:'bounded-no-fill',clientOrderId:cmd.order.identifier,
    symbol:cmd.order.market,side:'BUY',positionSide:'BOTH',reduceOnly:false,origQty:String(cmd.order.quantity),
    executedQty:'0',status:'EXPIRED',avgPrice:'0',updateTime:state.now,fills:[]}});
  const result=await h.ctx.runCycle();
  assert.ok(h.state.calls.findIndex(x=>x.action==='p10_quotes')<h.state.calls.findIndex(x=>x.action==='get_order'));
  assert.equal(h.state.calls.filter(x=>x.action==='create_order').length,1);
  assert.equal(result.entry.entered,false);assert.equal(h.state.tables.v11_long_regime_runtime[0].circuit_open,false);
});

test('17 an inspection without settlement does not advance reconciliation-success telemetry',async()=>{
  const p=position('AUDITUSDT',3,10),h=harness({positions:[p],signal:false});h.state.exchange=[];
  const rt=h.state.tables.v11_long_regime_runtime[0];rt.last_reconciliation_success_at='old';await h.ctx.runCycle();
  assert.equal(rt.last_reconciliation_success_at,'old');assert.ok(h.state.tables.v18_ops_incidents.some(x=>x.symbol==='AUDITUSDT'));
});

test('18 approved QV3, V19 entry control, margin, leverage, slots and V20 audit patch identity remain pinned',()=>{
  const source=readFileSync(new URL('../../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8');
  assert.match(source,/const MARGIN=40,LEV=3,[^;]*MAX_SLOTS=10/);assert.match(source,/QV3_ENTRY_EXIT_TWO_1|QV3_VERSION/);
  assert.equal(ENTRY_CONTROL_VERSION,'V19-SCOPE-AWARE-ENTRY-1');
  assert.match(source,/PATCH="V20-QV3-EVIDENCE-1"/);assert.match(source,/p_evidence_version:ENTRY_CONTROL_VERSION/);
});

test('18b normal entry sizing, stop and hold decision equal the deployed production basis',async()=>{
  const make=sourceRef=>{const h=harness({sourceRef});h.state.entryQuote={best_bid:.6129,best_ask:.613};
    h.state.tables.v11_long_regime_signals[0].symbol='EDGEUSDT';h.state.tables.v11_long_regime_signals[0].features.referenceClose=.613;
    h.state.tables.v11_long_regime_signals[0].features.atr=.01;
    h.state.createOrder=(cmd,state)=>{state.exchange=[{market:'EDGEUSDT',side:'LONG',quantity:196,entry_price:.613}];
      return{order:{orderId:'entry-exact',clientOrderId:cmd.order.identifier,symbol:'EDGEUSDT',side:'BUY',positionSide:'BOTH',
        reduceOnly:false,origQty:String(cmd.order.quantity),executedQty:String(cmd.order.quantity),status:'FILLED',avgPrice:'.613',
        updateTime:state.now,fills:[{tradeId:'entry-trade',qty:String(cmd.order.quantity),price:'.613',commission:'.06',
          commissionAsset:'USDT',time:state.now,side:'BUY'}]}};};return h;};
  const before=make(PRODUCTION_BASIS),after=make(null),oldRun=await before.ctx.runCycle(),newRun=await after.ctx.runCycle(),
    oldCmd=before.state.calls.find(x=>x.action==='create_order'),newCmd=after.state.calls.find(x=>x.action==='create_order'),
    oldPosition=before.state.tables.v11_long_regime_positions[0],newPosition=after.state.tables.v11_long_regime_positions[0];
  assert.deepEqual({quantity:newCmd.order.quantity,price:newCmd.order.price,leverage:newCmd.leverage},
    {quantity:oldCmd.order.quantity,price:oldCmd.order.price,leverage:oldCmd.leverage});
  assert.deepEqual({quantity:newPosition.remaining_quantity,entry:newPosition.entry_price,stop:newPosition.hard_stop_price},
    {quantity:oldPosition.remaining_quantity,entry:oldPosition.entry_price,stop:oldPosition.hard_stop_price});
  assert.equal(newRun.entry.entered,oldRun.entry.entered);
  const oldHold=harness({sourceRef:PRODUCTION_BASIS,positions:[position('HOLDUSDT',3,10)],signal:false}),
    newHold=harness({positions:[position('HOLDUSDT',3,10)],signal:false});
  oldHold.state.quotes.HOLDUSDT=10.05;newHold.state.quotes.HOLDUSDT=10.05;
  const oldHeld=await oldHold.ctx.runCycle(),newHeld=await newHold.ctx.runCycle(),
    oldHeldPosition=oldHold.state.tables.v11_long_regime_positions[0],newHeldPosition=newHold.state.tables.v11_long_regime_positions[0];
  assert.deepEqual({action:newHeld.managed[0].action.action,reason:newHeld.managed[0].action.reason,
    peak:newHeldPosition.peak_price,stop:newHeldPosition.hard_stop_price},
    {action:oldHeld.managed[0].action.action,reason:oldHeld.managed[0].action.reason,
      peak:oldHeldPosition.peak_price,stop:oldHeldPosition.hard_stop_price});
});
