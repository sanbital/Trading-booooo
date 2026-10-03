import test from 'node:test';import assert from 'node:assert/strict';
import {observeVenue} from '../ops/deterministic/venue-read.mjs';
import {assertControlResult} from '../ops/deterministic/control-result.mjs';
const at=Date.parse('2026-10-03T11:00:00Z');
function fixture(){return {
 p10_portfolio:{exchange:'binance_futures',account_scope:'futures',positions_complete:true,positions:[],settled_quote:1234,observation:{id:'p',source:'BINANCE_ACCOUNT_REST',requested_at_ms:at-100,received_at_ms:at-10}},
 v18_open_orders:{complete:true,orders:[],algos:[],observed_at_ms:at-20},
 futures_position_mode:{exchange:'binance_futures',account_scope:'futures',position_mode:'ONE_WAY',dual_side_position:false,observation:{id:'m',source:'BINANCE_POSITION_MODE_REST',requested_at_ms:at-100,received_at_ms:at-10}}};}
test('venue observation has only three signed reads, no DB dependency or permission grant',async()=>{
 const data=fixture(),calls=[];const result=await observeVenue({read:async c=>{calls.push(c);return data[c.action]},now:()=>at});
 assert.deepEqual(calls,[{action:'p10_portfolio'},{action:'v18_open_orders'},{action:'futures_position_mode'}]);
 assert.equal(result.summary.status,'VENUE_FLAT_VERIFIED_DB_UNAVAILABLE');assert.equal(result.summary.new_entry_permission_granted,false);
 assert.equal(result.summary.db_reconciliation,'UNAVAILABLE');assert(!JSON.stringify(result.summary).includes('1234'));
});
test('stale or incomplete venue truth is refused during a database outage',async()=>{
 for(const change of [d=>d.p10_portfolio.positions_complete=false,d=>d.v18_open_orders.complete=false,d=>d.v18_open_orders.observed_at_ms=at-6000]){
  const data=fixture();change(data);await assert.rejects(()=>observeVenue({read:async c=>data[c.action],now:()=>at}),/INCOMPLETE_OR_STALE/);
 }
});
test('held exposure, foreign orders or unsupported mode never become flat/reconciled proof',async()=>{
 for(const change of [d=>d.p10_portfolio.positions=[{market:'QUSDT',side:'LONG',quantity:1}],d=>d.v18_open_orders.algos=[{algoId:1}],d=>d.futures_position_mode.dual_side_position=true]){
  const data=fixture();change(data);const {summary}=await observeVenue({read:async c=>data[c.action],now:()=>at});
  assert.equal(summary.status,'VENUE_OBSERVED_DB_RECONCILIATION_REQUIRED');assert.equal(summary.new_entry_permission_granted,false);
 }
});
test('a successful HTTP envelope cannot make DB-degraded pause/control successful',()=>{
 assert.throws(()=>assertControlResult('pause_new_entries',{ok:true,status:'DB_DEGRADED',error:'LOAD_SETTINGS_DB:Signal timed out.'}),/NOT_APPLIED/);
 assert.throws(()=>assertControlResult('pause_new_entries',{ok:true,error:'failed'}),/NOT_SUCCESSFUL/);
 assert.throws(()=>assertControlResult('pause_new_entries',{ok:true,settings:{pause_new_entries:false}}),/NOT_CONFIRMED/);
 assert.throws(()=>assertControlResult('resume_new_entries',{ok:true,settings:{pause_new_entries:true}}),/NOT_CONFIRMED/);
 assert.equal(assertControlResult('pause_new_entries',{ok:true,settings:{pause_new_entries:true}}).pause_new_entries,true);
});
