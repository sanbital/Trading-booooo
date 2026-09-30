import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {nmrClockFinal,nmrOriginal} from '../test-support/nmr-clock-final.mjs';
import {CLOCK_FINAL,validClockFinalPacket,clockExecutionSafety} from '../supabase/functions/_shared/leader20/clock-final.mjs';
import {hash} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {batchFinalPayload} from '../supabase/functions/_shared/leader20/final.mjs';
import {finalRecheckStep,setRecheckTestHooks,executionCapture,executionDynamicSafety} from '../supabase/functions/v10-lane-executor/gpt-final-recheck-adapter.mjs';
import {gptFinalCheck,gptBeginExecution} from '../supabase/functions/v10-lane-executor/gpt-final-review-adapter.mjs';
import {entryCapacity} from '../supabase/functions/v10-lane-executor/entry-capacity.mjs';
import {requireEntryAuthority} from '../supabase/functions/_shared/leader20/runtime.mjs';
import {depthQuote,rollingCapture} from '../test-support/pre-execution-fixtures.mjs';

const capacity=available=>entryCapacity({maxSlots:10,slotCost:152.121375,cashBufferUsdt:.1,liveAvailableUsdt:available});
function validityHooks(f){let reads=0,ai=0;setRecheckTestHooks({capture:async()=>{reads++;return rollingCapture(
 f.ticket.initial.capture_context,f.now(),{mid:f.ticket.initial.executionRef.mid,hash:`rolling-${f.now()}`});},
 fetchFn:async()=>{ai++;throw Error('NO_AI_RECHECK');},readFresh:async()=>{reads++;throw Error('NO_NEW_MARKET');},
 store:{claim:async()=>{throw Error('NO_RECHECK_ROW');}},log:[]});return {reads:()=>reads,ai:()=>ai};}
const marketQuote=(f,ratio=1)=>depthQuote(f.quote(ratio),{receivedAt:f.now()});

test('NMR original 22:10 BUY -> actual coordinator -> safety -> real IOC dispatcher with mock exchange',async()=>{
 const f=await nmrClockFinal(),guard=validityHooks(f);
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
 const step=await finalRecheckStep(f.db,f.s,{ticket:f.ticket,rawQuote:marketQuote(f),e1:{observations:[{return:-.01,buyShare:.1}]},now:f.now});
 assert.equal(step.proceed,true,step.reason);assert.equal(step.record.recheck_triggered,false);
 assert.equal(step.reason,'PRE_EXECUTION_VALID');
 step.record.dispatch_capture=await executionCapture(f.ticket,f.s.symbol,f.now());step.record.dispatch_quote=marketQuote(f);
 assert.equal(executionDynamicSafety(f.s,f.ticket,step.record,f.now()).ok,true);
 assert.equal(gptFinalCheck(f.db,f.s,step.record).allowed,true);assert.ok(gptBeginExecution(f.db,f.s,step.record));
 assert.equal(gptBeginExecution(f.db,f.s,step.record),null);
 const intents=new Map(),orders=[];
 f.db.rpc=async()=>({data:{allowed:true}});
 f.db.from=table=>table==='leader20_control'?{select(){return this;},eq(){return this;},async maybeSingle(){return {data:{active_strategy:'LEADER20_DYNAMIC_1'}};}}:
 {insert:row=>({select:()=>({single:async()=>{if(intents.has(row.client_order_id))return {error:{message:'duplicate client order id'}};
  intents.set(row.client_order_id,row);return {data:{id:'mock-intent',...row}};}})}),update:()=>({eq:async()=>({error:null})})};
 const source=readFileSync(new URL('../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8'),start=source.indexOf('async function dispatchEntryIocAttempt('),
  code=source.slice(start,source.indexOf('\n// ---',start));
 const ctx={requireEntryAuthority,IOC_RETRY_POLICY:{maxAttempts:2},LEV:3,REVISION:'offline',PATCH:'offline',cid:(p,id)=>p+id,
  Date:class extends Date{static now(){return f.now();}},verifyExecutionLease:async()=>{},fill:r=>r,entryReceipt:r=>r,
  classifyFailure:()=>({fatal:true})};vm.createContext(ctx);vm.runInContext(code+'\nthis.dispatch=dispatchEntryIocAttempt;',ctx);
 const options={attemptNo:1,quantity:40,limitPrice:f.quote().best_ask,step:.1,payload:{entry_clock_final:step.record.clock_final_authority},
  authorize:()=>gptFinalCheck(f.db,f.s,step.record)};
 const exchange=async request=>{if(request.action==='get_order')return {quantity:40,status:'FILLED',price:f.quote().best_ask};
  orders.push(request);return {quantity:40,status:'FILLED',price:request.order.price,exchangeOrderId:'mock'};};
 const placed=await ctx.dispatch(f.db,f.s,exchange,options);assert.equal(placed.receipt.quantity,40);assert.equal(orders.length,1);
 await assert.rejects(ctx.dispatch(f.db,f.s,exchange,options),/duplicate client order id/);assert.equal(orders.length,1);
 assert.equal(guard.reads(),2);assert.equal(guard.ai(),0);assert.equal(f.store.rows.size,1);
 assert.ok(!JSON.stringify(step.record).includes('RC_BATCH_CAPTURE_NOT_ADVANCED'));
});

test('clock expiry is absolute, including retry/superseding parameters and a fresh quote',async()=>{
 const f=await nmrClockFinal();f.setNow(f.ticket.expires-1);assert.equal(f.c.check(f.s).allowed,true);
 f.setNow(f.ticket.expires);
 assert.equal(f.c.check(f.s,{allowAged:true,supersededBy:'ignored'}).reason,'CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION');
 assert.equal(f.c.beginExecution(f.s),null);
 const r=await finalRecheckStep(f.db,f.s,{ticket:f.ticket,rawQuote:f.quote(),now:f.now});
 assert.equal(r.proceed,false);assert.equal(r.reason,'CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION');
});

test('hard quote failures abort with a fresh rolling capture and without delta GPT',async()=>{
 const f=await nmrClockFinal(),guard=validityHooks(f),id=f.c.identity(f.s);
 for(const ratio of [.995,1,1.005])assert.equal(clockExecutionSafety(f.ticket,id,f.quote(ratio),f.now()).ok,true);
 const cases=[[null,'CLOCK_EXECUTION_QUOTE_INVALID'],[{...marketQuote(f),timing:{received_at_ms:f.now()-1001}},'CLOCK_EXECUTION_QUOTE_STALE'],
  [{...marketQuote(f),best_ask:f.quote().best_bid*1.01},'EXECUTION_ABORTED_MARKET_DISCONTINUITY'],[marketQuote(f,.97),'EXECUTION_ABORTED_MARKET_DISCONTINUITY']];
 for(const [quote,reason]of cases){const r=await finalRecheckStep(f.db,f.s,{ticket:f.ticket,rawQuote:quote,now:f.now});assert.equal(r.proceed,false);assert.equal(r.reason,reason);}
 assert.equal(guard.reads(),cases.length);assert.equal(guard.ai(),0);
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
