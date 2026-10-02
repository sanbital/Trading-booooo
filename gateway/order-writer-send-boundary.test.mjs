import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {beforeExchangeMutation,createOrderWriterFence} from './order-writer-fence.mjs';
const source=readFileSync(new URL('./server.mjs',import.meta.url),'utf8');
const transport=source.slice(source.indexOf('async function binanceRequest('),source.indexOf('const EXCHANGES ='));
const command={action:'create_order',exchange:'binance_futures',order:{identifier:'same-client-id'},
  writer:{account_key:'binance_futures:futures',execution_key:'same-execution',owner:crypto.randomUUID(),fence:1}};
function fixture({required=true,sync=async()=>{},parse=async()=>({data:{}}),fetchImpl=async()=>({})}={}){
  let sends=0;
  const scope={BINANCE_API_KEY:'fixture-only',BINANCE_SECRET_KEY:'fixture-only',ORDER_WRITER_REQUIRED:required,
    guardRate:()=>{},syncBinanceTime:sync,beforeExchangeMutation,binanceTimeOffsetMs:0,
    binanceQueryString:()=>'',createBinanceSignature:()=>'',binanceHost:()=> 'https://fixture.invalid',
    AbortController,setTimeout,clearTimeout,parseResponse:parse,
    fetch:async(...args)=>{sends++;return fetchImpl(...args);}};
  vm.runInNewContext(transport+';globalThis.send=futuresRequest;',scope);
  return{send:scope.send,sends:()=>sends};
}
test('real transport refuses a holder fenced during preparation, before exchange fetch',async()=>{
  let valid=true;
  const gate=createOrderWriterFence({required:true,authorize:async()=>valid});
  const f=fixture({sync:async()=>{valid=false;}});
  await assert.rejects(gate.run(command,()=>f.send('POST','/fapi/v1/order',{})),/WRITER_FENCED/);
  assert.equal(f.sends(),0);
});
test('each mutation rechecks ownership: leverage success cannot authorize a later order',async()=>{
  let valid=true;
  const gate=createOrderWriterFence({required:true,authorize:async()=>valid});
  const f=fixture({fetchImpl:async()=>{valid=false;return{};}});
  await assert.rejects(gate.run(command,async()=>{
    await f.send('POST','/fapi/v1/leverage',{});
    await f.send('POST','/fapi/v1/order',{});
  }),/WRITER_FENCED/);
  assert.equal(f.sends(),1,'only the earlier leverage request may be sent');
});
test('timestamp retry rechecks the same durable fence before a second network send',async()=>{
  let valid=true;
  const gate=createOrderWriterFence({required:true,authorize:async()=>valid});
  const f=fixture({sync:async force=>{if(force)valid=false;},
    parse:async()=>{throw Object.assign(Error('timestamp rejected'),{code:-1021});}});
  await assert.rejects(gate.run(command,()=>f.send('POST','/fapi/v1/order',{})),/WRITER_FENCED/);
  assert.equal(f.sends(),1);
});
test('background futures mutation without writer context fails closed',async()=>{
  const f=fixture();
  await assert.rejects(f.send('DELETE','/fapi/v1/algoOrder',{}),/WRITER_CONTEXT_REQUIRED/);
  assert.equal(f.sends(),0);
});
test('read-only reconciliation and venue dry-run stay usable when DB ownership is unavailable',async()=>{
  const f=fixture();
  await f.send('GET','/fapi/v1/order',{});
  await f.send('POST','/fapi/v1/order/test',{});
  assert.equal(f.sends(),2);
});
test('disabled expand mode preserves existing signed transport without writer context',async()=>{
  const f=fixture({required:false});
  await f.send('POST','/fapi/v1/order',{});assert.equal(f.sends(),1);
});
