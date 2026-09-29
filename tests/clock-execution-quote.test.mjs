import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {nmrClockFinal} from '../test-support/nmr-clock-final.mjs';
import {clockExecutionStep,authorizeClockExecution,setRecheckTestHooks,clockExecutionTrace} from '../supabase/functions/v10-lane-executor/gpt-final-recheck-adapter.mjs';
import {gptFinalCheck,gptBeginExecution} from '../supabase/functions/v10-lane-executor/gpt-final-review-adapter.mjs';
import {requireEntryAuthority} from '../supabase/functions/_shared/leader20/runtime.mjs';

const source=readFileSync(new URL('../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8');
const start=source.indexOf('async function dispatchEntryIocAttempt('),code=source.slice(start,source.indexOf('\n// ---',start));
const production=JSON.parse(readFileSync(new URL('./fixtures/nmr-clock-quote-20260928-2320.json',import.meta.url)));
async function fixture(){
 const f=await nmrClockFinal({fixture:production}),events=[],orders=[],writes=[],intents=new Set();
 setRecheckTestHooks({capture:async()=>{throw Error('NO_NEW_CAPTURE');},fetchFn:async()=>{throw Error('NO_AI_RECHECK');},
  readFresh:async()=>{throw Error('NO_NEW_MARKET');},store:{claim:async()=>{throw Error('NO_RECHECK_ROW');}},log:[]});
 const oldQuote=f.original.source.old_quote;assert.ok(oldQuote.timing.received_at_ms>f.now());
 // Reproduce the real guard instant: the admission quote is now 2193ms old.
 f.setNow(oldQuote.timing.received_at_ms+2193);
 let firstQuotes=0;
 const initial=await clockExecutionStep(f.s,f.ticket,async()=>{firstQuotes++;return f.quote();},{now:f.now});
 assert.equal(firstQuotes,1);assert.notEqual(initial.record.dispatch_quote,oldQuote);
 assert.equal(initial.proceed,true);const tapeAt=f.now(),record={...initial.record,
  dispatch_capture:f.ticket.initial.capture_context,dispatch_quote:f.quote(),
  dispatch_tape:{available:true,source:'TEST',startAt:tapeAt-10000,endAt:tapeAt,receivedAt:tapeAt,
    tradeCount:30,last10sReturn:.001,takerBuyQuoteShare:.7}};
 assert.ok(gptBeginExecution(f.db,f.s,record));
 f.db.rpc=async()=>({data:{allowed:true}});
 f.db.from=table=>table==='leader20_control'?{select(){return this;},eq(){return this;},async maybeSingle(){
  events.push('authority');f.setNow(f.now()+400);return {data:{active_strategy:'LEADER20_DYNAMIC_1'}};}}:{
  insert:row=>({select:()=>({single:async()=>{if(intents.has(row.client_order_id))return {error:{message:'duplicate'}};
   intents.add(row.client_order_id);events.push('intent');f.setNow(f.now()+2000);return {data:{id:'mock-intent',...row}};}})}),
  update:row=>({eq:async()=>{writes.push(row);return {error:null};}})};
 const ctx={requireEntryAuthority,IOC_RETRY_POLICY:{maxAttempts:2},LEV:3,REVISION:'offline',PATCH:'offline',cid:(p,id)=>p+id,
  Date:class extends Date{static now(){return f.now();}},verifyExecutionLease:async()=>{events.push('lease');f.setNow(f.now()+1000);},
  fill:r=>r,entryReceipt:r=>r,classifyFailure:()=>({fatal:true})};
 vm.createContext(ctx);vm.runInContext(code+'\nthis.dispatch=dispatchEntryIocAttempt;',ctx);
 const run=(readQuote=async()=>f.quote())=>ctx.dispatch(f.db,f.s,async request=>{
  events.push('send');orders.push(request);return {quantity:40,status:'FILLED',price:request.order.price};
 },{attemptNo:1,quantity:40,limitPrice:f.quote().best_ask,step:.1,payload:{entry_clock_execution:clockExecutionTrace(f.ticket)},
  authorize:()=>authorizeClockExecution(f.s,f.ticket,record,async()=>{events.push('quote');return readQuote();},
   ()=>gptFinalCheck(f.db,f.s,record),{now:f.now})});
 return {...f,run,record,events,orders,writes};
}

test('clock IOC acquires a new quote after slow durable intent, lease and generation reads, then sends without AI',async()=>{
 const f=await fixture(),old=f.record.dispatch_quote.timing.received_at_ms,r=await f.run();
 assert.equal(r.receipt.quantity,40);assert.equal(f.orders.length,1);assert.ok(f.now()-old>1000);
 assert.deepEqual(f.events.slice(-4),['lease','authority','quote','send']);
 assert.equal(r.evidence.clockExecutionSafety.received_at_ms,r.evidence.sentAt);
 assert.equal(r.evidence.clockExecutionSafety.checked_at_ms,r.evidence.sentAt);
 assert.equal(f.record.recheck_triggered,false);assert.equal(f.calls(),1);assert.equal(f.store.rows.size,1);
 assert.equal(clockExecutionTrace(f.ticket).old_quote_used,false);
 await assert.rejects(f.run(),/duplicate/);assert.equal(f.orders.length,1);
});

test('one stale gateway response refreshes once before the one IOC, without new AI/capture',async()=>{
 const f=await fixture();let reads=0;
 const r=await f.run(async()=>++reads===1?{...f.quote(),timing:{received_at_ms:f.now()-1001}}:f.quote());
 assert.equal(r.receipt.quantity,40);assert.equal(reads,2);assert.equal(f.orders.length,1);assert.equal(f.calls(),1);
 assert.equal(clockExecutionTrace(f.ticket).quote_refresh_attempts,1);
 assert.equal(clockExecutionTrace(f.ticket).execution_failure_reason,undefined);
});

test('fresh venue quote preserves every hard safety refusal and never restamps stale quotes',async()=>{
 for(const [make,reason]of [
  [f=>({...f.quote(),timing:{received_at_ms:f.now()-1001}}),'CLOCK_EXECUTION_QUOTE_STALE'],
  [()=>null,'CLOCK_EXECUTION_QUOTE_INVALID'],
  [f=>({...f.quote(),best_ask:f.quote().best_bid*1.01}),'EXECUTION_ABORTED_MARKET_DISCONTINUITY'],
  [f=>f.quote(.97),'EXECUTION_ABORTED_MARKET_DISCONTINUITY'],
  [()=>{throw Error('gateway unavailable');},'CLOCK_EXECUTION_QUOTE_UNAVAILABLE']]){
  const f=await fixture(),r=await f.run(async()=>make(f));
  assert.equal(r.blocked,true);assert.equal(r.reason,reason);assert.equal(f.orders.length,0);
  assert.equal(f.writes.at(-1).state,'REJECTED');assert.equal(f.calls(),1);
 }
});

test('clock expiry while obtaining final quote prevents a late IOC',async()=>{
 const f=await fixture(),r=await f.run(async()=>{f.setNow(f.ticket.expires);return f.quote();});
 assert.equal(r.reason,'CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION');assert.equal(f.orders.length,0);
 assert.equal(f.calls(),1);
});

test('expired clock BUY does not even request a quote after durable I/O',async()=>{
 const f=await fixture();f.setNow(f.ticket.expires-1000);const r=await f.run();
 assert.equal(r.reason,'CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION');assert.equal(f.events.includes('quote'),false);
 assert.equal(f.orders.length,0);
});

test('final clock quote does not bypass changed frozen snapshot or final authority refusal',async()=>{
 const f=await fixture();f.record.dispatch_capture=structuredClone(f.record.dispatch_capture);
 f.record.dispatch_capture.trajectory[0].aggressive_buy++;
 const r=await f.run();assert.equal(r.reason,'CLOCK_FINAL_SNAPSHOT_MISMATCH');assert.equal(f.orders.length,0);
});
