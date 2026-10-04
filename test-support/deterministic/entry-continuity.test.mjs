import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyMarket,revalidateEntry,ENTRY_SIGNAL_POLICY} from '../../supabase/functions/_shared/deterministic/market-state.mjs';
import {entryEvidence} from '../../supabase/functions/_shared/deterministic/entry-evidence.mjs';
import {scenario,bearish,executableQuote,AT} from './fixtures.mjs';
import {evaluateModule,mockDb} from './harness.mjs';
const pause=(at=AT+8000)=>{
 const prices=Array.from({length:24},(_,i)=>100+.01*(i+1));prices[23]=prices[22]-.001;
 return scenario({prices,at});
};
const seed=()=>classifyMarket(scenario());

test('fresh approved BUY survives a brief five-second pause with all present safeguards intact',()=>{
 const initial=seed(),current=pause(),before=structuredClone(initial),check=revalidateEntry(initial,current);
 assert.equal(check.latest.decision,'WAIT');assert.equal(check.latest.phase,'MOMENTUM_DECAY');
 assert.ok(Object.values(check.latest.gates).every(Boolean));assert.equal(check.allowed,true);
 assert.equal(check.execution_state.decision,'BUY');assert.equal(check.execution_state.trigger,initial.trigger);
 assert.equal(check.authority.mode,'RETAINED_INITIAL_BUY');assert.deepEqual(initial,before);
 const signal={id:'s',features:{deterministic:{decision:initial}}},evidence=entryEvidence(signal,{check});
 assert.equal(evidence.latest.decision,'WAIT');assert.equal(evidence.execution_state.decision,'BUY');
 assert.equal(evidence.execution_authority.valid_until_ms,initial.at+ENTRY_SIGNAL_POLICY.maxAgeMs);
});

test('repeated preparation checks never renew the initial 30-second approval window',()=>{
 const initial=seed();
 for(const offset of [8000,18000,29999]){
  const check=revalidateEntry(initial,pause(AT+offset));assert.equal(check.allowed,true);
  assert.equal(check.authority.valid_until_ms,AT+30000);
 }
 const check=revalidateEntry(initial,pause(AT+30000));assert.equal(check.allowed,false);assert.equal(check.reason,'ENTRY_SIGNAL_EXPIRED');
 assert.equal(revalidateEntry(initial,scenario({at:AT+30001})).reason,'ENTRY_SIGNAL_EXPIRED','fresh market BUY cannot revive an expired original signal');
});

test('unapproved, future and malformed original decisions cannot obtain retained execution authority',()=>{
 for(const patch of [{decision:'WAIT'},{confirmation:'WAIT'},{setup:'REJECT'},{trigger:'WAIT'},{version:'RETIRED'},{reference_price:0},{capture_end_ms:AT+1}]){
  assert.equal(revalidateEntry({...seed(),...patch},pause()).reason,'INITIAL_BUY_REQUIRED');
 }
 assert.equal(revalidateEntry({...seed(),at:AT+9000},pause()).reason,'INITIAL_BUY_TIME_INVALID');
});

test('lost trend, collapsing flow and liquidity, stale data, market shock and expensive books still cancel',()=>{
 const initial=seed();
 const invalid=[
  bearish({at:AT+8000}),
  {...pause(),capture:{status:'UNAVAILABLE',reason:'MISSING_BUCKETS'}},
  scenario({at:AT+8000,values:{market_shock:true}}),
  scenario({at:AT+8000,values:{ema9_vs_ema20:-.003,return_60m:-.02}}),
  scenario({at:AT+8000,values:{sell_volume_expansion:true}}),
  scenario({at:AT+8000,values:{volume_climax_decline:true}})
 ];
 for(const current of invalid){const check=revalidateEntry(initial,current);assert.equal(check.allowed,false);assert.equal(check.execution_state,null);}
 const stale=pause();stale.at=stale.capture.end_ms+10000;assert.equal(revalidateEntry(initial,stale).reason,'CURRENT_DATA_INCOMPLETE_OR_STALE');
 const regressed=scenario({at:AT-5000});regressed.at=AT;assert.equal(revalidateEntry(initial,regressed).reason,'CAPTURE_REGRESSED');
});

test('price chase, loss of breakout/recovery level and adverse drift still invalidate an approval',()=>{
 const initial=seed(),current=pause();
 assert.equal(revalidateEntry(initial,{...current,price:initial.reference_price*1.02}).reason,'LATE_EXECUTION');
 assert.equal(revalidateEntry(initial,{...current,price:initial.trigger_reference-.001}).reason,'FAILED_BREAKOUT');
 const recovery={...initial,trigger:'PULLBACK_RECOVERY',trigger_reference:initial.reference_price*.999};
 assert.equal(revalidateEntry(recovery,{...current,price:initial.reference_price*.998}).reason,'PULLBACK_LOW_BROKEN');
 const momentum={...initial,trigger:'MOMENTUM_REACCELERATION'};
 assert.equal(revalidateEntry(momentum,{...current,price:initial.reference_price*.98}).reason,'ENTRY_PRICE_DETERIORATED');
});

test('expired queued signals retire before any account, quote or authority RPC',async()=>{
 const h=await evaluateModule(),{db,writes}=mockDb(()=>assert.fail('expired signal accessed database'));
 h.ctx.requireEntryAuthority=()=>assert.fail('expired signal read authority');h.ctx.opsGateway=()=>assert.fail('expired signal read venue');
 const result=await h.ctx.openBull(db,{features:{deterministic:{decision:{...seed(),at:Date.now()-30001}}}},[]);
 assert.equal(result.reason,'ENTRY_SIGNAL_EXPIRED');assert.equal(writes.length,0);
});

test('the complete entry path sends the retained execution state to SQL and reaches exactly one create_order',async()=>{
 const h=await evaluateModule(),at=Date.now(),initial=classifyMarket(scenario({at:at-8000})),market=pause(at),
  quote=executableQuote({at,price:market.price,depth:40000,askDepth:10000}),actions=[],submitted=[];
 const {db,writes}=mockDb(q=>{
  if(q.rpc==='deterministic_reserve_entry_slot')return {data:{reserved:true,id:'reservation'}};
  if(q.rpc==='deterministic_begin_submit'){submitted.push(q.args.p_state);return {data:{updated:true,order_id:'intent'}};}
  if(q.table==='v11_long_regime_orders'&&q.op==='insert')return {data:{...q.patch,id:'intent'}};
  return {data:true};
 });
 const pf={positions_complete:true,positions:[],observation:{id:'account',requested_at_ms:at,received_at_ms:at}},pair={pf,manual:[],positions:[]};
 h.ctx.requireEntryAuthority=async()=>({allowed:true});h.ctx.requireLeaderEntryControls=async()=>{};h.ctx.verifyExecutionLease=async()=>{};
 h.ctx.withAccountMutation=async(db,operation)=>operation();h.ctx.readOpsPair=async()=>pair;h.ctx.opsControls=async()=>({});
 h.ctx.currentMarket=async()=>market;h.ctx.gatewayTakerFeeRate=()=>.0005;h.ctx.supportedFuturesMode=()=>true;
 h.ctx.symbolFilters=()=>({quantityStep:.1});h.ctx.sizeEntry=()=>({amount:4.5,limitPrice:quote.best_ask,sizedMargin:150});
 h.ctx.decideEntryWith=()=>({allowed:true});h.ctx.persistDecisionRisk=async()=>{};
 h.ctx.plannedEntryRiskView=()=>({allowed:true,pair});h.ctx.planAggressiveIocRetry=()=>({ok:false});h.ctx.settleKnownEntry=async()=>null;
 const raw={order:{exchange_order_id:'123',market:'TESTUSDT',side:'BUY',reduce_only:false,status:'EXPIRED',
  executed_volume:0,requested_volume:4.5,average_price:0,raw:{positionSide:'BOTH',status:'EXPIRED',origQty:'4.5',executedQty:'0'}}};
 h.ctx.opsGateway=()=>async(command,timeout,options)=>{
  await options?.beforeTransport?.();actions.push(command.action);
  if(command.action==='quote')return quote;
  if(['create_order','get_order'].includes(command.action)){
   raw.order.client_order_id=command.order?.identifier??command.identifier;return raw;
  }
  return {};
 };
 const signal={id:'signal',symbol:'TESTUSDT',features:{sizingContractVersion:h.value('SLOT_SIZING_CONTRACT.version'),
  targetMarginUsdt:150,leverage:3,exitPolicy:{stopPct:.025},deterministic:{version:initial.version,decision:initial}}};
 await h.ctx.openBull(db,signal,[],[],{});
 assert.equal(submitted.length,1);assert.equal(submitted[0].decision,'BUY');
 assert.equal(submitted[0].entry_authority.mode,'RETAINED_INITIAL_BUY');
 assert.equal(submitted[0].entry_authority.market_decision,'WAIT');
 assert.equal(actions.filter(x=>x==='create_order').length,1);assert.ok(actions.includes('get_order'));
 assert.ok(writes.some(x=>x.table==='v11_long_regime_orders'&&x.op==='insert'));
});
