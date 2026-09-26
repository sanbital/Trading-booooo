import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {harness,position} from '../test-support/v18-ops/harness.mjs';
import {EXIT_CLASS,EXIT_REASONS,exitClass,hardSafetyState,softCandidate,assertExitAuthority,positionGeneration,EXIT_AUTHORITY_VERSION} from '../supabase/functions/_shared/exit-authority.mjs';
import {HOLD_POLICY,holdStep,initialHoldState,nextEvent} from '../supabase/functions/_shared/gpt-final-decision/hold.mjs';
import {POLICY} from '../supabase/functions/_shared/leader-momentum-v17.mjs';
import {EXIT_REVIEW_R5,nextExitReviewed} from '../supabase/functions/_shared/leader-exit-review.mjs';
import {P142_POLICY_VERSION,CEC0040_VERSION} from '../supabase/functions/_shared/leader-cec0040.mjs';
const T=Date.parse('2026-09-26T10:15:00Z'),policy={...POLICY,...EXIT_REVIEW_R5};
const soft={active:true,crossed:true,key:'retestAnchor_LOCK:102',reason:'retestAnchor_LOCK',level:102};
const mk=()=>{const p=position('TESTUSDT',10,100);p.entry_at=new Date(T-1200000).toISOString();p.updated_at=p.entry_at;p.metadata.leaderLastHighAt=p.entry_at;return p;};
const makeApproval=(p,now=T)=>({authority:'GPT_FINAL_ONLY',valid:true,decision:'EXIT',positionId:p.id,generation:positionGeneration(p),jobKey:'final-key',completedAt:now,snapshotAt:now,refreshError:null});
function production(p=mk(),bid=101,decision='HOLD',now=T){
 const h=harness({positions:[p],signal:false,now});h.state.quotes[p.symbol]=bid;let ai=0;
 h.ctx.fd1HoldTick=async(_db,row,args)=>{ai++;return {close:decision==='EXIT',reason:'FD1_GPT_'+decision,
  approval:decision==='EXIT'?makeApproval(row,h.state.now):undefined,state:{...initialHoldState(row.entry_price),last:{decision},softReceipt:args.softTrigger}};};
 h.state.createOrder=(cmd,state)=>{const q=state.exchange.find(x=>x.market===p.symbol).quantity;state.exchange=state.exchange.filter(x=>x.market!==p.symbol);
  return {order:{orderId:'exit-1',clientOrderId:cmd.order.identifier,symbol:p.symbol,side:'SELL',positionSide:'BOTH',reduceOnly:true,origQty:String(q),executedQty:String(q),avgPrice:String(bid),status:'FILLED',updateTime:state.now,
   fills:[{id:'1',qty:String(q),price:String(bid),commission:'.01',commissionAsset:'USDT',time:state.now}]}};};
 return {...h,ai:()=>ai,manage:()=>h.ctx.manage(h.state.tables.v11_long_regime_positions[0],{gateway:h.gateway,exchangeQuantity:new Map([[p.symbol,p.remaining_quantity]]),manualSymbols:[],evaluateQv3:false})};
}
test('T01/T26 INV-EXIT-01 hard stop closes before any AI work even when providers fail',async()=>{
 const h=production(mk(),96);h.ctx.fd1HoldTick=()=>{throw Error('MUST_NOT_CALL_AI')};
 const r=await h.manage();assert.equal(r.action,'CLOSE');assert.equal(r.reason,'R5_RISK_CUT');
 assert.equal(h.state.calls.filter(x=>x.action==='create_order').length,1);
});
test('T02 liquidation safety can close immediately without strategy approval',async()=>{
 const h=production();const r=await h.ctx.close(h.state.tables.v11_long_regime_positions[0],1,'LIQUIDATION_SAFETY');
 assert.equal(r.closed,true);assert.equal(h.ai(),0);
});
test('T03 corruption cannot dispatch guessed quantity; ownership/reconciliation protection remains',async()=>{
 const h=production();h.state.exchange[0].quantity=999;
 await assert.rejects(()=>h.ctx.close(mk(),1,'RECONCILIATION_CORRUPTION'),/RECONCILIATION|OWNERSHIP/);
 assert.equal(h.state.calls.filter(x=>x.action==='create_order').length,0);assert.equal(h.state.tables.v11_long_regime_positions[0].state,'OPEN');
});
for(const [id,stage] of [['T04','retestAnchor_LOCK'],['T05','retestAnchor_TRAIL'],['T06','V17_PROFIT_LOCK']])
test(id+' INV-EXIT-02 soft protection alone cannot close or install a profit stop',async()=>{
 const p=mk();p.peak_price=104;p.hard_stop_price=102;p.metadata.leaderExitPolicyVersion=P142_POLICY_VERSION;
 p.metadata.cec0040={version:CEC0040_VERSION,enforcementEnabled:true};p.metadata.p142State={stage,stopPrice:102};
 p.metadata.exitProtection.orders[0].spec.params.triggerPrice=102;
 const h=production(p,101,'HOLD'),r=await h.manage();
 assert.equal(r.action,'HOLD');assert.equal(h.ai(),1);
 assert.equal(h.state.calls.filter(x=>x.action==='create_order').length,0);
 const orders=h.state.tables.v11_long_regime_positions[0].metadata.exitProtection.orders.filter(x=>!x.terminal);
 assert.equal(orders.length,1);assert.equal(orders[0].exitClass,EXIT_CLASS.HARD_SAFETY);
 assert.ok(orders[0].spec.params.triggerPrice<=100);
 const created=h.state.calls.findIndex(x=>x.action==='v17_create_stop'),cancelled=h.state.calls.findIndex(x=>x.action==='v17_cancel_stop');
 assert.ok(created>=0&&cancelled>created,'new hard stop must be acknowledged before retiring legacy soft');
});
async function settled(decision,{valid=true,refresh_error=null}={}){
 const p=mk(),initial={...initialHoldState(100),pending:{key:'job',event:'SOFT_PROTECTION_TRIGGER:retestAnchor_LOCK',at:T-2000,softKey:soft.key}};
 return holdStep(initial,{now:T,price:101,peak:104,softTrigger:soft,positionId:p.id,generation:positionGeneration(p),
  answerOf:async()=>({state:'DONE',valid,decision,completed_at_ms:T-1000,snapshot_at_ms:T-1500,refresh_error})});
}
test('T07 INV-EXIT-04 FINAL HOLD consumes a soft crossing; unchanged evidence does not reopen it',async()=>{
 const r=await settled('HOLD');assert.equal(r.close,false);assert.equal(r.reason,'FD1_GPT_HOLD');
 const n=nextEvent({...r.state,lastReviewAt:T,lastReviewPrice:101},{now:T+21000,price:101,peak:104,softTrigger:soft});
 assert.equal(n.event,null);
 const changed=nextEvent({...r.state,lastReviewAt:T},{now:T+21000,price:100,peak:104,softTrigger:soft});
 assert.ok(changed.event.startsWith('SOFT_PROTECTION_TRIGGER:'));
});
test('T08 INV-EXIT-08/09 PROTECT raises internal soft protection, doubles sensitivity, no exposure or hard-floor change',async()=>{
 const r=await settled('PROTECT');assert.equal(r.close,false);assert.ok(r.state.protectLevel>=102);
 assert.equal(r.state.protection.sensitivityMultiplier,2);assert.equal(r.state.protection.exposureIncrease,false);
 assert.equal(r.state.protectUntil,T+30000);
 assert.equal(nextEvent(r.state,{now:T+30001,price:101,peak:104,softTrigger:soft}).event,'PROTECTION_REASSESSMENT');
});
test('T09/T10 INV-EXIT-03/10 fresh FINAL EXIT dispatches one close; closed lifecycle rejects duplicate intent',async()=>{
 const p=mk();p.peak_price=104;const h=production(p,101,'EXIT'),r=await h.manage();assert.equal(r.action,'CLOSE');
 await h.ctx.close(p,1,'FD1_GPT_EXIT',{finalApproval:makeApproval(p)});
 assert.equal(h.state.calls.filter(x=>x.action==='create_order').length,1);
 const started=await holdStep(initialHoldState(100),{now:T,price:101,peak:104,softTrigger:soft,positionId:p.id,generation:positionGeneration(p),answerOf:async()=>null});
 const again=await holdStep(started.state,{now:T+1000,price:101,peak:104,softTrigger:soft,positionId:p.id,generation:positionGeneration(p),answerOf:async()=>({state:'RUNNING'})});
 assert.equal(again.start,undefined);assert.equal(again.state.reviews,1);
});
test('T14 hard loss floor wins while arbitration is pending',async()=>{
 const p=mk();p.metadata.fd1Hold={...initialHoldState(100),pending:{key:'running',event:'SOFT_PROTECTION_TRIGGER:TRAILING',at:T-1000}};
 const h=production(p,97);h.ctx.fd1HoldTick=()=>new Promise(()=>{});
 assert.equal((await h.manage()).action,'CLOSE');
});
test('T25 provider failure on soft trigger keeps protection and bounds retry',async()=>{
 const r=await settled('EXIT',{valid:false});assert.equal(r.close,false);assert.equal(r.state.retryAfter,T+60000);
 const refresh=await settled('EXIT',{refresh_error:'LATEST_SNAPSHOT_UNAVAILABLE'});assert.equal(refresh.close,false);
});
test('INV-EXIT-05/06/07 DeepSeek/FIRST/stale/wrong-generation results never authorize an order',()=>{
 const p=mk(),a=makeApproval(p);
 for(const bad of [null,{...a,authority:'DEEPSEEK'},{...a,authority:'GPT_FIRST'},{...a,completedAt:T-25001},{...a,snapshotAt:T+1},{...a,generation:'old'},{...a,decision:'HOLD'}])
  assert.throws(()=>assertExitAuthority('FD1_GPT_EXIT',p,bad,T),/FRESH_GPT_FINAL/);
 for(const reason of Object.keys(EXIT_REASONS).filter(k=>exitClass(k)===EXIT_CLASS.SOFT_PROTECTION))
  assert.throws(()=>assertExitAuthority(reason,p,a,T),/SOFT_DIRECT_CLOSE/);
});
test('hard floor is monotonic over every carried stage and provider opinion',()=>{
 let p=mk(),last=0;
 for(const bid of [100,101.5,99,105,104,99]){
  const h=hardSafetyState(p,{bid,now:T,peak:Math.max(p.peak_price,bid),policy,r5:true});
  assert.ok(h.hardFloor>=last);assert.ok(h.hardFloor>=100*.975);last=h.hardFloor;
  const raw=nextExitReviewed({entryPrice:100,entryAt:Date.parse(p.entry_at),entryFee:.06,quantity:10,peakPrice:h.peak,stopPrice:h.hardFloor,lastHighAt:Date.parse(p.entry_at)},bid,T,policy);
  const c=softCandidate(raw,h,p,bid);p={...p,peak_price:h.peak,hard_stop_price:h.hardFloor,metadata:{...p.metadata,exitAuthority:{...h,softLevel:c.level,softReason:c.reason}}};
 }
});


const historical=JSON.parse(readFileSync(new URL('../test-support/exit-authority-v2/historical.json',import.meta.url),'utf8'));
function historicalPosition(row){
 const p=position(row.symbol,10,Number(row.entry_price));p.entry_at=row.entry_at;p.updated_at=new Date(Date.parse(row.closed_at)-1000).toISOString();
 p.peak_price=Number(row.peak_price);p.hard_stop_price=Number(row.hard_stop_price);p.metadata.leaderLastHighAt=p.entry_at;
 p.metadata.leaderExitPolicyVersion=row.policy;p.metadata.cec0040={version:CEC0040_VERSION,enforcementEnabled:true};
 p.metadata.p142State={stopPrice:Number(row.hard_stop_price),stage:row.p142?.stage??'retestAnchor_LOCK'};
 p.metadata.exitProtection.orders[0].spec.params.triggerPrice=Number(row.hard_stop_price);
 return p;
}
test('T23 JELLY: verified soft native stop formerly beat HOLD; v2 HOLD preserves hard floor and position',async()=>{
 const row=historical.find(x=>x.symbol==='JELLYJELLYUSDT'),p=historicalPosition(row);
 assert.equal(row.hold.last.decision,'HOLD');assert.equal(row.exit_reason,'V17_NATIVE_STOP');
 assert.equal(p.hard_stop_price,.06875);assert.ok(row.post_exit_60m.high>Number(row.exit_price));
 const h=production(p,Number(row.exit_price),'HOLD',Date.parse(row.closed_at)),r=await h.manage();
 assert.equal(r.action,'HOLD');assert.equal(h.state.tables.v11_long_regime_positions[0].state,'OPEN');
 assert.equal(h.state.calls.filter(x=>x.action==='create_order').length,0);
 const floor=h.state.tables.v11_long_regime_positions[0].hard_stop_price;
 assert.ok(floor>=p.entry_price*.975);assert.ok(floor<.06875);
});
test('T24 historical HARD saver: FOLKS HOLD cannot override the unchanged catastrophic loss floor',async()=>{
 const row=historical.find(x=>x.symbol==='FOLKSUSDT'),p=historicalPosition(row);
 assert.equal(row.hold.last.decision,'HOLD');assert.ok(row.post_exit_60m.low<Number(row.exit_price));
 const h=production(p,Number(row.exit_price),'HOLD',Date.parse(row.closed_at)),r=await h.manage();
 assert.equal(r.action,'CLOSE');assert.equal(h.ai(),0);
});
for(const row of historical.filter(x=>/^[BE]_/.test(x.case)))test('loser-protection counterexample '+row.case,async()=>{
 const p=historicalPosition(row);assert.ok(row.post_exit_60m.low<Number(row.exit_price));
 // Two deliberately scripted FINAL responses, not a hindsight claim about what GPT would say.
 const exit=production(p,Number(row.exit_price),'EXIT',Date.parse(row.closed_at));
 assert.equal((await exit.manage()).action,'CLOSE');assert.equal(exit.ai(),1);
 const hold=production(p,Number(row.exit_price),'HOLD',Date.parse(row.closed_at));
 assert.equal((await hold.manage()).action,'HOLD');
 hold.state.now+=60000;
 hold.state.quotes[p.symbol]=Math.min(row.post_exit_60m.low,p.entry_price*.975-.000001);
 const hard=await hold.manage();assert.equal(hard.action,'CLOSE');
 assert.equal(hold.ai(),1,'subsequent hard loss does not wait for another model opinion');
});
