import test from 'node:test';
import assert from 'node:assert/strict';
import {beforeExchangeMutation,createOrderWriterFence,createGatewayAuthorizer,hasExchangeSideEffect} from './order-writer-fence.mjs';
const command={action:'create_order',exchange:'binance_futures',writer:{account_key:'binance_futures:futures',
  execution_key:'stable-key',owner:crypto.randomUUID(),fence:1}};
test('expand deployment preserves legacy behavior while required mode fails closed',async()=>{
  let calls=0;
  const old=createOrderWriterFence({required:false,authorize:()=>assert.fail()});
  await old.run({action:'create_order'},()=>calls++);assert.equal(calls,1);
  const next=createOrderWriterFence({required:true,authorize:()=>assert.fail()});
  await assert.rejects(next.run({action:'create_order'},()=>calls++),/WRITER_ENVELOPE_REQUIRED/);
  assert.equal(calls,1);
});
test('all writes and unknown actions require fencing; read-only stop proof remains available',()=>{
  for(const action of ['create_order','cancel_order','cancel_bot_orders','set_leverage','v17_create_stop','v17_cancel_stop','future_write']) {
    assert.equal(hasExchangeSideEffect({action}),true,action);
  }
  for(const action of ['p10_portfolio','v18_open_orders','get_order','v17_stop_fill','v17_query_stop']) {
    assert.equal(hasExchangeSideEffect({action}),false,action);
  }
});
test('fenced or unavailable DB never calls exchange',async()=>{
  for(const authorize of [async()=>false,async()=>{throw Error('DB connection refused');}]) {
    const gate=createOrderWriterFence({required:true,authorize});let submits=0;
    await assert.rejects(gate.run(command,()=>submits++));assert.equal(submits,0);
  }
});
test('queued writer verifies again after predecessor completes; no concurrent exchange mutation',async()=>{
  let finish,active=0,maxActive=0,currentFence=1;
  const gate=createOrderWriterFence({required:true,authorize:async w=>w.fence===currentFence});
  const first=gate.run(command,async()=>{active++;maxActive=Math.max(maxActive,active);
    await new Promise(resolve=>{finish=resolve;});active--;});
  await new Promise(resolve=>setImmediate(resolve));
  let secondCalls=0;
  const second=gate.run(command,()=>secondCalls++);
  const rejected=assert.rejects(second,/WRITER_FENCED/);
  currentFence=2;finish();await first;await rejected;
  assert.equal(secondCalls,0);assert.equal(maxActive,1);assert.equal(gate.activeAccounts(),0);
});
test('cross-account envelope is refused',async()=>{
  const gate=createOrderWriterFence({required:true,authorize:()=>assert.fail()});
  await assert.rejects(gate.run({...command,writer:{...command.writer,account_key:'other'}},()=>assert.fail()),/WRITER_ACCOUNT_MISMATCH/);
});
test('authorizer rejects transient HTTP and malformed authorization without exposing body or secrets',async()=>{
  const auth=createGatewayAuthorizer({url:'https://example.invalid',key:'fixture-only',
    fetchImpl:async()=>({ok:false,status:503,text:()=>assert.fail()})});
  await assert.rejects(auth(command.writer,{}),/WRITER_DB_UNAVAILABLE/);
  const falseAuth=createGatewayAuthorizer({url:'https://example.invalid',key:'fixture-only',
    fetchImpl:async()=>({ok:true,json:async()=>({true:true})})});
  assert.equal(await falseAuth(command.writer,{}),false);
});
test('authorizer classifies DB timeout/DNS/reset/refused without leaking transport messages',async()=>{
  for(const [error,code]of [[Object.assign(Error('sensitive fixture detail'),{name:'TimeoutError'}),'WRITER_DB_TIMEOUT'],
    [Object.assign(Error('sensitive fixture detail'),{cause:{code:'EAI_AGAIN'}}),'WRITER_DB_DNS_FAILURE'],
    [Object.assign(Error('sensitive fixture detail'),{cause:{code:'ECONNRESET'}}),'WRITER_DB_CONNECTION_RESET'],
    [Object.assign(Error('sensitive fixture detail'),{cause:{code:'ECONNREFUSED'}}),'WRITER_DB_CONNECTION_REFUSED']]){
    const auth=createGatewayAuthorizer({url:'https://example.invalid',key:'fixture-only',fetchImpl:async()=>{throw error;}});
    await assert.rejects(auth(command.writer,{}),e=>e.code===code&&!e.message.includes('sensitive'));
  }
});

test('staged writer envelope is fenced again at final signed boundary even before mandatory cutover',async()=>{
 let checks=0,venueCalls=0;const gate=createOrderWriterFence({required:false,authorize:async()=>++checks===1});
 await assert.rejects(gate.run(command,async()=>{await beforeExchangeMutation({required:false,venue:'binance_futures',method:'POST',path:'/fapi/v1/order'});venueCalls++;}),/WRITER_FENCED/);assert.equal(checks,2);assert.equal(venueCalls,0);
});
test('legacy reduce-only management shares writer and releases it, while P10 BUY cannot borrow it',async()=>{
 let acquired=0,released=0,executed=0;const gate=createOrderWriterFence({required:true,authorize:async()=>true,acquireLegacy:async()=>{acquired++;return {envelope:command.writer,release:async()=>released++};}});
 await assert.rejects(gate.run({exchange:'binance_futures',action:'create_order',order:{side:'BUY',position_effect:'OPEN'}},()=>executed++),/FINAL_BUY_WRITER_REQUIRED/);assert.equal(acquired,0);
 await gate.run({exchange:'binance_futures',action:'create_order',order:{side:'SELL',position_effect:'CLOSE'}},async()=>{await beforeExchangeMutation({required:true,venue:'binance_futures',method:'POST',path:'/fapi/v1/order'});executed++;});assert.equal(acquired,1);assert.equal(released,1);assert.equal(executed,1);
});
