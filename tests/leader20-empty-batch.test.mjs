import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {callBatch,buildBatch,unpackSymbol,EVIDENCE_FORMAT} from '../supabase/functions/_shared/leader20/batch.mjs';
import {paidTransport} from '../supabase/functions/_shared/leader20/paid-transport.mjs';
import {rawCapture} from '../test-support/dynamic-fixtures.mjs';
const fixture=JSON.parse(await readFile(new URL('../test-support/production-all-blocked-20260928.json',import.meta.url)));
test('original all-blocked production batch keeps all ten explicit blocks with no provider reservation or transport',async()=>{
 const b=fixture.source_batch,original=structuredClone(b.packet);let rpc=0,network=0;
 const transport=paidTransport({rpc:async()=>{rpc++;throw Error('must not reserve');}},
  {parentKey:'batch:'+b.id,purpose:'ENTRY',fetchFn:async()=>{network++;throw Error('must not dispatch');}});
 const out=await callBatch(b.packet,{fetchFn:transport,now:()=>b.packet.as_of_ms+100});
 assert.equal(b.result.attempted,true);assert.equal(b.result.api_cost_usd,.001440804);
 assert.equal(out.attempted,false);assert.equal(out.api_cost_usd,0);assert.equal(out.usage,null);
 assert.equal(out.error,'BATCH_NO_READY_SYMBOLS');assert.equal(out.request_id,undefined);
 assert.equal(rpc,0);assert.equal(network,0);assert.deepEqual(b.packet,original);
 assert.equal(out.results.length,10);assert.equal(new Set(out.results.map(r=>r.id)).size,10);
 assert.deepEqual(out.results,b.result.results);assert.ok(out.results.every(r=>!r.valid&&r.decision==='BLOCKED'));
});
test('new complete data recovers normally and any READY symbol still gets one batch call without discarding other blocks',async()=>{
 const at=1800000000200,symbols=fixture.source_batch.packet.symbols;
 for(const readyCount of [1,10]){
  const rows=symbols.map((s,i)=>({symbol:s.id,rank:i+1,capture:i<readyCount?rawCapture(at):{status:'UNAVAILABLE',reason:'CAPTURE_READ'}}));
  const b=await buildBatch(rows,{asOf:at,epochId:'recovered',generation:2});let calls=0;
  for(let i=0;i<readyCount;i++)assert.deepEqual(unpackSymbol(b,b.symbols[i]),rows[i].capture.trajectory);
  const out=await callBatch(b,{apiKey:'fixture',now:()=>at,fetchFn:async(_url,options)=>{
   calls++;const ids=JSON.parse(JSON.parse(options.body).messages[1].content).symbols.map(s=>s.id);
   assert.deepEqual(ids,symbols.map(s=>s.id));
   return Response.json({model:'deepseek-flash',usage:{prompt_tokens:20000,completion_tokens:2000},choices:[{finish_reason:'stop',message:{
    content:JSON.stringify({results:b.symbols.map(s=>({id:s.id,version:s.review_ref,last_ms:s.last_ms,decision:s.state==='READY'?'WAIT':'BLOCKED',
     reason:'Mixed recent flow',uncertainty:'Uncertain continuation',evidence_format:EVIDENCE_FORMAT,
     evidence:[[0,b.columns.indexOf('mid')],[23,b.columns.indexOf('aggressive_buy')]]}))})}}]});
  }});
  assert.equal(calls,1);assert.equal(out.attempted,true);assert.equal(out.results.filter(r=>r.valid).length,readyCount);
  assert.equal(out.results.filter(r=>r.decision==='BLOCKED').length,10-readyCount);assert.equal(out.api_cost_usd,.0084);
 }
});
