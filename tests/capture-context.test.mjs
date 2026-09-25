import {test} from 'node:test';import assert from 'node:assert/strict';
import {summarizeCapture} from '../collectors/doa-capture/context.mjs';
import {validateCapture,readCapture,contextForModel} from '../supabase/functions/_shared/gpt-final-decision/capture-context.mjs';
import {readSources} from '../supabase/functions/_shared/gpt-final-decision/market.mjs';
import {computeFacts} from '../supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {buildDecisionPacket,payloadFor,modelInput} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {buildRecheckPacket,recheckPayload,CHANGE_DEFS} from '../supabase/functions/_shared/gpt-final-decision/recheck.mjs';
function ring(t){return Array.from({length:12},(_,i)=>({payload:{available_at:new Date(t-(11-i)*5000).toISOString(),interval_start:new Date(t-(12-i)*5000).toISOString(),interval_end:new Date(t-(11-i)*5000).toISOString(),bucket_complete:true,coverage_25:true,coverage_50:true,spread_bps:i===11?4:2,mid:100+i,bid_25_usdt:1000-i*10,ask_25_usdt:1000+i*20,buy_quote_5s:300,sell_quote_5s:700,sell_quote_max_1s:500,displayed_ask_added_5s:100,displayed_ask_removed_5s:50,buy_vwap_450:111.01,sell_vwap_450:110.99}}));}
test('real 60s summary preserves units and does not fabricate ratios with zero depth',()=>{const t=Date.now(),r=ring(t),c=summarizeCapture(r,t);assert.equal(c.status,'AVAILABLE');assert.equal(c.values.spread_vs_60s_median,2);assert.equal(c.values.buy_share_60s,.3);assert.equal(c.values.bid_depth_25_change,-.11);r[0].payload.bid_25_usdt=0;assert.equal(summarizeCapture(r,t).values.bid_depth_25_change,null);});
test('warmup, missing sequence, future data and stale history fail closed',()=>{const t=Date.now(),r=ring(t);assert.equal(summarizeCapture(r.slice(1),t).status,'UNAVAILABLE');r[5].payload.bucket_complete=false;assert.equal(summarizeCapture(r,t).status,'UNAVAILABLE');assert.equal(summarizeCapture(ring(t+5000),t).status,'UNAVAILABLE');const c={...summarizeCapture(ring(t),t),ingested_at_ms:t};assert.equal(validateCapture(c,t+25001).status,'UNAVAILABLE');assert.equal(validateCapture({...c,ingested_at_ms:t+1},t).status,'UNAVAILABLE');assert.equal(contextForModel(c,t+25001).status,'UNAVAILABLE');});
test('capture read has a real deadline even if the network ignores AbortSignal',async()=>{const t=Date.now();const c=await readCapture('BTCUSDT',t,{timeoutMs:15,env:k=>k==='SUPABASE_URL'?'https://test':'key',fetchFn:()=>new Promise(()=>{})});assert.equal(c.reason,'TIMEOUT');assert.ok(Date.now()-t<250);});
test('capture context reaches actual serialized ENTRY, HOLD and RECHECK payloads and hash',async()=>{
 const t=Date.now(),capture=validateCapture({...summarizeCapture(ring(t-1000),t),ingested_at_ms:t},t);
 const facts=computeFacts({captureContext:capture},{asOf:t});
 for(const task of ['ENTRY','HOLD']){const p=await buildDecisionPacket({task,subjectId:'test',symbol:'BTCUSDT',dataMode:'LIVE',facts,position:{event:'REVIEW'}});const sent=JSON.parse(payloadFor(p).input[1].content);assert.equal(sent.capture_context.status,'AVAILABLE');assert.equal(sent.capture_context.values.buy_share_60s,.3);assert.match(payloadFor(p).input[0].content,/capture_context/);const q=await buildDecisionPacket({task,subjectId:'test',symbol:'BTCUSDT',dataMode:'LIVE',facts:computeFacts({},{asOf:t}),position:{event:'REVIEW'}});assert.notEqual(p.snapshot_hash,q.snapshot_hash);assert.deepEqual(modelInput(p).risk_flags,modelInput(q).risk_flags);}
 const deltas=Object.fromEntries(Object.keys(CHANGE_DEFS).map(k=>[k,null]));deltas.elapsed_since_initial_ms=null;
 const p=await buildRecheckPacket({signalId:'test',symbol:'BTCUSDT',facts,detection:{reasons:[],deltas}});
 assert.equal(JSON.parse(recheckPayload(p).input[1].content).current.capture_context.status,'AVAILABLE');assert.match(recheckPayload(p).input[0].content,/capture_context/);
});
test('REPLAY never reads production capture or includes future context',async()=>{let calls=[];const x=await readSources('BTCUSDT',Date.now(),{mode:'REPLAY',fetchFn:async url=>{calls.push(url);return new Response('[]');}});assert.ok(!calls.some(x=>x.includes('doa_gpt_capture_context')));assert.equal(x.src.captureContext,undefined);});
test('LIVE market reader carries authenticated capture through facts into the model input',async()=>{
 const t=Date.now(),old=globalThis.Deno;let reads=0;
 globalThis.Deno={env:{get:k=>k==='SUPABASE_URL'?'https://capture.test':'test-key'}};
 try{const {src}=await readSources('BTCUSDT',t,{fetchFn:async(url,opts)=>{
  if(url.startsWith('https://capture.test/')){reads++;assert.equal(opts.headers.apikey,'test-key');assert.equal(JSON.parse(opts.body).p_as_of,new Date(t).toISOString());return Response.json({...summarizeCapture(ring(t-1000),t),ingested_at_ms:t});}
  return Response.json([]);
 }});const facts=computeFacts(src,{asOf:t});const p=await buildDecisionPacket({task:'ENTRY',subjectId:'wire',symbol:'BTCUSDT',dataMode:'LIVE',facts});assert.equal(reads,1);assert.equal(JSON.parse(payloadFor(p).input[1].content).capture_context.status,'AVAILABLE');
 }finally{if(old===undefined)delete globalThis.Deno;else globalThis.Deno=old;}
});
