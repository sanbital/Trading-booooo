// Dynamic multi-slot entry capacity (entry-capacity.mjs). The queue behaviour (sequential
// admission, re-reads after fills, QNT/TRB) is exercised against the executor's real loop in
// test-support/v17-exit/entry-queue.test.mjs; this file pins the arithmetic and the accounting.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ENTRY_CAPACITY_VERSION,UNUSED_SLOT_REASON as R,ACCOUNT_SCOPED_REASONS,accountStopReason,budgetCovers,entryCapacity,ledgerEntry,
  slotCostUsdt,slotReasonOf,unusedSlotAccounting} from './entry-capacity.mjs';
import {SLOT_SIZING_CONTRACT,slotSizingBounds} from '../_shared/leader-slot-sizing.mjs';
import {evaluateEntryDecision} from '../_shared/leader-entry-control.mjs';

const src=readFileSync(new URL('./index.ts',import.meta.url),'utf8');
const FEE=Number(src.match(/takerFeeRate:([\d.]+),iocMaxBps:IOC_MAX_BPS/)[1]);
const COST=slotCostUsdt({maxOrderMarginUsdt:slotSizingBounds().maxOrderMarginUsdt,leverage:SLOT_SIZING_CONTRACT.leverage,
  takerFeeRate:FEE,iocMaxBps:SLOT_SIZING_CONTRACT.iocMaxBps});
const cap=(liveAvailableUsdt,extra={})=>entryCapacity({maxSlots:10,slotCost:COST,cashBufferUsdt:.1,liveAvailableUsdt,...extra});

test('slot cost: the 150 USDT slot at its lot-step ceiling, plus taker fee and IOC price-cap open loss',()=>{
  assert.equal(SLOT_SIZING_CONTRACT.targetMarginUsdt,150);
  assert.equal(slotSizingBounds().maxOrderMarginUsdt,151.25);
  assert.equal(FEE,.0005);
  assert.ok(Math.abs(COST-151.25*(1+3*(.0005+.0012)))<1e-12);
  assert.throws(()=>slotCostUsdt({maxOrderMarginUsdt:0,leverage:3,takerFeeRate:0,iocMaxBps:0}),/SLOT_COST_INVALID/);
  assert.throws(()=>entryCapacity({maxSlots:0,slotCost:COST,cashBufferUsdt:.1,liveAvailableUsdt:1}),/CONFIG_INVALID/);
});

test('capacity table: 149/150+buffer/345/470/620/1000/1500/1520.32/ample, MAX_SLOTS 10',()=>{
  const table=[[149,0],[150,0],[152.13,1],[345,2],[470,3],[620,4],[1_000,6],[1_500,9],[1_520.32,10],[50_000,10]];
  for(const [available,expected] of table){
    const c=cap(available);
    assert.equal(c.capacity,expected,`${available}`);
    assert.equal(c.version,ENTRY_CAPACITY_VERSION);
    // A slot is never shrunk to fit: the margin a capacity of N implies is N full slots.
    assert.ok(expected*COST+.1<=available+1e-9);
    if(expected<10)assert.ok((expected+1)*COST+.1>available,'one more full slot does not fit');
  }
  assert.equal(cap(149).reason,R.INSUFFICIENT_MARGIN);
  assert.equal(cap(50_000).reason,null);
});

test('used slots are the union by symbol of exchange, DB, unresolved entry orders and the run ledger',()=>{
  const c=cap(5_000,{livePositions:[{symbol:'AUSDT',quantity:1},{symbol:'ZEROUSDT',quantity:0}],
    dbPositions:[{symbol:'AUSDT',state:'OPEN'},{symbol:'BUSDT',state:'OPEN'},{symbol:'OLDUSDT',state:'CLOSED'}],
    orders:[{id:1,symbol:'CUSDT',intent:'OPEN_LONG',state:'RECONCILIATION_PENDING',response_payload:{}},
      {id:2,symbol:'DUSDT',intent:'OPEN_LONG',state:'FILLED',response_payload:{}}],
    quarantinedOrderIds:['1'],
    ledger:[{symbol:'EUSDT',marginUsdt:150,at:1}]});
  assert.deepEqual(c.usedSymbols,['AUSDT','BUSDT','CUSDT','EUSDT']);
  assert.equal(c.usedSlots,4);assert.equal(c.slotRoom,6);
  assert.equal(c.pendingEntryOrders,1);assert.equal(c.holdOrders,0,'a quarantined order does not hold the account');
});

test('free margin: the lower of live (less unseen ledger fills) and snapshot (less fills after its capture), less pending reserve',()=>{
  const ledger=[ledgerEntry({symbol:'AUSDT',sizedMarginUsdt:150,entryFinality:{respondedAt:1_000}},9_999)];
  assert.equal(ledger[0].at,1_000,'dated by the exchange answer, not the booking time');
  // Live shows the fill; a snapshot captured before it does not.
  const seen=cap(200,{livePositions:[{symbol:'AUSDT',quantity:1}],snapshot:{availableUsdt:350,capturedAtMs:900},ledger});
  assert.equal(seen.freeMarginUsdt,200);assert.equal(seen.snapshotAvailableUsdt,200);
  // Neither view shows it yet: the ledger takes it off both.
  const lagging=cap(350,{snapshot:{availableUsdt:350,capturedAtMs:900},ledger});
  assert.equal(lagging.unseenLedgerMarginUsdt,150);assert.equal(lagging.freeMarginUsdt,200);assert.equal(lagging.capacity,1);
  // A snapshot captured after the answer already contains the fill.
  const later=cap(200,{livePositions:[{symbol:'AUSDT',quantity:1}],snapshot:{availableUsdt:200,capturedAtMs:1_001},ledger});
  assert.equal(later.freeMarginUsdt,200);assert.equal(later.capacity,1);
  // Without exchange evidence the booking time is used, which can only count the fill twice.
  assert.equal(ledgerEntry({symbol:'x',sizedMarginUsdt:10},5).at,5);
  // A partial fill books its actual margin.
  assert.equal(ledgerEntry({symbol:'x',sizedMarginUsdt:60.5},5).marginUsdt,60.5);
});

test('unreadable live margin is an account safety block, never capacity',()=>{
  const c=cap(undefined);assert.equal(c.capacity,0);assert.equal(c.reason,R.ACCOUNT_SAFETY_BLOCK);
  assert.equal(c.detail,'AVAILABLE_BALANCE_UNREADABLE');
});

// The same predicate as the entry control's PENDING_ORDER_IDENTITY account hold.
function controlHolds(orders,issues){
  const now=Date.now();
  const d=evaluateEntryDecision({candidateSymbol:'NEWUSDT',classification:{issues,accounting:[]},
    portfolio:{exchange:'binance_futures',account_scope:'futures',positions_complete:true,positions:[],available_quote:5_000,
      total_equity_quote:5_000,total_initial_margin_quote:0,observation:{id:'o',source:'BINANCE_ACCOUNT_REST',requested_at_ms:now,received_at_ms:now}},
    openOrders:{complete:true,orders:[],algos:[],observed_at_ms:now},orders,
    runtime:{live_enabled:true},operator:{entry_enabled:true,legacy_entries_retired:true},
    settings:{mode:'LIVE_LIMITED',pause_new_entries:false,withdrawal_mode:false,manual_intervention_required:false,
      scalp_kill_switch:false,emergency_liquidation:false,pause_lock_reason:null},
    maxSlots:10,proposedMargin:150,cashBuffer:.1,requireNativeProtection:false,now});
  return d.reasons.some(r=>r.startsWith('PENDING_ORDER_IDENTITY'));
}
test('the account hold mirrors the entry control exactly (PENDING_ORDER_IDENTITY)',()=>{
  const cases=[];
  for(const state of ['PLANNED','DISPATCHED','RECONCILIATION_PENDING','RECONCILIATION_FAILED','FILLED','CANCELED','REJECTED'])
    for(const final of [false,true])for(const intent of ['OPEN_LONG','CLOSE_LONG'])for(const quarantined of [false,true])
      cases.push({state,final,intent,quarantined});
  for(const k of cases){
    const order={id:'o1',symbol:'XUSDT',intent:k.intent,state:k.state,response_payload:k.final?{v18ExposureFinal:true}:{}};
    const issues=k.quarantined?[{kind:'UNKNOWN_ORDER_OUTCOME',symbol:'XUSDT',orderId:'o1',controlScope:'SYMBOL_QUARANTINE'}]:[];
    const c=cap(5_000,{orders:[order],quarantinedOrderIds:k.quarantined?['o1']:[]});
    assert.equal(c.holdOrders>0,controlHolds([order],issues),JSON.stringify(k));
    if(c.holdOrders>0){assert.equal(c.capacity,0);assert.equal(c.reason,R.PENDING_CAPITAL_RESERVED);}
  }
});

test('reasons: exactly one per zero-capacity cause, in order of precedence',()=>{
  const pending={id:'o',symbol:'P',intent:'OPEN_LONG',state:'DISPATCHED',response_payload:{}};
  assert.equal(cap(5_000,{orders:[pending]}).reason,R.PENDING_CAPITAL_RESERVED);
  const ten=Array.from({length:10},(_,i)=>({symbol:`S${i}`,quantity:1}));
  assert.equal(cap(5_000,{livePositions:ten}).reason,R.MAX_SLOTS_REACHED);
  assert.equal(cap(5_000,{livePositions:ten}).detail,'10/10');
  // Enough margin for one slot, but an unresolved entry order under quarantine holds it back.
  const c=cap(200,{orders:[pending],quarantinedOrderIds:['o']});
  assert.equal(c.capacity,0);assert.equal(c.reason,R.PENDING_CAPITAL_RESERVED);assert.match(c.detail,/^PENDING_ENTRY_MARGIN:1$/);
  assert.equal(cap(100).reason,R.INSUFFICIENT_MARGIN);assert.equal(cap(100).detail,'100.00<152.13');
});

test('slotReasonOf maps every refusal the queue can see to one of the six reasons',()=>{
  const map={
    'ENTRY_MARGIN_INSUFFICIENT:120.0000:150.2000':R.INSUFFICIENT_MARGIN,
    'ENTRY_CONTROL:ACCOUNT_ENTRY_HOLD:ACCOUNT_MARGIN_LIMIT':R.INSUFFICIENT_MARGIN,
    'EXECUTION_SAFETY_REJECT:INSUFFICIENT_MARGIN':R.INSUFFICIENT_MARGIN,
    'V11_SLOT_FULL':R.MAX_SLOTS_REACHED,'ENTRY_CONTROL:ACCOUNT_ENTRY_HOLD:ACCOUNT_SLOT_LIMIT':R.MAX_SLOTS_REACHED,
    'ENTRY_CONTROL:ACCOUNT_ENTRY_HOLD:PENDING_ORDER_IDENTITY:42':R.PENDING_CAPITAL_RESERVED,
    'ENTRY_CONTROL:ACCOUNT_ENTRY_HOLD:LIVE_ORDINARY_ORDER:X:1':R.PENDING_CAPITAL_RESERVED,
    'ENTRY_CONTROL:ACCOUNT_RISK_BLOCK:ACCOUNT_CIRCUIT:X':R.ACCOUNT_SAFETY_BLOCK,
    'ENTRY_CONTROL:OPERATOR_HALT:OPERATOR_ENTRY_CONTROL':R.ACCOUNT_SAFETY_BLOCK,
    'PORTFOLIO_CHANGED':R.ACCOUNT_SAFETY_BLOCK,'PORTFOLIO_CHANGED_DURING_E1':R.ACCOUNT_SAFETY_BLOCK,
    'GPT_FINAL_RECHECK_SKIP':R.NO_VALID_GPT_BUY,'GPT_REVIEW_EXPIRED':R.NO_VALID_GPT_BUY,'GPT_TRIGGER_EXPIRED':R.NO_VALID_GPT_BUY,
    'E1_DISPATCH_QUOTE_AGED:1400':R.EXECUTION_SAFETY_REJECT,'ENTRY_SPREAD:41':R.EXECUTION_SAFETY_REJECT,
    'IOC_NO_FILL:CANCELED':R.EXECUTION_SAFETY_REJECT,'IOC_RETRY_EXHAUSTED:CYCLE_BUDGET_RESERVE':R.EXECUTION_SAFETY_REJECT,
    'ENTRY_CONTROL:SYMBOL_QUARANTINE:X':R.EXECUTION_SAFETY_REJECT,'SLOT_UNAVAILABLE:DUPLICATE_SYMBOL_OPEN':R.EXECUTION_SAFETY_REJECT,
    'V17_TRIGGER_STALE':R.EXECUTION_SAFETY_REJECT,'BOO_ENTRY_GATE:X':R.EXECUTION_SAFETY_REJECT};
  for(const [reason,expected] of Object.entries(map))assert.equal(slotReasonOf(reason),expected,reason);
  // An account-scoped stop is never read as "no valid BUY", whatever its text says.
  assert.equal(accountStopReason('ENTRY_MARGIN_INSUFFICIENT:1:2'),R.INSUFFICIENT_MARGIN);
  assert.equal(accountStopReason('V11_SLOT_FULL'),R.MAX_SLOTS_REACHED);
  assert.equal(accountStopReason('SOMETHING_UNLABELLED'),R.ACCOUNT_SAFETY_BLOCK);
  assert.equal(accountStopReason('GPT_REVIEW_EXPIRED'),R.ACCOUNT_SAFETY_BLOCK);
  assert.deepEqual([...ACCOUNT_SCOPED_REASONS].sort(),[R.ACCOUNT_SAFETY_BLOCK,R.INSUFFICIENT_MARGIN,R.MAX_SLOTS_REACHED,R.PENDING_CAPITAL_RESERVED].sort());
});

test('unused-slot accounting always sums to the empty slots, one reason each',()=>{
  const sum=u=>Object.values(u.byReason).reduce((a,b)=>a+b,0);
  // 3 held, 470 USDT free (3 fundable of 7 empty), 1 execution refusal, no stop.
  const held=[{symbol:'A',quantity:1},{symbol:'B',quantity:1},{symbol:'C',quantity:1}];
  const c=cap(470,{livePositions:held});
  const u=unusedSlotAccounting(c,{refusals:[R.EXECUTION_SAFETY_REJECT]});
  assert.equal(u.free,7);assert.equal(sum(u),7);
  assert.deepEqual(u.byReason,{[R.INSUFFICIENT_MARGIN]:4,[R.EXECUTION_SAFETY_REJECT]:1,[R.NO_VALID_GPT_BUY]:2});
  // An account-scoped stop takes every fundable slot.
  assert.deepEqual(unusedSlotAccounting(c,{stop:{reason:R.ACCOUNT_SAFETY_BLOCK,detail:'x'},refusals:[R.EXECUTION_SAFETY_REJECT]}).byReason,
    {[R.INSUFFICIENT_MARGIN]:4,[R.ACCOUNT_SAFETY_BLOCK]:3});
  // A budget stop explains as many slots as BUYs it did not reach.
  assert.deepEqual(unusedSlotAccounting(c,{stop:{reason:R.EXECUTION_SAFETY_REJECT,detail:'CYCLE_BUDGET_RESERVE'},unreached:2}).byReason,
    {[R.INSUFFICIENT_MARGIN]:4,[R.EXECUTION_SAFETY_REJECT]:2,[R.NO_VALID_GPT_BUY]:1});
  // A held account: every empty slot waits on the pending order.
  const pending=cap(5_000,{orders:[{id:'o',symbol:'P',intent:'OPEN_LONG',state:'DISPATCHED',response_payload:{}}]});
  assert.deepEqual(unusedSlotAccounting(pending).byReason,{[R.PENDING_CAPITAL_RESERVED]:9});
  // Full book: nothing is empty.
  const ten=Array.from({length:10},(_,i)=>({symbol:`S${i}`,quantity:1}));
  assert.deepEqual(unusedSlotAccounting(cap(5_000,{livePositions:ten})),{free:0,byReason:{},stop:null});
  // Unreadable account.
  assert.deepEqual(unusedSlotAccounting(cap(undefined)).byReason,{[R.ACCOUNT_SAFETY_BLOCK]:10});
});

test('budgetCovers: time AND gateway calls must both cover the reserve; no budget defers to the wall clock',()=>{
  assert.equal(budgetCovers(null,{ms:20000,calls:26}),true);
  assert.equal(budgetCovers({remaining:()=>20000,callsLeft:26},{ms:20000,calls:26}),true);
  assert.equal(budgetCovers({remaining:()=>19999,callsLeft:160},{ms:20000,calls:26}),false);
  assert.equal(budgetCovers({remaining:()=>55000,callsLeft:25},{ms:20000,calls:26}),false);
});

test('the executor wires the capacity: operator MAX_SLOTS, the 0.10 cash buffer, reserves that fit one cycle budget',()=>{
  assert.match(src,/const ENTRY_SLOT_COST_USDT=slotCostUsdt\(\{maxOrderMarginUsdt:MAX_ORDER_MARGIN_USDT,leverage:LEV,takerFeeRate:\.0005,iocMaxBps:IOC_MAX_BPS\}\);/);
  assert.match(src,/entryCapacity\(\{maxSlots:MAX_SLOTS,slotCost:ENTRY_SLOT_COST_USDT,cashBufferUsdt:ENTRY_CASH_BUFFER_USDT,\.\.\.view,ledger\}\)/);
  const [,ms,calls]=src.match(/const ENTRY_ATTEMPT_RESERVE=Object\.freeze\(\{ms:(\d+),calls:(\d+)\}\);/).map(Number);
  const [,rms,rcalls]=src.match(/const IOC_RETRY_RESERVE=Object\.freeze\(\{ms:(\d+),calls:(\d+)\}\);/).map(Number);
  const [,lms,lcalls]=src.match(/cycleBudgets\.set\(db,createBudget\(\{ms:(\d+),calls:(\d+)\}\)\)/).map(Number);
  assert.ok(ms<lms&&calls<lcalls&&rms<ms&&rcalls<calls);
  // The retry guard sits before the retry's first gateway read.
  const guard=src.indexOf('if(!budgetCovers(cycleBudgets.get(db),IOC_RETRY_RESERVE))'),point=src.indexOf('let retryAt=Date.now(),[retryQuote0,retryTape]');
  assert.ok(guard>0&&point>guard);
  // No fixed per-run attempt count, and no literal slot count anywhere in the capacity code.
  assert.ok(!/ENTRY_ATTEMPTS_PER_RUN/.test(src));
  const mod=readFileSync(new URL('./entry-capacity.mjs',import.meta.url),'utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*$/gm,'');
  assert.ok(!/\b(2|3|4|10)\b\s*[;,)]/.test(mod.replace(/10_000/g,'').replace(/toFixed\(\d+\)/g,'')),'no hard-coded slot count in the capacity module');
});
