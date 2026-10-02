import test from 'node:test';import assert from 'node:assert/strict';import {recoverAccountAtCutover} from '../ops/execution-infra/cutover-account-recovery.mjs';
test('paused cron recovery invokes only reconciliation with private authentication and no entry tick',async()=>{
 const calls=[];const fetchImpl=async(u,i)=>{calls.push([u,i]);return{ok:true,json:async()=>calls.length===1?[{name:'service_role',api_key:'private-db'}]:calls.length===2?[{token:'private-internal'}]:{ready:true}}};
 assert.equal(await recoverAccountAtCutover({project:'example',accessToken:'private-management',fetchImpl}),true);
 assert.deepEqual(JSON.parse(calls[2][1].body),{mode:'account-recovery'});assert.equal(calls[2][1].headers['x-v10-executor-token'],'private-internal');
 await assert.rejects(recoverAccountAtCutover({project:'example',accessToken:'secret',fetchImpl:async()=>({ok:false})}),/KEY_UNAVAILABLE/);
});
