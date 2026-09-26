import test from 'node:test';
import assert from 'node:assert/strict';
import {CHASE_STATE,LIVE_CHASE_MODE,LIVE_CHASE_POLICY,LIVE_CHASE_REASON,chaseContext,classifyChase,deadChaseState,
  liveChaseTimingValid,liveChaseTrigger} from './leader-live-chase.mjs';
import {SETUP_POLICY,startPullbackSetup} from './leader-pullback-reaccel.mjs';
import {entryExecutionWindow} from '../v10-lane-executor/entry-evidence.mjs';
import {fd1EntryIdentity} from './gpt-final-decision/engine.mjs';
import {CHASE_CEILING} from './gpt-final-decision/contract.mjs';
import {v30FrontDecision,V30_FRONT_LIVE_VERSION} from './gpt-final-review/contract.mjs';
import {entryTriggerFresh} from './leader-pullback-reaccel.mjs';
import {POLICY} from './leader-momentum-v17.mjs';
import {readFileSync} from 'node:fs';

const MIN=60_000,REF=100,CLOSE=Date.parse('2026-09-25T10:00:00Z'),CHASE_OPEN=CLOSE+4*MIN;
/** 66 completed 1m bars ending at the chase bar: a 60-minute rise into a close `chasePct`
 * above the reference, with the last five bars carrying `vol5` x volume and `buy` taker share. */
function bars({chasePct=.02,vol5=2,buy=.6,start=REF*.97,lastLoc=null,lowerLow=false,n=66}={}){
  const out=[],target=REF*(1+chasePct);
  for(let i=0;i<n;i++){
    const t=CHASE_OPEN-(n-1-i)*MIN,c=start+(target-start)*i/(n-1),o=i?start+(target-start)*(i-1)/(n-1):c*.999;
    let h=Math.max(o,c)*1.0005,l=Math.min(o,c)*.9995;
    if(lowerLow&&i===n-3)l=REF*.9;
    const q=i>=n-5?1000*vol5:1000;
    out.push([t,String(o),String(h),String(l),String(c),'0',t+MIN-1,String(q),0,'0',String(q*buy),'0']);
  }
  if(lastLoc!==null){ // re-close the chase bar at a chosen place in the 5-bar range
    const last=out.at(-1),five=out.slice(-5),hi=Math.max(...five.map(b=>+b[2])),lo=Math.min(...five.map(b=>+b[3]));
    const c=lo+(hi-lo)*lastLoc;last[4]=String(c);last[3]=String(Math.min(+last[3],c,+last[1]));
  }
  return out;
}
const classify=(raw,px)=>classifyChase(raw,{referencePrice:REF,chaseBarOpenTime:CHASE_OPEN,...(px?{}:{})});

test('the lateness category ceiling is the V17 chase ceiling',()=>{
  assert.equal(CHASE_CEILING,SETUP_POLICY.maxChasePct);
  assert.ok(LIVE_CHASE_POLICY.maxLiveChasePct>SETUP_POLICY.maxChasePct);
});

test('CHASE LIVE: volume, buyer tape, close near the high, higher low, 60m trend up',()=>{
  const c=classify(bars());
  assert.equal(c.state,CHASE_STATE.LIVE);assert.deepEqual(c.reasons,['MOMENTUM_SUSTAINED']);
  assert.ok(c.metrics.volume_ratio_5m_vs_60m>=1&&c.metrics.taker_buy_ratio_5m>=.5&&c.metrics.close_location_5m>=.7);
  assert.ok(Math.abs(c.metrics.chase_pct-.02)<1e-9);assert.ok(c.metrics.return_60m>0);
  assert.ok(c.metrics.breakout_price>0&&c.metrics.recent_peak>0);
});

test('CHASE UNCERTAIN: every DEAD condition clear but the close sits mid-range',()=>{
  const c=classify(bars({lastLoc:.6}));
  assert.equal(c.state,CHASE_STATE.UNCERTAIN);assert.deepEqual(c.reasons,['CLOSE_MID_RANGE']);
});

test('CHASE DEAD keeps the rejection and names why',()=>{
  const cases=[[{vol5:.5},'VOLUME_FADING'],[{buy:.4},'TAPE_SELLERS'],[{lastLoc:.2},'BREAKOUT_FAILING'],
    [{lowerLow:true},'LOWER_LOW'],[{start:REF*1.08},'TREND_DOWN'],[{chasePct:.06},'CHASE_EXTREME']];
  for(const [opt,reason] of cases){const c=classify(bars(opt));
    assert.equal(c.state,CHASE_STATE.DEAD,reason);assert.ok(c.reasons.includes(reason),`${reason}: ${c.reasons}`);}
  assert.deepEqual(classify(null).reasons,['CHASE_DATA_UNAVAILABLE']);
  assert.deepEqual(classify(bars({n:40})).reasons,['CHASE_DATA_UNAVAILABLE'],'less than an hour of bars');
  const gap=bars();gap.splice(30,1);assert.deepEqual(classify(gap).reasons,['CHASE_DATA_UNAVAILABLE'],'a gap is not a pass');
  assert.deepEqual(classifyChase(bars(),{referencePrice:0,chaseBarOpenTime:CHASE_OPEN}).reasons,['CHASE_INPUT_INVALID']);
  // A bar after the chase bar is never read.
  const late=bars();late.push([CHASE_OPEN+MIN,'1','1','1','1','0',CHASE_OPEN+2*MIN-1,'1','0','0','0','0']);
  assert.deepEqual(classify(late),classify(bars()));
});

/** The frozen state machine's CHASE_EXPIRED verdict for a signal armed at CLOSE. */
function chaseExpired(px=REF*1.02){
  const armed=startPullbackSetup({id:'sig-1',symbol:'ABCUSDT',features:{referenceClose:REF,signal5Close:CLOSE}},CLOSE,SETUP_POLICY).state;
  return {...armed,state:'CHASE_EXPIRED',terminalReason:'V17_CHASE_EXPIRED',lastCandleOpenTime:CHASE_OPEN,lastClose:px,
    transitions:[...armed.transitions,{at:CHASE_OPEN+MIN+4000,to:'CHASE_EXPIRED',reason:'V17_CHASE_EXPIRED'}]};
}
test('CHASE LIVE or DEAD-on-real-data becomes a trigger with the ordinary 60 s window (DEAD is AI evidence); data failure, late or extreme stays rejected',()=>{
  const live=classify(bars()),now=CHASE_OPEN+MIN+4000;
  const t=liveChaseTrigger(chaseExpired(),live,{now,setupPolicy:SETUP_POLICY});
  assert.equal(t.state,'TRIGGERED');assert.equal(t.terminalReason,null);assert.equal(t.triggerMode,LIVE_CHASE_MODE);
  assert.equal(t.triggerAt,CHASE_OPEN+MIN);assert.equal(t.triggerExpiresAt,CHASE_OPEN+MIN+SETUP_POLICY.entryTriggerTtlMs);
  assert.equal(t.triggerClose,REF*1.02);assert.equal(t.chase.state,CHASE_STATE.LIVE);
  assert.equal(t.transitions.at(-1).reason,LIVE_CHASE_REASON);
  const deadT=liveChaseTrigger(chaseExpired(),classify(bars({vol5:.5})),{now,setupPolicy:SETUP_POLICY});
  assert.equal(deadT.state,'TRIGGERED','a DEAD verdict on real bars is evidence for the AI (2026-09-26)');
  assert.equal(deadT.chase.state,CHASE_STATE.DEAD);assert.ok(deadT.chase.reasons.includes('VOLUME_FADING'));
  assert.equal(liveChaseTrigger(chaseExpired(),classify(null),{now,setupPolicy:SETUP_POLICY}),null,'data failure stays rejected');
  assert.equal(liveChaseTrigger(chaseExpired(),live,{now:CHASE_OPEN+2*MIN,setupPolicy:SETUP_POLICY}),null,'window closed');
  assert.equal(liveChaseTrigger(chaseExpired(REF*1.06),live,{now,setupPolicy:SETUP_POLICY}),null,'beyond the 5% safety ceiling');
  assert.equal(liveChaseTrigger({...chaseExpired(),terminalReason:'V17_SETUP_EXPIRED'},live,{now,setupPolicy:SETUP_POLICY}),null);
  const dead=deadChaseState(chaseExpired(),classify(bars({buy:.4})),now);
  assert.match(dead.terminalReason,/^V17_CHASE_EXPIRED:DEAD:.*TAPE_SELLERS/);assert.equal(dead.state,'CHASE_EXPIRED');
  assert.match(deadChaseState(chaseExpired(),live,now,'CHASE_TRIGGER_WINDOW_UNAVAILABLE').terminalReason,
    /^V17_CHASE_EXPIRED:STALE:CHASE_TRIGGER_WINDOW_UNAVAILABLE$/);
});

function liveRow(mutate=s=>s){
  const t=liveChaseTrigger(chaseExpired(),classify(bars()),{now:CHASE_OPEN+MIN+4000,setupPolicy:SETUP_POLICY});
  const px=t.triggerClose;
  return {id:'sig-1',symbol:'ABCUSDT',features:{strategy:'LEADER_MOMENTUM_V17',referenceClose:REF,signal5Close:CLOSE,dayReturn:.2,rank:2,
    exitPolicy:{stopPct:.025},v17Setup:mutate(t),
    b06133:{source:{decisionAt:t.triggerAt,prebars:[{openTime:CHASE_OPEN-MIN,closeTime:CHASE_OPEN-1,close:px*.99},
      {openTime:CHASE_OPEN,closeTime:CHASE_OPEN+MIN-1,close:px}]}}}};
}
test('a LIVE chase trigger proves its own execution window; tampered provenance is refused',()=>{
  const w=entryExecutionWindow(liveRow(),true,120000,SETUP_POLICY);
  assert.equal(w.valid,true);assert.equal(w.basis,'LIVE_CHASE_TRIGGER');
  assert.equal(w.startsAt,CHASE_OPEN+MIN);assert.equal(w.expiresAt,CHASE_OPEN+2*MIN);
  assert.equal(liveChaseTimingValid(liveRow(),SETUP_POLICY),true);
  for(const [name,m] of [['data-failure chase',s=>({...s,chase:{...s.chase,state:'DEAD',reasons:['CHASE_DATA_UNAVAILABLE']}})],
    ['no CHASE_EXPIRED observation',s=>({...s,transitions:s.transitions.filter(x=>x.to!=='CHASE_EXPIRED')})],
    ['price inside the ordinary band',s=>({...s,triggerClose:REF*1.005,lastClose:REF*1.005})],
    ['moved trigger',s=>({...s,triggerAt:s.triggerAt+MIN,triggerExpiresAt:s.triggerExpiresAt+MIN})]]){
    assert.equal(entryExecutionWindow(liveRow(m),true,120000,SETUP_POLICY).valid,false,name);
  }
  const bad=liveRow();bad.features.b06133.source.prebars.at(-1).close=1;
  assert.equal(entryExecutionWindow(bad,true,120000,SETUP_POLICY).valid,false,'selector read a different bar');
});

test('GPT sees the chase: identity binds it for a LIVE trigger only, and the packet carries late-entry context',()=>{
  const id=fd1EntryIdentity(liveRow());
  assert.equal(id.chase.state,CHASE_STATE.LIVE);assert.equal(id.chase.version,LIVE_CHASE_POLICY.version);
  const plain=liveRow(s=>{const {chase,triggerMode,...rest}=s;return rest;});
  const ordinary=fd1EntryIdentity(plain);
  assert.ok(!('chase' in ordinary),'an ordinary trigger identity is unchanged');
  assert.deepEqual(Object.keys(ordinary),['signal_id','symbol','trigger_at_ms','reference_close','day_return','rank','judgments','exit_policy']);
  const ctx=chaseContext(id.chase,{values:{distance_high_4h:-.03,est_buy_slippage_bps:4},quality:{last_close:102.4}},
    {referencePrice:REF,stopPct:.025});
  assert.equal(ctx.chase_state,'LIVE');assert.ok(Math.abs(ctx.distance_from_reference_pct-.024)<1e-9);
  assert.equal(ctx.room_to_4h_high_pct,.03);assert.equal(ctx.stop_distance_pct,.025);assert.equal(ctx.expected_slippage_bps,4);
  assert.ok(ctx.breakout_price>0&&Number.isFinite(ctx.distance_from_breakout_pct)&&Number.isFinite(ctx.distance_from_peak_pct));
  assert.equal(chaseContext(null,{},{}),null);
});

test('volumeTails: a LIVE chase trigger meets the unchanged V30 front; nothing in the queue bypasses it',()=>{
  const src=readFileSync(new URL('../v10-lane-executor/index.ts',import.meta.url),'utf8');
  const queue=src.slice(src.indexOf('async function runEntryQueue('),src.indexOf('async function requireLeaderEntryControls'));
  assert.ok(!/LIVE_MOMENTUM_CHASE|triggerMode|LIVE_CHASE|chase/i.test(queue),'the queue treats every trigger alike');
  const loop=queue.slice(queue.indexOf('for(const advanced of triggered)'));
  assert.ok(loop.indexOf('applyB06133Selection(')<loop.indexOf('applyCec0040Selection(')&&
    loop.indexOf('applyCec0040Selection(')<loop.indexOf('executable.push('),'V30 front, then CEC, then GPT for every trigger');
  const tails=v30FrontDecision({version:'B06133_ENTRY_SELECTION_1',factors:{volumeTails:true,fresh5over15:true}},V30_FRONT_LIVE_VERSION);
  assert.equal(tails.admitted,false);assert.ok(tails.failed.includes('volumeTails'));
});

test('ENTRY_DRIFT stays evidence for a LIVE chase, while the trigger window stays a hard bound',()=>{
  const t=liveChaseTrigger(chaseExpired(),classify(bars()),{now:CHASE_OPEN+MIN+4000,setupPolicy:SETUP_POLICY});
  assert.equal(entryTriggerFresh(t,CHASE_OPEN+MIN+9000,t.triggerClose,POLICY.maxEntryDriftPct,SETUP_POLICY),'V17_ENTRY_DRIFT',
    'the >1% distance is reported (the executor passes it to GPT/FINAL RECHECK as evidence)');
  assert.equal(entryTriggerFresh(t,CHASE_OPEN+2*MIN+1,t.triggerClose,POLICY.maxEntryDriftPct,SETUP_POLICY),'V17_TRIGGER_STALE');
  const src=readFileSync(new URL('../v10-lane-executor/index.ts',import.meta.url),'utf8');
  assert.match(src,/return \["V17_ENTRY_DRIFT","ENTRY_DRIFT"\]\.includes\(String\(reason\|\|""\)\)\?null:reason;/);
});
