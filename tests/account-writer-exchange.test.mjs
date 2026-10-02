import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createWriterExchange} from '../supabase/functions/_shared/account-writer-exchange.mjs';
import {createWriterGateway} from '../supabase/functions/_shared/account-writer-gateway.mjs';

test('gateway transport preserves narrow fencing and DB error codes without arbitrary response text',async()=>{
 for(const [raw,expected]of [['WRITER_FENCED','LEASE_FENCED'],['WRITER_DB_TIMEOUT','DB_TIMEOUT'],
  ['WRITER_DB_DNS_FAILURE','DNS_TEMPORARY_FAILURE'],['WRITER_DB_CONNECTION_RESET','DB_CONNECTION_RESET']]){
  const gateway=createWriterGateway({url:'https://fixture.invalid',secret:'fixture-secret',networkBoundMs:1000,
   fetchImpl:async()=>({ok:false,status:503,json:async()=>({ok:false,code:raw,error:'DO_NOT_LOG_ME'})})});
  await assert.rejects(gateway({action:'create_order'}),e=>e.code===expected&&e.message===expected);
 }
});
import {assertSettlementResult} from '../supabase/functions/_shared/account-order-writer.mjs';
const row={execution_key:'decision-attempt-1',account_key:'binance_futures:futures',kind:'ENTRY',
 symbol:'TESTUSDT',side:'BUY',client_order_id:'stable-client-id',created_at:new Date().toISOString(),
 payload:{exchange:'binance_futures',action:'create_order',engine_version:'UNCHANGED_ENGINE',
 order:{market:'TESTUSDT',side:'BUY',identifier:'stable-client-id',quantity:1}}};
const raw={orderId:123,clientOrderId:row.client_order_id,symbol:row.symbol,side:'BUY',positionSide:'BOTH',
 reduceOnly:false,origQty:1,executedQty:0,avgPrice:0,status:'NEW'};
test('fenced transport signs the exact durable payload, uses abort and never alters order fields',async()=>{
 let submitted;
 const gateway=createWriterGateway({url:'https://fixture.invalid',secret:'fixture-secret',networkBoundMs:1200,
 fetchImpl:async(url,options)=>{
  submitted=JSON.parse(options.body);
  const expected=createHmac('sha256','fixture-secret').update(options.headers['x-gateway-ts']+'\n'+options.headers['x-gateway-nonce']+'\n'+options.body).digest('hex');
  assert.equal(options.headers['x-gateway-signature'],expected);assert.ok(options.signal);
  return {ok:true,json:async()=>({ok:true,result:raw})};
 }});
 const controller=new AbortController();await gateway(row.payload,{signal:controller.signal});
 assert.deepEqual(submitted,row.payload);controller.abort();await assert.rejects(gateway(row.payload,{signal:controller.signal}));
});
test('submission is followed by same-client-ID query using existing entry receipt guards',async()=>{
 const calls=[];const exchange=createWriterExchange({gateway:async command=>{calls.push(command);return raw;}});
 const lease={owner:crypto.randomUUID(),fence:7};let verified=0;
 const receipt=await exchange.submitFenced(row,{lease,verify:async()=>{verified++;}});
 assert.equal(verified,1);assert.equal(receipt.status,'NEW');assert.equal(receipt.quantity,0);
 assert.deepEqual(calls[0],{...row.payload,writer:{account_key:row.account_key,execution_key:row.execution_key,owner:lease.owner,fence:'7'}});
 assert.equal(calls[1].action,'get_order');assert.equal(calls[1].identifier,row.client_order_id);
});
test('an acknowledgement or same-symbol order with another client ID cannot settle this request',async()=>{
 const exchange=createWriterExchange({gateway:async command=>command.action==='create_order'?raw:{...raw,clientOrderId:'another-id'}});
 await assert.rejects(exchange.submitFenced(row,{lease:{owner:'owner',fence:1},verify:async()=>{}}),/ENTRY_ORDER_EVIDENCE_PENDING/);
});
test('negative lookup requires existing complete corroborated proof and never submits',async()=>{
 let submits=0;
 for(const complete of [false,true]) {
  const exchange=createWriterExchange({gateway:async command=>{
   if(command.action==='create_order'){submits++;assert.fail();}
   if(command.action==='get_order')throw Error('GW_-2013 order does not exist');
   assert.equal(command.action,'v18_entry_never_placed_proof');
   return {proven:complete,found:false,position_quantity:0,position_read_ok:true,trade_read_ok:complete};
  }});
  const result=await exchange.lookup(row);assert.equal(result.neverPlaced,complete);assert.equal(result.complete,complete);
 }
 assert.equal(submits,0);
});
test('DNS/5xx lookup failures and retention-expired orders never become negative proof',async()=>{
 for(const error of ['DNS timeout','GATEWAY_HTTP_503','order does not exist']) {
  let reads=0;
  const exchange=createWriterExchange({now:()=>Date.now()+7*3600000,gateway:async()=>{reads++;throw Error(error);}});
  const result=await exchange.lookup(row);assert.equal(result.complete,false);assert.equal(reads,1);
 }
});
test('partial execution cannot become FILLED even if an adapter reports that result',()=>{
 assert.throws(()=>assertSettlementResult(row,{quantity:.2,status:'PARTIALLY_FILLED'},{state:'FILLED'}),/PARTIAL_FILL_CANNOT_BE_FILLED/);
 assert.throws(()=>assertSettlementResult(row,{quantity:.2,status:'FILLED'},{state:'FILLED'}),/PARTIAL_FILL_CANNOT_BE_FILLED/);
 assert.doesNotThrow(()=>assertSettlementResult(row,{quantity:1,status:'FILLED'},{state:'FILLED'}));
});
test('wrong or missing durable client ID is blocked before network',async()=>{
 const exchange=createWriterExchange({gateway:()=>assert.fail()});
 await assert.rejects(exchange.submitFenced({...row,client_order_id:'other'},{}),/WRITER_CLIENT_ORDER_ID_MISMATCH/);
});
test('arbitrary gateway failure bodies cannot appear in thrown errors',async()=>{
 const gateway=createWriterGateway({url:'https://fixture.invalid',secret:'fixture-secret',networkBoundMs:1000,
  fetchImpl:async()=>({ok:false,status:503,json:async()=>({ok:false,error:'Authorization: DO_NOT_LOG_ME'})})});
 await assert.rejects(gateway(row.payload),error=>error.message==='GATEWAY_HTTP_503'&&!error.message.includes('DO_NOT_LOG_ME'));
});
