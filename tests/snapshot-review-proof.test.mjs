import test from 'node:test';import assert from 'node:assert/strict';import {createHash,createHmac}from'node:crypto';import {readSnapshotReviewProof}from'../ops/execution-infra/snapshot-review-proof.mjs';
test('independent proof uses the verified audit signature and admits only two current read commands',async()=>{
 const token='t'.repeat(32),commit='a'.repeat(40),secret=createHash('sha256').update('gateway:'+token).digest('hex'),calls=[];
 const result=await readSnapshotReviewProof({app:'trading-booooo',token,commit,now:()=>1000,fetchImpl:async(url,opt)=>{
  if(url.endsWith('/health'))return{ok:true,json:async()=>({deployment_commit:commit,order_writer:{required:true}})};
  assert.equal(url,'https://trading-booooo.fly.dev/v1/command');assert.equal(opt.method,'POST');const h=opt.headers;
  assert.equal(h['x-gateway-signature'],createHmac('sha256',secret).update(h['x-gateway-ts']+'\n'+h['x-gateway-nonce']+'\n'+opt.body).digest('hex'));
  const cmd=JSON.parse(opt.body);calls.push(cmd.action);assert.equal(cmd.exchange,'binance_futures');
  return{ok:true,json:async()=>({ok:true,result:cmd.action==='p10_portfolio'?{positions:[],observation:{id:'new'}}:{complete:true,orders:[],algos:[]}})};
 }});assert.deepEqual(calls.sort(),['p10_portfolio','v18_open_orders']);assert.equal(result.portfolio.observation.id,'new');assert.equal(result.openOrders.complete,true);
});
test('build drift and permanent authentication failures fail closed without retry or side effect',async()=>{
 let reads=0;
 const config={app:'trading-booooo',token:'t'.repeat(32),commit:'a'.repeat(40)};
 await assert.rejects(readSnapshotReviewProof({...config,fetchImpl:async()=>({ok:true,json:async()=>({deployment_commit:'b'.repeat(40),order_writer:{required:true}})})}),/BUILD_CHANGED/);
 await assert.rejects(readSnapshotReviewProof({...config,fetchImpl:async url=>{
  if(url.endsWith('/health'))return{ok:true,json:async()=>({deployment_commit:config.commit,order_writer:{required:true}})};
  reads++;return{ok:false,status:401};
 }}),/HTTP_401/);assert.equal(reads,2);
});
