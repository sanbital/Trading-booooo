import {test} from 'node:test';import assert from 'node:assert/strict';
import {createHandler} from '../../supabase/functions/doa-capture-ingest/handler.mjs';
test('missing/wrong token, forbidden actions, oversized bodies never invoke RPC',async()=>{
 let calls=0,reads=0;const token='a'.repeat(64);
 const handler=createHandler({getToken:async()=>{reads++;return token;},invoke:async()=>{calls++;return {enabled:true};}});
 const req=(body,secret=token)=>new Request('https://test',{method:'POST',headers:{'x-doa-capture-token':secret},body:typeof body==='string'?body:JSON.stringify(body)});
 assert.equal((await handler(req({action:'watch'},''))).status,401);assert.equal(reads,0);
 assert.equal((await handler(req({action:'watch'},'b'.repeat(64)))).status,401);
 assert.equal((await handler(req({action:'trade'}))).status,400);
 assert.equal((await handler(req(' '.repeat(500001)))).status,413);assert.equal(calls,0);
 assert.equal((await handler(req({action:'watch'}))).status,200);assert.equal(calls,1);
});
