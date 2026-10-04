import test from 'node:test';import assert from 'node:assert/strict';
import {evaluateModule,mockDb} from './harness.mjs';

test('executor and generator evaluate their complete module bodies and register one handler',async()=>{
 const e=await evaluateModule();assert.equal(e.served.length,1);assert.equal(e.value('NATIVE_STOP_ENABLED'),false);
 const g=await evaluateModule(new URL('../../supabase/functions/v10-lane-signal-generator/index.ts',import.meta.url));assert.equal(g.served.length,1);
 const native=await evaluateModule(undefined,{env:{V17_NATIVE_STOP:'true'}});assert.equal(native.value('NATIVE_STOP_ENABLED'),true);
 assert.equal(native.value('MAX_SLOTS'),10);assert.equal(native.value('LEV'),3);assert.equal(native.value('MARGIN'),150);assert.equal(native.value('POLICY.stopPct'),.025);
});
test('a final validation refusal persists a rejected intent and sends no order',async()=>{
 const {db,writes}=mockDb(q=>q.rpc?{data:true}:{data:{id:'intent',requested_quantity:4.5,client_order_id:'test-id'}}),h=await evaluateModule();
 h.ctx.requireEntryAuthority=async()=>{};h.ctx.verifyExecutionLease=async()=>{};let sends=0;
 const r=await h.ctx.dispatchEntryIocAttempt(db,{id:'signal',symbol:'TESTUSDT'},async()=>{sends++;throw Error('must not send')},
  {attemptNo:1,quantity:4.5,limitPrice:100,step:.1,payload:{entry_latency:{}},authorize:async()=>({allowed:false,reason:'FLOW_REVERSED'})});
 assert.equal(r.blocked,true);assert.equal(sends,0);assert.equal(writes.at(-1).patch.state,'REJECTED');assert.equal(writes.at(-1).patch.response_payload.notDispatched,true);
});
test('IOC acknowledgement is followed by the same order query; terminal partial stays partial',async()=>{
 const intent={id:'intent',requested_quantity:4.5,client_order_id:'test-id',symbol:'TESTUSDT'},
  {db}=mockDb(q=>q.rpc==='deterministic_begin_submit'?{data:{updated:true,order_id:'intent'}}:{data:intent}),h=await evaluateModule();h.ctx.requireEntryAuthority=async()=>{};h.ctx.verifyExecutionLease=async()=>{};
 const calls=[],raw={order:{exchange_order_id:'123',client_order_id:'test-id',market:'TESTUSDT',side:'BUY',reduce_only:false,status:'PARTIALLY_FILLED_CANCELED',raw_status:'EXPIRED',
  executed_volume:2,requested_volume:4.5,average_price:100,raw:{positionSide:'BOTH',status:'EXPIRED',executedQty:'2',origQty:'4.5',avgPrice:'100',updateTime:Date.now()}}};
 const gw=async(cmd,timeout,options)=>{await options?.beforeTransport?.();calls.push(cmd);return raw;};const attempt={},r=await h.ctx.dispatchEntryIocAttempt(db,{id:'signal',symbol:'TESTUSDT'},gw,
  {attemptNo:1,quantity:4.5,limitPrice:100,step:.1,payload:{entry_latency:{}},authorize:async()=>({allowed:true}),attempt});
 assert.deepEqual(calls.map(x=>x.action),['create_order','get_order']);assert.equal(calls[1].exchange_order_id,'123');
 assert.equal(r.receipt.quantity,2);assert.ok(r.receipt.quantity<r.receipt.requested);assert.equal(attempt.dispatched,true);
 assert.ok(r.evidence.entryLatency.order_sent<=r.evidence.entryLatency.exchange_ack);
});
test('an ambiguous send failure retains the same durable identity and never retries create',async()=>{
 const {db,writes}=mockDb(q=>q.rpc==='deterministic_begin_submit'?{data:{updated:true,order_id:'intent'}}:{data:{id:'intent',requested_quantity:4.5,client_order_id:'test-id'}}),h=await evaluateModule();
 h.ctx.requireEntryAuthority=async()=>{};h.ctx.verifyExecutionLease=async()=>{};h.ctx.circuit=async()=>{};
 let sends=0;await assert.rejects(()=>h.ctx.dispatchEntryIocAttempt(db,{id:'signal',symbol:'TESTUSDT'},async()=>{sends++;throw Error('transport timeout')},
  {attemptNo:1,quantity:4.5,limitPrice:100,step:.1,payload:{entry_latency:{}},authorize:async()=>({allowed:true})}),/transport timeout/);
 assert.equal(sends,1);assert.ok(writes.some(x=>x.patch.state==='RECONCILIATION_FAILED'));assert.ok(writes.some(x=>x.patch.status==='ORDERED'));
});
test('lease ownership is required and a contending request cannot enter the trading body',async()=>{
 const {db}=mockDb(q=>({data:false})),h=await evaluateModule();let ran=false;
 assert.equal((await h.ctx.runWithLease(db,async()=>{ran=true})).skipped,'V17_EXECUTOR_BUSY');assert.equal(ran,false);
 await assert.rejects(()=>h.ctx.verifyExecutionLease(db),/LEASE_MISSING/);
});
test('old provider request modes cannot reach the executor run handler',async()=>{
 const h=await evaluateModule(undefined,{env:{SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture'},
  client:{from(){const b={select(){return b},eq(){return b},maybeSingle:async()=>({data:{token:'fixture'}})};return b}}});
 for(const mode of ['gpt-final','gpt-hold','gpt-final-recheck']){
  const r=await h.served[0](new Request('https://fixture.invalid',{method:'POST',headers:{'x-v10-executor-token':'fixture'},body:JSON.stringify({mode})}));
  assert.equal(r.status,400);assert.equal((await r.json()).error,'RETIRED_OR_INVALID_MODE');
 }
});

test('lost mandatory submit acknowledgement refuses before send and does not create ambiguous exposure',async()=>{
 const {db,writes}=mockDb(q=>q.rpc==='deterministic_begin_submit'?{error:{code:'CONNECTION_RESET'}}:{data:{id:'intent',requested_quantity:4.5,client_order_id:'test-id'}}),h=await evaluateModule();
 h.ctx.requireEntryAuthority=async()=>{};h.ctx.verifyExecutionLease=async()=>{};let sends=0;
 const r=await h.ctx.dispatchEntryIocAttempt(db,{id:'signal',symbol:'TESTUSDT'},async(cmd,timeout,options)=>{await options?.beforeTransport?.();sends++},{attemptNo:1,quantity:4.5,limitPrice:100,step:.1,payload:{},authorize:async()=>({allowed:true})});
 assert.equal(r.blocked,true);assert.equal(sends,0);assert.equal(writes.at(-1).patch.state,'REJECTED');assert.equal(writes.at(-1).patch.response_payload.submissionPhase,'PRE_SEND');
});

test('short account mode keeps analysis outside writer authority and fences the actual gateway command',async()=>{
 let lease=null,fence=0;const {db}=mockDb(q=>{
  if(q.rpc==='v17_acquire_analysis_lease')return {data:{owner:q.args.p_owner,fence:1}};
  if(q.rpc==='v17_acquire_gateway_writer'){if(lease)return {data:null};lease=q.args.p_owner;fence++;return {data:{owner:lease,fence}};}
  if(q.rpc==='v17_release_writer'){lease=null;return {data:true};}
  if(q.rpc==='v17_verify_writer')return {data:lease===q.args.p_owner};
  if(q.rpc)return {data:true};
  return {data:q.table==='v17_execution_infrastructure_control'?{short_writer_enabled:true}:{owner:lease,fence}};
 }),commands=[],h=await evaluateModule(undefined,{env:{BINANCE_FUTURES_ORDER_GATEWAY_URL:'https://fixture.invalid',BINANCE_FUTURES_GATEWAY_SHARED_SECRET:'fixture'},extra:{fetch:async(url,init)=>{commands.push(JSON.parse(init.body));return new Response(JSON.stringify({ok:true,result:{ack:true}}));}}});
 await h.ctx.loadAccountExecutionMode(db);h.ctx.__db=db;
 const scopes=h.value('accountHostScopes.get(__db)');
 await scopes.periodic(async()=>{
  assert.equal(lease,null);
  const gw=h.ctx.opsGateway(db);
  await assert.rejects(()=>gw({action:'v17_create_stop'}),/ACCOUNT_WRITER_CONTEXT_REQUIRED/);
  await h.ctx.withAccountMutation(db,async()=>{assert.ok(lease);await gw({action:'v17_create_stop'});});
  assert.equal(lease,null);
 });
 assert.equal(commands.length,1);assert.equal(commands[0].writer.account_key,'binance_futures:futures');assert.equal(commands[0].writer.fence,1);assert.equal(commands[0].writer.execution_key.length,64);
});

test('legacy account lease mode also sends a current fenced writer envelope',async()=>{
 const {db}=mockDb(q=>q.rpc?{data:true}:{data:{owner:'fixture-owner',fence:7}}),commands=[],h=await evaluateModule(undefined,{env:{BINANCE_FUTURES_ORDER_GATEWAY_URL:'https://fixture.invalid',BINANCE_FUTURES_GATEWAY_SHARED_SECRET:'fixture'},extra:{fetch:async(url,init)=>{commands.push(JSON.parse(init.body));return new Response(JSON.stringify({ok:true,result:{ack:true}}));}}});
 h.ctx.__db=db;h.value("leaseOwners.set(__db,'fixture-owner')");await h.ctx.opsGateway(db)({action:'v17_create_stop'});
 assert.equal(commands.length,1);assert.equal(commands[0].writer.owner,'fixture-owner');assert.equal(commands[0].writer.fence,7);
});
