import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,position} from './harness.mjs';

test('successful signal evaluation advances success time without claiming flat position protection',async()=>{
  const h=harness({signal:false}),rt=h.state.tables.v11_long_regime_runtime[0];
  rt.last_success_at='2026-09-10T00:00:00Z';rt.last_error='OLD_TIMEOUT';
  const out=await h.ctx.runCycle();
  assert.equal(out.entry.reason,'NO_FRESH_BULL_SIGNAL');
  assert.equal(rt.last_success_at,rt.last_cycle_completed_at);
  assert.equal(rt.last_error,null);
  assert.equal(rt.last_management_success_at,undefined);
  assert.ok(!h.state.calls.some(x=>['create_order','v17_create_stop','v17_cancel_stop'].includes(x.action)));
});

test('failed account read cannot refresh success or erase its failure',async()=>{
  const h=harness({signal:false,hook:({type,cmd})=>{if(type==='gateway'&&cmd.action==='p10_portfolio')throw Error('The signal has been aborted');}});
  const rt=h.state.tables.v11_long_regime_runtime[0];rt.last_success_at='old';
  await assert.rejects(()=>h.ctx.runCycle(),/aborted/);
  assert.equal(rt.last_success_at,'old');assert.match(rt.last_error,/aborted/);
});

test('recovery observations count separately from successful entry evaluation',async()=>{
  const h=harness({circuit:true,signal:false}),rt=h.state.tables.v11_long_regime_runtime[0];rt.last_success_at='old';
  for(let i=0;i<2;i++){await h.ctx.runCycle();assert.equal(rt.last_success_at,'old');h.advance();}
  await h.ctx.runCycle();assert.equal(rt.circuit_open,false);assert.equal(rt.last_success_at,rt.last_cycle_completed_at);
});

test('degraded symbol protection never updates overall success while other symbols remain managed',async()=>{
  const h=harness({positions:[position('TACUSDT',64310,.001866),position()],signal:false}),rt=h.state.tables.v11_long_regime_runtime[0];
  rt.last_success_at='old';h.state.quotes.TACUSDT=Error('quote timeout');h.state.quotes.SAGAUSDT=.0185;
  const out=await h.ctx.runCycle();assert.equal(out.protectionHealth,'DEGRADED');assert.equal(rt.last_success_at,'old');
  assert.equal(h.state.tables.v11_long_regime_positions.find(p=>p.symbol==='SAGAUSDT').peak_price,.0185);
});

test('disabled runtime cannot report success from an early HTTP 200 response',async()=>{
  const h=harness({signal:false}),rt=h.state.tables.v11_long_regime_runtime[0];rt.live_enabled=false;rt.last_success_at='old';
  await h.ctx.runCycle();assert.equal(rt.last_success_at,'old');assert.equal(rt.entry_block_reason,'RUNTIME_NOT_LIVE');
});

test('loss of lease prevents telemetry writes as well as financial writes',async()=>{
  const h=harness({signal:false,hook:({type,cmd,state})=>{if(type==='gateway'&&cmd.action==='p10_portfolio'){state.lease=false;state.boundary=state.writes.length;}}});
  await assert.rejects(()=>h.ctx.runCycle(),/LEASE|FENCED/);assert.equal(h.state.writes.length,h.state.boundary);
});
