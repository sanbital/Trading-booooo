import test from 'node:test';
import assert from 'node:assert/strict';
import {callDecision} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {readFileSync} from 'node:fs';
import {frozenReview,firstPayload,arbitrationPayload,reviewsFor,finalEvidenceTransport} from '../supabase/functions/_shared/gpt-final-decision/dual.mjs';
test('UTF8 cost bound refuses oversized input before charging or invoking a provider',async()=>{
 const r=await callDecision({}, {apiKey:'fixture',fetchFn:()=>assert.fail('paid call'),payloadFn:()=>({max_output_tokens:1000,input:'한'.repeat(44000)})});
 assert.equal(r.error,'FD_REQUEST_COST_BOUND');assert.equal(r.attempted,false);
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
