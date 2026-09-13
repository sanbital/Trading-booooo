import test from 'node:test';import assert from 'node:assert/strict';
import {createOpsHandler} from '../../supabase/functions/qv3-ops-status/handler.mjs';
function fixture(){const commands=[];const f=createOpsHandler({url:'https://etaajwpernzrcdrifdnw.supabase.co',key:'fixture',gatewayUrl:'https://gateway.invalid',gatewaySecret:'fixture',fetchFn:async(url,init)=>{
 if(url.includes('edge_internal_tokens'))return new Response('[{"token":"fixture"}]');
 if(url.endsWith('/health'))return new Response('{"version":"test","secret":"not-returned"}');
 const cmd=JSON.parse(init.body);commands.push(cmd);return new Response(JSON.stringify({ok:true,version:'test',result:cmd.action==='v18_open_orders'?{complete:true,orders:[],algos:[]}:[]}));
 }});return{commands,run:(body={mode:'snapshot'},token='fixture')=>f(new Request('https://fixture',{method:'POST',headers:{'x-v16-diagnostic-token':token},body:JSON.stringify(body)}))};}
test('ops diagnostic signs only three fixed account read commands',async()=>{const h=fixture(),r=await h.run(),d=await r.json();assert.equal(r.status,200);assert.equal(d.health.secret,undefined);assert.deepEqual(h.commands.map(x=>x.action).sort(),['p10_portfolio','symbol_info','v18_open_orders']);assert.equal(h.commands.find(x=>x.action==='symbol_info').market,'4USDT');});
test('ops diagnostic rejects arbitrary command bodies and invalid auth',async()=>{const h=fixture();assert.equal((await h.run({mode:'snapshot',action:'create_order'})).status,400);assert.equal((await h.run({mode:'snapshot'},'wrong')).status,401);assert.equal(h.commands.length,0);});
