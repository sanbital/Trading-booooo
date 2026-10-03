import test from 'node:test';import assert from 'node:assert/strict';
import {summarizeMetrics,summarizeConfig,summarizeHealth,readPlatform} from '../ops/deterministic/platform-health-read.mjs';
test('platform metrics discard arbitrary labels, credentials and unrelated metrics',()=>{
 assert.deepEqual(summarizeMetrics('node_memory_MemAvailable_bytes{instance="private-host",password="secret"} 123\nnode_cpu_seconds_total{cpu="0",mode="idle",instance="private-host"} 42\nsecret_metric{token="secret"} 99\npg_up NaN'),[{name:'node_memory_MemAvailable_bytes',labels:{},value:123},{name:'node_cpu_seconds_total',labels:{cpu:'0',mode:'idle'},value:42}]);
 assert.deepEqual(summarizeConfig({max_connections:90,work_mem:'4MB',password:'secret',connection_string:'postgres://secret',pool_mode:'transaction'}),{max_connections:90,work_mem:'4MB',pool_mode:'transaction'});
 assert.deepEqual(summarizeHealth([{name:'db',status:'healthy',password:'secret'}]),[{name:'db',status:'healthy'}]);
});
test('platform observation has no key-reveal, machine exec, configuration write or order request',async()=>{
 const requests=[];const result=await readPlatform({token:'fixture',fetchImpl:async(url,init)=>{requests.push(url);assert.equal(init.method,undefined);assert.equal(init.headers.authorization,'Bearer fixture');return new Response(url.endsWith('/metrics')?'node_memory_MemTotal_bytes 1000':'[]',{status:200});}});
 assert.equal(requests.length,4);assert(requests.every(u=>u.startsWith('https://api.supabase.com/v1/projects/etaajwpernzrcdrifdnw/')));assert(requests.every(u=>!/api-keys|reveal|machines|command/.test(u)));assert(result.metrics.ok);
});
test('independent observations survive a failed endpoint without printing its error body',async()=>{
 const result=await readPlatform({token:'fixture',fetchImpl:async url=>url.includes('health?')?new Response('secret-error-body',{status:544}):new Response(url.endsWith('/metrics')?'pg_up 1':'{}',{status:200})});
 assert.equal(result.health.http,544);assert(result.metrics.ok);assert(!JSON.stringify(result).includes('secret-error-body'));
});
