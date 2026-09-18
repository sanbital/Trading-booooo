import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {entryExecutionWindow,normalizeEntryBook,gatewayTakerFeeRate,supportedFuturesMode,entryPriceEvidence} from './entry-evidence.mjs';
import {SETUP_POLICY as P, entryTriggerFresh} from '../_shared/leader-pullback-reaccel.mjs';
import {POLICY,STRATEGY,entryFresh} from '../_shared/leader-momentum-v17.mjs';
import {E1_POLICY,startE1,advanceE1} from '../_shared/leader-e1-runtime.mjs';
import {evaluateBooEntry,finalizeBooEntry} from './boo-entry-adapter.mjs';

const T=Date.parse('2026-09-18T00:55:00Z');
function signal() {
  const s={id:'test-drift',symbol:'DRIFTUSDT',features:{strategy:STRATEGY,signal5Close:T,referenceClose:.01879}};
  s.features.v17Setup={policyVersion:P.version,state:'TRIGGERED',signalId:s.id,symbol:s.symbol,
    identity:`${P.version}:${s.symbol}:${s.id}:${T}`,signal5Close:T,armedAt:T,
    referencePrice:.01879,expiresAt:T+P.setupTtlMs,triggerAt:T+9*60000,triggerExpiresAt:T+10*60000,
    triggerClose:.0189,pullbackObserved:true};
  return s;
}
const windowFor=(s)=>entryExecutionWindow(s,true,POLICY.maxEntryAgeMs,P);
function quote(now=T) {return {best_bid:100,best_ask:101,bids:[{price:'100',size:'10'},{price:'99',size:'20'}],
  asks:[{price:'101',size:'10'},{price:'102',size:'20'}],raw:{symbol:'TEST'},
  timing:{requested_at_ms:now-200,received_at_ms:now-100}};}
function mode(now=T,dual=false) {return {exchange:'binance_futures',account_scope:'futures',
  dual_side_position:dual,position_mode:dual?'HEDGE':'ONE_WAY',
  observation:{id:'test-observation',source:'BINANCE_POSITION_MODE_REST',requested_at_ms:now-150,received_at_ms:now-100}};}

test('a nine-minute pullback trigger gets its own 60s window, not an expired 120s signal',()=>{
  const w=windowFor(signal());assert.equal(w.valid,true);assert.equal(w.startsAt,T+540000);
  assert.equal(w.expiresAt,T+600000);assert.equal(w.featureAsOf,T);
});
test('setup expiration bounds even a late trigger window',()=>{
  const s=signal();s.features.v17Setup.triggerAt=T+P.setupTtlMs-30000;
  s.features.v17Setup.triggerExpiresAt=s.features.v17Setup.triggerAt+P.entryTriggerTtlMs;
  assert.equal(windowFor(s).expiresAt,T+P.setupTtlMs);
});
test('legacy retains its 120s clock and ignores unowned setup fields',()=>{
  assert.deepEqual(entryExecutionWindow(signal(),false,120000,P),
    {valid:true,basis:'LEGACY_SIGNAL',featureAsOf:T,startsAt:T,expiresAt:T+120000});
});
for (const [label,change] of [
  ['missing setup',s=>delete s.features.v17Setup],
  ['wrong policy',s=>s.features.v17Setup.policyVersion='OTHER'],
  ['untriggered setup',s=>s.features.v17Setup.state='ARMED'],
  ['wrong symbol',s=>s.features.v17Setup.symbol='BTCUSDT'],
  ['wrong signal',s=>s.features.v17Setup.signalId='OTHER'],
  ['wrong identity',s=>s.features.v17Setup.identity='OTHER'],
  ['rebased arm',s=>s.features.v17Setup.armedAt=T+60000],
  ['rebased reference',s=>s.features.v17Setup.referencePrice=.05],
  ['extended setup',s=>s.features.v17Setup.expiresAt+=60000],
  ['extended trigger',s=>s.features.v17Setup.triggerExpiresAt+=60000],
  ['null trigger',s=>s.features.v17Setup.triggerAt=null],
  ['string false pullback',s=>s.features.v17Setup.pullbackObserved='false'],
]) test(`invalid evidence cannot gain an execution window: ${label}`,()=>{
  const s=signal();change(s);assert.equal(windowFor(s).valid,false);
});

test('normalized gateway depth is used even when raw has no depth',()=>{
  const b=normalizeEntryBook(quote(),1000,T);assert.equal(b.health.bookHealthy,true);
  assert.deepEqual(b.asks,[['101','10'],['102','20']]);
});
test('raw-only REST arrays remain compatible',()=>{
  const q=quote();q.raw={asks:[['101','10']],bids:[['100','10']]};delete q.asks;delete q.bids;
  assert.equal(normalizeEntryBook(q,1000,T).health.bookHealthy,true);
});
for (const [label,change] of [
  ['missing depth',q=>delete q.asks],['malformed normalized side',q=>{q.raw={asks:[['101','5']]};q.asks=null;}],
  ['zero size',q=>q.asks[0].size=0],['infinite price',q=>q.asks[0].price=Infinity],
  ['unsorted book',q=>q.asks.reverse()],['mismatched top',q=>q.best_bid=98],
  ['crossed book',q=>q.best_bid=102],['future quote',q=>q.timing.received_at_ms=T+1],
  ['stale quote',q=>{q.timing.received_at_ms=T-1001;q.timing.requested_at_ms=T-1200;}],
  ['missing timestamp',q=>delete q.timing.received_at_ms],['explicit gap',q=>q.bookGap=true],
]) test(`unhealthy book stays blocked: ${label}`,()=>{
  const q=quote();change(q);assert.equal(normalizeEntryBook(q,1000,T).health.bookHealthy,false);
});

test('percent fee 0.05 becomes fraction 0.0005 exactly once',()=>{
  assert.equal(gatewayTakerFeeRate({exchange:'binance_futures',market:'XUSDT',source:'futures_commission_rate',taker_pct:.05},'XUSDT'),.0005);
});
test('explicit reported zero fee is valid, absent/null/boolean is not',()=>{
  const base={exchange:'binance_futures',market:'XUSDT',source:'futures_commission_rate'};
  assert.equal(gatewayTakerFeeRate({...base,taker_pct:0},'XUSDT'),0);
  for(const x of [null,'',false,undefined,NaN,Infinity,-1])
    assert.equal(gatewayTakerFeeRate({...base,taker_pct:x},'XUSDT'),undefined);
});
test('conflicting fee units or different symbol fail closed',()=>{
  const f={exchange:'binance_futures',market:'XUSDT',source:'futures_commission_rate',taker_pct:.05,taker:.05};
  assert.equal(gatewayTakerFeeRate(f,'XUSDT'),undefined);
  assert.equal(gatewayTakerFeeRate({...f,taker:.0005},'OTHERUSDT'),undefined);
});
test('mode requires explicit recent authenticated one-way evidence',()=>{
  assert.equal(supportedFuturesMode(mode(),T),true);
  for(const m of [null,{},mode(T,true),{...mode(),dual_side_position:'false'},
    {...mode(),position_mode:'HEDGE'},mode(T-4000),mode(T+500),
    {...mode(),observation:{...mode().observation,source:'ASSUMED'}}])
    assert.equal(supportedFuturesMode(m,T),false);
});

const source=await readFile(new URL('./index.ts',import.meta.url),'utf8');
function functionSource(name) {
  const re=new RegExp(`^(?:async )?function ${name}\\(`,'m');const found=re.exec(source);
  assert.ok(found,`missing ${name}`);const start=found.index;
  const next=source.slice(start+1).search(/\n(?:async function |function |const |let |Deno\.serve)/);
  return next<0?source.slice(start):source.slice(start,start+1+next);
}
function host(now) {
  const ctx={entryExecutionWindow,normalizeEntryBook,entryPriceEvidence,entryTriggerFresh,
    SETUP_POLICY:P,SETUP_REASON:{NOT_TRIGGERED:'V17_SETUP_NOT_TRIGGERED',TRIGGER_FUTURE:'V17_TRIGGER_FUTURE',TRIGGER_STALE:'V17_TRIGGER_STALE'},
    POLICY,STRATEGY,entryFresh,setupGoverns:s=>s.features.signal5Close>=Date.parse('2026-09-17T00:00:00Z'),
    signalSetup:s=>s.features.v17Setup,rec:x=>x??{},N:(x,d=0)=>Number.isFinite(Number(x))?Number(x):d,
    Date:{now:()=>now},E1_POLICY,startE1,advanceE1,hashJson:async()=> 'test-hash',
    fetchE1AggTrades:async()=>({available:true,raw:[],startAt:now-10000,endAt:now,
      tradeCount:20,last10sReturn:.001,takerBuyQuoteShare:.8}),
    e1CurrentAssessment:(_s,q)=>({rawQuote:q,quote:{bid:100,ask:101,receivedAt:now-100,bookGap:false,
      sourceTier:'RECEIVED_REST_L2_100',quoteAgeMs:100},guardPassed:true,liquidityPassed:true})};
  vm.createContext(ctx);
  for(const n of ['executionWindowFor','entryFreshFor','checkedEntryFresh','runE1Gate'])
    vm.runInContext(functionSource(n),ctx);
  return ctx;
}
test('real runE1Gate accepts a valid fresh trigger after the original signal expired',async()=>{
  const s=signal(),now=T+540008,ctx=host(now),commands=[];
  const result=await ctx.runE1Gate(s,quote(now),1,async c=>{commands.push(c.action);return quote(now);});
  assert.equal(result.decision.allowed,true);assert.equal(result.decision.expiresAt,T+600000);
  assert.deepEqual(commands,['quote']);
});
test('real runE1Gate does not resurrect an expired trigger',async()=>{
  const ctx=host(T+600001);
  const r=await ctx.runE1Gate(signal(),quote(),1,async()=>quote());
  assert.equal(r.decision.allowed,false);assert.equal(r.decision.confirmationState,'EXPIRED');
});
test('real price gate keeps both sides of the original 1% drift limit',()=>{
  const s=signal(),now=T+540010,ctx=host(now);
  assert.equal(ctx.entryFreshFor(s,s.features,now,.0189),null);
  assert.equal(ctx.entryFreshFor(s,s.features,now,.0191),'V17_ENTRY_DRIFT');
  assert.equal(ctx.entryFreshFor(s,s.features,now,.0185),'V17_ENTRY_DRIFT');
  assert.equal(ctx.entryFreshFor(s,s.features,T+600000,.0189),'V17_TRIGGER_STALE');
});
test('actual rejected limit price, original reference and audit stage are retained',()=>{
  const s=signal(),now=T+540010,ctx=host(now),attempt={};
  assert.equal(ctx.checkedEntryFresh(s,s.features,now,.0191,attempt,'ADMISSION_PRICE',quote(now)),'V17_ENTRY_DRIFT');
  const d=attempt.entryPriceCheck;assert.equal(d.evaluatedPrice,.0191);
  assert.equal(d.referencePrice,.01879);assert.equal(d.priceBasis,'ORDER_LIMIT');
  assert.equal(d.finalAdmission,false);assert.equal(d.orderDispatched,false);
  assert.ok(d.evaluatedPrice>d.upperAllowedPrice);
});
test('setup transition is explicitly not a final entry approval',()=>{
  const transition=functionSource('advanceSignalSetup');
  assert.ok(transition.includes('finalAdmission:false'));
  assert.ok(!transition.includes('"ENTRY_ALLOW"'));
  assert.ok(source.includes('stage:"PRE_ORDER_REJECTION"'));
  assert.ok(source.includes('attempt.booAdmission={enforcement:booAdmission.enforcement,blocks:booAdmission.blocks'));
});

test('OBSERVE diagnostics never masquerade as an enforcing block',()=>{
  const deny={allowed:false,reason:'VALIDATION_RECORD_MISSING'};
  assert.equal(finalizeBooEntry({verdict:deny},{verdict:deny,enforcement:'OBSERVE'}).blocks,false);
  assert.equal(finalizeBooEntry({verdict:deny},{verdict:deny,enforcement:'ENFORCE'}).blocks,true);
});
test('unknown commission causes explicit SKIP, not a fabricated fee or planning exception',()=>{
  const result=evaluateBooEntry({phase:'ADMISSION',now:T,
    gateContext:{enforcement:'ENFORCE',approval:null,controlReadOk:true,approvalReadOk:true},runningIdentity:{},
    settings:{risk_per_trade_pct:.25,max_daily_loss_pct:1},runtime:{live_enabled:true},operatorControl:{entry_enabled:true},
    signal:{strategy:{eligible:true},filters:{},structuralStop:'99'},book:{asks:[],bids:[],health:{}},
    account:{equity:'100',realizedToday:'0',realizedThisWeek:'0',highWaterEquity:null,consecutiveLosses:0,
      modeSupported:true,protectionSupported:true},fees:{takerFeeRate:undefined,stopFeeRate:undefined},
    lease:{held:true,fencingToken:'1',gatewayReady:true},costEvidence:{source:'ASSUMED'}});
  assert.equal(result.blocks,true);assert.equal(result.sizing.reason,'ACCOUNT_FEE_UNAVAILABLE');
});

// Production replay, 2026-09-18 KST. Every EXPIRED:ORIGINAL_SIGNAL_EXPIRED the
// deployed executor (v50) emitted in the 24h to 15:13 KST is listed below with the
// timestamps the signal row actually carried: the 5m close, the re-acceleration
// trigger, its 60s deadline, the 15m setup deadline, and the moment the executor
// rejected the candidate (v11_long_regime_signals.updated_at, not created_at --
// created_at is when the setup was armed).
//
// In all twelve the rejection lands 8-15s AFTER the trigger fired and well inside
// its 60s window, while the legacy close+120s clock had already run out. That is
// the defect: an expired ORIGINAL signal clock was applied to a trigger that was
// still live. The window this repository now computes must refuse none of them.
//
// Passing this window check is admission to the next stage, not an entry: each of
// these still has to clear the drift, sizing and liquidity gates afterwards.
const PRODUCTION_EXPIRY_REPLAY_20260918 = [
  ['DRIFTUSDT', '15:05:00', '15:10:00', '15:10:09.687'],
  ['ONEUSDT', '13:45:00', '13:47:00', '13:47:10.501'],
  ['ARBUSDT', '12:50:00', '12:52:00', '12:52:11.480'],
  ['APTUSDT', '12:30:00', '12:38:00', '12:38:08.498'],
  ['PONSUSDT', '12:05:00', '12:18:00', '12:18:07.976'],
  ['ARBUSDT', '12:15:00', '12:17:00', '12:17:11.598'],
  ['PONSUSDT', '12:00:00', '12:05:00', '12:05:08.721'],
  ['APTUSDT', '11:35:00', '11:44:00', '11:44:08.590'],
  ['ARBUSDT', '11:05:00', '11:12:00', '11:12:07.757'],
  ['ARBUSDT', '10:50:00', '11:00:00', '11:00:14.613'],
  ['ARBUSDT', '10:00:00', '10:02:00', '10:02:10.471'],
  ['BABYUSDT', '09:20:00', '09:22:00', '09:22:09.232'],
];
const kst = (hms) => Date.parse(`2026-09-18T${hms}+09:00`);

test('production replay: the 12 live expiry rejections were all inside their trigger window', () => {
  for (const [symbol, closeAt, triggerAt, rejectedAt] of PRODUCTION_EXPIRY_REPLAY_20260918) {
    const close = kst(closeAt), trigger = kst(triggerAt), rejected = kst(rejectedAt);
    const id = `replay-${symbol}-${closeAt}`;
    const s = {
      id, symbol,
      features: {
        strategy: STRATEGY, signal5Close: close, referenceClose: 1.5,
        v17Setup: {
          policyVersion: P.version, state: 'TRIGGERED', signalId: id, symbol,
          identity: `${P.version}:${symbol}:${id}:${close}`,
          signal5Close: close, armedAt: close, referencePrice: 1.5,
          expiresAt: close + P.setupTtlMs,
          triggerAt: trigger, triggerExpiresAt: trigger + P.entryTriggerTtlMs,
          triggerClose: 1.51, pullbackObserved: true,
        },
      },
    };
    const w = windowFor(s);
    assert.equal(w.valid, true, `${symbol} ${closeAt}: window must be valid`);
    // The defect, reproduced: the legacy clock had expired at the moment of rejection.
    assert.ok(close + POLICY.maxEntryAgeMs <= rejected,
      `${symbol} ${closeAt}: legacy clock must already be expired, or this is not the defect`);
    // The fix: the governing window had not.
    assert.ok(rejected < w.expiresAt,
      `${symbol} ${closeAt}: rejected ${rejected} must precede window end ${w.expiresAt}`);
    // The window is the trigger's own deadline, bounded by the setup's.
    assert.equal(w.expiresAt, Math.min(close + P.setupTtlMs, trigger + P.entryTriggerTtlMs));
    assert.equal(w.basis, 'PULLBACK_TRIGGER');
  }
});

test('production replay: startE1 stops calling these expired once the window governs', () => {
  for (const [symbol, closeAt, triggerAt, rejectedAt] of PRODUCTION_EXPIRY_REPLAY_20260918) {
    const close = kst(closeAt), trigger = kst(triggerAt), rejected = kst(rejectedAt);
    const identity = { signalId: `replay-${symbol}-${closeAt}`, symbol, decisionAt: rejected };
    // What production did: the ORIGINAL signal clock.
    const legacy = startE1({
      ...identity, signalExpiresAt: close + POLICY.maxEntryAgeMs, baselineEligible: true,
      tape: { available: false }, quote: null,
    });
    assert.deepEqual(legacy.reasonCodes, ['ORIGINAL_SIGNAL_EXPIRED']);
    assert.equal(legacy.reject, true);
    assert.equal(legacy.confirmationState, 'EXPIRED');
    // What the repaired path passes instead.
    const governed = startE1({
      ...identity,
      signalExpiresAt: Math.min(close + P.setupTtlMs, trigger + P.entryTriggerTtlMs),
      baselineEligible: true, tape: { available: false }, quote: null,
    });
    assert.ok(!governed.reasonCodes.includes('ORIGINAL_SIGNAL_EXPIRED'));
    assert.equal(governed.reject, false);
    assert.notEqual(governed.confirmationState, 'EXPIRED');
  }
});
