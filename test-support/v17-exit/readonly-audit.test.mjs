import test from 'node:test';
import assert from 'node:assert/strict';
import {auditAccount} from '../../supabase/functions/_shared/leader-readonly-audit.mjs';
const chain=data=>{const b={select:()=>b,eq:()=>b,gte:()=>b,order:()=>b,limit:async()=>({data}),single:async()=>({data:data[0]})};return b;};
test('audit rejects a caller-supplied trading mode before IO',async()=>{
 await assert.rejects(()=>auditAccount({from(){throw Error('IO');}},()=>{throw Error('IO');},{mode:'create_order'}),/INVALID_MODE/);
});
test('audit reads ordinary and remembered conditional orders and labels incomplete coverage',async()=>{
 const p={id:'p',symbol:'EDGEUSDT',state:'OPEN',metadata:{exitProtection:{orders:[{clientId:'stop',terminal:false}]}}},calls=[];
 const out=await auditAccount({from:()=>chain([p])},async c=>{calls.push(c.action);return c.action==='p10_portfolio'?{positions:[]}:[];});
 assert.deepEqual(calls,['p10_portfolio','open_orders','v17_query_stop']);
 assert.equal(out.allConditionalOrdersVerified,false);assert.equal(out.fundingVerified,false);
});
