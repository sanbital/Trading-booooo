import test from 'node:test';
import assert from 'node:assert/strict';
import {maintainArchive} from '../supabase/functions/doa-capture-ingest/archive.mjs';
import {createHandler} from '../supabase/functions/doa-capture-ingest/handler.mjs';
const id='11111111-1111-4111-8111-111111111111';
function fixture(){
 const calls=[],objects=new Map(),job={state:'UPLOAD',object:{id,object_path:`v1/${id}.json.gz`,row_count:1},rows:[{symbol:'哈基米USDT',at:'2026-09-27T00:00:00Z',payload:{sell:0,mid:1,buy:5}}]};
 const rpc=async(a,b)=>{calls.push([a,b]);return a==='claim'?job:{state:'DONE'};};
 const storage={ensurePrivateBucket:async()=>{},uploadImmutable:async(p,b)=>{if(!objects.has(p))objects.set(p,b);},download:async p=>objects.get(p),remove:async p=>objects.delete(p)};
 return {rpc,storage,job,calls,objects};
}
test('private archive round trip preserves full payload, unicode, zeros and retry identity',async()=>{
 const x=fixture(),a=await maintainArchive(x),b=await maintainArchive(x);
 assert.equal(a.state,'VERIFIED');assert.equal(a.raw_sha256,b.raw_sha256);assert.equal(x.objects.size,1);
 assert.equal(x.calls.filter(x=>x[0]==='verified').length,2);assert.equal(a.rows,1);
});
test('corrupt object cannot authorize purge or verification',async()=>{
 const x=fixture();await maintainArchive(x);x.calls.length=0;x.objects.set(x.job.object.object_path,new Uint8Array([1,2,3]));
 await assert.rejects(maintainArchive(x));assert.ok(!x.calls.some(x=>x[0]==='verified'));
});
test('different valid gzip payload also fails raw checksum',async()=>{
 const x=fixture();await maintainArchive(x);x.calls.length=0;x.job.rows[0].payload.mid=2;
 await assert.rejects(maintainArchive(x),/CHECKSUM/);assert.ok(!x.calls.some(x=>x[0]==='verified'));
});
test('failed upload/download and deletion do not mark data verified/deleted',async()=>{
 const x=fixture();x.storage.download=async()=>{throw Error('OUTAGE');};
 await assert.rejects(maintainArchive(x),/OUTAGE/);assert.ok(!x.calls.some(x=>x[0]==='verified'));
 x.job.state='DELETE';x.storage.remove=async()=>{throw Error('OUTAGE');};
 await assert.rejects(maintainArchive(x),/OUTAGE/);assert.ok(!x.calls.some(x=>x[0]==='deleted'));
});
test('disabled, idle, busy and capped work never reach storage',async()=>{
 for(const state of ['DISABLED','IDLE','BUSY','CAP_REACHED'])assert.deepEqual(await maintainArchive({rpc:async()=>({state}),storage:{}}),{state});
});
test('archive maintenance uses the same authentication and cannot take a caller path or owner',async()=>{
 let calls=0;const token='a'.repeat(64),handler=createHandler({getToken:async()=>token,invoke:async()=>{},maintenance:async()=>{calls++;return {state:'IDLE'};}});
 const req=t=>new Request('https://example.test',{method:'POST',headers:{'x-doa-capture-token':t},body:JSON.stringify({action:'archive-maintenance',path:'evil',owner:'evil'})});
 assert.equal((await handler(req('b'.repeat(64)))).status,401);assert.equal(calls,0);
 assert.equal((await handler(req(token))).status,200);assert.equal(calls,1);
});
