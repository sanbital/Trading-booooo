// Independent read-only resource timeline. No trading endpoint, SQL scan or restart.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {randomBytes,createCipheriv,publicEncrypt} from 'node:crypto';
import {gzipSync} from 'node:zlib';
export function encryptTimeline(timeline,publicKey){
 const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
 const data=Buffer.concat([cipher.update(gzipSync(JSON.stringify(timeline))),cipher.final()]);
 return {version:2,compression:'gzip',key:publicEncrypt({key:publicKey,oaepHash:'sha256'},key).toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')};
}
export async function observePlatform({fetchImpl=fetch,token,project,signal}){
 const read=async(path)=>{
  try {const r=await fetchImpl(`https://api.supabase.com/v1/projects/${project}/${path}`,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.any([signal,AbortSignal.timeout(6000)])});
   if(!r.ok)return {ok:false,http:r.status};return {ok:true,value:await r.text()};
  }catch(e){return {ok:false,error:['TimeoutError','AbortError'].includes(e.name)?'TIMEOUT':'TRANSPORT_FAILED'};}
 };
 const [metrics,health]=await Promise.all([read('analytics/endpoints/metrics'),read('health?services=db&services=db_postgres_user&services=rest&services=pooler')]);
 return {utc:new Date().toISOString(),metrics,health};
}
if(import.meta.url===new URL(process.argv[1],'file:').href){
 if(process.env.GITHUB_REPOSITORY!=='sanbital/Trading-booooo'||process.env.GITHUB_REF!=='refs/heads/main')throw Error('READ_ONLY_SAMPLER_REPOSITORY_GUARD');
 const interval=15000,limit=Number(process.env.PLATFORM_SAMPLE_COUNT??280),key=readFileSync('ops/execution-infra/evidence-public.pem'),timeline={version:'PLATFORM_TIMELINE_1',commit:process.env.GITHUB_SHA,samples:[]};
 if(!Number.isInteger(limit)||limit<20||limit>480)throw Error('READ_ONLY_SAMPLE_COUNT_INVALID');
 mkdirSync('infra-evidence',{recursive:true});
 const started=Date.now();
 for(let i=0;i<limit;i++){
  const controller=new AbortController();
  const row=await observePlatform({token:process.env.SUPABASE_ACCESS_TOKEN,project:'etaajwpernzrcdrifdnw',signal:controller.signal});
  timeline.samples.push(row);controller.abort();
  writeFileSync('infra-evidence/platform-timeline.encrypted.json',JSON.stringify(encryptTimeline(timeline,key)));
  if(i%4===0)console.log(JSON.stringify({utc:row.utc,kst:new Date(Date.parse(row.utc)+9*3600000).toISOString().replace('Z','+09:00'),sample:i+1,metrics:row.metrics.ok,health:row.health.ok}));
  const delay=Math.max(0,started+(i+1)*interval-Date.now());if(i+1<limit)await new Promise(resolve=>setTimeout(resolve,delay));
 }
}
