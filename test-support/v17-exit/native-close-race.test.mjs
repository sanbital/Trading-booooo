import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,position,nativeFill} from '../v18-ops/harness.mjs';
for(const mode of ['full','partial-intent','no-receipt','manual','details-delayed','query-failure','partial-native'])test('native/software close race: '+mode,async()=>{
 const p=position('CKBUSDT',101139,.0011868);
 if(mode==='no-receipt')p.metadata.exitProtection.orders=[];
 if(mode==='manual')p.metadata.v17ManualPosition=true;
 const h=harness({positions:[p],signal:false});h.state.exchange=[];
 if(mode!=='no-receipt')h.state.stopFills[p.symbol]=nativeFill(p,{exact:mode!=='details-delayed',quantity:mode==='partial-native'?82539:p.remaining_quantity});
 if(mode==='query-failure')h.state.hook=({type,cmd})=>{if(type==='gateway'&&cmd.action==='v17_query_stop')throw Error('read timeout')};
 if(['full','partial-intent'].includes(mode)){
  const r=await h.ctx.close(p,mode==='partial-intent'?.3:1,'RISK_CUT');assert.equal(r.closed,true);assert.equal(r.nativeReconciled,true);
 }else await assert.rejects(()=>h.ctx.close(p,1,'RISK_CUT'),/RECONCILIATION|OWNERSHIP/);
 assert.ok(!h.state.calls.some(c=>c.action==='create_order'));
 if(['no-receipt','manual','query-failure'].includes(mode))assert.equal(h.state.tables.v11_long_regime_positions[0].state,'OPEN');
});
