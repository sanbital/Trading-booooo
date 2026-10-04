import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyMarket,revalidateEntry,decidePosition,captureSafety} from '../../supabase/functions/_shared/deterministic/market-state.mjs';
import {normalizeCapture} from '../../supabase/functions/_shared/deterministic/features.mjs';
import {overlayExecutableBook,detachAudit,requireEntryAuthority} from '../../supabase/functions/_shared/deterministic/runtime.mjs';
import {EXIT_CLASS,exitClass} from '../../supabase/functions/_shared/deterministic/exit-authority.mjs';
import {scenario,bearish,position,executableQuote,AT} from './fixtures.mjs';

test('A: trend, active buyers, expanding participation and held breakout permit BUY',()=>{
 const d=classifyMarket(scenario());assert.equal(d.structural_strength,'STRONG');assert.equal(d.current_propulsion,'STRONG');
 assert.equal(d.setup,'PASS');assert.equal(d.trigger,'BREAKOUT');assert.equal(d.confirmation,'PASS');assert.equal(d.decision,'BUY');
});
test('B: +50% extension with falling buyers, sell flow and rejection blocks a chase',()=>{
 const input=bearish({values:{rsi_5m_14:90,rsi_1m_14:88,bb_position:1.3,ema9_distance:.025,volume_ratio_5m_vs_60m:3,volume_climax_decline:true,distance_high_60m:-.001}});
 input.return24h=.5;const d=classifyMarket(input);assert.equal(d.structural_strength,'STRONG');assert.equal(d.current_propulsion,'WEAK');
 assert.equal(d.exhaustion.state,'BLOCK');assert.equal(d.decision,'REJECT');
 assert.equal(d.exhaustion.families.filter(x=>x==='OVEREXTENSION').length,1);
});
test('C: quiet pullback, established low, recovering buyers and rising recovery velocity can BUY',()=>{
 const prices=[100.05,100.1,100.2,100.3,100.4,100.45,100.42,100.35,100.3,100.2,100.1,100,99.9,99.8,99.7,99.6,99.55,99.6,99.65,99.75,99.85,99.95,100.05,100.15];
 const pressure=prices.map((_,i)=>i<18?.35:.51+(i-18)*.045),input=scenario({prices,pressure,values:{volume_ratio_5m_vs_60m:.8}}),d=classifyMarket(input);
 assert.equal(d.trigger,'PULLBACK_RECOVERY');assert.equal(d.decision,'BUY');
});
test('D: a book/flow reversal within ten seconds cancels a past BUY',()=>{
 const seed=classifyMarket(scenario()),latest=bearish({at:AT+5000}),r=revalidateEntry(seed,latest);
 assert.equal(r.action,'CANCEL_ENTRY');assert.equal(r.allowed,false);
 const onlyBook=overlayExecutableBook(scenario(),executableQuote({depth:600,askDepth:50000}),AT);
 assert.equal(revalidateEntry(seed,onlyBook).allowed,false,'the current executable book is authority');
});
test('E: +2% additional execution drift cancels an otherwise intact BUY',()=>{
 const input=scenario(),seed=classifyMarket(input),r=revalidateEntry(seed,{...input,price:input.price*1.02});
 assert.equal(r.action,'CANCEL_ENTRY');assert.equal(r.reason,'LATE_EXECUTION');
});
test('F: stronger current flow and a normal spread execute despite an older decision',()=>{
 const old=scenario({at:AT-15000}),seed=classifyMarket(old),current=scenario(),r=revalidateEntry(seed,current);
 assert.equal(r.decision_age_ms,15000);assert.equal(r.action,'EXECUTE');
});
test('G: a strong position with continued highs and positive flow remains HOLD',()=>{
 const input=scenario(),p=position({peak_price:100.2}),d=decidePosition({...input,position:p,bid:100.24});
 assert.equal(d.action,'HOLD');assert.equal(d.state,'THESIS_INTACT');
});
test('H: +1% MFE then +0.2% with flow reversal and failed highs protects or exits',()=>{
 const input=bearish(),d=decidePosition({...input,position:position(),bid:100.2});
 assert.ok(['PROTECT','EXIT'].includes(d.action));assert.ok(d.weak_families.includes('FLOW'));assert.ok(Math.abs(d.mfe-.01)<1e-12);
});
test('I: immediate thesis collapse exits before the unchanged 2.5% hard stop',()=>{
 const input=bearish(),p=position({peak_price:100}),d=decidePosition({...input,position:p,bid:99.5});
 assert.equal(d.action,'EXIT');assert.equal(d.reason,'DETERMINISTIC_THESIS_FAILURE');assert.ok(99.5>p.hard_stop_price);
});
test('J/K/L: absent keys, OpenAI outage and DeepSeek 402 have no decision effect',()=>{
 const before=classifyMarket(scenario());
 for(const failure of ['ALL_KEYS_REMOVED','OPENAI_OUTAGE','DEEPSEEK_402']){
  const input=scenario();input.providerStatus=failure;assert.deepEqual(classifyMarket(input),before);
 }
});
test('M: malformed, stale, missing or future capture refuses only that symbol',()=>{
 const healthy=scenario();for(const patch of [{trajectory:[]},{trajectory:[null]},{end_ms:AT-10000},{entry_window:{slot:1}}]){
  const invalid=normalizeCapture({...healthy.raw,...patch},AT);assert.equal(classifyMarket({...healthy,capture:invalid}).decision,'REJECT');
  assert.equal(classifyMarket(healthy).decision,'BUY');
 }
 const raw=structuredClone(healthy.raw);raw.trajectory.at(-1).exchange_event_ms=AT+1;
 assert.equal(captureSafety({...raw,dynamics:healthy.capture.dynamics},AT).ok,false);
});
test('N: asynchronous audit rejection never becomes a trading decision dependency',async()=>{
 const db={from(){return {insert(){return Promise.reject(Error('AUDIT_DB_DOWN'));}}}};
 await assert.doesNotReject(()=>detachAudit(db,{symbol:'TESTUSDT'}));assert.equal(classifyMarket(scenario()).decision,'BUY');
});
test('resident hard stop survives missing market and candle data',()=>{
 const input=scenario();input.capture={status:'UNAVAILABLE'};input.facts={};
 const p=position(),above=decidePosition({...input,position:p,bid:99}),crossed=decidePosition({...input,position:p,bid:97.4});
 assert.equal(above.state,'DATA_DEGRADED');assert.equal(crossed.action,'EXIT');
});
test('a single bearish evidence family cannot force a strategy exit',()=>{
 const input=scenario({values:{last_body:-.001,close_location_value:.2}});
 const d=decidePosition({...input,position:position(),bid:100.2});assert.equal(d.action,'HOLD');
});
test('fresh book VWAP changes cost and insufficient depth fails closed without mutating tape',()=>{
 const input=scenario(),original=JSON.stringify(input.capture),updated=overlayExecutableBook(input,executableQuote(),AT);
 assert.equal(JSON.stringify(input.capture),original);assert.ok(updated.facts.values.expected_entry_vwap>updated.facts.values.expected_exit_vwap);
 assert.equal(overlayExecutableBook(input,executableQuote({depth:100}),AT).capture.status,'UNAVAILABLE');
});
test('original capture failure and healthy but insufficient book depth retain distinct causes',()=>{
 const input=scenario(),seed=classifyMarket(input),missing={...input,capture:{status:'UNAVAILABLE',reason:'MISSING_BUCKET_120S'}};
 const preserved=overlayExecutableBook(missing,executableQuote(),AT);
 assert.equal(preserved.capture.reason,'MISSING_BUCKET_120S');assert.equal(preserved.execution_book.book_healthy,true);
 assert.equal(revalidateEntry(seed,preserved).reason,'CURRENT_DATA_INCOMPLETE_OR_STALE');
 const shallow=overlayExecutableBook(input,executableQuote({depth:100}),AT),check=revalidateEntry(seed,shallow);
 assert.equal(shallow.execution_book.book_healthy,true);assert.equal(shallow.execution_book.sell_vwap,null);
 assert.equal(shallow.execution_book.required_notional,450);assert.equal(check.allowed,false);assert.equal(check.reason,'CURRENT_EXECUTION_COST_INVALID');
});
test('a retired signal can never become automatic BUY when its API authority disappears',async()=>{
 await assert.rejects(()=>requireEntryAuthority({rpc(){throw Error('must not read database');}},{features:{}}),/RETIRED_ENTRY_AUTHORITY/);
});
test('pre-cutover hard-safety reasons remain executable during open-position ownership handoff',()=>{
 for(const reason of ['V17_NATIVE_STOP','NATIVE_HARD_STOP','R5_RISK_CUT','V17_RISK_CUT','RISK_CUT','LIQUIDATION_SAFETY','V17_HARD_STOP','DETERMINISTIC_RESIDENT_STOP'])
  assert.equal(exitClass(reason),EXIT_CLASS.HARD_SAFETY,reason);
 for(const reason of ['FD1_GPT_EXIT','FD1_DEEPSEEK_EXIT','EMERGENCY_EXIT_THESIS_FAILURE'])
  assert.throws(()=>exitClass(reason),/UNCLASSIFIED_EXIT_REASON/);
});
