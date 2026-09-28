import fs from 'node:fs';
import assert from 'node:assert/strict';
import {frozenReview,arbitrationPayload,reviewsFor,finalEvidenceTransport} from '../../supabase/functions/_shared/gpt-final-decision/dual.mjs';
import {recheckPayload,recheckCaptureInput} from '../../supabase/functions/_shared/gpt-final-decision/recheck.mjs';
import {callDecision} from '../../supabase/functions/_shared/gpt-final-decision/api.mjs';
const fixture=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),packet=fixture.final_packet;
const snapshot=await frozenReview(packet,{snapshotAtMs:packet.dynamic_as_of_ms,inputPayload:recheckPayload});
const payload=finalEvidenceTransport(arbitrationPayload(snapshot,snapshot,reviewsFor(null,{valid:false}))).payload;
const bytes=new TextEncoder().encode(JSON.stringify(payload)).length;
assert.ok(bytes<=130000,`request bytes ${bytes}`);
const user=JSON.parse(payload.input[1].content);
assert.equal(user.current.capture_context.ordered_path.length,24);
assert.equal(user.initial.capture_context.ordered_path.length,24);
assert.deepEqual(user.current.capture_context,recheckCaptureInput(packet.facts.capture_context));
let requests=0;
const result=await callDecision(packet,{apiKey:'offline-fixture',payloadFn:()=>payload,fetchFn:async()=>{
 requests++;return Response.json({error:{code:'OFFLINE_TRANSPORT_PROOF'}},{status:503});
}});
assert.equal(requests,1);assert.notEqual(result.error,'FD_REQUEST_COST_BOUND');
console.log(JSON.stringify({source_job:fixture.job_key,historical_error:fixture.error,historical_request_bytes:fixture.request_bytes,
 current_request_bytes:bytes,current_path_buckets:24,initial_path_buckets:24,transport_reached:true,paid_calls:0,orders:0}));
