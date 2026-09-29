import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {nmrClockFinal,nmrOriginal} from '../test-support/nmr-clock-final.mjs';
import {CLOCK_FINAL,validClockFinalPacket,clockExecutionSafety,clockExecutionFlowSafety} from '../supabase/functions/_shared/leader20/clock-final.mjs';
import {hash} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {batchFinalPayload} from '../supabase/functions/_shared/leader20/final.mjs';
import {finalRecheckStep,setRecheckTestHooks,executionCapture,executionDynamicSafety} from '../supabase/functions/v10-lane-executor/gpt-final-recheck-adapter.mjs';
import {gptFinalCheck,gptBeginExecution} from '../supabase/functions/v10-lane-executor/gpt-final-review-adapter.mjs';
import {entryCapacity} from '../supabase/functions/v10-lane-executor/entry-capacity.mjs';
import {requireEntryAuthority} from '../supabase/functions/_shared/leader20/runtime.mjs';

const capacity=available=>entryCapacity({maxSlots:10,slotCost:152.121375,cashBufferUsdt:.1,liveAvailableUsdt:available});
const healthyTape=(at,{ret=.001,buy=.7,trades=20}={})=>({available:true,source:'TEST',startAt:at-10000,endAt:at,
 receivedAt:at,tradeCount:trades,last10sReturn:ret,takerBuyQuoteShare:buy});
function forbidRecheck(){let reads=0,ai=0;setRecheckTestHooks({capture:async()=>{reads++;throw Error('NO_NEW_CAPTURE');},
 fetchFn:async()=>{ai++;throw Error('NO_AI_RECHECK');},readFresh:async()=>{reads++;throw Error('NO_NEW_MARKET');},
 store:{claim:async()=>{throw Error('NO_RECHECK_ROW');}},log:[]});return {reads:()=>reads,ai:()=>ai};}

test('NMR original 22:10 BUY -> actual coordinator -> safety -> real IOC dispatcher with mock exchange',async()=>{
 const f=await nmrClockFinal(),guard=forbidRecheck();
 assert.equal(capacity(f.original.source.available_quote).capacity,2);
 assert.equal(await hash({...f.packet,snapshot_hash:''}),f.packet.snapshot_hash);
 assert.equal(f.reviewed.allowed,true,JSON.stringify(f.reviewed));assert.equal(f.calls(),1);
 const row=[...f.store.rows.values()][0];assert.equal(row.record.result.requires_final_recheck,false);
 assert.equal(row.record.result.review_route,CLOCK_FINAL);
 assert.deepEqual(f.packet.facts.capture_context.trajectory,nmrOriginal.packet.facts.capture_context.trajectory);
 const input=JSON.parse(f.payload().input[1].content),columns=input.capture_context.ordered_path_columns;
 assert.deepEqual(input.capture_context.ordered_path,f.packet.facts.capture_context.trajectory.map(x=>columns.map(k=>x[k]??null)));
 assert.equal(input.deepseek_prior_review.last_ms,input.capture_context.end_ms);
 assert.equal(input.deepseek_prior_review.version,f.packet.leader20.batch_advice.version);
 // Reproduce the original 17-second delay beyond the old 15-second answer limit.
 f.setNow(f.now()+17000);assert.equal(f.c.check(f.s).allowed,true);
 const step=await finalRecheckStep(f.db,f.s,{ticket:f.ticket,rawQuote:f.quote(),e1:{observations:[{return:-.01,buyShare:.1}]},now:f.now});
 assert.equal(step.proceed,true,step.reason);assert.equal(step.record.recheck_triggered,false);
 assert.equal(step.reason,'CLOCK_FINAL_BUY_TO_EXECUTION');
 step.record.dispatch_capture=await executionCapture(f.ticket,f.s.symbol,f.now());step.record.dispatch_quote=f.quote();
 step.record.dispatch_tape=healthyTape(f.now());
 assert.equal(executionDynamicSafety(f.s,f.ticket,step.record,f.now()).ok,true);
 assert.equal(gptFinalCheck(f.db,f.s,step.record).allowed,true);assert.ok(gptBeginExecution(f.db,f.s,step.record));
 assert.equal(gptBeginExecution(f.db,f.s,step.record),null);
 const intents=new Map(),orders=[];
 f.db.rpc=async()=>({data:{allowed:true}});
 f.db.from=table=>table==='leader20_control'?{select(){return this;},eq(){return this;},async maybeSingle(){return {data:{active_strategy:'LEADER20_DYNAMIC_1'}};}}:
 {insert:row=>({select:()=>({single:async()=>{if(intents.has(row.client_order_id))return {error:{message:'duplicate client order id'}};
  intents.set(row.client_order_id,row);return {data:{id:'mock-intent',...row}};}})})};
 const source=readFileSync(new URL('../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8'),start=source.indexOf('async function dispatchEntryIocAttempt('),
  code=source.slice(start,source.indexOf('\n// ---',start));
 const ctx={requireEntryAuthority,IOC_RETRY_POLICY:{maxAttempts:2},LEV:3,REVISION:'offline',PATCH:'offline',cid:(p,id)=>p+id,
  Date:class extends Date{static now(){return f.now();}},verifyExecutionLease:async()=>{},fill:r=>r,entryReceipt:r=>r,
  classifyFailure:()=>({fatal:true})};vm.createContext(ctx);vm.runInContext(code+'\nthis.dispatch=dispatchEntryIocAttempt;',ctx);
 const options={attemptNo:1,quantity:40,limitPrice:f.quote().best_ask,step:.1,payload:{entry_clock_final:step.record.clock_final_authority},
  authorize:()=>gptFinalCheck(f.db,f.s,step.record)};
 const exchange=async request=>{orders.push(request);return {quantity:40,status:'FILLED',price:request.order.price};};
 const placed=await ctx.dispatch(f.db,f.s,exchange,options);assert.equal(placed.receipt.quantity,40);assert.equal(orders.length,1);
 await assert.rejects(ctx.dispatch(f.db,f.s,exchange,options),/duplicate client order id/);assert.equal(orders.length,1);
 assert.equal(guard.reads(),0);assert.equal(guard.ai(),0);assert.equal(f.store.rows.size,1);
 assert.ok(!JSON.stringify(step.record).includes('RC_BATCH_CAPTURE_NOT_ADVANCED'));
});

test('AAVE 20:01 regression: strong BUY propulsion that collapses before dispatch is blocked',()=>{
 const at=Date.parse('2026-09-29T11:01:49.000Z');
 const ticket={initial:{executionRef:{mid:168.23},capture_context:{dynamics:{horizons:{
  s15:{return:.0014866352,buy_share:.89596876},s30:{return:.0018440855,buy_share:.71899844}}}}}};
 const aaveTape={available:true,source:'BINANCE_FUTURES_AGGTRADES_REST',startAt:at-10000,endAt:at,receivedAt:at,
  tradeCount:53,last10sReturn:.00017838030681405215,takerBuyQuoteShare:.5572119998044506};
 const quote={best_bid:168.20,best_ask:168.22,timing:{received_at_ms:at}};
 const blocked=clockExecutionFlowSafety(ticket,aaveTape,quote,at);
 assert.equal(blocked.ok,false);assert.equal(blocked.reason,'CLOCK_EXECUTION_PROPULSION_COLLAPSED');
 assert.ok(blocked.flow.initialBuyShare-blocked.flow.buyShare>.20);
 const healthy=clockExecutionFlowSafety(ticket,healthyTape(at,{ret:.001,buy:.72,trades:50}),
  {best_bid:168.39,best_ask:168.41,timing:{received_at_ms:at}},at);
 assert.equal(healthy.ok,true,JSON.stringify(healthy));
 const reversed=clockExecutionFlowSafety(ticket,healthyTape(at,{ret:-.001,buy:.35,trades:50}),quote,at);
 assert.equal(reversed.ok,false);assert.equal(reversed.reason,'CLOCK_EXECUTION_FLOW_REVERSED');
 const stale=clockExecutionFlowSafety(ticket,{...aaveTape,receivedAt:at-5001},quote,at);
 assert.equal(stale.ok,false);assert.equal(stale.reason,'CLOCK_EXECUTION_FLOW_INVALID_OR_STALE');
});

test('clock expiry is absolute, including retry/superseding parameters and a fresh quote',async()=>{
 const f=await nmrClockFinal();f.setNow(f.ticket.expires-1);assert.equal(f.c.check(f.s).allowed,true);
 f.setNow(f.ticket.expires);
 assert.equal(f.c.check(f.s,{allowAged:true,supersededBy:'ignored'}).reason,'CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION');
 assert.equal(f.c.beginExecution(f.s),null);
 const r=await finalRecheckStep(f.db,f.s,{ticket:f.ticket,rawQuote:f.quote(),now:f.now});
 assert.equal(r.proceed,false);assert.equal(r.reason,'CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION');
});

test('ordinary quote changes keep BUY; stale, missing, catastrophic spread/gap abort without AI',async()=>{
 const f=await nmrClockFinal(),guard=forbidRecheck(),id=f.c.identity(f.s);
 for(const ratio of [.995,1,1.005])assert.equal(clockExecutionSafety(f.ticket,id,f.quote(ratio),f.now()).ok,true);
 const cases=[[null,'CLOCK_EXECUTION_QUOTE_INVALID'],[{...f.quote(),timing:{received_at_ms:f.now()-1001}},'CLOCK_EXECUTION_QUOTE_STALE'],
  [{...f.quote(),best_ask:f.quote().best_bid*1.01},'EXECUTION_ABORTED_MARKET_DISCONTINUITY'],[f.quote(.97),'EXECUTION_ABORTED_MARKET_DISCONTINUITY']];
 for(const [quote,reason]of cases){const r=await finalRecheckStep(f.db,f.s,{ticket:f.ticket,rawQuote:quote,now:f.now});assert.equal(r.proceed,false);assert.equal(r.reason,reason);}
 assert.equal(guard.reads(),0);assert.equal(guard.ai(),0);
});

test('changed slot, generation, snapshot, invalid result and superseding identity cannot inherit BUY',async()=>{
 for(const mutate of [p=>p.leader20.entry_window.slot_ms+=600000,p=>p.leader20.generation++,p=>p.leader20.execution_snapshot_hash='other',
  p=>p.facts.capture_context.trajectory.pop(),p=>p.facts.capture_context.trajectory[3].aggressive_buy++]){
  const p=structuredClone(nmrOriginal.packet);mutate(p);
  const structurallyBound=validClockFinalPacket(p,nmrOriginal.result.completed_at_ms);
  assert.ok(!structurallyBound||await hash({...p,snapshot_hash:''})!==p.snapshot_hash,'structure or exact packet hash must reject');
 }
 const f=await nmrClockFinal(),row=[...f.store.rows.values()][0];row.record.result.valid=false;
 assert.equal((await f.c.consider(f.s)).allowed,false);assert.equal(f.c.beginExecution(f.s),null);
 const other=await nmrClockFinal();other.s.features.leader20.generation++;
 assert.equal(other.c.check(other.s).allowed,false);assert.equal(other.c.beginExecution(other.s),null);
 const absent=await finalRecheckStep(other.db,other.s,{ticket:{decision:'BUY'},rawQuote:other.quote(),now:other.now});
 assert.equal(absent.reason,'CLOCK_FINAL_AUTHORITY_INVALID');
});

test('clock payload replaces legacy mandatory recheck language and preserves account policy',()=>{
 const prompt=batchFinalPayload(nmrOriginal.packet).input[0].content;
 assert.match(prompt,/FINAL STRATEGY AUTHORITY/);assert.doesNotMatch(prompt,/FINAL RECHECK with a fresh execution quote is mandatory/);
 assert.equal(capacity(0).capacity,0);assert.equal(capacity(331.34419204).capacity,2);
 assert.equal(nmrOriginal.identity.exit_policy.stopPct,.025);
});
