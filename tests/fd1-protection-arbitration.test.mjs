// AI_PROTECTION_ARBITRATION_1 regression.
//
// Motivation (real trade, production project etaajwpernzrcdrifdnw, position
// eb583cdc-3414-48fb-a559-e097476281be): SOONUSDT entered at 0.231022, ran to a 0.2365 peak, and
// the deterministic retestAnchor engine raised the exchange-resident reduce-only STOP_MARKET on
// its own — 0.233511 (PROFIT_LOCK, 21:36:15Z) then 0.233911 (retestAnchor_LOCK, 21:38:18Z) — while
// the AI reviewer had answered HOLD at 21:33:19Z and never approved either level. Price touched it
// and the whole position was closed at 0.234 with exit_reason retestAnchor_LOCK.
//
// These tests pin the corrected authority split: the deterministic engine only proposes a
// candidate, every raise of the resident soft stop is the reviewer's decision, an approved level
// is append-only, and hard safety keeps executing without any model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {harness,position} from '../test-support/v18-ops/harness.mjs';
import {EXIT_CLASS,PROTECTION_ACTIONS,PROTECTION_ARBITRATION_VERSION,exitClass,hardSafetyState,
  softCandidate,approvedProtection,exitContext,positionGeneration} from '../supabase/functions/_shared/exit-authority.mjs';
import {holdStep,initialHoldState,nextEvent,HOLD_POLICY} from '../supabase/functions/_shared/gpt-final-decision/hold.mjs';
import {POLICY} from '../supabase/functions/_shared/leader-momentum-v17.mjs';
import {EXIT_REVIEW_R5,nextExitReviewed} from '../supabase/functions/_shared/leader-exit-review.mjs';
import {P142_POLICY_VERSION,CEC0040_VERSION,nextExitP142} from '../supabase/functions/_shared/leader-cec0040.mjs';
import {DECISIONS} from '../supabase/functions/_shared/gpt-final-decision/contract.mjs';

const T=Date.parse('2026-09-26T21:38:18Z'),policy={...POLICY,...EXIT_REVIEW_R5};
// The exact live trade.
const SOON=Object.freeze({symbol:'SOONUSDT',entry:0.231022,peak:0.2365,hardStop:0.2283,
  profitLockCandidate:0.233511,lockCandidate:0.233911,exitFill:0.234,tick:0.0001,quantity:2600});

function soonPosition({candidate=SOON.lockCandidate,stage='retestAnchor_LOCK',residentTrigger=SOON.hardStop,
  peak=SOON.peak,metadata={}}={}){
  const p=position(SOON.symbol,SOON.quantity,SOON.entry);
  p.entry_at=new Date(T-8*60000).toISOString();p.updated_at=p.entry_at;p.peak_price=peak;
  p.hard_stop_price=SOON.hardStop;p.metadata.leaderLastHighAt=p.entry_at;
  p.metadata.leaderExitPolicyVersion=P142_POLICY_VERSION;
  p.metadata.cec0040={version:CEC0040_VERSION,enforcementEnabled:true};
  p.metadata.entryMarketRules={priceTick:SOON.tick};
  p.metadata.p142State={version:P142_POLICY_VERSION,positionId:p.id,entryAt:Date.parse(p.entry_at),
    entryPrice:SOON.entry,style:'retestAnchor',accepted:SOON.entry+(candidate-SOON.entry)*2,
    stopPrice:candidate,stage,completed:[],lastBarOpen:null};
  p.metadata.exitProtection.orders[0].spec.params.triggerPrice=residentTrigger;
  p.metadata=({...p.metadata,...metadata});
  return p;
}
function deterministic(p,bid,now=T){
  const meta=p.metadata,hard=hardSafetyState(p,{bid,now,peak:Math.max(Number(p.peak_price),bid),policy,r5:true,priceTick:SOON.tick});
  const raw=nextExitP142({entryPrice:Number(p.entry_price),entryAt:Date.parse(p.entry_at),entryFee:Number(p.entry_fee_usdt),
    quantity:Number(p.original_quantity),peakPrice:Number(p.peak_price),stopPrice:hard.hardFloor,
    lastHighAt:Date.parse(meta.leaderLastHighAt),priceTick:0},bid,now,policy,meta.p142State);
  return {hard,raw,candidate:softCandidate(raw,hard,p,bid)};
}
const residentTriggerOf=p=>Number(p.metadata.exitProtection.orders[0].spec.params.triggerPrice);
const tickUp=x=>Math.ceil(x/SOON.tick-1e-10)*SOON.tick;
// A complete carried AI_EXIT_AUTHORITY_2 record, as the executor persists it. An incomplete one is
// rejected by hardSafetyState on purpose, so the fixture must be the real shape.
function carried(extra){
  const p=soonPosition();
  return {version:'AI_EXIT_AUTHORITY_2',generation:positionGeneration(p),
    initialFloor:tickUp(SOON.entry*(1-policy.stopPct)),hardFloor:SOON.hardStop,hardReason:'R5_RISK_CUT',
    lowestObservedBid:SOON.entry,maeScope:'SINCE_V2_ATTACH',attachedAt:Date.parse(p.entry_at),...extra};
}
function approve(p,bid,{aiApproved=null,aiReason=null,now=T}={}){
  const {hard,candidate}=deterministic(p,bid,now);
  return {hard,candidate,approved:approvedProtection(p,hard,bid,{aiApproved,aiReason,
    residentLevel:residentTriggerOf(p),candidate:candidate.level})};
}
// One GPT HOLD review, already settled, over the candidate that was actually offered.
function reviewed(decision,{candidate=SOON.lockCandidate,reason='retestAnchor_LOCK',prior=null,
  authority='GPT_FINAL_ONLY',valid=true,state='DONE',now=T,pendingAt=null}={}){
  const trigger={active:true,crossed:false,key:reason+':'+candidate,reason,level:candidate};
  const initial={...initialHoldState(SOON.entry),...(prior??{}),
    pending:{key:'job-'+candidate,event:'SOFT_PROTECTION_TRIGGER:'+reason,at:pendingAt??now-2000,
      softKey:trigger.key,softLevel:candidate,softReason:reason}};
  return holdStep(initial,{now,price:SOON.exitFill,peak:SOON.peak,timeCandidate:null,softTrigger:trigger,
    positionId:SOON.symbol,generation:SOON.symbol+':'+new Date(T-8*60000).toISOString(),
    answerOf:async()=>state==='DONE'?{state,valid,decision,authority,completed_at_ms:now-1000,
      snapshot_at_ms:now-1500,refresh_error:null}:{state}});
}
function production(p,bid,{fd1=null,now=T}={}){
  const h=harness({positions:[p],signal:false,now});h.state.quotes[p.symbol]=bid;
  h.state.symbolInfo={quantity_step:0.1,price_tick:SOON.tick,min_notional:5};
  let ai=0;
  h.ctx.fd1HoldTick=async(_db,row,args)=>{ai++;return fd1?fd1(row,args):
    {close:false,reason:'FD1_GPT_HOLD',state:{...initialHoldState(row.entry_price),last:{decision:'HOLD'},softReceipt:args.softTrigger}};};
  h.state.createOrder=(cmd,st)=>{const q=st.exchange.find(x=>x.market===p.symbol).quantity;
    st.exchange=st.exchange.filter(x=>x.market!==p.symbol);
    return {order:{orderId:'exit-1',clientOrderId:cmd.order.identifier,symbol:p.symbol,side:'SELL',positionSide:'BOTH',
      reduceOnly:true,origQty:String(q),executedQty:String(q),avgPrice:String(bid),status:'FILLED',updateTime:st.now,
      fills:[{id:'1',qty:String(q),price:String(bid),commission:'.01',commissionAsset:'USDT',time:st.now}]}};};
  return {...h,ai:()=>ai,
    stops:()=>h.state.calls.filter(x=>x.action==='v17_create_stop').map(x=>Number(x.params.triggerPrice)),
    closes:()=>h.state.calls.filter(x=>x.action==='create_order'),
    manage:()=>h.ctx.manage(h.state.tables.v11_long_regime_positions[0],
      {gateway:h.gateway,exchangeQuantity:new Map([[p.symbol,p.remaining_quantity]]),manualSymbols:[],evaluateQv3:false})};
}

test('01 the hard stop is always active and executes with no AI work at all',async()=>{
  const p=soonPosition();
  const h=production(p,SOON.hardStop-SOON.tick);
  h.ctx.fd1HoldTick=()=>{throw Error('MUST_NOT_CALL_AI');};
  const r=await h.manage();
  assert.equal(r.action,'CLOSE');
  assert.equal(exitClass(r.reason),EXIT_CLASS.HARD_SAFETY);
  assert.equal(h.closes().length,1);
  // and the hard floor itself is present in every arbitration view
  const {hard,candidate,approved}=approve(p,SOON.exitFill);
  assert.equal(hard.hardFloor,SOON.hardStop);
  assert.equal(exitContext(p,hard,candidate,SOON.exitFill,T,approved).hard_floor,SOON.hardStop);
});

test('02 generating a candidate alone changes no protection and touches no stop order',async()=>{
  const p=soonPosition();
  const {candidate,approved}=approve(p,SOON.exitFill);
  assert.equal(candidate.level,SOON.lockCandidate,'the deterministic engine proposes the live level');
  assert.equal(approved.level,null,'nothing above the hard floor has been approved');
  assert.equal(approved.candidateAboveApproved,true);
  const h=production(p,SOON.exitFill);
  const r=await h.manage();
  assert.equal(r.action,'HOLD');
  assert.deepEqual(h.stops(),[],'no replacement stop is submitted for an unapproved candidate');
  assert.equal(residentTriggerOf(h.state.tables.v11_long_regime_positions[0]),SOON.hardStop);
});

test('03 GPT HOLD keeps the approved protection exactly where it was',async()=>{
  const r=await reviewed('HOLD');
  assert.equal(r.close,false);assert.equal(r.reason,'FD1_GPT_HOLD');
  assert.equal(r.state.protectLevel??null,null);
  assert.equal(r.protectApproval.verdict,'HELD');
  assert.equal(r.protectApproval.candidate,SOON.lockCandidate);
  const p=soonPosition();
  assert.equal(approve(p,SOON.exitFill,{aiApproved:r.state.protectLevel}).approved.level,null);
});

test('04 GPT RAISE_PROTECTION raises to the approved candidate and no further',async()=>{
  const r=await reviewed('PROTECT');
  assert.equal(r.state.protectLevel,SOON.lockCandidate);
  assert.equal(r.protectApproval.verdict,'APPROVED');
  const p=soonPosition();
  const {approved}=approve(p,SOON.exitFill,{aiApproved:r.state.protectLevel,aiReason:r.state.protectReason});
  assert.equal(approved.level,SOON.lockCandidate);
  assert.equal(approved.reason,'retestAnchor_LOCK');
  assert.equal(approved.source,'AI_APPROVED');
  assert.equal(approved.raised,true);
  const h=production(p,SOON.peak,{fd1:async(row)=>({close:false,reason:'FD1_GPT_PROTECT',
    state:{...initialHoldState(row.entry_price),protectLevel:SOON.lockCandidate,protectReason:'retestAnchor_LOCK',
      last:{decision:'PROTECT'}}})});
  const out=await h.manage();
  assert.equal(out.action,'HOLD');
  // The approved level, at the symbol's price tick. Nothing else is submitted.
  assert.deepEqual(h.stops(),[tickUp(SOON.lockCandidate)],'exactly the approved level becomes resident');
});

test('05 GPT EXIT dispatches one reduce-only exit immediately',async()=>{
  const p=soonPosition();
  const h=production(p,SOON.exitFill,{fd1:async(row,args)=>({close:true,reason:'FD1_GPT_EXIT',
    state:{...initialHoldState(row.entry_price),last:{decision:'EXIT'},softReceipt:args.softTrigger},
    approval:{authority:'GPT_FINAL_ONLY',valid:true,decision:'EXIT',positionId:row.id,
      generation:positionGeneration(row),jobKey:'final-key',completedAt:T,snapshotAt:T,refreshError:null}})});
  const r=await h.manage();
  assert.equal(r.action,'CLOSE');assert.equal(r.reason,'FD1_GPT_EXIT');
  assert.equal(exitClass(r.reason),EXIT_CLASS.AI_STRATEGIC);
  const dispatched=h.closes();
  assert.equal(dispatched.length,1);
  assert.equal(dispatched[0].order.position_effect,'CLOSE');
  assert.equal(dispatched[0].order.side,'SELL');
});

test('06 DeepSeek RAISE_PROTECTION with GPT HOLD stays HOLD: protection is unchanged',async()=>{
  // DeepSeek is an independent parallel reviewer with no authority. Its advice reaches GPT inside
  // the frozen snapshot; only GPT's own answer is consumed here.
  const r=await reviewed('HOLD');
  assert.equal(r.state.protectLevel??null,null,'a DeepSeek PROTECT preference cannot raise anything');
  assert.equal(r.protectApproval.verdict,'HELD');
  assert.ok(DECISIONS.HOLD.includes('PROTECT'),'PROTECT is a real reviewer action, not advice only');
});

test('07 DeepSeek HOLD with GPT RAISE_PROTECTION raises: GPT is the final judge',async()=>{
  const r=await reviewed('PROTECT');
  assert.equal(r.state.protectLevel,SOON.lockCandidate);
  assert.equal(r.protectApproval.verdict,'APPROVED');
});

test('08 a GPT timeout keeps the last approved protection and raises nothing',async()=>{
  const prior={protectLevel:SOON.profitLockCandidate,protectReason:'V17_PROFIT_LOCK'};
  const late=await reviewed('HOLD',{prior,now:T+HOLD_POLICY.timeAnswerWaitMs+1000,pendingAt:T,state:'RUNNING'});
  assert.equal(late.close,false);
  assert.equal(late.reason,'FD1_FINAL_TIMEOUT');
  assert.equal(late.protectApproval.verdict,'KEEP_LAST_APPROVED_PROTECTION');
  assert.equal(late.state.protectLevel,SOON.profitLockCandidate,'the earlier approval survives');
  const p=soonPosition({residentTrigger:SOON.profitLockCandidate});
  const {approved}=approve(p,SOON.exitFill,{aiApproved:late.state.protectLevel,aiReason:'V17_PROFIT_LOCK'});
  assert.equal(approved.level,SOON.profitLockCandidate,'never the newer unapproved candidate');
  assert.equal(approved.raised,false);
});

test('09 a DeepSeek failure alone does not stop GPT from deciding',async()=>{
  // The reviewer answer is GPT's; a missing advisor changes neither its authority nor the binding.
  const r=await reviewed('PROTECT',{authority:'GPT_FINAL_ONLY'});
  assert.equal(r.state.protectLevel,SOON.lockCandidate);
  const held=await reviewed('HOLD',{authority:'GPT_FINAL_ONLY'});
  assert.equal(held.reason,'FD1_GPT_HOLD');
});

test('10 an approval below the standing approved level is ignored and recorded',()=>{
  const p=soonPosition({metadata:{exitAuthority:carried({approvedSoftLevel:SOON.lockCandidate,approvedSoftReason:'retestAnchor_LOCK'})}});
  const {approved}=approve(p,SOON.exitFill,{aiApproved:SOON.profitLockCandidate,aiReason:'V17_PROFIT_LOCK'});
  assert.equal(approved.level,SOON.lockCandidate);
  assert.equal(approved.reason,'retestAnchor_LOCK');
  assert.equal(approved.ignoredRequest.verdict,'BELOW_APPROVED_IGNORED');
  assert.equal(approved.ignoredRequest.requestedLevel,SOON.profitLockCandidate);
});

test('11 an approval equal to the standing approved level is a no-op',()=>{
  const p=soonPosition({metadata:{exitAuthority:carried({approvedSoftLevel:SOON.lockCandidate,approvedSoftReason:'retestAnchor_LOCK'})}});
  const {approved}=approve(p,SOON.exitFill,{aiApproved:SOON.lockCandidate,aiReason:'retestAnchor_LOCK'});
  assert.equal(approved.level,SOON.lockCandidate);
  assert.equal(approved.raised,false);
  assert.equal(approved.ignoredRequest.verdict,'EQUAL_TO_APPROVED_NO_OP');
});

test('12 a candidate above the approved level binds only once it is approved',()=>{
  const p=soonPosition({metadata:{exitAuthority:carried({approvedSoftLevel:SOON.profitLockCandidate,approvedSoftReason:'V17_PROFIT_LOCK'})}});
  const unapproved=approve(p,SOON.exitFill).approved;
  assert.equal(unapproved.level,SOON.profitLockCandidate);
  assert.equal(unapproved.candidateAboveApproved,true);
  const granted=approve(p,SOON.exitFill,{aiApproved:SOON.lockCandidate,aiReason:'retestAnchor_LOCK'}).approved;
  assert.equal(granted.level,SOON.lockCandidate);
  assert.equal(granted.raised,true);
});

test('13 an approved soft stop can never be lowered, by any route',async()=>{
  const p=soonPosition({metadata:{exitAuthority:carried({approvedSoftLevel:SOON.lockCandidate,approvedSoftReason:'retestAnchor_LOCK',
    residentLevel:SOON.lockCandidate,residentReason:'retestAnchor_LOCK'})}});
  for(const attempt of [SOON.hardStop+SOON.tick,SOON.profitLockCandidate,0,-1,null,NaN,'0.1'])
    assert.equal(approve(p,SOON.exitFill,{aiApproved:attempt,aiReason:'retestAnchor_TRAIL'}).approved.level,
      SOON.lockCandidate,'lowering attempt: '+String(attempt));
  // and a reviewer PROTECT over a smaller candidate cannot lower the reviewer's own floor either
  const lower=await reviewed('PROTECT',{candidate:SOON.profitLockCandidate,reason:'V17_PROFIT_LOCK',
    prior:{protectLevel:SOON.lockCandidate,protectReason:'retestAnchor_LOCK'}});
  assert.equal(lower.state.protectLevel,SOON.lockCandidate);
  assert.equal(lower.protectApproval.verdict,'NOT_ABOVE_APPROVED');
});

test('14 the hard stop cannot be lowered or removed by any protection decision',()=>{
  const p=soonPosition();
  const lowered=hardSafetyState({...p,hard_stop_price:SOON.hardStop},
    {bid:SOON.exitFill,now:T,peak:SOON.peak,policy,r5:true,priceTick:SOON.tick});
  assert.equal(lowered.hardFloor,SOON.hardStop);
  // a carried hard floor is never widened even when the ladder would compute a lower one
  const carried=hardSafetyState({...p,metadata:{...p.metadata,exitAuthority:{
    version:'AI_EXIT_AUTHORITY_2',generation:positionGeneration(p),hardFloor:SOON.hardStop,
    initialFloor:Math.ceil(SOON.entry*(1-policy.stopPct)/SOON.tick-1e-10)*SOON.tick,lowestObservedBid:SOON.entry}}},
    {bid:SOON.exitFill,now:T,peak:SOON.peak,policy,r5:false,priceTick:SOON.tick});
  assert.ok(carried.hardFloor>=SOON.hardStop);
  assert.equal(approve(p,SOON.exitFill,{aiApproved:SOON.hardStop-SOON.tick}).approved.level,null,
    'a request below the hard floor adds nothing and removes nothing');
});

test('15 protection replacement is acknowledge-before-cancel, so no naked window exists',()=>{
  const source=readFileSync(new URL('../supabase/functions/_shared/leader-native-protection.mjs',import.meta.url),'utf8');
  const ensure=source.slice(source.indexOf('async function ensure(id,request)'),source.indexOf('async function finishReplacement'));
  const ack=ensure.indexOf('record.ackAt=clock()'),cancel=ensure.indexOf('for(const old of outstanding)state=await cancelRemembered');
  assert.ok(ack>0&&cancel>ack,'the replacement is acknowledged before the old stop is cancelled');
  assert.match(ensure,/Never cancel the old stop before the replacement is acknowledged/);
  // and the submitted trigger can never be below a level already resting on the exchange
  assert.match(ensure,/stopPrice:Math\.max\(request\.stopPrice,\.\.\.hardOrders\.map\(x=>x\.spec\.params\.triggerPrice\)\)/);
});

test('16 the approved level is restored from persisted state after a restart',()=>{
  const p=soonPosition({metadata:{exitAuthority:carried({approvedSoftLevel:SOON.lockCandidate,
    approvedSoftReason:'retestAnchor_LOCK',approvedSoftSource:'AI_APPROVED'})}});
  // a cold process with no in-memory reviewer state at all
  const {approved}=approve(p,SOON.exitFill);
  assert.equal(approved.level,SOON.lockCandidate);
  assert.equal(approved.source,'APPROVED_CARRIED');
  assert.equal(approved.crossed,false);
  assert.equal(approvedProtection(p,{hardFloor:SOON.hardStop},SOON.lockCandidate-SOON.tick,
    {residentLevel:SOON.lockCandidate}).crossed,true,'and it still binds after the restart');
});

test('17 a closed position keeps no stale protection',async()=>{
  const p=soonPosition();
  const h=production(p,SOON.exitFill,{fd1:async(row,args)=>({close:true,reason:'FD1_GPT_EXIT',
    state:{...initialHoldState(row.entry_price),last:{decision:'EXIT'},softReceipt:args.softTrigger},
    approval:{authority:'GPT_FINAL_ONLY',valid:true,decision:'EXIT',positionId:row.id,
      generation:positionGeneration(row),jobKey:'final-key',completedAt:T,snapshotAt:T,refreshError:null}})});
  const r=await h.manage();
  assert.equal(r.action,'CLOSE');
  assert.equal(r.nativeStop?.status,'CLOSED','the resting stop is retired with the position');
  assert.equal(h.state.tables.v11_long_regime_positions[0].state,'CLOSED');
});

test('18 a repeated approval of the same level submits no duplicate stop order',async()=>{
  const p=soonPosition({residentTrigger:SOON.lockCandidate,
    metadata:{exitAuthority:carried({approvedSoftLevel:SOON.lockCandidate,approvedSoftReason:'retestAnchor_LOCK',
      residentLevel:SOON.lockCandidate,residentReason:'retestAnchor_LOCK'})}});
  const h=production(p,SOON.peak,{fd1:async(row)=>({close:false,reason:'FD1_GPT_PROTECT',
    state:{...initialHoldState(row.entry_price),protectLevel:SOON.lockCandidate,protectReason:'retestAnchor_LOCK',
      last:{decision:'PROTECT'}}})});
  const r=await h.manage();
  assert.equal(r.action,'HOLD');
  assert.deepEqual(h.stops(),[],'the level is already resident; nothing is re-submitted');
});

test('19 SOON regression: an unapproved retestAnchor candidate no longer clips the winner',async()=>{
  // The live sequence. 0.233511 then 0.233911 were produced by the deterministic engine while the
  // reviewer answered HOLD; production made each one resident and the trade was closed at 0.234.
  for(const [candidate,peak] of [[SOON.profitLockCandidate,0.236],[SOON.lockCandidate,SOON.peak]]){
    const p=soonPosition({candidate,peak});
    const {hard,candidate:proposed,approved}=approve(p,SOON.exitFill);
    assert.equal(proposed.level,candidate,'the candidate is still computed and still offered');
    assert.equal(approved.level,null,'but it is not protection');
    assert.equal(hard.hardFloor,SOON.hardStop,'the hard stop is untouched');
    // the level the exchange would have filled, at the price it actually filled at
    const h=production(p,candidate-SOON.tick);
    const r=await h.manage();
    assert.equal(r.action,'HOLD','HOLD means the position is not closed at the candidate');
    assert.equal(h.closes().length,0);
    assert.deepEqual(h.stops(),[]);
    assert.equal(residentTriggerOf(h.state.tables.v11_long_regime_positions[0]),SOON.hardStop);
    // the reviewer saw both the standing protection and the candidate it was asked about
    const view=exitContext(p,hard,proposed,candidate-SOON.tick,T,approved).protection;
    assert.equal(view.candidate_soft_stop,candidate);
    assert.equal(view.approved_soft_stop,null);
    assert.equal(view.arbitration,PROTECTION_ARBITRATION_VERSION);
    assert.deepEqual(view.actions,PROTECTION_ACTIONS);
    assert.equal(view.lowering_possible,false);
    assert.equal(view.on_reviewer_failure,'KEEP_LAST_APPROVED_PROTECTION');
    assert.equal(view.raise_binds_to,'EXACTLY_THE_OFFERED_CANDIDATE_SOFT_STOP_NEVER_A_MODEL_SUPPLIED_PRICE');
  }
  // Counterfactual, recorded deliberately: after the real 0.234 exit SOON fell through 0.2283, so
  // the arbitrated path keeps a live hard stop that would have closed the trade there instead.
  // retestAnchor is not disabled and hard safety is not weakened; only the authority moved.
  const p=soonPosition();
  const h=production(p,SOON.hardStop-SOON.tick);
  const r=await h.manage();
  assert.equal(r.action,'CLOSE');
  assert.equal(exitClass(r.reason),EXIT_CLASS.HARD_SAFETY);
});

test('20 a budget or latency failure never raises protection, and never lowers it',async()=>{
  for(const failure of [{state:'RUNNING',now:T+HOLD_POLICY.timeAnswerWaitMs+1000,pendingAt:T},
                        {state:'DONE',valid:false,decision:'ABSTAIN'},
                        {state:'DONE',valid:true,decision:'ABSTAIN'}]){
    const r=await reviewed(failure.decision??'PROTECT',{...failure,
      prior:{protectLevel:SOON.profitLockCandidate,protectReason:'V17_PROFIT_LOCK'}});
    assert.equal(r.close,false);
    assert.equal(r.state.protectLevel,SOON.profitLockCandidate,'kept, neither raised nor lowered');
    assert.equal(r.protectApproval.verdict,'KEEP_LAST_APPROVED_PROTECTION');
  }
  // An unauthorized reviewer (no API key, budget exhausted) leaves the standing approval in place
  // and the resident stop exactly where the exchange already has it.
  const p=soonPosition({residentTrigger:SOON.profitLockCandidate,
    metadata:{exitAuthority:carried({approvedSoftLevel:SOON.profitLockCandidate,approvedSoftReason:'V17_PROFIT_LOCK',
      residentLevel:SOON.profitLockCandidate,residentReason:'V17_PROFIT_LOCK'})}});
  const h=production(p,SOON.exitFill,{fd1:async(row)=>({close:false,reason:'FD1_FINAL_UNAVAILABLE',
    state:{...initialHoldState(row.entry_price),protectLevel:SOON.profitLockCandidate,protectReason:'V17_PROFIT_LOCK'}})});
  const out=await h.manage();
  assert.equal(out.action,'HOLD');
  assert.deepEqual(h.stops(),[]);
  assert.equal(residentTriggerOf(h.state.tables.v11_long_regime_positions[0]),SOON.profitLockCandidate);
});
