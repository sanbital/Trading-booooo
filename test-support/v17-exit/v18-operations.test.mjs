import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import * as policy from '../../supabase/functions/_shared/leader-momentum-v17.mjs';
import * as exit from '../../supabase/functions/_shared/leader-exit-review.mjs';
import * as ops from '../../supabase/functions/_shared/leader-operations.mjs';
import * as settlement from '../../supabase/functions/_shared/leader-settlement.mjs';
import {createGatewayProtection,createPositionProtectionStore} from '../../supabase/functions/_shared/leader-protection-adapter.mjs';
import {protectNewLeaderPosition} from '../../supabase/functions/_shared/leader-entry-protection.mjs';
import {memoryDb} from './memory-db.mjs';
const source=readFileSync(new URL('../../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8');
function executor({enabled=true,gateway,protection}={}){
 const ctx={...policy,...exit,...ops,...settlement,leaderPortfolioMatches:policy.portfolioMatches,protectNewLeaderPosition,
  createGatewayProtection:protection??createGatewayProtection,console,crypto,Date,Map,Set,Number,Math,Promise,String,Object,Array,JSON,Error,
  setTimeout,clearTimeout,TextEncoder,AbortController,Response,
  Deno:{env:{get:k=>k==='V17_NATIVE_STOP'&&enabled?'true':''},serve:()=>{}},createClient:()=>{throw Error('NO_NETWORK');}};
 vm.createContext(ctx);vm.runInContext(source.replace(/^import .*;\r?\n/gm,''),ctx);
 ctx.gateway=gateway??(async()=>{throw Error('UNEXPECTED_NETWORK');});ctx.verifyExecutionLease=async()=>{};
 return ctx;
}
function position(overrides={}){return {id:'owned-position',symbol:'EDGEUSDT',side:'LONG',state:'OPEN',entry_at:new Date(Date.now()-60000).toISOString(),entry_price:.612,
 entry_fee_usdt:.028,original_quantity:93,remaining_quantity:93,realized_pnl_usdt:-.028,peak_price:.612,hard_stop_price:.5967,
 signal_id:'signal',active_lane:'BULL',updated_at:new Date().toISOString(),metadata:{executionMode:policy.STRATEGY,leaderExitPolicyVersion:exit.EXIT_REVIEW_R5.policyVersion},...overrides};}
test('real openBull protects 93 filled units in the same call and journals protection',async()=>{
 const calls=[],ensures=[],ask=120.12/196,now=Date.now();let bought=false;
 const db=memoryDb({trading_account_snapshots:[{captured_at:new Date().toISOString(),exchange:'binance_futures',available_quote:94,positions_complete:true}],v11_long_regime_positions:[],v11_long_regime_signals:[{id:'signal',status:'CLAIMED'}]});
 const h=executor({protection:()=>({ensure:async(id,r)=>{ensures.push(r);calls.push('PROTECT');return {status:'PROTECTED'};}}),gateway:async c=>{
  calls.push(c.action);
  if(c.action==='p10_portfolio')return {positions:bought?[{market:'EDGEUSDT',side:'LONG',quantity:93}]:[],available_quote:94};
  if(c.action==='quote')return {best_bid:ask*.9999,best_ask:ask};
  if(c.action==='symbol_info')return {quantity_step:1,price_tick:.0001,min_notional:5};
  if(c.action==='create_order'){assert.equal(c.order.quantity,196);bought=true;return {order:{status:'EXPIRED',orderId:'entry'},fill:{executedVolume:93,averagePrice:ask,paidFee:.028}};}
  if(c.action==='p10_quotes')return [{market:'EDGEUSDT',best_bid:ask,best_ask:ask,timing:{received_at_ms:Date.now()}}];
  throw Error('UNEXPECTED_ACTION');
 }});h.requireLeaderEntryControls=async()=>{};
 const s={id:'signal',symbol:'EDGEUSDT',features:{strategy:policy.STRATEGY,signal5Close:now-1000,referenceClose:ask,atr:.02,exitPolicy:{stopPct:.025,trailArmPct:.03,trailGapPct:.015,staleMs:2700000,maxHoldMs:21600000}}};
 const out=await h.openBull(db,s,[],[],{});
 assert.equal(out.entered,true);assert.equal(out.quantity,93);assert.equal(calls.filter(x=>x==='create_order').length,1);
 assert.equal(ensures[0].exchangeQuantity,93);assert.ok(calls.indexOf('PROTECT')>calls.indexOf('create_order'));
 assert.equal(db.tables.v11_long_regime_orders[0].state,'FILLED');
 assert.equal(db.tables.v11_long_regime_positions[0].metadata.entryProtection.status,'PROTECTED');
});
test('protection failures retain FILLED ownership and are recoverable, including manual refusal',async()=>{
 const p=position(),db=memoryDb({v11_long_regime_positions:[p]});
 const result=await protectNewLeaderPosition({enabled:true,position:p,readPortfolio:async()=>{throw Error('timeout');},manage:()=>{throw Error('UNREACHED');}});
 await ops.rememberEntryProtection(db,p.id,result);assert.equal(db.tables.v11_long_regime_positions[0].state,'OPEN');
 assert.equal(result.softwareMonitorRequired,true);
 let touched=false;const manual=await protectNewLeaderPosition({enabled:true,position:{...p,metadata:{...p.metadata,v17ManualPosition:true}},readPortfolio:async()=>{touched=true;},manage:()=>{}});
 assert.equal(touched,false);assert.match(manual.error,/NOT_OWNED/);
});
test('a partial software exit is never reported as CLOSED by immediate protection',async()=>{
 const p=position();const out=await protectNewLeaderPosition({enabled:true,position:p,readPortfolio:async()=>({positions:[{market:p.symbol,side:'LONG',quantity:93}]}),manage:async()=>({action:'CLOSE',result:{closed:false},nativeStop:{status:'RECONCILIATION_PENDING'}})});
 assert.notEqual(out.status,'CLOSED');assert.equal(out.softwareMonitorRequired,true);
});
test('CKB race: native receipt closes before software dispatch; zero duplicate SELLs',async()=>{
 const p=position({symbol:'CKBUSDT',metadata:{executionMode:policy.STRATEGY,exitProtection:{orders:[{terminal:false}]}}});
 const db=memoryDb({v11_long_regime_positions:[p]});let orders=0;
 const h=executor({gateway:async()=>{orders++;throw Error('MUST_NOT_DISPATCH');},protection:()=>({refresh:async()=>{Object.assign(db.tables.v11_long_regime_positions[0],{state:'CLOSED',remaining_quantity:0,exit_price:.601,exit_reason:'V17_NATIVE_STOP'});}})});
 const out=await h.closePos(db,p,1,'V17_RISK_CUT');assert.equal(out.closed,true);assert.equal(out.nativeAlreadyClosed,true);assert.equal(orders,0);
 assert.equal(db.tables.v11_long_regime_positions[0].exit_reason,'V17_NATIVE_STOP');
});
test('closed software reason survives native cancellation journal writes',async()=>{
 const p=position({state:'CLOSED',remaining_quantity:0,exit_reason:'V17_MOMENTUM_STALE',closed_at:'2026-09-10T01:00:00Z'}),db=memoryDb({v11_long_regime_positions:[p]});
 const store=createPositionProtectionStore(db),before=await store.load(p.id);assert.equal(await store.compareAndSwap(p.id,0,{...before,version:1}),true);
 assert.equal(db.tables.v11_long_regime_positions[0].exit_reason,p.exit_reason);assert.equal(db.tables.v11_long_regime_positions[0].closed_at,'2026-09-10T01:00:00.000Z');
});
test('native closure recovers the circuit and other owned positions remain managed',async()=>{
 const closedAt=new Date().toISOString(),p=position({symbol:'CKBUSDT',metadata:{executionMode:policy.STRATEGY,exitProtection:{orders:[{terminal:false}]}}}),other=position({id:'other',symbol:'EGLDUSDT'});
 const db=memoryDb({v11_long_regime_positions:[p,other],v11_long_regime_runtime:[{singleton:true,live_enabled:true,circuit_open:true,circuit_reason:'V17_POSITION_MANAGEMENT_FAILED:CKBUSDT',last_exit_at:'2026-09-10T01:00:00Z'}]});const managed=[];
 const out=await ops.managementPass({db,nativeEnabled:true,protection:{refresh:async()=>Object.assign(db.tables.v11_long_regime_positions[0],{state:'CLOSED',remaining_quantity:0,closed_at:closedAt}),ensure:async()=>({status:'CLOSED'})},manualAllowances:async()=>[],
  gateway:async c=>c.action==='p10_portfolio'?{positions:[{market:'EGLDUSDT',side:'LONG',quantity:93}]}:[],portfolioMatches:policy.portfolioMatches,
  manage:async p=>{managed.push(p.symbol);return {action:'HOLD',nativeStop:{status:'PROTECTED'}};}});
 assert.deepEqual(managed,['EGLDUSDT']);assert.equal(out.circuitRecovered,true);assert.equal(db.tables.v11_long_regime_runtime[0].last_exit_at,closedAt);assert.equal(out.entryAttempted,false);
});
test('an unresolved dispatch prevents automatic circuit recovery',async()=>{
 const p=position(),db=memoryDb({v11_long_regime_positions:[p],v11_long_regime_runtime:[{singleton:true,live_enabled:true,circuit_open:true,circuit_reason:'V17_POSITION_MANAGEMENT_FAILED:EDGEUSDT'}],v11_long_regime_orders:[{id:'pending',symbol:p.symbol,state:'RECONCILIATION_FAILED'}]});
 const out=await ops.managementPass({db,nativeEnabled:true,protection:{},manualAllowances:async()=>[],gateway:async c=>c.action==='p10_portfolio'?{positions:[{market:p.symbol,side:'LONG',quantity:93}]}:[],portfolioMatches:policy.portfolioMatches,manage:async()=>{throw Error('MUST_NOT_REDISPATCH');}});
 assert.equal(out.circuitRecovered,false);assert.equal(db.tables.v11_long_regime_runtime[0].circuit_open,true);
});
test('last exit timestamp cannot regress after an out-of-order reconciliation',async()=>{
 const db=memoryDb({v11_long_regime_positions:[position({state:'CLOSED',closed_at:'2026-09-10T01:00:00Z'})],v11_long_regime_runtime:[{singleton:true,last_exit_at:'2026-09-10T02:00:00Z'}]});
 await ops.updateLastExit(db);assert.equal(db.tables.v11_long_regime_runtime[0].last_exit_at,'2026-09-10T02:00:00Z');
});
test('fast quotes reject pre-entry, stale and future exchange observations',async()=>{
 const p=position({entry_at:new Date(Date.now()-1000).toISOString()});
 for(const at of [Date.now()-3000,Date.now()+10000,Date.now()-1500]){
  const ctx={fast:true,quotes:new Map([[p.symbol,{market:p.symbol,best_bid:1,best_ask:1,timing:{received_at_ms:Date.now(),book_captured_at_ms:at}}]])};
  const h=executor({gateway:async()=>[ctx.quotes.get(p.symbol)]});
  await assert.rejects(()=>h.leaderQuote(p,ctx),/STALE/);
 }
});
