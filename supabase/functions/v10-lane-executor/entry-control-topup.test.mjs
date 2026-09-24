import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateEntryDecision,CONTROL_SCOPE} from '../_shared/leader-entry-control.mjs';
const NOW=Date.parse('2026-09-24T08:40:00Z');
function base(existingPositionId=null){
  const position={id:'p1',symbol:'TESTUSDT',state:'OPEN',original_quantity:3,remaining_quantity:3,updated_at:new Date(NOW-100).toISOString()};
  const portfolio={exchange:'binance_futures',account_scope:'futures',positions_complete:true,available_quote:1000,
    total_equity_quote:2000,total_initial_margin_quote:100,positions:[{symbol:'TESTUSDT',side:'LONG',quantity:3,
      entry_price:100,leverage:3,initial_margin_quote:100}],
    observation:{id:'a1',source:'BINANCE_ACCOUNT_REST',requested_at_ms:NOW-200,received_at_ms:NOW-100}};
  const openOrders={complete:true,orders:[],algos:[],observed_at_ms:NOW-50};
  return evaluateEntryDecision({candidateSymbol:'TESTUSDT',classification:{issues:[],accounting:[]},portfolio,openOrders,
    positions:[position],orders:[],quarantines:[],manualSymbols:[],managementFailures:[],
    runtime:{live_enabled:true,circuit_open:false},operator:{entry_enabled:true,legacy_entries_retired:true},
    settings:{mode:'LIVE_LIMITED',pause_new_entries:false,withdrawal_mode:false,manual_intervention_required:false,
      scalp_kill_switch:false,emergency_liquidation:false,pause_lock_reason:null},
    maxSlots:1,proposedMargin:50,cashBuffer:.1,requireNativeProtection:false,existingPositionId,now:NOW});
}
test('verified same-lifecycle partial top-up may use its already occupied slot',()=>{
  const d=base('p1');assert.equal(d.allowed,true);assert.equal(d.scope,CONTROL_SCOPE.NORMAL);
});
test('same symbol without explicit lifecycle identity remains duplicate-exposure blocked',()=>{
  const d=base(null);assert.equal(d.allowed,false);assert.equal(d.scope,CONTROL_SCOPE.SYMBOL_QUARANTINE);
  assert.ok(d.reasons.some(x=>x.startsWith('LIVE_EXPOSURE_EXISTS:')));
});
test('wrong lifecycle id cannot bypass duplicate protection',()=>{
  const d=base('other');assert.equal(d.allowed,false);assert.equal(d.scope,CONTROL_SCOPE.SYMBOL_QUARANTINE);
});
test('a partially exited position cannot be topped up even when its exchange balance matches',()=>{
  const d=base('p1');
  const position={id:'p1',symbol:'TESTUSDT',state:'OPEN',original_quantity:4,remaining_quantity:3,
    updated_at:new Date(NOW-100).toISOString()};
  const x=evaluateEntryDecision({candidateSymbol:'TESTUSDT',classification:{issues:[],accounting:[]},
    portfolio:{exchange:'binance_futures',account_scope:'futures',positions_complete:true,available_quote:1000,
      total_equity_quote:2000,total_initial_margin_quote:100,positions:[{symbol:'TESTUSDT',side:'LONG',quantity:3,
        entry_price:100,leverage:3,initial_margin_quote:100}],
      observation:{id:'a1',source:'BINANCE_ACCOUNT_REST',requested_at_ms:NOW-200,received_at_ms:NOW-100}},
    openOrders:{complete:true,orders:[],algos:[],observed_at_ms:NOW-50},positions:[position],orders:[],
    quarantines:[],manualSymbols:[],managementFailures:[],runtime:{live_enabled:true,circuit_open:false},
    operator:{entry_enabled:true,legacy_entries_retired:true},settings:{mode:'LIVE_LIMITED',pause_new_entries:false,
      withdrawal_mode:false,manual_intervention_required:false,scalp_kill_switch:false,
      emergency_liquidation:false,pause_lock_reason:null},maxSlots:1,proposedMargin:50,cashBuffer:.1,
    requireNativeProtection:false,existingPositionId:'p1',now:NOW});
  assert.equal(d.allowed,true);
  assert.equal(x.allowed,false);
  assert.equal(x.scope,CONTROL_SCOPE.SYMBOL_QUARANTINE);
});
