export const ARCHIVE_BUCKET='leader20-capture-private';
const MAX_BYTES=8388608;
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':
 '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
export async function sha256(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');}
async function transform(bytes,stream){return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());}
/** One bounded batch per invocation; no market, AI, or order API dependencies. */
export async function maintainArchive({rpc,storage,owner=crypto.randomUUID()}) {
 const job=await rpc('claim',{owner});
 if(!['UPLOAD','DELETE'].includes(job.state))return job;
 const o=job.object;
 if(!o||!/^v1\/[a-f0-9-]{36}\.json\.gz$/.test(o.object_path))throw Error('ARCHIVE_PATH_INVALID');
 await storage.ensurePrivateBucket();
 if(job.state==='DELETE'){
  await storage.remove(o.object_path);
  await rpc('deleted',{id:o.id,owner});
  return {state:'DELETED',id:o.id};
 }
 if(!Array.isArray(job.rows)||job.rows.length!==o.row_count||!o.row_count||o.row_count>1000)throw Error('ARCHIVE_ROW_COUNT');
 const raw=new TextEncoder().encode(canonical({version:1,rows:job.rows}));
 if(raw.length>MAX_BYTES)throw Error('ARCHIVE_RAW_CAP');
 const rawHash=await sha256(raw),packed=await transform(raw,new CompressionStream('gzip'));
 if(packed.length>MAX_BYTES)throw Error('ARCHIVE_OBJECT_CAP');
 await storage.uploadImmutable(o.object_path,packed);
 // On a retry, the existing object's compressed bytes may differ. Its full raw bytes must match.
 const downloaded=await storage.download(o.object_path);
 if(downloaded.length>MAX_BYTES)throw Error('ARCHIVE_DOWNLOAD_CAP');
 const unpacked=await transform(downloaded,new DecompressionStream('gzip'));
 if(unpacked.length!==raw.length||await sha256(unpacked)!==rawHash)throw Error('ARCHIVE_CHECKSUM_MISMATCH');
 const result={id:o.id,owner,row_count:o.row_count,bytes:downloaded.length,raw_sha256:rawHash,object_sha256:await sha256(downloaded)};
 await rpc('verified',result);
 return {state:'VERIFIED',id:o.id,rows:o.row_count,raw_bytes:raw.length,bytes:downloaded.length,
  raw_sha256:rawHash,object_sha256:result.object_sha256};
}
