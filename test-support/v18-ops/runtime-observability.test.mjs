import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,position} from './harness.mjs';

test('CASE 20: actual protected position management advances management heartbeat',async()=>{
  const p=position(),h=harness({positions:[p],signal:false});
  const rt=h.state.tables.v11_long_regime_runtime[0];rt.last_management_success_at='old';
  const out=await h.ctx.runCycle();
  assert.equal(out.managed.length,1);assert.ok(out.managed[0].action);assert.equal(out.managed[0].error,undefined);
  assert.equal(rt.last_management_success_at,rt.last_cycle_completed_at);
});
test('new entry protection completion has its own timestamp even with no pre-entry managed positions',async()=>{
  const h=harness({signal:false}),rt=h.state.tables.v11_long_regime_runtime[0],at=h.state.now-20;
  h.ctx.runEntryQueue=async()=>({entered:true,entryProtection:{status:'PROTECTED',finishedAt:at}});
  const out=await h.ctx.runCycle();assert.equal(out.managed.length,0);
  assert.equal(rt.last_management_success_at,new Date(at).toISOString());
  assert.equal(rt.last_position_protection_success_at,new Date(at).toISOString());
});

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


test('open circuit retains incident diagnostics while heartbeat advances',async()=>{
 const h=harness({signal:false,circuit:true}),rt=h.state.tables.v11_long_regime_runtime[0];
 Object.assign(rt,{last_error:'INCIDENT_OWNED',last_success_at:'old',incident_generation:145});
 await h.ctx.runtimeTelemetry({last_cycle_completed_at:'tick',last_error:null},{successful:true},'tick');
 assert.equal(rt.last_cycle_completed_at,'tick');assert.equal(rt.last_error,'INCIDENT_OWNED');
 assert.equal(rt.last_success_at,'old');assert.equal(rt.incident_generation,145);
 assert.ok(h.state.writes.filter(w=>w.count>0).every(w=>!Object.hasOwn(w.patch,'last_error')));
});

test('circuit raised between heartbeat and diagnostic UPDATE cannot be cleared or escalated',async()=>{
 let raised=false;
 const h=harness({signal:false,hook:({type,table,patch,state})=>{
  if(type==='db'&&table==='v11_long_regime_runtime'&&patch&&Object.hasOwn(patch,'last_error')&&!raised){
   raised=true;Object.assign(state.tables[table][0],{circuit_open:true,last_error:'NEW_INCIDENT',incident_generation:146});
  }
 }}),rt=h.state.tables.v11_long_regime_runtime[0];rt.last_success_at='old';
 await h.ctx.runtimeTelemetry({last_cycle_completed_at:'tick'},{successful:true},'tick');
 assert.equal(raised,true);assert.equal(rt.circuit_open,true);assert.equal(rt.last_error,'NEW_INCIDENT');
 assert.equal(rt.last_success_at,'old');assert.equal(rt.incident_generation,146);
});

test('slow control read refreshes actual account evidence under original freshness limit',async()=>{
 let delayed=false;
 const h=harness({signal:false,shortWriter:true,hook:({type,table,patch,state})=>{
  if(type==='db'&&table==='v17_operator_control'&&!patch&&!delayed){delayed=true;state.now+=3500;}
 }});await h.ctx.enableShort();
 const out=await h.ctx.periodic(async()=>{
  const pair=await h.ctx.readOpsPair(h.db),orders=await h.ctx.opsGateway(h.db)({action:'v18_open_orders'},5000);
  return h.ctx.decideEntry(h.db,pair,'SAGAUSDT',orders);
 });
 assert.equal(delayed,true);assert.ok(h.state.portfolioCount>=2);
 assert.ok(!out.reasons.includes('ACCOUNT_EVIDENCE_INCOMPLETE_OR_STALE'));
 assert.ok(h.state.calls.every(c=>!['create_order','cancel_order','v17_create_stop','v17_cancel_stop'].includes(c.action)));
});
