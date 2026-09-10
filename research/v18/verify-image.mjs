import {readFileSync,copyFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';import {pathToFileURL,fileURLToPath} from 'node:url';
import {stageEngine} from '../../gateway/stage-engine.mjs';
import assert from 'node:assert/strict';import net from 'node:net';
const root=fileURLToPath(new URL('../../',import.meta.url));
const stage=resolve(root,'../v18-image-boot');mkdirSync(stage,{recursive:true});stageEngine();
for(const line of readFileSync(join(root,'gateway/Dockerfile'),'utf8').split(/\r?\n/)){
 if(!line.startsWith('COPY '))continue;
 const source=line.split(/\s+/)[1];assert.match(source,/^[a-z0-9.-]+$/i);
 copyFileSync(join(root,'gateway',source),join(stage,source));
}
// Validate the Docker COPY set, startup, observer wiring and shutdown locally.
// All outbound fetches are replaced before importing the staged server.
const portProbe=net.createServer();await new Promise(r=>portProbe.listen(0,'127.0.0.1',r));
const port=portProbe.address().port;await new Promise(r=>portProbe.close(r));
Object.assign(process.env,{PORT:String(port),SCHEDULER_ENABLED:'false',V17_SHADOW_ENABLED:'true',V18_FAST_PROTECTION_ENABLED:'true',
 V18_EXECUTOR_TOKEN:'image-boot-test-only',SUPABASE_URL:'https://executor.invalid',GATEWAY_SHARED_SECRET:'test-only-'.repeat(5),
 BINANCE_API_KEY:'',BINANCE_SECRET_KEY:'',UPBIT_ACCESS_KEY:'',UPBIT_SECRET_KEY:''});
const realFetch=globalThis.fetch;let observations=0;
globalThis.fetch=async(url,request)=>{
 if(String(url).includes('/functions/v1/v10-lane-executor')){
  assert.equal(request.headers['x-v18-protection-token'],'image-boot-test-only');
  assert.equal(request.headers['x-v10-executor-token'],undefined);
  assert.deepEqual(JSON.parse(request.body),{mode:'protect'});observations++;
  return new Response('{"ok":true,"mode":"protect"}');
 }
 if(String(url).includes('ipify'))return new Response('{"ip":"127.0.0.1"}');
 throw Error('UNEXPECTED_BOOT_NETWORK');
};
let server;
try{
 const module=await import(pathToFileURL(join(stage,'server.mjs')).href+'?v18test='+Date.now());
 server=await module.startServer();
 for(let i=0;i<20&&observations===0;i++)await new Promise(r=>setTimeout(r,20));
 const health=await (await realFetch('http://127.0.0.1:'+port+'/health')).json();
 assert.equal(health.v18_fast_protection.enabled,true);assert.equal(health.v18_fast_protection.version,'V18-FAST-PROTECTION-1');
 assert.ok(observations>=1);assert.equal(health.v17_shadow.enabled,true);
 console.log('Docker COPY contents boot; management-only observer invokes correctly; local health verified.');
}finally{
 if(server)await new Promise(r=>server.close(r));globalThis.fetch=realFetch;
}
