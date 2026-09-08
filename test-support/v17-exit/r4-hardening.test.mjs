import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {R4_CANDIDATE as C,newR4State,nextR4Exit,restoreR4State} from '../../supabase/functions/_shared/leader-exit-r4.mjs';
import {normalizeR4GatewayOrder} from '../../supabase/functions/_shared/leader-exit-r4-gateway-contract.mjs';
const entry={positionId:'a',entryPrice:100,entryAt:0,quantity:100,quantityStep:1,entryFee:5};
test('late-but-fresh closed candle is evaluated and timestamps do not rewind',()=>{
 let s=newR4State(entry);s=nextR4Exit(s,{type:'bar',openAt:0,closeAt:60000,close:102}).state;
 s=nextR4Exit(s,{type:'tick',price:100,at:120100,sequence:1}).state;
 const out=nextR4Exit(s,{type:'bar',openAt:60000,closeAt:120000,receivedAt:120200,close:100});
 assert.equal(out.signals[0].leg,'runner');assert.equal(out.signals[0].at,120200);assert.equal(out.state.lastEventAt,120100);
});
test('missing sequence breaks the ten-second confirmation clock',()=>{
 let s=newR4State(entry);let out;
 for(let i=0;i<10;i++){out=nextR4Exit(s,{type:'tick',price:97,at:i*1000,sequence:i+1});s=out.state;}
 out=nextR4Exit(s,{type:'tick',price:97,at:10000,sequence:12});
 assert.equal(out.signals.length,0);assert.equal(out.state.risk.breachSince,10000);
});
test('a late first event cannot prove that no favorable move occurred',()=>{
 const out=nextR4Exit(newR4State(entry),{type:'tick',price:98,at:300000,sequence:100});
 assert.equal(out.state.coverageBroken,true);assert.equal(out.signals.length,0);
});
test('restart preserves peaks and floors but discards confirmation continuity',()=>{
 let s=nextR4Exit(newR4State(entry),{type:'tick',price:104,at:1000,sequence:1}).state;
 s=nextR4Exit(s,{type:'tick',price:101,at:2000,sequence:2}).state;
 const r=restoreR4State(s);assert.equal(r.risk.stopPrice,s.risk.stopPrice);assert.equal(r.peak,s.peak);
 assert.equal(r.risk.breachSince,null);assert.equal(r.coverageBroken,true);
});
test('invalid and changed policies cannot silently reuse a checkpoint',()=>{
 assert.throws(()=>newR4State(entry,{...C,minimumProgressPct:Infinity}),/INVALID/);
 assert.throws(()=>nextR4Exit(newR4State(entry),{type:'tick',price:100,at:0},{...C,riskFraction:.75}),/POLICY_STATE/);
});
test('all nine archived actual exit responses satisfy strict Gateway normalization',()=>{
 const rows=JSON.parse(readFileSync(new URL('./evidence/orders.json',import.meta.url),'utf8'));
 const closed=rows.filter(x=>x.intent==='CLOSE_LONG'&&x.response_payload?.order?.raw);
 assert.equal(closed.length,9);
 for(const row of closed){const raw=row.response_payload.order.raw;
  const out=normalizeR4GatewayOrder(row.response_payload,{clientId:raw.clientOrderId,symbol:raw.symbol,quantity:Number(raw.origQty)});
  assert.equal(out.exact,true);assert.equal(out.status,'FILLED');assert.ok(out.filledQuantity>0);assert.ok(out.commissionQuote>0);
 }
});
test('missing execution fills and unknown commission conversion are rejected',()=>{
 const rows=JSON.parse(readFileSync(new URL('./evidence/orders.json',import.meta.url),'utf8'));
 const p=structuredClone(rows.find(x=>x.intent==='CLOSE_LONG').response_payload),raw=p.order.raw;
 const expected={clientId:raw.clientOrderId,symbol:raw.symbol,quantity:Number(raw.origQty)};
 raw.fills[0].commissionAsset='BNB';raw.fills[0].feeQuoteMarkSource='ESTIMATE';
 assert.throws(()=>normalizeR4GatewayOrder(p,expected),/FEES_OR_FILLS/);
 raw.fills=[];assert.throws(()=>normalizeR4GatewayOrder(p,expected),/FILLS_MISSING/);
});
