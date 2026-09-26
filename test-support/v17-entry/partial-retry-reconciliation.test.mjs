import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {RETRY_RECONCILIATION_VERSION,retryProofCandidate,parentTradeStart,proveUnplacedPartialRetry} from '../../supabase/functions/v10-lane-executor/entry-retry-reconciliation.mjs';

function fixture(){
  const now=Date.now(),at=now-3*3600000,price=6.053931818181818,
    fills=[[1,1.7,6.053],[2,3.1,6.053],[3,51.5,6.054],[4,.9,6.055]].map(([id,qty,p])=>({tradeId:String(id),qty:String(qty),price:String(p),commission:qty*p*.0005,commissionAsset:'USDT',time:at}));
  const parent={id:'parent',position_id:'position',signal_id:'signal',symbol:'PROMUSDT',intent:'OPEN_LONG',state:'FILLED',
    exchange_order_id:'100',client_order_id:'tb-v11e-signal',requested_quantity:74.5,created_at:new Date(at-600).toISOString(),
    request_payload:{entry_ioc_attempt:1,order:{side:'BUY',position_side:'LONG',position_effect:'OPEN'}},
    response_payload:{v18ExposureFinal:true,order:{exchange_order_id:'100',client_order_id:'tb-v11e-signal',market:'PROMUSDT',side:'BUY',reduce_only:false,
      executed_volume:57.2,requested_volume:74.5,average_price:price,raw_status:'EXPIRED',raw:{positionSide:'BOTH',fills}}}};
  const order={id:'retry',signal_id:'signal',symbol:'PROMUSDT',intent:'OPEN_LONG',state:'RECONCILIATION_FAILED',exchange_order_id:null,
    client_order_id:'tb-v11r2-signal',requested_quantity:17.1,created_at:new Date(at+7000).toISOString(),
    reject_reason:'GW_400:Binance futures entry requires at least 40 USDT margin (120 USDT notional at 3x); got 103.6089',
    request_payload:{entry_ioc_attempt:2,entry_ioc_max_attempts:2,retry_of_order_id:'parent',order:{identifier:'tb-v11r2-signal',market:'PROMUSDT',side:'BUY',position_side:'LONG',position_effect:'OPEN',type:'LIMIT',time_in_force:'IOC',quantity:17.1,price:6.059}}};
  const proof={proven:false,found:false,lookup_code:-2013,position_read_ok:true,trade_read_ok:true,position_quantity:57.2,
    exchange:'binance_futures',market:'PROMUSDT',identifier:order.client_order_id,source:'BINANCE_FUTURES_ORDER_AND_POSITION_REST',
    requested_at_ms:now-900,observed_at_ms:now-600};
  const orderHistory=[{symbol:'PROMUSDT',orderId:100,clientOrderId:parent.client_order_id,side:'BUY',positionSide:'BOTH',
    type:'LIMIT',timeInForce:'IOC',status:'EXPIRED',reduceOnly:false,executedQty:'57.2',origQty:'74.5'}],
    trades=fills.map(t=>({symbol:'PROMUSDT',id:Number(t.tradeId),orderId:100,qty:t.qty,price:t.price,time:t.time,isBuyer:true})),
    position={id:'position',signal_id:'signal',symbol:'PROMUSDT',state:'OPEN',side:'LONG',active_lane:'BULL',original_quantity:57.2,
      remaining_quantity:57.2,entry_price:price,metadata:{executionMode:'LEADER_MOMENTUM_V17',entryOrderId:'100'}};
  const pair={positions:[position],orders:[parent,order],manual:[],pf:{exchange:'binance_futures',account_scope:'futures',positions_complete:true,
    positions:[{market:'PROMUSDT',side:'LONG',quantity:57.2,entry_price:price}],
    observation:{id:'fresh',source:'BINANCE_ACCOUNT_REST',requested_at_ms:now-100,received_at_ms:now-50}}};
  return {order,parent,proof,orderHistory,trades,pair,readsStartedAt:now-500,readsFinishedAt:now-200,now};
}
test('PROM-shaped first fill plus refused remainder is proven without treating the account as flat',()=>{
  const f=fixture();assert.equal(retryProofCandidate(f.order,f.now),true);assert.equal(parentTradeStart(f.parent),1);
  const r=proveUnplacedPartialRetry(f);assert.equal(r.proven,true);assert.equal(r.retainedQuantity,57.2);
  assert.equal(r.parentExchangeOrderId,'100');assert.equal(r.positionId,'position');assert.equal(f.proof.proven,false);
});
test('missing, known, stale or future retry absence is never proof',()=>{
  for(const patch of [{found:true},{found:null},{lookup_code:-1007},{trade_read_ok:false},{position_read_ok:false},
    {identifier:'different'},{requested_at_ms:Date.now()-10000},{observed_at_ms:Date.now()+10000}]){
    const f=fixture();Object.assign(f.proof,patch);assert.equal(proveUnplacedPartialRetry(f).proven,false,JSON.stringify(patch));
  }
});
test('an acknowledged retry, network error, different intent or expired retention cannot settle',()=>{
  for(const patch of [{exchange_order_id:'200'},{intent:'CLOSE_LONG'},{reject_reason:'GW_400:This operation was aborted'},
    {created_at:new Date(Date.now()-7*3600000).toISOString()}]){const f=fixture();Object.assign(f.order,patch);assert.equal(proveUnplacedPartialRetry(f).proven,false);}
});
test('retry order present or any other order in the complete recent history prevents settlement',()=>{
  for(const additional of [{orderId:200,clientOrderId:'tb-v11r2-signal'},{orderId:300,clientOrderId:'manual'}]){
    const f=fixture();f.orderHistory.push(additional);assert.equal(proveUnplacedPartialRetry(f).proven,false);
  }
  const f=fixture();f.orderHistory[0].status='NEW';assert.equal(proveUnplacedPartialRetry(f).proven,false);
});
test('unattributed, late, missing or duplicate fills keep the retry unresolved',()=>{
  const mutations=[f=>f.trades.push({...f.trades[0],id:5,orderId:200}),f=>f.trades.pop(),f=>f.trades.push(f.trades[0]),
    f=>f.trades[0].time=f.now,f=>f.trades[0].isBuyer=false,f=>f.trades[0].qty='1.8',f=>f.trades[0].price='6.1'];
  for(const mutate of mutations){const f=fixture();mutate(f);assert.equal(proveUnplacedPartialRetry(f).proven,false);}
});
test('manual ownership, partial exit and changed live quantity or entry price refuse proof',()=>{
  const mutations=[f=>f.pair.manual.push({symbol:'PROMUSDT'}),f=>f.pair.positions[0].remaining_quantity=50,
    f=>f.pair.pf.positions[0].quantity=74.3,f=>f.pair.pf.positions[0].entry_price=6.06,
    f=>f.pair.positions[0].metadata.exitAccountingPending=true,f=>f.proof.position_quantity=null,
    f=>f.pair.pf.observation.received_at_ms=f.now+2000,f=>f.pair.orders.push({...f.order,id:'third'})];
  for(const mutate of mutations){const f=fixture();mutate(f);assert.equal(proveUnplacedPartialRetry(f).proven,false);}
});
test('parent identity and exact receipt must agree with both exchange and owned position',()=>{
  const mutations=[f=>f.parent.signal_id='other',f=>f.parent.response_payload.v18ExposureFinal=false,
    f=>f.parent.response_payload.order.raw.fills.pop(),f=>f.orderHistory[0].executedQty='57.3',
    f=>f.orderHistory[0].clientOrderId='other',f=>f.pair.positions[0].metadata.entryOrderId='200'];
  for(const mutate of mutations){const f=fixture();mutate(f);assert.equal(proveUnplacedPartialRetry(f).proven,false);}
});

const src=fs.readFileSync(new URL('../../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8'),
  fn=src.slice(src.indexOf('const NEVER_PLACED_PROOF_MAX_AGE_MS'),src.indexOf('async function reconcileOps('));
function harness(f,{casMiss=false,historyThrows=false}={}){
  const writes=[],commands=[];
  const db={from(name){let patch=null,filters={};const b={select(){return b;},eq(k,v){filters[k]=v;return b;},is(k,v){filters[k]=v;return b;},
    update(p){patch=p;return b;},async maybeSingle(){if(patch){writes.push({name,patch,filters});return {error:null,data:casMiss?null:{id:f.order.id}};}
      return {error:null,data:f.parent};},then(resolve,reject){writes.push({name,patch,filters});return Promise.resolve({error:null}).then(resolve,reject);}};return b;}};
  const ctx={Date,Number,Math,String,Object,Error,Promise,JSON,console,RETRY_RECONCILIATION_VERSION,retryProofCandidate,parentTradeStart,proveUnplacedPartialRetry,
    N:(x,d=0)=>Number.isFinite(Number(x))?Number(x):d,rec:x=>x&&typeof x==='object'?x:{},classifyFailure:()=>({fatal:false}),
    readOpsPair:async()=>f.pair,verifyExecutionLease:async()=>{},audit:async()=>{},db,
    gw:async cmd=>{commands.push(cmd);if(historyThrows)throw Error('HISTORY_TIMEOUT');return cmd.action==='order_history'?f.orderHistory:cmd.action==='trade_history'?f.trades:f.proof;}};
  vm.createContext(ctx);vm.runInContext(fn,ctx);return {...ctx,writes,commands};
}
test('adapter resolves only the refused retry, preserves the first FILLED signal and sends no order',async()=>{
  const f=fixture(),h=harness(f),r=await h.settleNeverPlacedPartialRetry(h.db,f.order,f.proof,h.gw);
  assert.equal(r.outcome,'RESOLVED');assert.equal(r.executedQuantity,0);assert.equal(r.retainedQuantity,57.2);
  assert.deepEqual(h.commands.map(c=>c.action),['order_history','trade_history']);
  assert.equal(h.writes[0].patch.state,'REJECTED');assert.equal(h.writes[0].patch.response_payload.v18ExposureFinal,true);
  assert.equal(h.writes[0].filters.exchange_order_id,null);assert.equal(h.writes[1].patch.status,'FILLED');
  assert.equal(h.writes[1].filters.status,'ORDERED');assert.ok(!h.writes.some(w=>/positions|runtime|control/.test(w.name)));
});
test('adapter never writes evidence on a history failure or ownership mismatch',async()=>{
  const f=fixture(),h=harness(f,{historyThrows:true});await assert.rejects(()=>h.settleNeverPlacedPartialRetry(h.db,f.order,f.proof,h.gw),/HISTORY_TIMEOUT/);assert.equal(h.writes.length,0);
  const f2=fixture();f2.pair.pf.positions[0].quantity=70;const h2=harness(f2),r=await h2.settleNeverPlacedPartialRetry(h2.db,f2.order,f2.proof,h2.gw);
  assert.equal(r.outcome,'UNRESOLVED');assert.equal(h2.writes.length,0);
});
test('CAS race cannot produce a resolved outcome or rewrite the parent signal',async()=>{
  const f=fixture(),h=harness(f,{casMiss:true});await assert.rejects(()=>h.settleNeverPlacedPartialRetry(h.db,f.order,f.proof,h.gw),/CAS_CONFLICT/);
  assert.equal(h.writes.length,1);assert.equal(h.writes[0].name,'v11_long_regime_orders');
});
test('reconciliation fallback reports unavailable history without clearing ambiguity',async()=>{
  const f=fixture(),h=harness(f);h.gw=async cmd=>{
    if(cmd.action==='v18_entry_never_placed_proof')return f.proof;
    throw Error('HISTORY_TIMEOUT');
  };
  const r=await h.settleNeverPlacedEntry(h.db,f.order,Error('GW_400:-2013 Order does not exist.'),h.gw);
  assert.equal(r.outcome,'UNRESOLVED');assert.equal(r.reason,'RETRY_NEVER_PLACED_PROOF_UNAVAILABLE');assert.equal(h.writes.length,0);
});
test('ordinary main executor fixes cannot trigger the historical CEC bootstrap',()=>{
  const workflow=fs.readFileSync(new URL('../../.github/workflows/deploy-cec0040-shadow-20260920.yml',import.meta.url),'utf8');
  assert.match(workflow,/branches: \[release\/cec0040-live-20260920\]/);
  assert.doesNotMatch(workflow,/branches:.*\bmain\b/);
});
