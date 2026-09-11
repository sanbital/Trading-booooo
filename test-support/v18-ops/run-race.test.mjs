import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,position,nativeFill} from './harness.mjs';
const saga=()=>position(),tac=()=>position('TACUSDT',64310,.001866);
const row=(h,s)=>h.state.tables.v11_long_regime_positions.find(p=>p.symbol===s);
function race(baseline=false,exact=true){
 const h=harness({baseline,positions:[tac(),saga()],hook:({type,cmd,patch,state})=>{
  // run -> manage TAC -> manage SAGA -> DB refresh -> openBull account check.
  if(type==='db'&&patch?.status==='CLAIMED')state.armed=true;
  if(type==='gateway'&&cmd.action==='p10_portfolio'&&state.armed&&!state.fired){
   state.fired=true;state.exchange=state.exchange.filter(x=>x.market!=='TACUSDT');state.stopFills.TACUSDT=nativeFill(tac(),{exact});
  }
 }});return h;
}
test('01 baseline actual run/manage/refresh/openBull reproduces TAC COUNT:1:2 circuit',async()=>{
 const h=race(true);await assert.rejects(()=>h.ctx.runCycle(),/EXTERNAL_POSITION/);
 assert.equal(h.state.tables.v11_long_regime_runtime[0].circuit_reason,'BULL_EXTERNAL_EXPOSURE:COUNT:1:2:SAGAUSDT');
 assert.equal(row(h,'TACUSDT').state,'OPEN');assert.ok(!h.state.calls.some(c=>c.action==='create_order'));
});
test('03/04/20 baseline circuit skips price management, has no recovery or cycle heartbeat',async()=>{
 const h=harness({baseline:true,positions:[saga()],circuit:true,signal:false});h.state.quotes.SAGAUSDT=.0185;
 for(let i=0;i<3;i++){await h.ctx.runCycle();h.advance();}
 assert.equal(row(h,'SAGAUSDT').peak_price,.01699);
 assert.equal(h.state.tables.v11_long_regime_runtime[0].circuit_open,true);
 assert.equal(h.state.tables.v11_long_regime_runtime[0].last_cycle_completed_at,undefined);
});
test('01 patched actual run defers SOPH, reconciles TAC, continues SAGA next cycle',async()=>{
 const h=race();const a=await h.ctx.runCycle();assert.equal(h.state.fired,true);
 assert.equal(row(h,'TACUSDT').state,'CLOSED');assert.ok(!h.state.calls.some(c=>c.action==='create_order'));
 h.advance();h.state.quotes.SAGAUSDT=.0185;await h.ctx.runCycle();
 assert.equal(row(h,'SAGAUSDT').peak_price,.0185);assert.ok(row(h,'SAGAUSDT').hard_stop_price>.01656525);
 assert.notEqual(a.entry.entered,true);
});
test('02 raw/detail fills delayed 120s: TAC exposure zero, PnL null, SAGA management continues',async()=>{
 const h=race(false,false);await h.ctx.runCycle();
 assert.equal(row(h,'TACUSDT').remaining_quantity,0);assert.equal(row(h,'TACUSDT').realized_pnl_usdt,null);
 h.advance();h.state.quotes.SAGAUSDT=.0185;await h.ctx.runCycle();assert.equal(row(h,'SAGAUSDT').peak_price,.0185);
 h.advance();h.state.stopFills.TACUSDT=nativeFill(tac());await h.ctx.runCycle();
 assert.ok(Number.isFinite(row(h,'TACUSDT').realized_pnl_usdt));assert.equal(row(h,'TACUSDT').metadata.exitAccountingPending,false);
});
test('03 circuit does not suppress actual nextExitReviewed peak/stop ratchet (synthetic price)',async()=>{
 const h=harness({positions:[saga()],circuit:true,signal:false});h.state.quotes.SAGAUSDT=.0185;
 const out=await h.ctx.runCycle();assert.equal(row(h,'SAGAUSDT').peak_price,.0185);
 assert.ok(row(h,'SAGAUSDT').hard_stop_price>.01656525);assert.equal(out.managed[0].action.nativeStop.status,'PROTECTED');
});
test('04 flat recoverable incident clears only after three fresh independent cycles',async()=>{
 const h=harness({circuit:true,signal:false});
 for(let n=0;n<3;n++){const r=await h.ctx.runCycle();assert.equal(r.recovery.resolved,n===2);h.advance();}
 assert.equal(h.state.tables.v11_long_regime_runtime[0].circuit_open,false);
 assert.ok(!h.state.calls.some(c=>c.action==='create_order'));
});
test('05 pause, kill, withdrawal and manual intervention preserve operator controls',async()=>{
 for(const flag of ['pause_new_entries','scalp_kill_switch','withdrawal_mode','manual_intervention_required']){
  const h=harness({circuit:true,signal:false,settings:{[flag]:true}});
  for(let n=0;n<3;n++){await h.ctx.runCycle();h.advance();}
  assert.equal(h.state.tables.v11_long_regime_runtime[0].circuit_open,true);assert.equal(h.state.tables.trading_settings[0][flag],true);
  assert.ok(!h.state.calls.some(c=>c.action==='create_order'));
 }
});
test('06 true external position is isolated, never adopted or liquidated',async()=>{
 const h=harness({positions:[saga()],signal:false});h.state.exchange.push({market:'MANUALUSDT',side:'LONG',quantity:9});
 await h.ctx.runCycle();assert.equal(h.state.tables.v11_long_regime_positions.length,1);
 assert.ok(!h.state.calls.some(c=>c.action==='create_order'));assert.ok(row(h,'SAGAUSDT').last_evaluated_at);
 assert.equal(h.state.tables.v11_long_regime_runtime[0].incident_kind,'UNEXPLAINED_EXPOSURE');
});
test('07 mixed manual/auto symbol: no software close or stop replacement on that symbol',async()=>{
 const h=harness({positions:[saga(),tac()],signal:false,manual:[{symbol:'SAGAUSDT',side:'LONG',maxQuantity:8000}]});
 h.state.exchange[0].quantity=8000;h.state.quotes.SAGAUSDT=.001;
 await h.ctx.runCycle();assert.ok(!h.state.calls.some(c=>c.action==='create_order'||c.action==='v17_create_stop'&&c.params.symbol==='SAGAUSDT'));
 assert.equal(row(h,'SAGAUSDT').remaining_quantity,7067.3);assert.ok(h.state.calls.some(c=>c.action==='p10_quotes'&&c.markets.includes('TACUSDT')));
});
test('14 lease expires during quote: no later row writes or exchange mutations',async()=>{
 const h=harness({positions:[saga()],signal:false,hook:({type,cmd,state})=>{if(type==='gateway'&&cmd.action==='p10_quotes'){state.lease=false;state.writeBoundary=state.writes.length;}}});
 await assert.rejects(()=>h.ctx.runCycle(),/LEASE|FENCED/);assert.equal(h.state.writes.length,h.state.writeBoundary);
 assert.ok(!h.state.calls.some(c=>['create_order','v17_create_stop','v17_cancel_stop'].includes(c.action)));
});
test('15 incomplete or stale portfolio never becomes flat/recovered',async()=>{
 for(const override of [{positions_complete:false},{observation:{id:'cached',source:'BINANCE_ACCOUNT_REST',requested_at_ms:0,received_at_ms:0}}]){
  const h=harness({circuit:true,signal:false});h.state.portfolioOverride=override;await h.ctx.runCycle();
  assert.equal(h.state.tables.v11_long_regime_runtime[0].circuit_open,true);assert.ok(!h.state.calls.some(c=>c.rpc==='v18_recovery_observation'));
 }
});
test('16 one symbol quote timeout cannot starve another owned symbol',async()=>{
 const h=harness({positions:[tac(),saga()],signal:false});h.state.quotes.TACUSDT=Error('quote timeout');h.state.quotes.SAGAUSDT=.0185;
 const r=await h.ctx.runCycle();assert.equal(row(h,'SAGAUSDT').peak_price,.0185);assert.equal(r.protectionHealth,'DEGRADED');
 assert.ok(!h.state.calls.some(c=>c.action==='create_order'));
});
test('17 ten delayed positions have bounded work; safe symbol evaluated before reconciliation',async()=>{
 const many=Array.from({length:9},(_,i)=>position('TEST'+i+'USDT',10,1)),h=harness({positions:[...many,saga()],signal:false});
 h.state.exchange=h.state.exchange.filter(x=>x.market==='SAGAUSDT');
 for(const p of many)h.state.stopFills[p.symbol]=nativeFill(p,{exact:false});
 await h.ctx.runCycle();const commands=h.state.calls.filter(c=>c.action);
 assert.ok(commands.findIndex(c=>c.action==='p10_quotes')<commands.findIndex(c=>c.action==='v17_stop_fill'));
 assert.ok(commands.filter(c=>c.action==='v17_stop_fill').length<=3);assert.ok(commands.length<60);
});
test('18 LEGACY closed position invocation produces no orders or ownership edits',async()=>{
 const p=saga();p.state='CLOSED';p.remaining_quantity=0;const h=harness({positions:[p],signal:false});
 const result=await h.ctx.close(p,1,'LEGACY_EXIT');assert.equal(result.closed,true);
 assert.ok(!h.state.calls.some(c=>c.action==='create_order'));assert.equal(h.state.writes.length,0);
});
test('19 recovery proof cannot clear a newly opened incident generation',async()=>{
 const h=harness({circuit:true,signal:false,hook:({type,name,state})=>{if(type==='rpc'&&name==='v18_recovery_observation'){state.tables.v11_long_regime_runtime[0].incident_id='new-incident';state.tables.v11_long_regime_runtime[0].incident_generation++;}}});
 const r=await h.ctx.runCycle();assert.equal(r.recovery.resolved,false);assert.equal(h.state.tables.v11_long_regime_runtime[0].circuit_open,true);
});
test('20 early return has heartbeat, not a fabricated management success',async()=>{
 const h=harness({circuit:true,signal:false});await h.ctx.runCycle();const r=h.state.tables.v11_long_regime_runtime[0];
 assert.ok(r.last_cycle_started_at&&r.last_cycle_completed_at);assert.equal(r.last_management_success_at,undefined);
 assert.equal(r.entry_block_reason,'CIRCUIT_OPEN_MANAGEMENT_ACTIVE');
});
test('04 ACTIVE stop is allowed, missing or unrelated algo order blocks recovery',async()=>{
 const healthy=harness({positions:[saga()],circuit:true,signal:false});
 for(let i=0;i<3;i++){await healthy.ctx.runCycle();healthy.advance();}
 assert.equal(healthy.state.tables.v11_long_regime_runtime[0].circuit_open,false);
 for(const algos of [[],[{clientAlgoId:'foreign'}]]){
  const h=harness({positions:[saga()],circuit:true,signal:false});h.state.openOrdersOverride={algos};
  for(let i=0;i<3;i++){await h.ctx.runCycle();h.advance();}
  assert.equal(h.state.tables.v11_long_regime_runtime[0].circuit_open,true);
 }
});
test('17 a slow dependency exhausts time budget, retains heartbeat and sends no new exposure',async()=>{
 const h=harness({positions:[saga()],signal:false,hook:({type,cmd,state})=>{
  if(type==='gateway'&&cmd.action==='p10_quotes')state.now+=56000;
 }});
 await assert.rejects(()=>h.ctx.runCycle(),/BUDGET/);
 assert.ok(h.state.tables.v11_long_regime_runtime[0].last_cycle_completed_at);
 assert.ok(!h.state.calls.some(c=>['create_order','v17_create_stop','v17_cancel_stop'].includes(c.action)));
});
test('04 historical fee-only backlog does not prevent flat recovery',async()=>{
 const h=harness({circuit:true,signal:false});
 for(let n=0;n<150;n++)h.state.tables.v11_long_regime_orders.push({id:'old-'+n,symbol:'OLDUSDT',intent:'CLOSE_LONG',state:'RECONCILIATION_PENDING',response_payload:{v18ExposureFinal:true},updated_at:'2026-09-01T00:00:00Z',created_at:'2026-09-01T00:00:00Z'});
 for(let i=0;i<3;i++){await h.ctx.runCycle();h.advance();}
 assert.equal(h.state.tables.v11_long_regime_runtime[0].circuit_open,false);
 assert.ok(!h.state.calls.some(c=>c.action==='create_order'));
});
