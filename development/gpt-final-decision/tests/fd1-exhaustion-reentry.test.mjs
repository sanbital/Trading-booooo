// FD1 ENTRY trend / propulsion / fatigue separation and same-symbol trade memory (2026-09-26).
// The evidence layer only changes WHAT GPT sees and which SOFT categories it may cite; these
// tests pin that it never blocks a BUY, never fires on the preserved winners, and does fire on
// the multi-axis fade and the no-new-impulse re-entry of 2026-09-26.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {computeFacts,modelJudgments,tradeMemory,HISTORY_KEYS} from '../../../supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {validateDecision,riskFlags,wireSchema,EV_SKIP} from '../../../supabase/functions/_shared/gpt-final-decision/contract.mjs';
import {fatigueAxes,entryAssessment} from '../../../supabase/functions/_shared/gpt-final-decision/assessment.mjs';
import {buildDecisionPacket,modelInput,hash} from '../../../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {PROMPTS} from '../../../supabase/functions/_shared/gpt-final-decision/prompt.mjs';
import {RECHECK_PROMPT,INITIAL_KEYS,recheckModelInput,buildRecheckPacket,detectChange,recheckFlags} from '../../../supabase/functions/_shared/gpt-final-decision/recheck.mjs';
import {readHistory} from '../../../supabase/functions/_shared/gpt-final-decision/engine.mjs';
import {T,MIN,src,entryWire} from './fixtures.mjs';
const PROD=JSON.parse(readFileSync(new URL('./production-entries-20260926.json',import.meta.url),'utf8'));
const base=computeFacts(src(T),{asOf:T+2000,referenceClose:1.1,dayReturn:.2,rank:3});
/** A LIVE packet whose facts are exactly `values` (complete candles and book, as production had). */
const packet=async(values,cec={action:'PROBE',ready:true,predictionUsdt:-2.5})=>buildDecisionPacket({task:'ENTRY',subjectId:'s-'+Math.random(),symbol:'ABCUSDT',
  dataMode:'LIVE',facts:{...base,values:{...Object.fromEntries(Object.keys(base.values).map(k=>[k,null])),...values}},judgments:modelJudgments({cec0040:cec})});
const soft=p=>riskFlags(p).soft;
const buy=(p,support)=>validateDecision(entryWire({t:'ENTRY',c:p.candidate_id,d:'BUY',reasons:[],support,n:'상승 지속'}),p);
const skip=(p,r,e)=>validateDecision(entryWire({t:'ENTRY',c:p.candidate_id,d:'SKIP',reasons:[{r,e}],support:[],n:'추진력 소진'}),p);
const strong={return_1m:.004,return_5m:.012,return_15m:.02,return_30m:.03,return_60m:.05,return_4h:.09,day_return:.1,accel_5m_vs_15m:.005,accel_15m_vs_60m:.008,
  distance_high_60m:0,minutes_since_high_60m:0,volume_ratio_5m_vs_60m:1.6,taker_buy_ratio_5m:.64,taker_buy_ratio_15m:.6,taker_buy_ratio_60m:.54,buyer_share_change:.1,
  oi_change_5m:.004,book_imbalance_25bps:.3,spread_bps:2,ask_depth_to_order:20,bid_depth_to_order:20,est_buy_slippage_bps:2,distance_trigger_reference:.004,
  distance_sma20:.01,btc_return_15m:.001,btc_return_60m:.002,relative_strength_15m:.019,relative_strength_60m:.048,funding_rate:.0001,premium_index:0};
const noHist={symbol_entries_24h:0};
const prev=(o)=>({prev_trade_minutes_since_exit:15,prev_trade_return:.02,prev_trade_mfe:.039,price_vs_prev_peak:-.007,price_vs_prev_exit:.014,new_high_since_prev_exit:0,symbol_entries_24h:1,...o});

test('1. early strength with strong propulsion: no fatigue, no new SKIP category, BUY valid',async()=>{
  const p=await packet({...strong,...noHist});
  assert.deepEqual(fatigueAxes(p.facts.values).weak,[]);assert.ok(!soft(p).includes('EXHAUSTION'));assert.ok(!('REENTRY_NO_NEW_IMPULSE' in riskFlags(p).flags));
  assert.equal(buy(p,['return_5m','taker_buy_ratio_5m','accel_5m_vs_15m']).decision,'BUY');
  assert.deepEqual(wireSchema('ENTRY',p).properties.reasons.items.properties.r.enum,['GPT_JUDGMENT'],'no band breached: SKIP only on GPT\'s own judgment');
});
test('2. normal short pullback inside a strong trend (one axis) is not exhaustion',async()=>{
  const v={...strong,return_5m:-.001,accel_5m_vs_15m:-.007,accel_15m_vs_60m:.004,taker_buy_ratio_5m:.51,buyer_share_change:-.03,minutes_since_high_60m:4,distance_high_60m:-.004};
  const p=await packet({...v,...noHist});
  assert.deepEqual(fatigueAxes(v).weak,[]);assert.ok(!soft(p).includes('EXHAUSTION'));
  assert.equal(buy(p,['return_15m','taker_buy_ratio_5m']).decision,'BUY');
  const oneAxis=await packet({...strong,taker_buy_ratio_5m:.47,buyer_share_change:-.05,...noHist});
  assert.deepEqual(fatigueAxes(oneAxis.facts.values).weak,['FLOW']);assert.ok(!soft(oneAxis).includes('EXHAUSTION'),'one weak axis alone never offers EXHAUSTION');
});
test('3. strong trend but PRICE/FLOW/BOOK fading together: EXHAUSTION evidence, never a block',async()=>{
  const v={...strong,accel_5m_vs_15m:-.001,accel_15m_vs_60m:-.004,taker_buy_ratio_5m:.46,buyer_share_change:-.07,book_imbalance_25bps:-.3,minutes_since_high_60m:12,distance_high_60m:-.006};
  const p=await packet({...v,...noHist});
  assert.deepEqual(fatigueAxes(v).weak,['PRICE','FLOW','BOOK']);assert.ok(soft(p).includes('EXHAUSTION'));
  assert.equal(skip(p,'EXHAUSTION',['accel_15m_vs_60m','taker_buy_ratio_5m','book_imbalance_25bps']).decision,'SKIP');
  assert.throws(()=>skip(p,'EXHAUSTION',['return_60m']),/EVIDENCE_OUTSIDE/,'only fatigue-axis facts may be cited');
  assert.equal(buy(p,['return_5m','return_60m']).decision,'BUY','EXHAUSTION is SOFT: GPT may still BUY');
  assert.equal(entryAssessment(v).fatigue.weak_count,3);
});
test('4. re-entry after a winner without a new high: REENTRY_NO_NEW_IMPULSE',async()=>{
  const p=await packet({...strong,...prev({})});
  assert.ok(soft(p).includes('REENTRY_NO_NEW_IMPULSE'));
  assert.equal(skip(p,'REENTRY_NO_NEW_IMPULSE',['prev_trade_minutes_since_exit','new_high_since_prev_exit']).decision,'SKIP');
  assert.equal(buy(p,['return_5m','taker_buy_ratio_5m']).decision,'BUY','SOFT only');
});
test('5. re-entry after a winner on a fresh breakout above its peak: no re-entry flag, breakout is support',async()=>{
  const p=await packet({...strong,...prev({price_vs_prev_peak:.006,new_high_since_prev_exit:1})});
  assert.ok(!soft(p).includes('REENTRY_NO_NEW_IMPULSE'));
  assert.deepEqual(buy(p,['return_5m','price_vs_prev_peak','new_high_since_prev_exit']).support.map(e=>e.key),['return_5m','price_vs_prev_peak','new_high_since_prev_exit']);
});
test('6. re-entry repeating a low-MFE loss structure: flagged, and the prior failure is citable',async()=>{
  const p=await packet({...strong,...prev({prev_trade_return:-.012,prev_trade_mfe:.001,price_vs_prev_peak:-.004,new_high_since_prev_exit:0,prev_trade_minutes_since_exit:25})});
  assert.ok(soft(p).includes('REENTRY_NO_NEW_IMPULSE'));
  assert.equal(skip(p,'REENTRY_NO_NEW_IMPULSE',['prev_trade_mfe','price_vs_prev_peak']).reasons[0].evidence[0].value,.001);
});
test('7. after a loss, a completely new strong wave (new high, >1h later) is not flagged',async()=>{
  const fresh=await packet({...strong,...prev({prev_trade_return:-.012,prev_trade_mfe:.001,new_high_since_prev_exit:1,price_vs_prev_peak:.02})});
  assert.ok(!soft(fresh).includes('REENTRY_NO_NEW_IMPULSE'));
  const later=await packet({...strong,...prev({prev_trade_minutes_since_exit:95})});
  assert.ok(!soft(later).includes('REENTRY_NO_NEW_IMPULSE'),'outside the 60-minute window the memory is context only');
  assert.equal(buy(fresh,['return_5m','price_vs_prev_peak']).decision,'BUY');
});
test('8. a negative CEC alone on a very strong symbol creates no SKIP route and is shown as a base rate',async()=>{
  const p=await packet({...strong,...noHist},{action:'REJECT',effectiveAllowed:false,ready:true,predictionUsdt:-4.9});
  assert.deepEqual(wireSchema('ENTRY',p).properties.reasons.items.properties.r.enum,['GPT_JUDGMENT'],'CEC creates no category; GPT alone may decide to skip');
  const cec=modelInput(p).model_judgments.cec0040;
  assert.equal(cec.strategy_base_rate_usdt_per_trade,-4.9);assert.equal(cec.symbol_specific,false);assert.ok(!('effective_allowed' in cec));
  assert.match(cec.note,/not a judgment of this symbol/);
});
test('9. several independent weak axes plus a negative CEC: a strong, citable SKIP case',async()=>{
  const v={...strong,accel_5m_vs_15m:-.002,accel_15m_vs_60m:-.005,taker_buy_ratio_5m:.45,buyer_share_change:-.08,volume_ratio_5m_vs_60m:.5,book_imbalance_25bps:-.29};
  const p=await packet({...v,...prev({})},{action:'REJECT',ready:true,predictionUsdt:-2.3});
  assert.deepEqual(soft(p).filter(k=>['EXHAUSTION','REENTRY_NO_NEW_IMPULSE'].includes(k)),['EXHAUSTION','REENTRY_NO_NEW_IMPULSE']);
  const a=validateDecision(entryWire({t:'ENTRY',c:p.candidate_id,d:'SKIP',support:[],n:'추진력 소진',
    reasons:[{r:'EXHAUSTION',e:['accel_15m_vs_60m','taker_buy_ratio_5m','volume_ratio_5m_vs_60m']},{r:'REENTRY_NO_NEW_IMPULSE',e:['new_high_since_prev_exit']}]}),p);
  assert.deepEqual(a.reasons.map(r=>r.category),['EXHAUSTION','REENTRY_NO_NEW_IMPULSE']);
});
test('10. production 2026-09-26: PROM/GRASS first-entry winners stay clean; the GRASS 02:49 loser is flagged',async()=>{
  for(const k of ['PROM_0216_WIN','GRASS_0220_WIN']){
    const p=await packet({...PROD[k],...noHist});
    assert.deepEqual(fatigueAxes(p.facts.values).weak,[],k);
    assert.ok(!soft(p).some(x=>['EXHAUSTION','REENTRY_NO_NEW_IMPULSE'].includes(x)),k);
    assert.equal(buy(p,['return_5m','taker_buy_ratio_5m','accel_15m_vs_60m']).decision,'BUY',k);
  }
  const g=await packet({...PROD.GRASS_0249_LOSS,...prev({prev_trade_minutes_since_exit:14.97,price_vs_prev_peak:-.0074,new_high_since_prev_exit:0})});
  assert.deepEqual(fatigueAxes(g.facts.values).weak,['PRICE','FLOW','PARTICIPATION','BOOK']);
  assert.ok(soft(g).includes('EXHAUSTION')&&soft(g).includes('REENTRY_NO_NEW_IMPULSE'));
  // Honest limit: a loser with strong propulsion at entry (SEI 10:21) carries no fatigue evidence.
  assert.deepEqual(fatigueAxes(PROD.SEI_1021_LOSS).weak,[]);
});
test('trade memory: only trades closed before asOf and entered within 24h; new high measured on completed 1m bars',()=>{
  const bars=[0,1,2,3,4,5].map(i=>({t:T-(6-i)*MIN,end:T-(5-i)*MIN-1,h:1+(i===4?.2:0),c:1}));
  const trade={entry_at_ms:T-6*MIN,exit_at_ms:T-3*MIN+5,entry_price:1,exit_price:1.02,peak_price:1.05};
  const m=tradeMemory([trade,{...trade,exit_at_ms:T+MIN}],{asOf:T,bars,last:{c:1.03}});
  assert.equal(m.values.symbol_entries_24h,1,'a trade closing after asOf is invisible');
  assert.equal(m.values.new_high_since_prev_exit,1);assert.ok(Math.abs(m.values.price_vs_prev_peak-(1.03/1.05-1))<1e-12);
  assert.equal(tradeMemory([{...trade,entry_at_ms:T-25*3600000}],{asOf:T,bars}).values.symbol_entries_24h,0,'older than 24h is ignored');
  assert.equal(tradeMemory(undefined,{asOf:T}).values,null,'no reader: unknown, not "no prior trade"');
});
test('history reader is bounded and fail-open; the engine filters trades closing at/after the trigger',async()=>{
  assert.deepEqual(await readHistory(null,{symbol:'X',trigger_at_ms:T}),{trades:null,error:null});
  assert.equal((await readHistory(()=>new Promise(()=>{}),{symbol:'X',trigger_at_ms:T},20)).error,'HISTORY_TIMEOUT');
  assert.equal((await readHistory(async()=>{throw Error('HISTORY_READ');},{symbol:'X',trigger_at_ms:T})).error,'HISTORY_READ');
  const r=await readHistory(async()=>[{exit_at_ms:T-1},{exit_at_ms:T}],{symbol:'X',trigger_at_ms:T});
  assert.equal(r.trades.length,1);
});
test('HOLD: GPT may EXIT on its own judgment; memory stays out of HOLD and FINAL RECHECK',async()=>{
  assert.match(PROMPTS.HOLD,/GPT_JUDGMENT/);assert.match(PROMPTS.HOLD,/시간은 청산 사유가 아니다/);
  const holdEnum=wireSchema('HOLD').properties.reasons.items.properties.r.enum;assert.ok(holdEnum.includes('GPT_JUDGMENT'));
  for(const k of HISTORY_KEYS)assert.ok(!wireSchema('HOLD').properties.support.items.enum.includes(k),k);
  for(const k of HISTORY_KEYS){assert.ok(!PROMPTS.HOLD.includes(k),k);assert.ok(!RECHECK_PROMPT.includes(k),k);assert.ok(!INITIAL_KEYS.includes(k),k);assert.ok(PROMPTS.ENTRY.includes(k),k);}
  assert.match(PROMPTS.ENTRY,/지금 이 가격에서 새 롱을 넣은 뒤 30~60분 동안 추가 상승할 확률과 기대값/);
  assert.match(PROMPTS.ENTRY,/"이미 많이 올랐다", "변동성이 높다", "신고가 근처", "단기 수익률이 높다"는 그 자체로 SKIP 사유가 아니다/);
});
test('FINAL RECHECK sees initial vs current assessment and may cite EXHAUSTION on current facts',async()=>{
  const faded={...strong,accel_5m_vs_15m:-.002,accel_15m_vs_60m:-.005,taker_buy_ratio_5m:.45,buyer_share_change:-.08};
  const facts={...base,values:{...Object.fromEntries(Object.keys(base.values).map(k=>[k,null])),...faded}};
  const init={snapshotAt:T,executionRef:{mid:1.21},facts:{...strong},support:['return_5m']};
  const d=detectChange(init,{at:T+10000,mid:1.2,book:null,tape:{return:-.001,buyShare:.4,tradeCount:100}});
  const p=await buildRecheckPacket({signalId:'x',symbol:'ABCUSDT',facts,initial:init,detection:d,judgments:null});
  assert.equal(recheckFlags(p).flags.EXHAUSTION.level,'SOFT');assert.ok(!('REENTRY_NO_NEW_IMPULSE' in recheckFlags(p).flags));
  const mi=recheckModelInput(p);assert.equal(mi.initial.assessment.fatigue.weak_count,0);assert.deepEqual(mi.current.assessment.fatigue.weak_axes,['PRICE','FLOW']);
});
