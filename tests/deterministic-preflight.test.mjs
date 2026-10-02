import test from 'node:test';import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {readVenue,reconcileHoldings,reconcileTrades} from '../ops/deterministic/preflight-read.mjs';
const now=1790980000000,commit='a'.repeat(40),token='t'.repeat(32);
const proof=()=>({db:{positions:[],orders:[]},now,
 portfolio:{exchange:'binance_futures',account_scope:'futures',positions_complete:true,positions:[],observation:{id:'account',source:'BINANCE_ACCOUNT_REST',requested_at_ms:now-200,received_at_ms:now-100}},
 openOrders:{complete:true,orders:[],algos:[],observed_at_ms:now-100},
 mode:{exchange:'binance_futures',account_scope:'futures',position_mode:'ONE_WAY',dual_side_position:false,observation:{id:'mode',source:'BINANCE_POSITION_MODE_REST',requested_at_ms:now-200,received_at_ms:now-100}}});
test('preflight admits signed allowlisted venue reads and uses the configured identity',async()=>{
 let commands=0;
 const result=await readVenue({app:'trading-booooo',token,commit,command:{action:'p10_portfolio'},now:()=>now,fetchImpl:async(url,opt)=>{
  if(url.endsWith('/health'))return{ok:true,json:async()=>({deployment_commit:commit,order_writer:{required:true},keys_configured:{binance_futures:true}})};
  commands++;assert.equal(url,'https://trading-booooo.fly.dev/v1/command');const h=opt.headers;
  const secret=createHash('sha256').update('gateway:'+token).digest('hex');
  assert.equal(h['x-gateway-signature'],createHmac('sha256',secret).update(h['x-gateway-ts']+'\n'+h['x-gateway-nonce']+'\n'+opt.body).digest('hex'));
  assert.deepEqual(JSON.parse(opt.body),{exchange:'binance_futures',action:'p10_portfolio'});
  return{ok:true,json:async()=>({ok:true,result:{positions:[]}})};
 }});assert.deepEqual(result,{positions:[]});assert.equal(commands,1);
});
test('preflight rejects create, cancel, leverage and extra order fields before network access',async()=>{
 let calls=0;const config={app:'trading-booooo',token,commit,fetchImpl:async()=>{calls++;}};
 for(const command of [{action:'create_order'},{action:'cancel_order'},{action:'set_leverage'},{action:'p10_portfolio',order:{}},{action:'trade_history',market:'BTCUSDT',limit:1001}])await assert.rejects(readVenue({...config,command}),/ALLOWLIST/);
 assert.equal(calls,0);
});
test('different build or venue identity and authentication errors fail closed',async()=>{
 let reads=0;const config={app:'trading-booooo',token,commit,command:{action:'v18_open_orders'}};
 await assert.rejects(readVenue({...config,fetchImpl:async()=>({ok:true,json:async()=>({deployment_commit:'b'.repeat(40),order_writer:{required:true},keys_configured:{binance_futures:true}})})}),/BUILD_OR_IDENTITY/);
 await assert.rejects(readVenue({...config,fetchImpl:async url=>{
  if(url.endsWith('/health'))return{ok:true,json:async()=>({deployment_commit:commit,order_writer:{required:true},keys_configured:{binance_futures:true}})};
  reads++;return{ok:false,status:401};
 }}),/HTTP_401/);assert.equal(reads,1);
});
test('complete fresh flat truth passes while stale truth, UNKNOWN or unexpected stops block',()=>{
 assert.deepEqual(reconcileHoldings(proof()).failures,[]);
 const stale=proof();stale.portfolio.observation.requested_at_ms=now-3001;assert.ok(reconcileHoldings(stale).failures.includes('ACCOUNT_TRUTH_STALE_OR_INCOMPLETE'));
 const unknown=proof();unknown.db.orders.push({state:'UNKNOWN'});assert.ok(reconcileHoldings(unknown).failures.includes('UNRESOLVED_DB_ORDER'));
 const extra=proof();extra.openOrders.algos.push({});assert.ok(reconcileHoldings(extra).failures.includes('EXCHANGE_PROTECTION_OR_OPEN_ORDER_MISMATCH'));
});
test('quantity mismatch or absent native protection blocks held positions',()=>{
 const p=proof();p.db.positions.push({id:'p',symbol:'BTCUSDT',side:'LONG',remaining_quantity:1});p.portfolio.positions.push({market:'BTCUSDT',side:'LONG',quantity:2});
 const result=reconcileHoldings(p);assert.ok(result.failures.includes('EXCHANGE_DB_POSITION_MISMATCH'));assert.ok(result.failures.includes('EXCHANGE_PROTECTION_OR_OPEN_ORDER_MISMATCH'));
});
test('closed numerical residue preserves history without fabricating exposure; real or pending residuals block',()=>{
 const p=proof(),dust={state:'CLOSED',closed_at:'2026-10-01T12:00:00Z',remaining_quantity:9e-13,metadata:{exitAccountingPending:false,exitProtection:{orders:[{terminal:true}]}}};
 p.db.positions.push(dust);assert.deepEqual(reconcileHoldings(p).failures,[]);assert.equal(reconcileHoldings(p).closed_quantity_dust_rows,1);
 for(const row of [{...dust,remaining_quantity:1e-6},{...dust,state:'OPEN'},{...dust,metadata:{exitAccountingPending:true}},{...dust,metadata:{exitProtection:{orders:[{terminal:false}]}}}]){
  p.db.positions=[row];assert.ok(reconcileHoldings(p).failures.includes('EXCHANGE_DB_POSITION_MISMATCH'));
 }
});
test('fill identity, actual quantity, price, fees, attribution and accounting all reconcile',()=>{
 const fill={market:'BTCUSDT',exchange_trade_id:1,exchange_order_id:'2',side:'BUY',quantity:1,price:100,fee_amount:.05,fee_asset:'USDT',source:'AUTOMATED',v17_position_id:'p',v17_order_id:'o',accounting_status:'ACCOUNTED'},
 trade={id:1,orderId:2,isBuyer:true,qty:'1',price:'100',commission:'.05',commissionAsset:'USDT',time:now};
 assert.deepEqual(reconcileTrades([fill],{BTCUSDT:[trade]},now-86400000).failures,[]);
 assert.ok(reconcileTrades([{...fill,quantity:2}],{BTCUSDT:[trade]},now-86400000).failures.includes('EXCHANGE_DB_FILL_OR_FEE_MISMATCH'));
 assert.ok(reconcileTrades([{...fill,v17_position_id:null}],{BTCUSDT:[trade]},now-86400000).failures.includes('FILL_ATTRIBUTION_MISSING'));
 assert.ok(reconcileTrades([{...fill,accounting_status:'PENDING'}],{BTCUSDT:[trade]},now-86400000).failures.includes('FILL_ACCOUNTING_UNSETTLED'));
 assert.ok(reconcileTrades([],{BTCUSDT:[trade]},now-86400000).failures.includes('EXCHANGE_FILL_MISSING_IN_DB'));
 assert.ok(reconcileTrades([fill],{},now-86400000).failures.includes('DB_FILL_EXCHANGE_PROOF_MISSING'));
});
test('a saturated trade page cannot establish complete fill truth',()=>{
 assert.ok(reconcileTrades([],{BTCUSDT:Array.from({length:1000},()=>({time:now}))},now-86400000).failures.includes('TRADE_HISTORY_INCOMPLETE'));
});
