// Full-cycle replacement for former tests that expected circuit-open to skip management.
import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,position,nativeFill} from '../v18-ops/harness.mjs';
test('blocked native fill settles while an independently owned symbol stays managed',async()=>{
 const egld=position('EGLDUSDT',24.4,4.9374),saga=position(),h=harness({positions:[egld,saga],signal:false,circuit:true});
 h.state.exchange=h.state.exchange.filter(x=>x.market==='SAGAUSDT');h.state.stopFills.EGLDUSDT=nativeFill(egld);
 const r=await h.ctx.runCycle();assert.equal(h.state.tables.v11_long_regime_positions[0].state,'CLOSED');
 assert.ok(r.managed.some(x=>x.symbol==='SAGAUSDT'&&x.action));
});
test('unknown DB-only exposure stays open and isolated, never forced closed',async()=>{
 const p=position();p.metadata.exitProtection.orders=[];const h=harness({positions:[p],signal:false});h.state.exchange=[];
 await h.ctx.runCycle();assert.equal(h.state.tables.v11_long_regime_positions[0].state,'OPEN');
 assert.equal(h.state.tables.v11_long_regime_runtime[0].incident_kind,'UNEXPLAINED_EXPOSURE');
});
test('read failure is reported as pending, not as successful accounting',async()=>{
 const p=position(),h=harness({positions:[p],signal:false});h.state.exchange=[];
 h.state.hook=({type,cmd})=>{if(type==='gateway'&&cmd.action==='v17_query_stop')throw Error('network timeout')};
 const r=await h.ctx.runCycle();assert.equal(h.state.tables.v11_long_regime_positions[0].state,'OPEN');
 assert.equal(r.entry.entered,false);assert.equal(r.protectionHealth,'DEGRADED');
});
