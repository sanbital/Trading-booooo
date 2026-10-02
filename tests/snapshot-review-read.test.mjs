import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import crypto from 'node:crypto';import {snapshotProofProgram}from'../ops/execution-infra/snapshot-review-read.mjs';
test('generated Fly proof uses the real gateway shared-secret signature and only fresh read actions',async()=>{
 const commit='a'.repeat(40),secret='gateway-secret'.repeat(3),calls=[],outputs=[],process={env:{GATEWAY_SHARED_SECRET:secret}};
 const ctx={process,require:name=>{assert.equal(name,'node:crypto');return crypto;},AbortSignal,JSON,Date,Promise,Error,console:{log:s=>outputs.push(JSON.parse(s))},fetch:async(url,opt)=>{
  if(url.endsWith('/health'))return{json:async()=>({deployment_commit:commit,order_writer:{required:true}})};
  assert.equal(url,'http://127.0.0.1:8080/v1/command');assert.equal(opt.method,'POST');const h=opt.headers;
  assert.equal(h['x-gateway-signature'],crypto.createHmac('sha256',secret).update(h['x-gateway-ts']+'\n'+h['x-gateway-nonce']+'\n'+opt.body).digest('hex'));
  const body=JSON.parse(opt.body);assert.equal(body.exchange,'binance_futures');assert.ok(['p10_portfolio','v18_open_orders'].includes(body.action));calls.push(body.action);
  return{ok:true,json:async()=>({ok:true,result:body.action==='p10_portfolio'?{positions:[],observation:{id:'fresh'}}:{complete:true,orders:[],algos:[]}})};
 }};await vm.runInNewContext(snapshotProofProgram(commit),ctx);
 assert.deepEqual(calls.sort(),['p10_portfolio','v18_open_orders']);assert.equal(outputs[0].portfolio.observation.id,'fresh');assert.equal(process.exitCode,undefined);
});
test('generated venue reader fails before reads if deployed gateway commit differs',async()=>{
 const calls=[],process={env:{GATEWAY_SHARED_SECRET:'secret'}},out=[];
 await vm.runInNewContext(snapshotProofProgram('a'.repeat(40)),{require:()=>crypto,process,console:{log:s=>out.push(JSON.parse(s))},fetch:async url=>{calls.push(url);return{json:async()=>({deployment_commit:'b'.repeat(40),order_writer:{required:true}})}}});
 assert.equal(process.exitCode,1);assert.equal(calls.length,1);assert.equal(out[0].error,'READ_FAILED');
});
