import test from 'node:test';
import assert from 'node:assert/strict';
import {callDecision} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {readFileSync} from 'node:fs';
import {nextEvent,MONTHLY_HOLD_POLICY,initialHoldState} from '../supabase/functions/_shared/gpt-final-decision/hold.mjs';
import {frozenReview,firstPayload,arbitrationPayload,reviewsFor,finalEvidenceTransport} from '../supabase/functions/_shared/gpt-final-decision/dual.mjs';
test('UTF8 cost bound refuses oversized input before charging or invoking a provider',async()=>{
 const r=await callDecision({}, {apiKey:'fixture',fetchFn:()=>assert.fail('paid call'),payloadFn:()=>({max_output_tokens:1000,input:'한'.repeat(44000)})});
 assert.equal(r.error,'FD_REQUEST_COST_BOUND');assert.equal(r.attempted,false);
});
test('monthly hold profile spends on changed risk, not unchanged two-minute polling',()=>{
 const at=1800000000000,st={...initialHoldState(1),lastReviewAt:at,reviews:1,reviewWindowAt:at};
 const args={price:1,peak:1,timeCandidate:null,softTrigger:null,dynamics:{observation:{}}};
 assert.equal(nextEvent(st,{...args,now:at+120000},MONTHLY_HOLD_POLICY).event,null);
 assert.equal(nextEvent(st,{...args,now:at+21600000},MONTHLY_HOLD_POLICY).event,'DYNAMIC_PERIODIC_REVIEW');
 const urgent={event:'BID_DEPTH_COLLAPSE',evidenceKey:'changed'};
 assert.equal(nextEvent(st,{...args,now:at+59999,dynamics:urgent},MONTHLY_HOLD_POLICY).event,null);
 assert.equal(nextEvent(st,{...args,now:at+60000,dynamics:urgent},MONTHLY_HOLD_POLICY).event,'BID_DEPTH_COLLAPSE');
 assert.equal(nextEvent(st,{...args,now:at+60000,dynamics:{event:'DATA_DEGRADED',evidenceKey:'changed'}},MONTHLY_HOLD_POLICY).event,null);
});
test('economy wire preserves the frozen market and complete ordered path for both preliminary reviewers',async()=>{
 const f=JSON.parse(readFileSync(new URL('../test-support/production-entry-timeout-20260927.json',import.meta.url)));
 const s=await frozenReview(f.packet,{snapshotAtMs:f.packet.dynamic_as_of_ms});
 const first=firstPayload(s),final=finalEvidenceTransport(arbitrationPayload(s,s,reviewsFor(null,{valid:false}))).payload;
 assert.deepEqual(JSON.parse(first.input[1].content),s.market_input);
 assert.deepEqual(JSON.parse(final.input[1].content).capture_context,s.market_input.capture_context);
 assert.equal(s.market_input.capture_context.ordered_path.length,24);
 assert.ok(JSON.stringify(final).length<75000);
 assert.ok(final.input[0].content.includes('GPT_JUDGMENT'));assert.ok(!final.input[0].content.includes('MODEL_JUDGMENT'));
});
