// Dedicated collector authentication. No arbitrary SQL, URL, prompt, or trading API.
import {createHandler} from './handler.mjs';
import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import {maintainArchive,ARCHIVE_BUCKET} from './archive.mjs';
const base=Deno.env.get('SUPABASE_URL')!;
const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const client=createClient(base,key,{auth:{persistSession:false,autoRefreshToken:false},
 global:{fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(15000)})}});
const bucket=client.storage.from(ARCHIVE_BUCKET);
const storage={
 async ensurePrivateBucket(){
  let r=await client.storage.getBucket(ARCHIVE_BUCKET);
  if(r.error){
   if(Number(('statusCode' in r.error?r.error.statusCode:undefined))!==404)throw Error('ARCHIVE_BUCKET_READ');
   const c=await client.storage.createBucket(ARCHIVE_BUCKET,{public:false,fileSizeLimit:8388608,allowedMimeTypes:['application/gzip']});
   if(c.error)throw Error('ARCHIVE_BUCKET_CREATE');
   r=await client.storage.getBucket(ARCHIVE_BUCKET);
  }
  if(r.error||!r.data||r.data.public!==false||Number(r.data.file_size_limit)!==8388608)throw Error('ARCHIVE_BUCKET_POLICY');
 },
 async uploadImmutable(path:string,bytes:Uint8Array){
  const r=await bucket.upload(path,bytes,{contentType:'application/gzip',upsert:false});
  if(r.error&&!['409','400'].includes(String(('statusCode' in r.error?r.error.statusCode:undefined))))throw Error('ARCHIVE_UPLOAD');
  // A duplicate is accepted only after a successful full download and checksum comparison.
 },
 async download(path:string){const r=await bucket.download(path);if(r.error||!r.data)throw Error('ARCHIVE_DOWNLOAD');return new Uint8Array(await r.data.arrayBuffer());},
 async remove(path:string){const r=await bucket.remove([path]);if(r.error&&Number(('statusCode' in r.error?r.error.statusCode:undefined))!==404)throw Error('ARCHIVE_DELETE');},
};
async function db(path:string,body?:unknown) {
  const r=await fetch(base+'/rest/v1/'+path,{method:body===undefined?'GET':'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  if(!r.ok) throw Error('DATABASE_'+r.status);
  return await r.json();
}
Deno.serve(createHandler({
 getToken:async()=>(await db('edge_internal_tokens?name=eq.doa-capture&select=token&limit=1'))[0]?.token,
 invoke:(action:string,body:unknown)=>db('rpc/doa_capture_rpc',{p_action:action,p_body:body}),
 maintenance:async()=>{
  const run=()=>maintainArchive({rpc:(action:string,body:unknown)=>db('rpc/leader20_archive_maintenance',{p_action:action,p_body:body}),storage});
  const first=await run();return first.state==='DELETED'?await run():first;
 },
}));
