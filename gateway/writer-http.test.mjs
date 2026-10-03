import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHmac,randomUUID} from 'node:crypto';

// Local HTTP + fixture transports only: no production DB or venue commands.
const secret='writer-http-fixture-'.repeat(3);
process.env.GATEWAY_SHARED_SECRET=secret;
process.env.SUPABASE_URL='https://writer-db.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-only';
process.env.BINANCE_API_KEY='fixture-only';
process.env.BINANCE_SECRET_KEY='fixture-only';
process.env.ORDER_WRITER_REQUIRED='true';
process.env.SCHEDULER_ENABLED='false';
const owner=randomUUID();
const order={exchange:'binance_futures',action:'create_order',engine_version:'8.0.0-P10-DONCHIAN-SLOW4R',leverage:3,
 order:{market:'BTCUSDT',side:'BUY',type:'LIMIT',price:100,quantity:4.5,time_in_force:'IOC',
 identifier:'tb-writer-http-fixture',position_side:'LONG',position_effect:'OPEN'},wait_for_final_ms:0,
 writer:{account_key:'binance_futures:futures',owner,fence:1,execution_key:'fixture-command'}};
const json=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
async function fixture(t,authorize){
 const calls=[],original=globalThis.fetch;
 globalThis.fetch=async(input,init={})=>{
  const u=new URL(String(input)),method=init.method??'GET';calls.push({path:u.pathname,method});
  if(u.hostname==='writer-db.invalid'){
   assert.equal(u.pathname,'/rest/v1/rpc/v17_gateway_authorize');
   const body=JSON.parse(init.body);assert.equal(body.p_owner,owner);assert.equal(body.p_fence,1);
   assert.equal(body.p_command.writer,undefined);return json(await authorize(body,calls));
  }
  if(u.pathname==='/api/v3/time')return json({serverTime:Date.now()});
  if(u.pathname==='/fapi/v1/exchangeInfo')return json({symbols:[{symbol:'BTCUSDT',status:'TRADING',contractType:'PERPETUAL',baseAsset:'BTC',quoteAsset:'USDT',filters:[
   {filterType:'PRICE_FILTER',tickSize:'0.1'},{filterType:'LOT_SIZE',stepSize:'0.1',minQty:'0.1',maxQty:'1000'},
   {filterType:'MARKET_LOT_SIZE',stepSize:'0.1',minQty:'0.1',maxQty:'1000'},{filterType:'MIN_NOTIONAL',notional:'5'}]}]});
  if(u.pathname==='/fapi/v1/positionSide/dual')return json({dualSidePosition:false});
  if(u.pathname==='/fapi/v1/leverage')return json({symbol:'BTCUSDT',leverage:3});
  if(u.pathname==='/fapi/v1/order'&&method==='POST')return json({symbol:'BTCUSDT',orderId:123,clientOrderId:order.order.identifier,status:'EXPIRED',side:'BUY',origQty:'4.5',executedQty:'0',cumQuote:'0',avgPrice:'0'});
  if(u.pathname==='/fapi/v1/userTrades')return json([]);
  throw Error('UNEXPECTED_FIXTURE_TRANSPORT');
 };
 const gateway=await import(`./server.mjs?writer-http=${randomUUID()}`);
 const server=gateway.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{globalThis.fetch=original;await new Promise(r=>server.close(r));});
 const send=command=>new Promise((resolve,reject)=>{
  const body=JSON.stringify(command),ts=String(Date.now()),nonce=randomUUID(),signature=createHmac('sha256',secret).update(`${ts}\n${nonce}\n${body}`).digest('hex');
  const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/v1/command',method:'POST',headers:{'content-type':'application/json','x-gateway-ts':ts,'x-gateway-nonce':nonce,'x-gateway-signature':signature}},res=>{
   let raw='';res.on('data',s=>raw+=s);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw)}));});req.on('error',reject);req.end(body);
 });return {send,calls};
}
test('real HTTP route authorizes the writer and rechecks both leverage and order boundaries',async t=>{
 let checks=0;const f=await fixture(t,()=>{checks++;return true;});
 const r=await f.send(order);assert.equal(r.status,200);assert.equal(r.body.ok,true);
 assert.equal(r.body.result.order.exchange_order_id,'123');assert.equal(checks,3);
 assert.equal(f.calls.filter(c=>c.path==='/fapi/v1/leverage'&&c.method==='POST').length,1);
 assert.equal(f.calls.filter(c=>c.path==='/fapi/v1/order'&&c.method==='POST').length,1);
});
test('HTTP entry without a writer cannot borrow legacy management authority or reach the venue',async t=>{
 const f=await fixture(t,()=>assert.fail('no DB authority for unfenced entry'));
 const {writer,...unfenced}=order;const r=await f.send(unfenced);
 assert.equal(r.status,503);assert.equal(r.body.code,'FINAL_BUY_WRITER_REQUIRED');assert.equal(f.calls.length,0);
});
test('writer changing after HTTP admission refuses the final signed order with zero venue writes',async t=>{
 let checks=0;const f=await fixture(t,()=>++checks===1);const r=await f.send(order);
 assert.equal(r.status,503);assert.equal(r.body.code,'WRITER_FENCED');assert.equal(checks,2);
 assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path.startsWith('/fapi/')).length,0);
});
