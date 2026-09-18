import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {readFuturesModeEvidence} from './futures-mode-evidence.mjs';
const T=Date.parse('2026-09-18T00:00:00Z');
for(const dual of [true,false]) test(`mode reader uses GET only, dual=${dual}`,async()=>{
  const calls=[];let clock=T;
  const r=await readFuturesModeEvidence(async(...args)=>{calls.push(args);return {dualSidePosition:dual};},()=>clock++);
  assert.deepEqual(calls,[['GET','/fapi/v1/positionSide/dual',{}, {timeoutMs:1500}]]);
  assert.equal(r.position_mode,dual?'HEDGE':'ONE_WAY');assert.equal(r.dual_side_position,dual);
  assert.equal(r.observation.requested_at_ms,T);assert.equal(r.observation.received_at_ms,T+1);
});
for(const value of [undefined,null,'false','true',0,1]) test(`mode reader refuses non-boolean ${String(value)}`,async()=>{
  await assert.rejects(readFuturesModeEvidence(async()=>({dualSidePosition:value}),()=>T),/FUTURES_POSITION_MODE_UNREADABLE/);
});
test('mode failure never falls back to a cached one-way assumption',async()=>{
  await assert.rejects(readFuturesModeEvidence(async()=>{throw Error('TIMEOUT');},()=>T),/TIMEOUT/);
});
test('gateway routes fresh mode evidence without touching the order cache or exit portfolio',async()=>{
  const s=await readFile(new URL('./server.mjs',import.meta.url),'utf8');
  const part=s.slice(s.indexOf('case "futures_position_mode":'),s.indexOf('case "p10_portfolio":'));
  assert.ok(part.includes('if (!futures) throw Error("FUTURES_MODE_FUTURES_ONLY")'));
  assert.ok(part.includes('readFuturesModeEvidence'));assert.ok(!part.includes('futuresPositionSideDual'));
  assert.ok(!part.includes('create_order'));assert.ok(!part.includes('POST'));
});
test('actual dispatcher sends exactly one mode GET and refuses a spot account',async()=>{
  const vm=await import('node:vm');
  const source=await readFile(new URL('./server.mjs',import.meta.url),'utf8');
  const start=source.indexOf('async function handleCommand(');
  const next=source.slice(start+1).search(/\n(?:async function |function |export |const )/);
  assert.ok(start>=0 && next>=0);
  const calls=[];
  const ctx={validateExchange:x=>x,isBinanceFutures:x=>x==='binance_futures',readFuturesModeEvidence,
    futuresRequest:async(...args)=>{calls.push(args);return {data:{dualSidePosition:false}};}};
  vm.createContext(ctx);vm.runInContext(source.slice(start,start+1+next),ctx);
  const r=await ctx.handleCommand({exchange:'binance_futures',action:'futures_position_mode'});
  assert.equal(r.position_mode,'ONE_WAY');assert.equal(calls.length,1);
  assert.equal(calls[0][0],'GET');assert.equal(calls[0][1],'/fapi/v1/positionSide/dual');
  await assert.rejects(ctx.handleCommand({exchange:'binance',action:'futures_position_mode'}),/FUTURES_MODE_FUTURES_ONLY/);
  assert.equal(calls.length,1);
});
