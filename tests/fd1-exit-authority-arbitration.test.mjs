import test from 'node:test';
import assert from 'node:assert/strict';
import {dualEntryDecision,arbitrationPayload,frozenReview} from '../supabase/functions/_shared/gpt-final-decision/dual.mjs';
import {buildDecisionPacket,MODEL} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {computeFacts} from '../supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {validateCapture120,CAPTURE_VERSION} from '../supabase/functions/_shared/gpt-final-decision/capture-context.mjs';
import {holdStep,initialHoldState} from '../supabase/functions/_shared/gpt-final-decision/hold.mjs';
import {src} from '../development/gpt-final-decision/tests/fixtures.mjs';
import {finalFields} from '../test-support/arbitration-fixtures.mjs';
const now=Date.now(),end=Math.floor((now-6000)/5000)*5000,positionId='actual-fixture',generation=positionId+':entry';
const trajectory=Array.from({length:24},(_,i)=>{
 const t=end-(23-i)*5000;
 return {flow_event_ms:t-200,flow_received_at_ms:t-100,bucket_ms:t,start_ms:t-5000,end_ms:t,received_at_ms:t+1000,exchange_event_ms:t-200,book_received_at_ms:t-100,
 mid:100+i*.01,start_mid:100+(i-1)*.01,d_mid_bps:1,d_spread_bps:-.1,d_ask_depth_25_pct:-.02,d_bid_depth_25_pct:.01,
 buy_share_5s:.6,d_buy_share:.01,net_taker_quote_5s:100,d_net_taker_quote:2,ask_book_net_5s:-5,buy_impact_450_bps:2,
 d_buy_impact_bps:-.01,sell_impact_450_bps:2,d_sell_impact_bps:.01,trade_count:10,arrival_rate:2,aggressive_notional:500,
 aggressive_buy:300,aggressive_sell:200,bid_book_net_5s:5,spread_bps:2,bid_depth_25_usdt:50000,ask_depth_25_usdt:40000,imbalance:.111,btc_return_1m:.001};
});
const capture=validateCapture120({version:CAPTURE_VERSION,status:'AVAILABLE',buckets:24,start_ms:end-120000,end_ms:end,ingested_at_ms:end+1000,trajectory},now);
assert.equal(capture.status,'AVAILABLE');
async function packet(){const f=computeFacts(src(now),{asOf:now});f.capture_context=capture;
 return buildDecisionPacket({task:'HOLD',subjectId:'soft120',symbol:'QUSDT',dataMode:'LIVE',facts:f,position:{event:'SOFT_PROTECTION_TRIGGER:TRAILING',
 positionId,generation,exitContext:{hard_floor:97.5,soft_trigger:{level:102,active:true},mfe:.04,mae:-.001}}});}
function advice(input,d){return {task:'HOLD',candidate_id:input.candidate_id,snapshot_hash:input.snapshot.snapshot_hash,decision_preference:d,
 confidence:.7,thesis_state:'ALIVE',bullish_evidence:['capture_context.trajectory.23.buy_share_5s'],bearish_evidence:[],
 risk_flags:[],trajectory_interpretation:'Provided flow persists',strongest_counterargument:'Pullback may accelerate',recommended_action:d,reason:'Read the supplied trajectory'};}
for(const [id,ds,final] of [['T11','EXIT','HOLD'],['T12','HOLD','EXIT'],['T13','EXIT','PROTECT']])
test(id+' actual parallel advice → refresh → FINAL → hold state, with full 120s input',async()=>{
 let first=null,advisory=null,calls=0,ready;const overlap=new Promise(r=>ready=r);let entered=0,finalSchema;
 const fetchFn=async(url,init)=>{
  const body=JSON.parse(init.body),isDS=String(url).includes('deepseek'),input=JSON.parse(isDS?body.messages[1].content:body.input[1].content);
  if(!input.independent_reviews){if(isDS)advisory=input;else first=input;if(++entered===2)ready();await overlap;}
  assert.equal(input.capture_context.trajectory.length,24);
  if(isDS)return Response.json({model:'deepseek-flash',usage:{prompt_tokens:1000,completion_tokens:100},choices:[{finish_reason:'stop',message:{content:JSON.stringify(advice(input,ds))}}]});
  calls++;
  if(input.independent_reviews){assert.ok(input.position.exit_context.latest_refresh);finalSchema=body.text.format.schema;}
  const d=input.independent_reviews?final:'HOLD',wire={t:'HOLD',c:input.candidate_id,d,reasons:d==='EXIT'?[{r:'GPT_JUDGMENT',e:['return_5m']}]:[],support:['return_5m'],n:'Fresh evidence reviewed',
   ...(input.independent_reviews?{arbitration:finalFields(input)}:{})};
  return Response.json({model:MODEL,status:'completed',usage:{input_tokens:1000,output_tokens:100},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(wire)}]}]});
 };
 const p=await packet(),r=await dualEntryDecision(p,{apiKey:'fixture',deepseekKey:'fixture',fetchFn,now:()=>now,snapshotAtMs:now,
  refreshPacket:async()=>({packet:{...p,position:{...p.position,exit_context:{...p.position.exit_context,latest_refresh:true}}},captured:now})});
 assert.deepEqual(first,advisory);assert.equal(calls,2);assert.equal(r.valid,true,r.error);assert.equal(r.decision,final);
 const enumCount=JSON.stringify(finalSchema).match(/"enum":/g)?.length??0;assert.ok(enumCount<40);
 function enums(x){return x&&typeof x==='object'?(Array.isArray(x.enum)?x.enum.length:0)+Object.entries(x).filter(([k])=>k!=='enum').reduce((n,[,v])=>n+enums(v),0):0;}
 assert.ok(enums(finalSchema)<=1000);
 const journal={packet:r.final_packet,result:{...r,final_packet:undefined}};
 assert.ok(Buffer.byteLength(JSON.stringify(journal,null,1))<300000,'complete serialized journal must fit production cap');
 const stepped=await holdStep({...initialHoldState(100),pending:{key:'k',event:'SOFT_PROTECTION_TRIGGER:TRAILING',at:now-1000}},
  {now,price:101,peak:104,positionId,generation,softTrigger:{active:true,level:102,reason:'TRAILING',key:'t'},
   answerOf:async()=>({state:'DONE',valid:r.valid,decision:r.decision,completed_at_ms:r.completed_at_ms,snapshot_at_ms:r.final_snapshot_at_ms,refresh_error:r.arbitration.refresh_error})});
 assert.equal(stepped.close,final==='EXIT');assert.equal(stepped.reason,'FD1_GPT_'+final);
});
test('120s evidence schema still rejects invented paths; skipped/future refresh is explicitly unavailable',async()=>{
 const p=await packet();let clock=now;
 const r=await dualEntryDecision(p,{apiKey:'fixture',now:()=>clock,snapshotAtMs:now,deadlineMs:now+3000,
  counterCall:async()=>({valid:false,attempted:false}),gptCall:async()=>{clock+=1600;return {valid:false,attempted:false,decision:'ABSTAIN'};},
  refreshPacket:async()=>({packet:p,captured:now+100000})});
 assert.equal(r.arbitration.refresh_error,'LATEST_SNAPSHOT_UNAVAILABLE');assert.equal(r.valid,false);
});

