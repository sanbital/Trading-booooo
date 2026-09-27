import test from 'node:test';
import assert from 'node:assert/strict';
import {readSources} from '../supabase/functions/_shared/gpt-final-decision/market.mjs';
import {rawCapture} from '../test-support/dynamic-fixtures.mjs';
const T=1800000000200;

async function read({slow=true,failedRefresh=false,mode='LIVE'}={}){
 let at=T+(slow?2000:1000),captures=0,books=0,sensors=0;
 const prior=globalThis.Deno;
 globalThis.Deno={env:{get:k=>k==='SUPABASE_URL'?'https://capture.test':'fixture-key'}};
 try{
  const result=await readSources('ABCUSDT',at,{mode,now:()=>at,captureSleep:async ms=>{at+=ms;},fetchFn:async(url,init)=>{
   const u=new URL(url);
   if(u.pathname.endsWith('doa_context_for_role_v1')){
    captures++;const asOf=Date.parse(JSON.parse(init.body).p_as_of);
    return Response.json(failedRefresh&&captures>1?{status:'UNAVAILABLE',reason:'GAP'}:rawCapture(asOf));
   }
   if(u.pathname.endsWith('doa_market_sensor_context_v1')){sensors++;return Response.json({status:'UNAVAILABLE',reason:'FIXTURE'});}
   if(u.pathname.endsWith('/depth')){books++;return Response.json({T:at,bids:[['1','100']],asks:[['1.001','100']]});}
   if(slow&&u.pathname.endsWith('/openInterestHist')){await new Promise(resolve=>setTimeout(resolve,50));at=T+5000;}
   return Response.json([]);
  }});
  return {...result,at,captures,books,sensors};
 }finally{if(prior===undefined)delete globalThis.Deno;else globalThis.Deno=prior;}
}

test('slow historical sources trigger one fresh book/capture/sensor read before freezing',async()=>{
 const r=await read();assert.equal(r.captures,2);assert.equal(r.books,2);assert.equal(r.sensors,2);
 assert.equal(r.src.captureContext.status,'AVAILABLE');
 assert.ok(r.at-r.src.captureContext.end_ms<=1500);
 assert.ok(r.src.captureContext.pre_inference_refresh.previous_age_ms>5000);
 assert.equal(r.src.book.requestedAtMs,r.at);
});
test('fresh sources need no extra read',async()=>{
 const r=await read({slow:false});assert.equal(r.captures,1);assert.equal(r.books,1);assert.equal(r.sensors,1);
 assert.equal(r.src.captureContext.pre_inference_refresh,undefined);
});
test('failed refresh remains unavailable instead of relabelling old data fresh',async()=>{
 const r=await read({failedRefresh:true});assert.ok(r.captures>=2);
 assert.equal(r.src.captureContext.status,'UNAVAILABLE');assert.equal(r.src.captureContext.reason,'INFERENCE_CAPTURE_NOT_READY');
 assert.ok(r.src.captureContext.pre_inference_refresh);
});
test('replay never requests live microstructure',async()=>{
 const r=await read({mode:'REPLAY'});assert.equal(r.captures+r.books+r.sensors,0);
 assert.equal(r.src.captureContext,undefined);
});
