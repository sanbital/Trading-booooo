import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
process.env.BINANCE_API_KEY='fixture';process.env.BINANCE_SECRET_KEY='fixture';process.env.SCHEDULER_ENABLED='false';
test('actual public quote 429 suppresses the following signed account request before transport',async t=>{
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({code:-1003,msg:'Too many requests'}),{status:429,headers:{'retry-after':'60','x-mbx-used-weight-1m':'2400'}});};
 t.after(()=>globalThis.fetch=original);
 const gw=await import(`./server.mjs?rest-cooldown=${randomUUID()}`);
 await assert.rejects(gw.quote('binance_futures','BTCUSDT'),e=>e.status===429);
 const started=calls;assert(started>=1&&started<=2);
 await assert.rejects(gw.p10Portfolio('binance_futures'),e=>e.code==='BINANCE_RATE_LIMITED');
 assert.equal(calls,started);
});
test('process replacement keeps an explicitly observed exchange ban and sends zero REST',async t=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>assert.fail('blocked startup must not call exchange');
 process.env.BINANCE_FUTURES_REST_BLOCK_UNTIL_MS=String(Date.now()+60000);
 t.after(()=>{globalThis.fetch=original;delete process.env.BINANCE_FUTURES_REST_BLOCK_UNTIL_MS;});
 const gw=await import(`./server.mjs?rest-startup=${randomUUID()}`);
 await assert.rejects(gw.p10Portfolio('binance_futures'),e=>e.code==='STARTUP_EXCHANGE_COOLDOWN');
});
