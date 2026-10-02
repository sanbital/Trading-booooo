import test from 'node:test';
import assert from 'node:assert/strict';
import {stageGatewayDatabaseKey} from '../ops/execution-infra/stage-gateway-db-key.mjs';
const env={SUPABASE_PROJECT_REF:'etaajwpernzrcdrifdnw',FLY_DATABASE_KEY_APP:'trading-booooo',
 SUPABASE_ACCESS_TOKEN:'fixture-only',FLY_API_TOKEN:'fixture-only'};
const key='eyJmaXh0dXJl.c2VydmljZQ.c2lnbmF0dXJl';
test('DB credential goes through stdin and stage only, with no flags or restart',async()=>{
 let calls=0;
 const result=await stageGatewayDatabaseKey({env,fetchImpl:async()=>({ok:true,json:async()=>[{name:'service_role',api_key:key}]}),
  run:(binary,args,options)=>{
   calls++;assert.equal(binary,'flyctl');assert.deepEqual(args,['secrets','import','--stage','-a','trading-booooo']);
   assert.equal(args.join(' ').includes(key),false);assert.equal(options.input,`SUPABASE_SERVICE_ROLE_KEY=${key}\n`);
   return {status:0,stdout:'DO_NOT_PRINT_SECRET',stderr:''};
  }});
 assert.equal(calls,1);assert.deepEqual(result,{staged:true,flagsChanged:false});
});
test('unapproved target or non-JWT/newline key cannot reach Fly',async()=>{
 for(const change of [{SUPABASE_PROJECT_REF:'other'}, {FLY_DATABASE_KEY_APP:'collector'}])
  await assert.rejects(stageGatewayDatabaseKey({env:{...env,...change},fetchImpl:()=>assert.fail(),run:()=>assert.fail()}));
 await assert.rejects(stageGatewayDatabaseKey({env,fetchImpl:async()=>({ok:true,json:async()=>[{name:'service_role',api_key:key+'\nOTHER=unsafe'}]}),run:()=>assert.fail()}),/DB_KEY_LEGACY_SERVICE_ROLE_MISSING/);
});
test('lookup and staging failure are sanitized and never expose raw bodies or CLI output',async()=>{
 await assert.rejects(stageGatewayDatabaseKey({env,fetchImpl:async()=>({ok:false,status:503,json:()=>assert.fail()})}),/DB_KEY_LOOKUP_UNAVAILABLE/);
 await assert.rejects(stageGatewayDatabaseKey({env,fetchImpl:async()=>({ok:true,json:async()=>[{name:'service_role',api_key:key}]}),
  run:()=>({status:1,stderr:key,stdout:key})}),error=>error.message==='DB_KEY_STAGE_FAILED');
});
