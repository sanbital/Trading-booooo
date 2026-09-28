import test from 'node:test';
import assert from 'node:assert/strict';
import {rawCapture} from '../test-support/dynamic-fixtures.mjs';
import {buildBatch,unpackSymbol,validateBatchResponse,callBatch,deepseekCost} from '../supabase/functions/_shared/leader20/batch.mjs';
const T=1800000000200;
const rows=()=>Array.from({length:10},(_,i)=>({symbol:`C${i}USDT`,rank:i+1,capture:rawCapture(T)}));
const build=r=>buildBatch(r,{asOf:T,epochId:'e',generation:1});
const response=b=>({results:b.symbols.map(s=>({id:s.id,version:s.review_ref,decision:'PASS',reason:'Flow reversal warrants review',uncertainty:'OI unknown',last_ms:s.last_ms,
 evidence:[[0,'mid',s.matrix[0]?.[b.columns.indexOf('mid')]],[23,'aggressive_buy',s.matrix[23]?.[b.columns.indexOf('aggressive_buy')]]]}))});
test('one request contains all ten IDs and 240 lossless ordered buckets',async()=>{
 const r=rows(),b=await build(r);let calls=0;
 for(let i=0;i<10;i++)assert.deepEqual(unpackSymbol(b,b.symbols[i]),r[i].capture.trajectory);
 const result=await callBatch(b,{apiKey:'fixture',fetchFn:async(url,options)=>{
  calls++;const p=JSON.parse(options.body);assert.equal(p.messages.length,2);
  assert.equal(JSON.parse(p.messages[1].content).symbols.length,10);
  return Response.json({model:'deepseek-flash',usage:{prompt_tokens:20000,completion_tokens:2000},choices:[{finish_reason:'stop',message:{content:JSON.stringify(response(b))}}]});
 }});assert.equal(calls,1);assert.equal(result.results.filter(r=>r.valid).length,10);assert.equal(result.api_cost_usd,.0084);
});
test('QNT-style gap/time reversal and stale captures block just the affected symbol',async()=>{
 const r=rows();r[0].capture.trajectory[12].bucket_ms-=5000;r[1].capture.end_ms=T-30000;
 const b=await build(r),v=validateBatchResponse(response(b),b);
 assert.equal(v.results.filter(r=>r.valid).length,8);assert.equal(v.results[0].decision,'BLOCKED');
});
test('missing, duplicate and version-mismatched IDs cannot hide good rows',async()=>{
 const b=await build(rows()),w=response(b);w.results.pop();w.results.push(w.results[0]);w.results[1].version='old';
 w.results.push({...w.results[2],id:'UNKNOWN'});
 const v=validateBatchResponse(w,b);assert.equal(v.results.filter(r=>r.valid).length,7);
 assert.equal(v.errors.length,1);assert.equal(v.results[9].reason,'MISSING_ID');
 assert.equal(validateBatchResponse('{bad',b).results.filter(r=>r.valid).length,0);
});
test('versions bind every bucket and never permanently suppress SKIP',async()=>{
 const r=rows(),b=await build(r);r[0].capture.trajectory[3].d_mid_bps+=1;
 const later=await buildBatch(rows(),{asOf:T+1,epochId:'e',generation:1});assert.equal(b.batch_hash,later.batch_hash);
 const changed=await build(r);assert.notEqual(b.symbols[0].data_version,changed.symbols[0].data_version);
 assert.equal(b.symbols[1].data_version,changed.symbols[1].data_version);
 const w=response(b);w.results[0].decision='SKIP';assert.equal(validateBatchResponse(w,b).results[0].valid,true);
 assert.equal(validateBatchResponse(response(changed),changed).results[0].decision,'PASS');
});
test('held overlap is blocked and provider failure never retries the same capture',async()=>{
 const b=await buildBatch(rows(),{asOf:T,epochId:'e',generation:1,held:['C0USDT']});let calls=0;
 assert.equal(validateBatchResponse(response(b),b).results[0].reason,'HELD_POSITION');
 assert.equal(b.symbols[0].matrix.length,0);
 const r=await callBatch(b,{apiKey:'fixture',fetchFn:async()=>{calls++;throw Error('network');}});
 assert.equal(calls,1);assert.equal(r.results.every(x=>!x.valid),true);assert.equal(r.api_cost_usd,null);
});
test('usage preserves cache; invalid or unknown tokens retain reservation',()=>{
 assert.equal(deepseekCost({prompt_tokens:1000,completion_tokens:100,prompt_cache_hit_tokens:1000}).cost_usd,.000126);
 assert.equal(deepseekCost({prompt_tokens:1000,completion_tokens:100,prompt_cache_hit_tokens:1001}),null);
});
test('cross-symbol numeric evidence and unbound quantitative prose block only that symbol',async()=>{
 const r=rows();r[1].capture.trajectory[23].aggressive_buy=160508.597;
 const b=await build(r),w=response(b);
 w.results[0].evidence[1][2]=160508.597;
 let result=validateBatchResponse(w,b);
 assert.equal(result.results[0].reason,'CROSS_SYMBOL_OR_CELL_MISMATCH');
 assert.equal(result.results.filter(x=>x.valid).length,9);
 const prose=response(b);prose.results[0].reason='Net buy +160508 supports entry';
 assert.equal(validateBatchResponse(prose,b).results[0].reason,'UNCITED_QUANTITATIVE_PROSE');
 const missing=response(b);delete missing.results[0].evidence;
 assert.equal(validateBatchResponse(missing,b).results[0].reason,'EVIDENCE_REQUIRED');
 const repeated=response(b);repeated.results[0].evidence[0]=repeated.results[0].evidence[1];
 assert.equal(validateBatchResponse(repeated,b).results[0].reason,'EVIDENCE_DUPLICATE');
});
