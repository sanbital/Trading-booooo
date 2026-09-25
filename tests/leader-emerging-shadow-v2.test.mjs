// LE-SHADOW-2 (SHADOW V2) tests: pure evidence axes, ALT GPT V2 contract, WAIT lifecycle/TTL, outcomes,
// parity snapshot reuse and independence, future-data leakage, snapshot freshness, budget, Binance
// weight protection, DB allowlist/append-only/real-vs-hypothetical constraints, and end-to-end
// PARITY / V2 WAIT / V2 OUTCOME / DISCOVERY runs AS shadow_le_writer on PGlite.
// Requires PGLITE_MODULE=<path to @electric-sql/pglite/dist/index.js> for the DB tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setupDb,addObserver,symbols,world,MIN,migration} from './leader-emerging-shadow-helpers.mjs';
import {klines} from '../development/gpt-final-decision/tests/fixtures.mjs';
import {createGuard,GuardError} from '../supabase/functions/leader-emerging-shadow/guard.mjs';
import {runScan} from '../supabase/functions/leader-emerging-shadow/shadow.mjs';
import {kstDayStart} from '../supabase/functions/leader-emerging-shadow/universe.mjs';
import {computeAxes,pickForGpt,BANDS} from '../supabase/functions/leader-emerging-shadow/v2/axes.mjs';
import {validateAnswer,wireSchema,legacyNegatives,TRIGGERS} from '../supabase/functions/leader-emerging-shadow/v2/contract.mjs';
import {ALT2_PROMPT} from '../supabase/functions/leader-emerging-shadow/v2/prompt.mjs';
import {callAlt2,buildPacketV2,v2Gate,BUDGET_V2} from '../supabase/functions/leader-emerging-shadow/v2/gpt.mjs';
import {evaluateWaitV2,terminalResolution,ttlMs,barsAfter} from '../supabase/functions/leader-emerging-shadow/v2/wait.mjs';
import {labelV2,beyondAskBps,roundTripBps} from '../supabase/functions/leader-emerging-shadow/v2/outcome.mjs';
import {parityEvent,rankContextAt,snapshotFreshness,runParity,runV2Wait,v2Outcome,runHealth,costFromFacts,V2_GUARD,SNAPSHOT_MAX_AGE_MS,SNAPSHOT_HARD_MAX_AGE_MS}
  from '../supabase/functions/leader-emerging-shadow/v2/run.mjs';
import {SQL_V2,makeStoreV2} from '../supabase/functions/leader-emerging-shadow/v2/store.mjs';

const T0=Date.UTC(2026,8,25,3,0,0);
const FACTS={return_1m:.001,return_5m:.006,return_15m:.012,return_30m:.02,return_60m:.03,return_4h:.08,day_return:.09,accel_5m_vs_15m:.002,
  accel_15m_vs_60m:.004,distance_high_60m:-.002,minutes_since_high_60m:2,distance_high_4h:-.01,distance_low_15m:.015,distance_sma20:.006,last_body:.001,
  last_upper_wick:.0005,distance_trigger_reference:.001,quote_volume_5m_usdt:3e6,volume_ratio_5m_vs_60m:1.6,taker_buy_ratio_5m:.55,taker_buy_ratio_15m:.54,
  taker_buy_ratio_60m:.52,buyer_share_change:.03,btc_return_15m:.001,btc_return_60m:.002,relative_strength_15m:.011,relative_strength_60m:.028,signal_rank:14,
  funding_rate:.0001,premium_index:.0003,open_interest_usdt:4e7,oi_change_5m:.004,oi_change_60m:.02,spread_bps:3,ask_depth_25bps_usdt:9000,bid_depth_25bps_usdt:12000,
  book_imbalance_25bps:.14,ask_depth_to_order:15,bid_depth_to_order:20,max_ask_wall_to_order:3,max_bid_wall_to_order:4,est_buy_slippage_bps:3};
const COST={breakeven_bps:17,roundtrip_cost_bps_real:17};
const pkt=(o={})=>({attempt:1,facts:FACTS,cost:COST,legacy:{cec0040:{action:'ADMIT'},b06133:{allowed:true},v30:{admitted:true}},rank_context:{rank:14},hard_safety:[],...o});
const wire=(o={})=>({d:'BUY',phase:'MID_CONTINUATION',overheat_view:'NOT_OVERHEATED',reasons:[],support:['taker_buy_ratio_5m','distance_high_60m','return_15m'],
  expected_move_bps:60,override:{model:'NONE',code:'NONE',e:[]},wait:{reason:'NONE',trigger:'NONE',param:null,ttl_min:null},n:'요약',...o});

// ================================================================ pure: axes (non-monotone)
test('axes: six independent axes, no composite; extreme strength lands on OVERHEAT, not on a better score', ()=>{
  const healthy=computeAxes(FACTS,{rank:14,rank15m:24,rank60m:45,vr15:1.5});
  assert.deepEqual(Object.keys(healthy).filter(k=>!['version','bands','semantics'].includes(k)),['leadership','emergence','continuation','flow','execution','overheat']);
  assert.ok(!('composite' in healthy)&&!('score' in healthy));
  assert.equal(healthy.emergence.state,'HEALTHY');assert.equal(healthy.overheat.level,'NONE');
  assert.equal(healthy.continuation.state,'HOLDING_NEAR_HIGH');assert.equal(healthy.execution.state,'GOOD');assert.equal(healthy.flow.price_oi,'PRICE_UP_OI_UP');
  const hot=computeAxes({...FACTS,volume_ratio_5m_vs_60m:5.2,taker_buy_ratio_5m:.66,return_5m:.001,day_return:.31},{rank:9,rank15m:60,rank60m:200,vr15:6});
  assert.equal(hot.emergence.state,'EXTREME_CHASE');
  const flags=hot.overheat.flags.map(f=>f.k);
  for(const k of ['EXTREME_DAY_RETURN','EXTREME_RANK_VELOCITY','VOLUME_BLOWOFF','TAKER_EXTREME_PRICE_STALL'])assert.ok(flags.includes(k),k);
  assert.equal(hot.overheat.level,'HIGH');assert.equal(hot.flow.volume_phase,'SPIKE');assert.equal(hot.flow.taker_phase,'EXTREME_BUY_CONCENTRATION');
  // velocity bands: slow / healthy / fast / extreme
  const s=v=>computeAxes(FACTS,{rank:20,rank15m:20+v}).emergence.state;
  assert.deepEqual([s(1),s(10),s(30),s(45),s(-3)],['SLOW','HEALTHY','FAST','EXTREME_CHASE','LOSING_RANK']);
  // price/OI relation cases
  const po=(r60,oi60,r5=.003,oi5=.001)=>computeAxes({...FACTS,return_60m:r60,oi_change_60m:oi60,return_5m:r5,oi_change_5m:oi5},{rank:5}).flow.price_oi;
  assert.deepEqual([po(.02,.01),po(.02,-.01),po(-.01,.01),po(.02,.01,.001,.03)],['PRICE_UP_OI_UP','PRICE_UP_OI_DOWN','PRICE_DOWN_OI_UP','OI_SPIKE_PRICE_STALL']);
  // high proximity: holding vs failing at the high
  assert.equal(computeAxes({...FACTS,last_upper_wick:.01,last_body:-.002,distance_high_60m:-.008,minutes_since_high_60m:1},{}).continuation.state,'FAILED_BREAKOUT_WICK');
  assert.equal(computeAxes({...FACTS,distance_high_60m:-.03,return_5m:-.004,minutes_since_high_60m:25},{}).continuation.state,'FADING_FROM_HIGH');
  assert.equal(computeAxes({...FACTS,distance_high_60m:-.012,return_5m:.004,accel_5m_vs_15m:.001,minutes_since_high_60m:14},{}).continuation.state,'PULLBACK_REACCELERATING');
  assert.equal(BANDS.version,'LE_AXES_2_BANDS');
});

test('prescore: <=1 LEADER + <=1 EMERGING; fewer overheat flags beats higher rank velocity', ()=>{
  const calm=computeAxes(FACTS,{rank:22,rank15m:30,rank60m:50});
  const chase=computeAxes({...FACTS,volume_ratio_5m_vs_60m:4.5},{rank:12,rank15m:70,rank60m:250});
  const lead=computeAxes(FACTS,{rank:2,rank15m:3,rank60m:5});
  const {selected,skipped}=pickForGpt([{symbol:'CHASEUSDT',lane:'EMERGING',axes:chase},{symbol:'CALMUSDT',lane:'EMERGING',axes:calm},{symbol:'LEADUSDT',lane:'LEADER',axes:lead}]);
  assert.deepEqual(selected.map(x=>x.symbol).sort(),['CALMUSDT','LEADUSDT']);
  assert.deepEqual(skipped.map(x=>x.symbol),['CHASEUSDT']);
});

// ================================================================ pure: contract
test('ALT2 contract: STRONG != BUY; phase, overheat, breakeven, non-strength fact, hard safety', ()=>{
  assert.equal(validateAnswer(wire(),pkt()).decision,'BUY');
  const bad=(w,p,re)=>assert.throws(()=>validateAnswer(wire(w),pkt(p)),re);
  bad({phase:'LATE_ACCELERATION'},{},/ALT2_BUY_PHASE/);
  bad({phase:'BLOWOFF_EXHAUSTION'},{},/ALT2_BUY_PHASE/);
  bad({overheat_view:'OVERHEATED'},{},/ALT2_BUY_OVERHEATED/);
  bad({support:['return_5m','return_15m','day_return','signal_rank']},{},/ALT2_BUY_STRENGTH_ONLY/);
  bad({support:['taker_buy_ratio_5m']},{},/ALT2_BUY_NEEDS_TWO_FACTS/);
  bad({expected_move_bps:17},{},/ALT2_BUY_BELOW_BREAKEVEN/);
  bad({},{cost:{breakeven_bps:null}},/ALT2_BUY_BELOW_BREAKEVEN/);
  bad({},{hard_safety:['SPREAD_GT_25BPS']},/ALT2_BUY_HARD_SAFETY/);
  bad({support:['made_up_key','other']},{},/ALT2_BUY_NEEDS_TWO_FACTS/);  // uncited keys are dropped
  bad({extra:1},{},/EXTRA/);
  bad({d:'HOLD'},{},/ENUM/);
});

test('ALT2 contract: override_reason is mandatory against a negative advisory model, and must be concrete', ()=>{
  const neg=pkt({legacy:{cec0040:{action:'REJECT'},b06133:{allowed:true},v30:{admitted:true}}});
  assert.deepEqual(legacyNegatives(neg.legacy),['CEC0040']);
  assert.throws(()=>validateAnswer(wire(),neg),/ALT2_OVERRIDE_MODEL:CEC0040/);
  assert.throws(()=>validateAnswer(wire({override:{model:'CEC0040',code:'NONE',e:[]}}),neg),/ALT2_OVERRIDE_CODE_REQUIRED/);
  assert.throws(()=>validateAnswer(wire({override:{model:'CEC0040',code:'ORDER_BOOK_IMPROVED',e:['book_imbalance_25bps']}}),neg),/ALT2_OVERRIDE_NEEDS_TWO_FACTS/);
  const ok=validateAnswer(wire({override:{model:'CEC0040',code:'ORDER_BOOK_IMPROVED',e:['book_imbalance_25bps','ask_depth_to_order']}}),neg);
  assert.equal(ok.override.code,'ORDER_BOOK_IMPROVED');
  const two=pkt({legacy:{cec0040:{action:'REJECT'},b06133:{allowed:false},v30:{admitted:true}}});
  assert.throws(()=>validateAnswer(wire({override:{model:'CEC0040',code:'TAKER_FLOW_RECOVERED',e:['taker_buy_ratio_5m','buyer_share_change']}}),two),/ALT2_OVERRIDE_MODEL:MULTIPLE/);
  // an abstract "strong trend" override does not exist in the schema
  assert.ok(!wireSchema().properties.override.properties.code.enum.some(x=>/STRONG|TREND|MOMENTUM/.test(x)));
  // override fields without a BUY are invalid
  assert.throws(()=>validateAnswer(wire({d:'SKIP',reasons:[{c:'LATE_ACCELERATION',e:['return_15m']}],override:{model:'CEC0040',code:'ORDER_BOOK_IMPROVED',e:[]}}),neg),/ALT2_OVERRIDE_WITHOUT_BUY/);
});

test('ALT2 contract: WAIT needs reason + one trigger + TTL 5..15; re-ask cannot WAIT; SKIP needs a cited fact', ()=>{
  const w=(x)=>wire({d:'WAIT',expected_move_bps:null,wait:{reason:'POST_SPIKE_COOLDOWN',trigger:'PULLBACK_REACCEL',param:30,ttl_min:10,...x}});
  assert.deepEqual(validateAnswer(w({}),pkt()).wait,{reason:'POST_SPIKE_COOLDOWN',trigger:'PULLBACK_REACCEL',param:30,ttl_min:10});
  assert.throws(()=>validateAnswer(w({ttl_min:4}),pkt()),/ALT2_WAIT_TTL_RANGE/);
  assert.throws(()=>validateAnswer(w({ttl_min:16}),pkt()),/ALT2_WAIT_TTL_RANGE/);
  assert.throws(()=>validateAnswer(w({ttl_min:null}),pkt()),/ALT2_WAIT_TTL_RANGE/);
  assert.throws(()=>validateAnswer(w({param:100}),pkt()),/ALT2_WAIT_PARAM_RANGE/);
  assert.throws(()=>validateAnswer(w({trigger:'SPREAD_IMPROVE',param:5}),pkt()),/ALT2_WAIT_PARAM_FORBIDDEN/);
  assert.throws(()=>validateAnswer(w({reason:'NONE'}),pkt()),/ALT2_WAIT_REASON/);
  assert.throws(()=>validateAnswer(w({trigger:'RANK_HOLD',param:null}),pkt({rank_context:{rank:null}})),/ALT2_WAIT_RANK_UNKNOWN/);
  assert.throws(()=>validateAnswer(w({}),pkt({attempt:2})),/ENUM/);   // recheck schema has no WAIT
  assert.ok(!wireSchema({recheck:true}).properties.d.enum.includes('WAIT'));
  assert.throws(()=>validateAnswer(wire({d:'SKIP',reasons:[]}),pkt()),/ALT2_SKIP_NEEDS_REASON/);
  assert.throws(()=>validateAnswer(wire({d:'SKIP',reasons:[{c:'BLOWOFF_VOLUME',e:['nope']}]}),pkt()),/ALT2_REASON_NEEDS_FACT/);
  assert.throws(()=>validateAnswer(wire({d:'SKIP',reasons:[{c:'BLOWOFF_VOLUME',e:['volume_ratio_5m_vs_60m']}],wait:{reason:'NONE',trigger:'PULLBACK_REACCEL',param:20,ttl_min:10}}),pkt()),/ALT2_WAIT_FIELDS_WITHOUT_WAIT/);
  for(const k of Object.keys(TRIGGERS))assert.ok(ALT2_PROMPT.includes(k),k);
});

test('ALT2 prompt: continuation-vs-blowoff question, STRONG != BUY, no production answer, advisory legacy', ()=>{
  for(const s of ['continuation','blow-off','"강도" 사실이 아닌 것','override.code','ADVISORY','시간이 지났다는 이유만으로 BUY 가 되지는 않는다'])assert.ok(ALT2_PROMPT.includes(s),s);
  assert.ok(!/production (GPT|FD1)의? (결정|판단|답)/.test(ALT2_PROMPT));
});

// ================================================================ pure: GPT caller + budget exhaustion
test('callAlt2: budget exhausted => SHADOW_BUDGET_EXHAUSTED and no request; invalid answer => ABSTAIN', async()=>{
  let fetched=0;
  const packet=buildPacketV2({lane:'PARITY',symbol:'AUSDT',eventKey:'k',facts:FACTS,axes:computeAxes(FACTS,{}),rankContext:{rank:3},legacy:null,cost:COST});
  const r=await callAlt2(packet,{lane:'PARITY',apiKey:'sk',fetchFn:async()=>{fetched++;},reserve:async()=>({ok:false,reason:'SHADOW_BUDGET_CALLS'}),settle:async()=>null});
  assert.equal(r.decision,'ABSTAIN');assert.equal(r.error,'SHADOW_BUDGET_EXHAUSTED:SHADOW_BUDGET_CALLS');assert.equal(fetched,0);assert.equal(r.attempted,false);
  const api=(w)=>async(u,i)=>new Response(JSON.stringify({model:'gpt-5.4-mini-2026-03-17',status:'completed',usage:{input_tokens:100,output_tokens:10},
    output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(w)}]}]}),{status:200});
  const settled=[];
  const bad=await callAlt2(packet,{lane:'PARITY',apiKey:'sk',fetchFn:api(wire({phase:'BLOWOFF_EXHAUSTION'})),reserve:async()=>({ok:true,reservation_id:7}),settle:async(id,u)=>settled.push([id,u])});
  assert.equal(bad.decision,'ABSTAIN');assert.match(bad.error,/ALT2_BUY_PHASE/);assert.equal(settled[0][0],7);
  assert.equal(v2Gate({control:{enabled:true,v2_parity_enabled:true},apiKey:null,health:{},lane:'PARITY'}),'SHADOW_KEY_MISSING');
  assert.equal(v2Gate({control:{enabled:true,v2_parity_enabled:false},apiKey:'k',health:{},lane:'PARITY'}),'V2_PARITY_DISABLED');
  assert.equal(v2Gate({control:{enabled:true,v2_discovery_gpt:true},apiKey:'k',health:{n_60m:10,n_err_60m:0,n_quota_60m:1,ledger_calls_today:3},lane:'DISCOVERY'}),'PRODUCTION_429_OR_QUOTA_60M');
  assert.equal(v2Gate({control:{enabled:true,v2_discovery_gpt:true},apiKey:'k',health:{n_60m:10,n_err_60m:0,n_quota_60m:0,ledger_calls_today:3},lane:'DISCOVERY'}),null);
  assert.ok(BUDGET_V2.DISCOVERY.perCycle<=2&&BUDGET_V2.PARITY.perRun<=3);
});

// ================================================================ pure: WAIT lifecycle / TTL
const bar=(t,{o=1,h=1.001,l=.999,c=1,q=1000,buy=600}={})=>[t,String(o),String(h),String(l),String(c),'0',t+MIN-1,String(q),0,String(buy),String(buy),'0'];
const BOOK={bids:[[.9995,50000]],asks:[[1.0005,50000]]};
const spec=(o={})=>({trigger:'PULLBACK_REACCEL',param:30,ttl_min:10,snapshot_at_ms:T0,expires_at_ms:T0+10*MIN,mid:1,high60:1.01,rank:10,
  init:{spread_bps:12,est_buy_slippage_bps:10,ask_depth_to_order:2,book_imbalance_25bps:-.1},oi_last:{v:5e6},...o});
test('WAIT lifecycle: TTL -> SKIP (never BUY), invalidation -> SKIP, trigger on post-snapshot data only', ()=>{
  assert.equal(ttlMs(5),5*MIN);assert.equal(ttlMs(15),15*MIN);assert.throws(()=>ttlMs(4));assert.throws(()=>ttlMs(20));
  const exp=evaluateWaitV2(spec(),{now:T0+10*MIN,bars:[],book:BOOK});
  assert.equal(exp.state,'EXPIRED');assert.deepEqual(terminalResolution(exp),{decision:'SKIP',reasons:['WAIT_TTL_NO_TRIGGER']});
  const down=evaluateWaitV2(spec(),{now:T0+3*MIN,bars:[],book:{bids:[[.98,5000]],asks:[[.9805,5000]]}});
  assert.equal(down.state,'INVALIDATED');assert.equal(terminalResolution(down).decision,'SKIP');
  const rank=evaluateWaitV2(spec(),{now:T0+6*MIN,bars:[],book:BOOK,rankFirst:{observedAt:T0+60_000,rank:25},rankLatest:{observedAt:T0+60_000,rank:25}});
  assert.equal(rank.state,'INVALIDATED');assert.equal(rank.reason,'RANK_DROP');
  assert.throws(()=>terminalResolution({state:'TRIGGERED'}),/NOT_TERMINAL_WITHOUT_GPT/);
  // pullback+reacceleration: bars BEFORE the snapshot minute are ignored (no look-back leakage)
  const pre=bar(T0-2*MIN,{l:.99,c:1.01});
  const pending=evaluateWaitV2(spec(),{now:T0+3*MIN,bars:[pre],book:BOOK});assert.equal(pending.state,'PENDING');
  const ok=evaluateWaitV2(spec(),{now:T0+4*MIN,bars:[pre,bar(T0+MIN,{l:.9965,c:.998,h:.999}),bar(T0+2*MIN,{c:1.002,h:1.003})],book:BOOK});
  assert.equal(ok.state,'TRIGGERED');
  // a bar that has not closed yet (end >= now) is not used
  assert.equal(barsAfter([bar(T0+MIN)],T0,T0+MIN+30_000).length,0);
  // book triggers
  assert.equal(evaluateWaitV2(spec({trigger:'SPREAD_IMPROVE',param:null}),{now:T0+MIN,bars:[],book:BOOK}).state,'PENDING'); // 10 bps > min(8, 12/2)
  const s2=evaluateWaitV2(spec({trigger:'SPREAD_IMPROVE',param:null}),{now:T0+MIN,bars:[],book:{bids:[[.99995,50000]],asks:[[1.00005,50000]]}});assert.equal(s2.state,'TRIGGERED');
  // one giant ask level is a wall (83x order), not improved depth; five 1,000-USDT levels are
  assert.equal(evaluateWaitV2(spec({trigger:'ASK_DEPTH_IMPROVE',param:null}),{now:T0+MIN,bars:[],book:BOOK}).state,'PENDING');
  const spread=[1.0001,1.0002,1.0003,1.0004,1.0005].map(p=>[p,1000/p]);
  const bd=evaluateWaitV2(spec({trigger:'ASK_DEPTH_IMPROVE',param:null}),{now:T0+MIN,bars:[],book:{bids:[[.9999,5000]],asks:spread}});assert.equal(bd.state,'TRIGGERED');
  const flow=evaluateWaitV2(spec({trigger:'TAKER_BUY_RETURN',param:null}),{now:T0+5*MIN,book:BOOK,
    bars:[bar(T0+MIN,{o:1,c:1.001,buy:700}),bar(T0+2*MIN,{o:1.001,c:1.002,buy:700}),bar(T0+3*MIN,{o:1.002,c:1.003,buy:700})]});
  assert.equal(flow.state,'TRIGGERED');
  const oi=evaluateWaitV2(spec({trigger:'OI_CONFIRM',param:null}),{now:T0+6*MIN,bars:[],book:BOOK,
    oiHist:[{timestamp:T0-MIN,sumOpenInterestValue:9e6},{timestamp:T0+5*MIN,sumOpenInterestValue:5.1e6}]});
  assert.equal(oi.state,'TRIGGERED');assert.equal(oi.detail.oi_before,5e6);
  const hold=evaluateWaitV2(spec({trigger:'RANK_HOLD',param:null}),{now:T0+6*MIN,bars:[],book:BOOK,rankFirst:{observedAt:T0+5*MIN,rank:12},rankLatest:{observedAt:T0+5*MIN,rank:12}});
  assert.equal(hold.state,'INVALIDATED');assert.equal(hold.reason,'RANK_NOT_HELD');
  // a rank snapshot taken BEFORE the WAIT is never used as confirmation
  const old=evaluateWaitV2(spec({trigger:'RANK_HOLD',param:null}),{now:T0+6*MIN,bars:[],book:BOOK,rankFirst:{observedAt:T0-MIN,rank:1},rankLatest:{observedAt:T0-MIN,rank:1}});
  assert.equal(old.state,'PENDING');
});

// ================================================================ pure: outcomes
test('outcome V2: 5..240m return/MFE/MAE, gross vs net; unknown cost is null, never 0', ()=>{
  const at=T0+20_000,rows=Array.from({length:241},(_,i)=>{const t=T0+i*MIN,p=1+i*.0001;return bar(t,{o:p,h:p*1.002,l:p*.999,c:p});});
  const l=labelV2({at,price:1,beyondAskBps:2},rows);
  assert.equal(l.cost_basis,'NET_ESTIMATED');assert.equal(l.roundtrip_cost_bps,17);
  assert.ok(Math.abs(l.ret_60m-(1+59*.0001-1))<1e-12);assert.ok(Math.abs(l.net_bps_60m-(l.gross_bps_60m-17))<1e-9);
  for(const h of [5,15,30,60,120,240]){const x=l.horizons[h];assert.ok(x.complete&&Number.isFinite(x.mfe)&&Number.isFinite(x.mae)&&Number.isFinite(x.net_bps),h);}
  assert.equal(l.data_complete,true);
  const g=labelV2({at,price:1,beyondAskBps:null},rows);
  assert.equal(g.cost_basis,'GROSS_ONLY');assert.equal(g.net_bps_60m,null);assert.ok(Number.isFinite(g.gross_bps_60m));
  const short=labelV2({at,price:1,beyondAskBps:2},rows.slice(0,70));
  assert.equal(short.ret_120m,null);assert.ok(Number.isFinite(short.ret_60m));assert.equal(short.data_complete,false);
  assert.equal(beyondAskBps(5,4),3);assert.equal(beyondAskBps(1,4),0);assert.equal(beyondAskBps(null,4),null);assert.equal(roundTripBps(null),null);
});

// ================================================================ pure: parity snapshot reuse, independence, leakage
const prodRow=(o={})=>({job_key:'job1',signal_id:'11111111-1111-1111-1111-111111111111',symbol:'AUSDT',candidate_id:'c_1',decision:'BUY',valid:true,error:null,
  snapshot_at:new Date(T0).toISOString(),created_at:new Date(T0+2500).toISOString(),snapshot_at_ms:T0,
  identity_json:JSON.stringify({trigger_at_ms:T0-11_000,rank:4,signal_id:'x'}),
  packet:{task:'ENTRY',facts:{values:FACTS,quality:{micro_complete:true,last_close:1.0,candles_complete:true}},execution_ref:{at:T0,ask:1.0005,bid:.9995,mid:1},
    snapshot_hash:'h',model_judgments:{b06133:{allowed:false,reason:'B06133_REJECT',factors:{}},v30:{admitted:true,failed:[]},cec0040:{action:'REJECT',prediction_usdt_per_trade:-3}}},...o});
test('parity: reuses the production snapshot exactly; the ALT packet never contains the production answer', ()=>{
  const pe=parityEvent(prodRow(),[]);
  assert.equal(pe.event.snapshot_source,'PRODUCTION_PACKET');assert.equal(pe.event.snapshot_at,new Date(T0).toISOString());
  assert.equal(pe.event.snapshot_offset_ms,11_000);assert.equal(pe.event.entry_ref_ask,1.0005);assert.equal(pe.event.spread_bps,3);
  assert.deepEqual(pe.facts,FACTS);
  const packet=buildPacketV2({lane:'PARITY',symbol:'AUSDT',eventKey:'k',facts:pe.facts,axes:pe.axes,rankContext:pe.rankContext,legacy:pe.legacy,cost:pe.cost,hardSafety:pe.hard});
  const txt=JSON.stringify(packet);
  for(const s of ['"BUY"','result','wire','decision','job1','c_1','prod_'])assert.ok(!txt.includes(s),'leaks production answer/identity: '+s);
  assert.deepEqual(legacyNegatives(packet.legacy).sort(),['B06133','CEC0040']);
  assert.equal(pe.cost.entry_slippage_beyond_ask_bps,1.5);assert.equal(pe.cost.breakeven_bps,16.5);
});

test('future-data leakage: rank context uses only scan cycles strictly before the snapshot', ()=>{
  const ord=s=>JSON.stringify(s);
  const cycles=[{observed_at:new Date(T0-60*MIN).toISOString(),rank_order:['X','Y','AUSDT']},{observed_at:new Date(T0-15*MIN).toISOString(),rank_order:['AUSDT','X']},
    {observed_at:new Date(T0-2*MIN).toISOString(),rank_order:['X','AUSDT']},{observed_at:new Date(T0+3*MIN).toISOString(),rank_order:['AUSDT']}];
  const r=rankContextAt(cycles,'AUSDT',T0);
  // current = the -2m cycle (the +3m cycle, where AUSDT is #1, is future data and must be ignored); refs within +-150 s of -17m / -62m
  assert.deepEqual([r.rank,r.rank15m,r.rank60m,r.velocity15,r.velocity60],[2,1,3,-1,1]);
  const r2=rankContextAt(cycles.map(c=>c),'AUSDT',T0+30_000);assert.equal(r2.rank,2);
  assert.equal(rankContextAt([{observed_at:new Date(T0+MIN).toISOString(),rank_order:['AUSDT']}],'AUSDT',T0).rank,null);
  assert.ok(ord(r));
});

test('snapshot freshness: fresh <=25 s, book refresh <=120 s, stale beyond (or from the future)', ()=>{
  assert.equal(snapshotFreshness(T0,T0+SNAPSHOT_MAX_AGE_MS),'FRESH');
  assert.equal(snapshotFreshness(T0,T0+SNAPSHOT_MAX_AGE_MS+1),'REFRESH_BOOK');
  assert.equal(snapshotFreshness(T0,T0+SNAPSHOT_HARD_MAX_AGE_MS+1),'STALE');
  assert.equal(snapshotFreshness(T0+1000,T0),'STALE');
});

// ================================================================ static: order-free, allowlist
test('V2 SQL: writes only shadow_le.v2_* / cycles, production SELECT only on already-granted tables, JSON params via ::text', ()=>{
  const READ_OK=new Set(['v11_cec0040_state','v17_market_scan_runs','gpt_final_entry_reviews','v11_long_regime_positions']);
  for(const [name,q] of Object.entries(SQL_V2)){
    for(const m of q.matchAll(/\b(insert\s+into|update|delete\s+from|merge\s+into|truncate)\s+([a-z_][\w.]*)/gi))
      assert.ok(/^shadow_le\.(v2_\w+|cycles)$/.test(m[2]),name+': write outside shadow_le v2: '+m[0]);
    for(const m of q.matchAll(/\bpublic\.(\w+)/g))assert.ok(READ_OK.has(m[1]),name+': production object: '+m[1]);
    for(const m of q.matchAll(/\b([a-z_]+)\.([a-z_0-9]+)\s*\(/g))assert.ok(m[1]==='shadow_le',name+': function outside shadow_le: '+m[0]);
    assert.ok(!/\bset\s+role|\bgrant\b|\bcreate\b|\balter\b|\bdrop\b|\bupdate\s/i.test(q),name+': DDL/update');
    assert.ok(!/\$\d+::jsonb?\b/.test(q),name+': JSON parameter must be $N::text::jsonb');
  }
});

test('V2 modules: no order / account / lease / production-ledger / service-key surface', ()=>{
  const dir=new URL('../supabase/functions/leader-emerging-shadow/v2/',import.meta.url);
  const src=['axes','contract','prompt','gpt','wait','outcome','run','store'].map(f=>readFileSync(new URL(f+'.mjs',dir),'utf8')).join('\n');
  for(const s of ['/fapi/v1/order','/fapi/v2/','listenKey','/fapi/v1/leverage','/fapi/v1/marginType','X-MBX-APIKEY','signature','v11_cec0040_decide',
    'gpt_final_review_claim','verifyExecutionLease','/v1/command','SERVICE_ROLE','createClient','OPENAI_API_KEY"','insert into public','update public'])
    assert.ok(!src.includes(s),'forbidden: '+s);
  assert.ok(!/import[^;]*(v10-lane-executor|gateway|coordinator|openai\.mjs|engine\.mjs|recheck\.mjs|api\.mjs)/.test(src));
});

test('V2 guard: own cap 60 / abort at used weight 1000; 451 is a day halt like 418/429', async()=>{
  assert.deepEqual({...V2_GUARD},{cycleWeightCap:60,abortAt:1000});
  const g=createGuard({fetchFn:async()=>new Response('[]',{status:200,headers:{'x-mbx-used-weight-1m':'1000'}}),...V2_GUARD});
  await assert.rejects(g.fetch('https://fapi.binance.com/fapi/v1/exchangeInfo'),e=>e.code==='SHARED_IP_WEIGHT_HIGH');
  const k=createGuard({fetchFn:async()=>new Response('{}',{status:451})});
  await assert.rejects(k.fetch('https://fapi.binance.com/fapi/v1/exchangeInfo'),e=>e instanceof GuardError&&e.code==='BINANCE_DAY_HALT');
  assert.equal(k.state.dayHalt,'BINANCE_HTTP_451');
  const c=createGuard({fetchFn:async()=>new Response('[]',{status:200}),...V2_GUARD});
  for(let i=0;i<12;i++)await c.fetch('https://fapi.binance.com/fapi/v1/depth?symbol=A&limit=100');
  await assert.rejects(c.fetch('https://fapi.binance.com/fapi/v1/klines?symbol=A&limit=5'),e=>e.code==='CYCLE_WEIGHT_CAP');
});

// ================================================================ DB (PGlite)
async function setupV2(){
  const x=await setupDb();
  await x.pg.exec(`alter table public.gpt_final_entry_reviews add column state text default 'DONE', add column signal_id text, add column candidate_id text,
    add column snapshot_at timestamptz, add column api_cost_usd numeric;
    alter table public.v11_long_regime_positions add column signal_id uuid;`);
  await x.pg.exec('begin;'+migration('v2')+'commit;');
  const asWriter={query:async(text,params)=>{await x.pg.exec('set role shadow_le_writer');try{return (await x.pg.query(text,params)).rows;}finally{await x.pg.exec('reset role');}}};
  return {...x,store2:makeStoreV2(asWriter)};
}
const denied=async(p,re=/permission denied|APPEND_ONLY|violates|must be owner/)=>assert.rejects(p,e=>re.test(e.message));

test('DB: v2 migration applies on top of LE-SHADOW-1; append-only; real vs hypothetical cannot be confused', async()=>{
  const {pg,admin}=await setupV2();
  const ev=(await admin.query(`insert into shadow_le.v2_events(lane,symbol,prod_job_key,candidate_at,snapshot_at,snapshot_offset_ms,snapshot_source,order_notional_basis_usdt,facts,axes,patch)
    values ('PARITY','AUSDT','j',now(),now(),0,'PRODUCTION_PACKET',600,'{}','{}','t') returning event_id`))[0].event_id;
  const ins=(o)=>admin.query(`insert into shadow_le.v2_decisions(event_id,lane,symbol,decision_source,decision,valid,actual_trade,shadow_trade) values ($1,$2,'AUSDT',$3,$4,true,$5,$6)`,
    [ev,o.lane??'PARITY',o.src,o.d,o.actual,o.shadow]);
  await ins({src:'PRODUCTION_GPT',d:'BUY',actual:null,shadow:false});
  await ins({src:'ALT_GPT',d:'BUY',actual:false,shadow:true});
  await denied(ins({src:'RULE_BASELINE',d:'BUY',actual:true,shadow:true}));          // a shadow row can never be an actual trade
  await denied(ins({src:'RULE_BASELINE',d:'SKIP',actual:false,shadow:true}));        // shadow_trade must equal decision=BUY
  await denied(ins({src:'PRODUCTION_GPT',d:'BUY',actual:true,shadow:false}));        // (dup key or check) production row not writable as actual here
  await denied(admin.query(`insert into shadow_le.v2_decisions(event_id,lane,symbol,decision_source,decision,valid,actual_trade,shadow_trade) values ($1,'PARITY','AUSDT','ALT_GPT','WAIT',true,false,false)`,[ev])); // WAIT without trigger/ttl
  await denied(admin.query(`insert into shadow_le.v2_events(lane,symbol,candidate_at,snapshot_at,snapshot_offset_ms,snapshot_source,order_notional_basis_usdt,facts,axes,patch)
    values ('PARITY','AUSDT',now(),now(),0,'SHADOW_LIVE_READ',600,'{}','{}','t')`));
  for(const t of ['v2_events','v2_decisions'])await denied(admin.query(`delete from shadow_le.${t}`));
  await denied(admin.query(`update shadow_le.v2_events set symbol='X'`));
  await denied(admin.query(`truncate shadow_le.v2_decisions`),/foreign key|APPEND_ONLY/);
  for(const t of ['v2_wait_events','v2_outcomes','v2_budget'])await denied(admin.query(`truncate shadow_le.${t}`),/APPEND_ONLY/);
  // writer role: v2 insert/select only; no production writes; no budget table writes
  await pg.exec('set role shadow_le_writer');
  await denied(pg.query(`insert into shadow_le.v2_budget(utc_day,lane,kind,calls,usd) values (current_date,'PARITY','RESERVE',1,0.01)`));
  await denied(pg.query(`update public.v11_long_regime_positions set state='CLOSED'`));
  await denied(pg.query(`insert into public.gpt_final_entry_reviews(job_key,purpose) values ('x','PRODUCTION')`));
  await denied(pg.query(`update shadow_le.control set v2_parity_enabled=true`));
  await pg.query(`select count(*) from shadow_le.v2_compare`);
  await pg.exec('reset role');
  // no anon/authenticated/service_role access to the new objects
  for(const r of ['anon','authenticated','service_role']){
    const n=(await admin.query(`select count(*)::int n from information_schema.role_table_grants where grantee=$1 and table_schema='shadow_le'`,[r]))[0].n;assert.equal(n,0,r);
  }
  // control log records the v2 flags
  await admin.query(`update shadow_le.control set v2_parity_enabled=true, set_by='t', reason='on'`);
  const lg=(await admin.query(`select v2_parity_enabled from shadow_le.control_log order by log_id desc limit 1`))[0];assert.equal(lg.v2_parity_enabled,true);
  await denied(admin.query(`update shadow_le.control set enabled=false, set_by='t', reason='x'`)); // v2 flags need enabled
});

test('DB: v2 budget per lane (DISCOVERY 300 / PARITY 200 calls, USD caps, 3 in flight) and health reads', async()=>{
  const {admin,store2}=await setupV2();
  await admin.query(`insert into shadow_le.v2_budget(utc_day,lane,kind,calls,usd,purpose) select (now() at time zone 'utc')::date,'PARITY','RESERVE',1,0.0001,'seed' from generate_series(1,199)`);
  await admin.query(`insert into shadow_le.v2_budget(utc_day,lane,kind,reservation_id,calls,usd,purpose) select utc_day,lane,'SETTLE',entry_id,0,0.0001,'seed' from shadow_le.v2_budget where kind='RESERVE'`);
  const last=await store2.v2BudgetReserve('PARITY',.001,'t');assert.equal(last.ok,true);await store2.v2BudgetSettle(last.reservation_id,.001);
  const over=await store2.v2BudgetReserve('PARITY',.001,'t');assert.equal(over.ok,false);assert.equal(over.reason,'SHADOW_BUDGET_CALLS');
  const disc=await store2.v2BudgetReserve('DISCOVERY',.001,'t');assert.equal(disc.ok,true,'lanes are counted apart');
  await store2.v2BudgetReserve('DISCOVERY',.001,'t');await store2.v2BudgetReserve('DISCOVERY',.001,'t');
  const infl=await store2.v2BudgetReserve('DISCOVERY',.001,'t');assert.equal(infl.reason,'SHADOW_BUDGET_INFLIGHT');
  await assert.rejects(admin.query(`select shadow_le.v2_budget_reserve('OTHER',0.01,'x')`),/LANE/);
  await assert.rejects(admin.query(`select shadow_le.v2_budget_reserve('PARITY',0.5,'x')`),/RESERVE_INVALID/);
  const h=await runHealth({store2,apiKey:null});assert.equal(h.shadow_key_present,false);assert.equal(h.writes,0);
  const u=await admin.query(`select * from shadow_le.v2_api_usage`);assert.ok(u.length>=1&&'production_gpt_calls' in u[0]&&'parity_gpt_calls' in u[0]);
});

function openaiFor(decide){
  const bodies=[];
  const fn=body=>{bodies.push(body);const input=JSON.parse(body.input[1].content);
    return new Response(JSON.stringify({model:'gpt-5.4-mini-2026-03-17',status:'completed',usage:{input_tokens:3000,output_tokens:120},
      output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(decide(input))}]}]}),{status:200,headers:{'x-request-id':'req_v2'}});};
  return {fn,bodies};
}
async function addProdEntry(admin,{job='job1',sym='AUSDT',decision='BUY',at=Date.now()-60_000}={}){
  const r=prodRow({job_key:job,symbol:sym,snapshot_at_ms:at});
  const rec={packet:{...r.packet,execution_ref:{at,ask:1.2,bid:1.199,mid:1.1995}},identity_json:JSON.stringify({trigger_at_ms:at-10_000}),snapshot_at_ms:at,
    result:{decision,wire:{d:decision}}};
  await admin.query(`insert into public.gpt_final_entry_reviews(job_key,purpose,symbol,decision,valid,attempted,record,created_at,state,signal_id,candidate_id,snapshot_at)
    values ($1,'PRODUCTION',$2,$3,true,true,$4,$5,'DONE',$6,'c_1',$7)`,[job,sym,decision,JSON.stringify(rec),new Date(at+2000).toISOString(),r.signal_id,new Date(at).toISOString()]);
}

test('PARITY end-to-end AS writer: same instant + same facts; production answer never sent; groups; idempotent', async()=>{
  const {admin,store2}=await setupV2();
  await admin.query(`update shadow_le.control set v2_parity_enabled=true, set_by='t', reason='on'`);
  await addProdEntry(admin,{job:'j1',decision:'BUY'});
  await addProdEntry(admin,{job:'j2',sym:'BUSDT',decision:'SKIP'});
  await admin.query(`insert into public.gpt_final_entry_reviews(job_key,purpose,symbol,decision,record,created_at,state) values ('h1','PRODUCTION','AUSDT','HOLD','{"packet":{"task":"HOLD"}}',now(),'DONE')`);
  const ai=openaiFor(p=>p.symbol==='AUSDT'
    ?wire({d:'SKIP',phase:'LATE_ACCELERATION',overheat_view:'OVERHEATED',expected_move_bps:null,reasons:[{c:'LATE_ACCELERATION',e:['return_15m']}]})
    :wire({override:{model:'MULTIPLE',code:'PULLBACK_REACCEL_CONFIRMED',e:['distance_high_60m','accel_5m_vs_15m']}}));
  const w=world({openai:ai.fn});
  const out=await runParity({store2,now:Date.now,apiKey:'sk-test',health:{n_60m:0,n_err_60m:0,n_quota_60m:0,ledger_calls_today:0},guard:createGuard({fetchFn:w.fetchFn,...V2_GUARD})});
  assert.equal(out.status,'OK',JSON.stringify(out));assert.equal(out.gpt_calls,2);
  assert.equal(w.calls.filter(c=>c.host==='fapi.binance.com').length,0,'parity decision uses zero Binance weight');
  for(const b of ai.bodies){const u=b.input[1].content;
    for(const s of ['"BUY"','"SKIP"','wire','result','j1','j2'])assert.ok(!u.includes(s),'production answer leaked: '+s);
    assert.equal(JSON.parse(u).facts.spread_bps,3,'production facts reused verbatim');}
  const d=await admin.query(`select symbol, decision_source, decision, actual_trade, shadow_trade from shadow_le.v2_decisions order by symbol, decision_source`);
  assert.deepEqual(d.map(x=>[x.symbol,x.decision_source,x.decision,x.actual_trade,x.shadow_trade]),[
    ['AUSDT','ALT_GPT','SKIP',false,false],['AUSDT','PRODUCTION_GPT','BUY',null,false],
    ['BUSDT','ALT_GPT','BUY',false,true],['BUSDT','PRODUCTION_GPT','SKIP',null,false]]);
  const e=await admin.query(`select symbol, snapshot_source, snapshot_offset_ms, entry_ref_ask, spread_bps from shadow_le.v2_events order by symbol`);
  assert.ok(e.every(x=>x.snapshot_source==='PRODUCTION_PACKET'&&Number(x.snapshot_offset_ms)===10000&&x.entry_ref_ask===1.2&&x.spread_bps===3));
  const g=await admin.query(`select symbol, grp from shadow_le.v2_compare order by symbol`);
  assert.deepEqual(g.map(x=>x.grp),['3_CURRENT_BUY_ALT_SKIP','4_CURRENT_SKIP_ALT_BUY']);
  const again=await runParity({store2,now:Date.now,apiKey:'sk-test',health:{n_60m:0,n_err_60m:0,n_quota_60m:0,ledger_calls_today:0}});
  assert.equal(again.status,'NOTHING_PENDING');
  // key missing: production row recorded, ALT not asked (no fake ABSTAIN), no OpenAI request
  await addProdEntry(admin,{job:'j3',sym:'CUSDT'});
  const n=ai.bodies.length,nokey=await runParity({store2,now:Date.now,apiKey:null,health:null});
  assert.equal(nokey.gate,'SHADOW_KEY_MISSING');assert.equal(ai.bodies.length,n);
  assert.equal((await admin.query(`select grp from shadow_le.v2_compare where symbol='CUSDT'`))[0].grp,'0_ALT_NOT_ASKED');
});

test('PARITY: a production snapshot older than 5 minutes is not re-asked (PARITY_LAG_EXCEEDED)', async()=>{
  const {admin,store2}=await setupV2();
  await admin.query(`update shadow_le.control set v2_parity_enabled=true, set_by='t', reason='on'`);
  await addProdEntry(admin,{job:'old',at:Date.now()-7*MIN});
  const ai=openaiFor(()=>wire());
  const out=await runParity({store2,now:Date.now,apiKey:'sk',health:{n_60m:0,n_err_60m:0,n_quota_60m:0,ledger_calls_today:0},guard:createGuard({fetchFn:world({openai:ai.fn}).fetchFn})});
  assert.equal(ai.bodies.length,0);assert.equal(out.gpt_calls,0);
  assert.match((await admin.query(`select error from shadow_le.v2_decisions where decision_source='ALT_GPT'`))[0].error,/PARITY_LAG_EXCEEDED/);
});

test('V2 WAIT end-to-end: expiry -> deterministic SKIP; trigger -> exactly one re-ask (no WAIT) with trigger-ask entry', async()=>{
  const {admin,store2}=await setupV2();
  await admin.query(`update shadow_le.control set v2_parity_enabled=true, set_by='t', reason='on'`);
  await addProdEntry(admin,{job:'w1',sym:'AUSDT',at:Date.now()-30_000});
  await addProdEntry(admin,{job:'w2',sym:'BUSDT',at:Date.now()-30_000});
  // the production packet carries CEC0040 REJECT + B06133 not allowed, so a BUY must state a concrete override
  const ai=openaiFor(p=>p.attempt===2?wire({override:{model:'MULTIPLE',code:'NEGATIVE_EVIDENCE_RESOLVED_IN_SNAPSHOT',e:['spread_bps','taker_buy_ratio_5m']}}):p.symbol==='AUSDT'
    ?wire({d:'WAIT',expected_move_bps:null,wait:{reason:'SPREAD_WIDE',trigger:'SPREAD_IMPROVE',param:null,ttl_min:5}})
    :wire({d:'WAIT',expected_move_bps:null,wait:{reason:'PULLBACK_NEEDED',trigger:'PULLBACK_REACCEL',param:40,ttl_min:5}}));
  const w=world({openai:ai.fn});
  const H={n_60m:0,n_err_60m:0,n_quota_60m:0,ledger_calls_today:0};
  await runParity({store2,now:Date.now,apiKey:'sk',health:H,guard:createGuard({fetchFn:w.fetchFn,...V2_GUARD})});
  assert.equal((await admin.query(`select count(*)::int n from shadow_le.v2_decisions where decision='WAIT'`))[0].n,2);
  // AUSDT: spread in the fake book is ~8.3 bps vs initial 3 -> not improved -> pending; BUSDT pending too
  const r1=await runV2Wait({store2,now:Date.now,apiKey:'sk',health:H,guard:createGuard({fetchFn:w.fetchFn,...V2_GUARD})});
  assert.ok(r1.waits.every(x=>x.state==='PENDING'),JSON.stringify(r1));
  // 6 minutes later: both TTLs (5 min) are over -> SKIP by WAIT_RESOLUTION, no Binance read, no GPT
  const later=()=>Date.now()+6*MIN,nb=w.calls.length,na=ai.bodies.length;
  const r2=await runV2Wait({store2,now:later,apiKey:'sk',health:H,guard:createGuard({fetchFn:w.fetchFn,...V2_GUARD})});
  assert.deepEqual(r2.waits.map(x=>[x.state,x.resolution]),[['EXPIRED','SKIP'],['EXPIRED','SKIP']]);
  assert.equal(w.calls.length,nb);assert.equal(ai.bodies.length,na);
  const fin=await admin.query(`select alt_final, wait_terminal_event from shadow_le.v2_final order by symbol`);
  assert.deepEqual(fin.map(x=>[x.alt_final,x.wait_terminal_event]),[['SKIP','EXPIRED'],['SKIP','EXPIRED']]);
  assert.deepEqual((await admin.query(`select grp from shadow_le.v2_compare order by symbol`)).map(x=>x.grp),['2_CURRENT_BUY_ALT_WAIT','2_CURRENT_BUY_ALT_WAIT']);
  // triggered case: SPREAD_IMPROVE with a tight book
  await addProdEntry(admin,{job:'w3',sym:'CUSDT',at:Date.now()-20_000});
  await runParity({store2,now:Date.now,apiKey:'sk',health:H,guard:createGuard({fetchFn:world({openai:openaiFor(()=>wire({d:'WAIT',expected_move_bps:null,
    wait:{reason:'SPREAD_WIDE',trigger:'SPREAD_IMPROVE',param:null,ttl_min:10}})).fn}).fetchFn,...V2_GUARD})});
  // initial spread 3 bps in the packet; the tight book has ~0.8 bps
  const tight=world({openai:ai.fn,depth:{bids:[[1.1999,50000],[1.1998,50000]],asks:[[1.2000,50000],[1.2001,50000]]}});
  const r3=await runV2Wait({store2,now:Date.now,apiKey:'sk',health:H,guard:createGuard({fetchFn:tight.fetchFn,...V2_GUARD})});
  assert.deepEqual(r3.waits.map(x=>[x.state,x.resolution]),[['TRIGGERED','BUY']],JSON.stringify(r3));
  const re=ai.bodies.at(-1);assert.ok(!JSON.stringify(re.text.format.schema.properties.d.enum).includes('WAIT'));
  assert.equal(JSON.parse(re.input[1].content).attempt,2);
  const row=(await admin.query(`select attempt, hyp_entry_basis, hyp_entry_ask from shadow_le.v2_decisions where symbol='CUSDT' and attempt=2`))[0];
  assert.deepEqual([row.attempt,row.hyp_entry_basis,row.hyp_entry_ask],[2,'WAIT_TRIGGER_ASK',1.2]);
  assert.equal((await admin.query(`select alt_final from shadow_le.v2_final where symbol='CUSDT'`))[0].alt_final,'BUY');
  // a second wait run cannot re-trigger or re-ask
  const n2=ai.bodies.length,r4=await runV2Wait({store2,now:Date.now,apiKey:'sk',health:H,guard:createGuard({fetchFn:tight.fetchFn,...V2_GUARD})});
  assert.equal(r4.status,'NO_OPEN_WAIT');assert.equal(ai.bodies.length,n2);
});

test('V2 OUTCOME end-to-end: matured events labeled once, production reality looked up read-only', async()=>{
  const {admin,store2}=await setupV2();
  const at=Date.now()-5*3600_000;
  await admin.query(`update shadow_le.control set v2_parity_enabled=true, set_by='t', reason='on'`);
  await addProdEntry(admin,{job:'o1',at});
  await admin.query(`insert into shadow_le.v2_events(lane,symbol,prod_job_key,prod_signal_id,candidate_at,snapshot_at,snapshot_offset_ms,snapshot_source,order_notional_basis_usdt,
    entry_ref_at,entry_ref_ask,entry_beyond_ask_bps,facts,axes,patch) values ('PARITY','AUSDT','o1','11111111-1111-1111-1111-111111111111',$1,$1,0,'PRODUCTION_PACKET',600,$1,1.2,2,'{}','{}','t')`,
    [new Date(at).toISOString()]);
  await admin.query(`insert into public.v11_long_regime_positions(symbol,state,entry_price,entry_at,realized_pnl_usdt,signal_id) values ('AUSDT','CLOSED',1.2,$1,4.5,'11111111-1111-1111-1111-111111111111')`,[new Date(at+10_000).toISOString()]);
  const w=world();
  const out=await v2Outcome({store2,now:Date.now,guard:createGuard({fetchFn:w.fetchFn,...V2_GUARD})});
  assert.equal(out.labeled,1,JSON.stringify(out));
  const o=(await admin.query(`select cost_basis, roundtrip_cost_bps, prod_actual_trade, prod_realized_pnl_usdt, data_complete, horizons from shadow_le.v2_outcomes`))[0];
  assert.deepEqual([o.cost_basis,o.roundtrip_cost_bps,o.prod_actual_trade,Number(o.prod_realized_pnl_usdt)],['NET_ESTIMATED',17,true,4.5]);
  assert.deepEqual(Object.keys(o.horizons),['5','15','30','60','120','240']);
  assert.ok(w.calls.every(c=>c.path==='/fapi/v1/klines'&&c.method==='GET'));
  assert.equal((await v2Outcome({store2,now:Date.now,guard:createGuard({fetchFn:w.fetchFn,...V2_GUARD})})).labeled,0);
  const st=await admin.query(`select * from shadow_le.v2_group_stats('-infinity','infinity',60)`);assert.ok(st.length>=1);
  // an event that is not yet mature is never labeled (no future data exists yet)
  await admin.query(`insert into shadow_le.v2_events(lane,symbol,prod_job_key,candidate_at,snapshot_at,snapshot_offset_ms,snapshot_source,order_notional_basis_usdt,
    entry_ref_at,entry_ref_ask,facts,axes,patch) values ('PARITY','BUSDT','o2',now(),now(),0,'PRODUCTION_PACKET',600,now(),1.2,'{}','{}','t')`);
  assert.equal((await v2Outcome({store2,now:Date.now,guard:createGuard({fetchFn:w.fetchFn,...V2_GUARD})})).labeled,0);
});

test('V2 yields to production: a production scan blocked for weight/429 stops V2 Binance reads', async()=>{
  const {admin,store2}=await setupV2();
  await admin.query(`insert into public.v17_market_scan_runs(captured_at,strategy,signal_close_at,details) values (now(),'V17',now(),'{"blocked":["SHARED_IP_WEIGHT_HIGH"],"errors":[]}')`);
  const w=world();
  const out=await v2Outcome({store2,now:Date.now,guard:createGuard({fetchFn:w.fetchFn,...V2_GUARD})});
  assert.equal(out.status,'SHADOW_YIELD_PRODUCTION_WEIGHT');assert.equal(w.calls.length,0);
});

/** 520-symbol market; C040 jumps into the top ranks (EMERGING). */
async function market(admin,t){
  const syms=symbols(520),dayStart=kstDayStart(t);
  await addObserver(admin,dayStart+5000,Object.fromEntries(syms.map(s=>[s,1])));
  const at=k=>Object.fromEntries(syms.map((s,i)=>[s,1+(520-i)/1000+(s==='C040USDT'&&k===0?.035:0)]));
  for(const k of [60,30,15])await addObserver(admin,t-k*MIN,at(k));
  await addObserver(admin,t,at(0));
  return syms;
}
test('DISCOVERY end-to-end: V1 cycle intact, V2 events for the shortlist, ALT GPT for <=1 LEADER + <=1 EMERGING', async()=>{
  const {admin,store,store2}=await setupV2();
  const t=Date.now()-20_000;if(t-kstDayStart(t)<90*MIN)return;
  const syms=await market(admin,t);
  for(const k of [60,30,15])await admin.query(`insert into shadow_le.cycles(mode,status,started_at,finished_at,kst_day,observation_bucket,observed_at,rank_order,arms_active,patch)
      values ('SCAN','OK',$1,$1,$2,$3,$1,$4,'[]','seed')`,[new Date(t-k*MIN).toISOString(),new Date(kstDayStart(t)+9*3600_000).toISOString().slice(0,10),
      new Date(Math.floor((t-k*MIN)/300000)*300000+2000).toISOString(),JSON.stringify(syms)]);
  await admin.query(`update shadow_le.control set v2_discovery_gpt=true, set_by='t', reason='on'`);
  const ai=openaiFor(()=>wire({d:'SKIP',phase:'LATE_ACCELERATION',overheat_view:'OVERHEATED',expected_move_bps:null,reasons:[{c:'EXTREME_RANK_CHASE',e:['return_15m']}]}));
  const w=world({exchangeSymbols:syms,openai:ai.fn});
  const out=await runScan({store,store2,guard:createGuard({fetchFn:w.fetchFn}),now:Date.now,apiKey:'sk'});
  assert.equal(out.status,'OK');assert.ok(out.v2&&!out.v2.error,JSON.stringify(out.v2));
  assert.ok(out.v2.events>=1&&out.v2.events===out.shortlist.length,JSON.stringify(out.v2));
  assert.ok(out.v2.gpt_calls<=2&&out.v2.gpt_calls>=1);
  const v1=(await admin.query(`select count(*)::int n from shadow_le.decisions where arm in ('RULE_BASELINE','TAKE_ALL')`))[0].n;assert.equal(v1,2*out.shortlist.length);
  const ev=await admin.query(`select lane, scan_lane, snapshot_source, entry_ref_ask, axes ? 'overheat' as has_overheat, candidate_at <= snapshot_at as ordered from shadow_le.v2_events`);
  assert.ok(ev.every(e=>e.lane==='DISCOVERY'&&e.entry_ref_ask>0&&e.has_overheat&&e.ordered));
  const rb=(await admin.query(`select count(*)::int n from shadow_le.v2_decisions where decision_source='RULE_BASELINE'`))[0].n;assert.equal(rb,out.v2.events);
  const sent=JSON.parse(ai.bodies[0].input[1].content);
  assert.equal(sent.lane_source,'DISCOVERY');assert.ok(sent.axes.overheat&&sent.axes.execution&&!('composite' in sent.axes));
  const g=(await admin.query(`select distinct grp from shadow_le.v2_compare`)).map(x=>x.grp);
  assert.ok(g.every(x=>/^(10_|D0_|D_)/.test(x)),JSON.stringify(g));
  // V2 failure never breaks V1: a broken store2 still returns the V1 cycle
  const broken={...store2,controlV2:async()=>{throw Error('boom');}};
  await addObserver(admin,t+5*MIN,Object.fromEntries(syms.map((s,i)=>[s,1+(520-i)/1000])));
  const out2=await runScan({store,store2:broken,guard:createGuard({fetchFn:w.fetchFn}),now:()=>t+5*MIN+20_000,apiKey:'sk'});
  assert.ok(['OK','DUPLICATE_BUCKET'].includes(out2.status));
});
