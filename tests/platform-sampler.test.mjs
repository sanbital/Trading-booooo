import test from 'node:test';import assert from 'node:assert/strict';
import {observePlatform,encryptTimeline} from '../ops/execution-infra/platform-sampler.mjs';
import {generateKeyPairSync,privateDecrypt,createDecipheriv} from 'node:crypto';
test('sampler only calls independent GET metrics and health and suppresses secret errors',async()=>{
 const seen=[];const result=await observePlatform({project:'p',token:'secret',signal:new AbortController().signal,fetchImpl:async(url,opts)=>{seen.push([url,opts.method]);throw Error('Authorization secret');}});
 assert.equal(seen.length,2);assert.ok(seen.every(([url,method])=>!url.includes('/query')&&!url.includes('/functions/')&&method===undefined));
 assert.equal(result.metrics.error,'TRANSPORT_FAILED');assert.ok(!JSON.stringify(result).includes('secret'));
});
test('encryption round trip preserves timeline without plaintext artifact',()=>{
 const pair=generateKeyPairSync('rsa',{modulusLength:2048});const data={samples:[{utc:'now',value:'private-account-state'}]};
 const encrypted=encryptTimeline(data,pair.publicKey);assert.ok(!JSON.stringify(encrypted).includes('private-account-state'));
 const key=privateDecrypt({key:pair.privateKey,oaepHash:'sha256'},Buffer.from(encrypted.key,'base64'));
 const d=createDecipheriv('aes-256-gcm',key,Buffer.from(encrypted.iv,'base64'));d.setAuthTag(Buffer.from(encrypted.tag,'base64'));
 assert.deepEqual(JSON.parse(Buffer.concat([d.update(Buffer.from(encrypted.data,'base64')),d.final()])),data);
});
