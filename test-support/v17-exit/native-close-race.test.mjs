import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createGatewayProtection} from '../../supabase/functions/_shared/leader-protection-adapter.mjs';

const src=readFileSync(new URL('../../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8');
const code=src.slice(src.indexOf('async function reconcileNativeCloseBeforeDispatch('),src.indexOf('async function manageBull('));
const Q=101139,PRICE=.0011723;
const receipt={clientId:'tb-v17s-race',terminal:false,status:'ACTIVE',spec:{params:{
  clientAlgoId:'tb-v17s-race',symbol:'CKBUSDT',side:'SELL',positionSide:'BOTH',
  reduceOnly:'true',type:'STOP_MARKET',quantity:Q,triggerPrice:.0011726}}};

function harness({enabled=true,remembered=true,exact=true,fillQuantity=Q,manual=false,queryFails=false}={}){
  let row={id:'ckb-race',symbol:'CKBUSDT',side:'LONG',state:'OPEN',signal_id:'s1',
    remaining_quantity:Q,original_quantity:Q,entry_price:.0011868,realized_pnl_usdt:-.06001587,
    updated_at:'2026-09-10T07:40:05.705Z',metadata:{executionMode:'LEADER_MOMENTUM_V17',
      v17ManualPosition:manual,exitProtection:{version:0,orders:remembered?[structuredClone(receipt)]:[]}}};
  const calls=[],circuits=[];
  const db={from(table){let patch,oldTime;
    assert.equal(table,'v11_long_regime_positions','a recovered native close must not insert a software order');
    const b={select(){return b},eq(key,value){if(key==='updated_at')oldTime=value;return b},
      update(value){patch=value;return b},single:async()=>({data:structuredClone(row)}),
      maybeSingle:async()=>{if(oldTime!==row.updated_at)return{data:null};row={...row,...patch};return{data:structuredClone(row)}}};
    return b;
  }};
  const gateway=async c=>{
    calls.push(c.action);
    if(c.action==='p10_portfolio')return{positions:[],positions_complete:true};
    if(c.action==='symbol_info')return{quantity_step:1};
    if(c.action==='v17_query_stop'){
      if(queryFails)throw Error('read timeout');
      return{...receipt.spec.params,algoId:'algo-race',algoStatus:'FINISHED',actualOrderId:'4191734774'};
    }
    if(c.action==='v17_stop_fill')return{exact,quantity:fillQuantity,funds:fillQuantity*PRICE,
      fee:.05928261,status:'FILLED',lastFillAt:Date.parse('2026-09-10T07:41:03.160Z')};
    throw Error('forbidden exchange command: '+c.action);
  };
  const ctx={Date,Number,Math,Error,Promise,String,Array,console,crypto,
    STRATEGY:'LEADER_MOMENTUM_V17',NATIVE_STOP_ENABLED:enabled,
    rec:v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{},
    createGatewayProtection,gateway,verifyExecutionLease:async()=>{},
    active:pf=>pf.positions,sym:x=>x.symbol,
    circuit:async(_db,reason)=>circuits.push(reason)};
  vm.createContext(ctx);vm.runInContext(code+';this.close=closePos;',ctx);
  return{db,ctx,calls,circuits,get row(){return row}};
}

test('stop fills after the first portfolio check: books exact CKB fill without another sell',async()=>{
  const h=harness(),stale=structuredClone(h.row);
  const r=await h.ctx.close(h.db,stale,1,'V17_RISK_CUT');
  assert.equal(r.closed,true);assert.equal(r.nativeReconciled,true);
  assert.equal(h.row.remaining_quantity,0);assert.equal(h.row.exit_reason,'V17_NATIVE_STOP');
  assert.equal(h.row.closed_at,'2026-09-10T07:41:03.160Z');
  assert.ok(Math.abs(h.row.realized_pnl_usdt-((PRICE-.0011868)*Q-.06001587-.05928261))<1e-10);
  assert.deepEqual(h.circuits,[]);
  assert.deepEqual(h.calls,['p10_portfolio','symbol_info','v17_query_stop','v17_stop_fill']);
  const pnl=h.row.realized_pnl_usdt;
  const again=await h.ctx.close(h.db,stale,1,'V17_RISK_CUT');
  assert.equal(again.nativeReconciled,true);assert.equal(h.row.realized_pnl_usdt,pnl,'repeated stale caller cannot double-book');
});

test('a partial close is never satisfied by a recovered full native close',async()=>{
  // A recovered native stop closed the WHOLE position. Handing that back to a caller that
  // asked to sell a fraction would book a full close against a partial intent, so the
  // shortcut must decline and leave the existing mismatch guard to fire.
  const h=harness();
  await assert.rejects(()=>h.ctx.close(h.db,structuredClone(h.row),.3,'BULL_T1'),/POSITION_MISMATCH/);
  assert.equal(h.circuits.length,1);
  assert.equal(h.row.state,'OPEN');
  assert.equal(h.row.remaining_quantity,Q);
  assert.ok(!h.calls.includes('v17_query_stop'),'a partial request must not even take the recovery path');
  assert.ok(!h.calls.includes('create_order'));
});

for(const [name,options] of [
  ['no remembered stop',{remembered:false}],
  ['native disabled',{enabled:false}],
  ['manual position',{manual:true}],
  ['inexact fill',{exact:false}],
  ['stop read failure',{queryFails:true}],
  ['partial native fill',{fillQuantity:82539}],
])test(name+' preserves the mismatch guard and never sends a software sell',async()=>{
  const h=harness(options);
  await assert.rejects(()=>h.ctx.close(h.db,structuredClone(h.row),1,'V17_RISK_CUT'),/POSITION_MISMATCH/);
  assert.equal(h.circuits.length,1);
  assert.equal(h.row.state,'OPEN');
  assert.ok(!h.calls.includes('create_order'));
  assert.ok(!h.calls.includes('v17_create_stop'));
  assert.ok(!h.calls.includes('v17_cancel_stop'));
});
