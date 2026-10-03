import test from 'node:test';import assert from 'node:assert/strict';
import {ENGINE} from '../../supabase/functions/_shared/deterministic/market-state.mjs';
import {plannedEntryRiskView} from '../../supabase/functions/_shared/deterministic/planned-entry-risk.mjs';
import {classifyPortfolio,riskOrders} from '../../supabase/functions/_shared/leader-ops-isolation.mjs';
import {evaluateEntryDecision} from '../../supabase/functions/_shared/leader-entry-control.mjs';
import {evaluateModule,mockDb} from './harness.mjs';

function fixture(attemptNo=1){
 const now=Date.now(),signal={id:'signal',symbol:'TESTUSDT'},request={action:'create_order',leverage:3,
  order:{market:signal.symbol,side:'BUY',type:'LIMIT',price:100,time_in_force:'IOC',quantity:4.5,
   identifier:'tb-intent-'+attemptNo,position_side:'LONG',position_effect:'OPEN'},wait_for_final_ms:4000};
 const order={id:'intent',signal_id:signal.id,symbol:signal.symbol,intent:'OPEN_LONG',state:'PLANNED',
  position_id:null,exchange_order_id:null,client_order_id:request.order.identifier,requested_quantity:'4.5',response_payload:{},
  request_payload:{...request,deterministic:{version:ENGINE},executor_patch:ENGINE,
   entry_ioc_attempt:attemptNo,entry_ioc_max_attempts:2,entry_ioc:{attempt:attemptNo}}};
 const pf={exchange:'binance_futures',account_scope:'futures',positions_complete:true,positions:[],available_quote:1000,
  total_equity_quote:1000,total_initial_margin_quote:0,observation:{id:'snapshot',source:'BINANCE_ACCOUNT_REST',requested_at_ms:now,received_at_ms:now}},
  pair={pf,positions:[],manual:[],quarantines:[],orders:[structuredClone(order)]};
 pair.match=classifyPortfolio([],pf,{orders:pair.orders,now});return {now,pair,context:{order,signal,attemptNo,request}};
}
function decide(f,pair=f.pair,extra={}){
 return evaluateEntryDecision({candidateSymbol:'TESTUSDT',classification:pair.match,portfolio:pair.pf,
  positions:pair.positions,orders:pair.orders,openOrders:{complete:true,orders:[],algos:[],observed_at_ms:f.now},
  runtime:{live_enabled:true,circuit_open:false},operator:{entry_enabled:true,legacy_entries_retired:true},
  settings:{mode:'LIVE_LIMITED',pause_new_entries:false,withdrawal_mode:false,manual_intervention_required:false,
   scalp_kill_switch:false,emergency_liquidation:false,pause_lock_reason:null},proposedMargin:150,cashBuffer:.1,now:f.now,...extra});
}
test('the exact unsent own intent permits fresh dispatch risk, without changing durable unknown semantics',()=>{
 const f=fixture(),before=structuredClone(f.pair);assert.equal(decide(f).allowed,false);
 assert.equal(f.pair.match.issues[0].kind,'UNKNOWN_ORDER_OUTCOME');
 const scoped=plannedEntryRiskView(f.pair,f.context,f.now);assert.equal(scoped.allowed,true);
 assert.equal(decide(f,scoped.pair).allowed,true);assert.deepEqual(f.pair,before);
 assert.equal(riskOrders(f.pair.orders).length,1);assert.equal(scoped.pair.orders.length,0);
});
test('other uncertain entry identities and stale account evidence remain fail closed',()=>{
 for(const sameSymbol of [true,false]){
  const f=fixture();f.pair.orders.push({...structuredClone(f.context.order),id:'other',client_order_id:'other-client',
   symbol:sameSymbol?'TESTUSDT':'OTHERUSDT',state:'UNKNOWN'});
  const scoped=plannedEntryRiskView(f.pair,f.context,f.now);assert.equal(scoped.allowed,true);
  const risk=decide(f,scoped.pair);assert.equal(risk.allowed,false);assert.match(risk.reasons.join(','),/UNKNOWN_ORDER_OUTCOME/);
 }
 const f=fixture();f.pair.pf.observation.requested_at_ms-=4000;
 assert.equal(decide(f,plannedEntryRiskView(f.pair,f.context,f.now).pair).allowed,false);
});
test('foreign, missing, duplicate, changed, acknowledged and already submitted intents never receive the exception',()=>{
 const changes=[o=>o.signal_id='foreign',o=>o.symbol='OTHERUSDT',o=>o.client_order_id='foreign',o=>o.position_id='position',
  o=>o.exchange_order_id='123',o=>o.requested_quantity=5,o=>o.request_payload.order.price=101,
  o=>o.request_payload.deterministic.version='old',o=>o.response_payload={deterministic_submission:{owner:'writer'}},
  o=>o.response_payload={orderId:'123'},...['DISPATCHED','PARTIALLY_FILLED','UNKNOWN','RECONCILIATION_PENDING','FILLED','REJECTED'].map(s=>o=>o.state=s)];
 for(const change of changes){const f=fixture();change(f.pair.orders[0]);assert.equal(plannedEntryRiskView(f.pair,f.context,f.now).allowed,false);}
 for(const rows of [[],['duplicate']]){const f=fixture();f.pair.orders=rows.length?[f.pair.orders[0],structuredClone(f.pair.orders[0])]:[];
  assert.equal(plannedEntryRiskView(f.pair,f.context,f.now).allowed,false);}
 const f=fixture();f.context.request.order.side='SELL';assert.equal(plannedEntryRiskView(f.pair,f.context,f.now).allowed,false);
});
test('partial IOC topup retains proved exposure, first fill identity and exact native protection',()=>{
 const f=fixture(2),p={id:'position',signal_id:'signal',symbol:'TESTUSDT',side:'LONG',state:'OPEN',active_lane:'BULL',
  original_quantity:2,remaining_quantity:2,metadata:{executionMode:'LEADER_MOMENTUM_V17',entryOrderId:'123',exitProtection:{orders:[{
   clientId:'stop',algoId:'456',status:'ACTIVE',terminal:false,spec:{params:{clientAlgoId:'stop',symbol:'TESTUSDT',quantity:2,triggerPrice:97.5}}}]}}};
 f.pair.positions=[p];f.pair.pf.positions=[{market:p.symbol,quantity:2,side:'LONG',entry_price:100,leverage:3,initial_margin_quote:200/3}];
 f.pair.orders.push({id:'first',position_id:p.id,signal_id:p.signal_id,symbol:p.symbol,intent:'OPEN_LONG',state:'FILLED',
  exchange_order_id:'123',request_payload:{order:{side:'BUY',position_side:'LONG',position_effect:'OPEN'}}});
 const scoped=plannedEntryRiskView(f.pair,f.context,f.now);assert.equal(scoped.allowed,true);assert.equal(scoped.pair.match.safe.length,1);
 assert.equal(scoped.pair.orders[0].id,'first');
 const openOrders={complete:true,orders:[],observed_at_ms:f.now,algos:[{clientAlgoId:'stop',algoId:'456',symbol:p.symbol,
  side:'SELL',positionSide:'BOTH',reduceOnly:true,orderType:'STOP_MARKET',quantity:2,algoStatus:'NEW'}]};
 assert.equal(decide(f,scoped.pair,{existingPositionId:p.id,openOrders}).allowed,true);
 assert.equal(decide(f,scoped.pair,{existingPositionId:p.id}).allowed,false);
});
test('dispatch supplies its inserted identity before the mandatory submit fence and venue POST',async()=>{
 const f=fixture(),events=[],{db}=mockDb(q=>{
  if(q.op==='insert'){events.push('persist');return {data:{...q.patch,id:'intent',response_payload:{},exchange_order_id:null}};}
  if(q.rpc==='deterministic_begin_submit'){events.push('submit-fence');return {data:{updated:true,order_id:'intent'}};}
  return {data:true};
 }),h=await evaluateModule();h.ctx.requireEntryAuthority=async()=>{};h.ctx.verifyExecutionLease=async()=>{};
 const raw={order:{exchange_order_id:'123',market:'TESTUSDT',side:'BUY',reduce_only:false,
  status:'EXPIRED',executed_volume:0,requested_volume:4.5,average_price:0,raw:{positionSide:'BOTH',status:'EXPIRED',origQty:'4.5',executedQty:'0'}}};
 await h.ctx.dispatchEntryIocAttempt(db,f.context.signal,async cmd=>{events.push(cmd.action);raw.order.client_order_id=cmd.order?.identifier??cmd.identifier;return raw;},
  {attemptNo:1,quantity:4.5,limitPrice:100,step:.1,payload:{deterministic:{version:ENGINE},entry_ioc:{attempt:1}},
   authorize:async context=>{events.push('fresh-authorize');assert.equal(context.order.id,'intent');assert.equal(context.signal,f.context.signal);
    const pair={...f.pair,orders:[structuredClone(context.order)]};
    const view=plannedEntryRiskView(pair,context,f.now);assert.equal(view.allowed,true);assert.equal(decide(f,view.pair).allowed,true);
    return {allowed:true,deterministic:{version:ENGINE}};}});
 assert.deepEqual(events,['persist','fresh-authorize','submit-fence','create_order','get_order']);
});
