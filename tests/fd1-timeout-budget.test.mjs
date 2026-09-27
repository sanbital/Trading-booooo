import test from 'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';
import{frozenReview,firstPayload,validateFirstWire,arbitrationPayload,reviewsFor,dualEntryDecision}from'../supabase/functions/_shared/gpt-final-decision/dual.mjs';
import{wireSchema}from'../supabase/functions/_shared/gpt-final-decision/contract.mjs';
import{compactWireSchema,payloadFor,MODEL}from'../supabase/functions/_shared/gpt-final-decision/api.mjs';
const f=JSON.parse(readFileSync(new URL('../test-support/production-entry-timeout-20260927.json',import.meta.url)));
const at=f.packet.dynamic_as_of_ms;
const freeze=()=>frozenReview(f.packet,{snapshotAtMs:at});
function expand(s,root=s){if(!s||typeof s!=='object')return s;if(Array.isArray(s))return s.map(x=>expand(x,root));if(s.$ref)return expand(root.$defs[s.$ref.split('/').at(-1)],root);return Object.fromEntries(Object.entries(s).filter(([k])=>k!=='$defs').map(([k,v])=>[k,expand(v,root)]));}
test('actual timeout packet: compact FIRST, smaller FINAL and raw evidence unchanged',async()=>{
 const before=JSON.stringify(f.packet),s=await freeze(),first=firstPayload(s),final=arbitrationPayload(s,s,reviewsFor(null,{valid:false}));
 assert.equal(f.old_result.error,'API_TIMEOUT');assert.equal(f.old_result.first_latency_ms,6003);
 assert.ok(JSON.stringify(first).length<40000);assert.ok(JSON.stringify(final).length<110000);
 assert.equal(first.max_output_tokens,320);assert.equal(JSON.stringify(f.packet),before);
 assert.equal(s.packet.facts.market_sensor.market_sensor_trajectory.length,24);
 assert.equal(s.market_input.market_sensor.market_sensor_trajectory.length,24);
 for(let i=0;i<24;i++)for(const[k,v]of Object.entries(s.market_input.market_sensor.market_sensor_trajectory[i]))assert.deepEqual(v,s.packet.facts.market_sensor.market_sensor_trajectory[i][k]);
 assert.deepEqual(s.market_input.capture_context.dynamics,s.packet.facts.capture_context.dynamics);
});
test('transport enum deduplication preserves the exact full validation schema',()=>{
 const raw=wireSchema('ENTRY',f.packet),small=compactWireSchema(raw);assert.deepEqual(expand(small),raw);assert.deepEqual(expand(compactWireSchema(small)),raw);
 const withExisting={...raw,$defs:{shared_wire_enum_0:{type:'string',enum:['keep']}}};const second=compactWireSchema(withExisting);assert.deepEqual(second.$defs.shared_wire_enum_0,withExisting.$defs.shared_wire_enum_0);assert.deepEqual(expand(second),raw);
 assert.ok(JSON.stringify(small).length<JSON.stringify(raw).length);
});
test('FIRST is an evidence-bound preliminary opinion with no execution authority',async()=>{
 const s=await freeze(),wire={c:s.packet.candidate_id,d:'BUY',confidence:.8,evidence:['facts.trend.return_5m'],n:'Trend remains supported'};
 const answer=validateFirstWire(wire,s);assert.equal(answer.preliminary,true);assert.deepEqual(answer.authority,[]);
 assert.throws(()=>validateFirstWire({...wire,c:'wrong'},s));assert.throws(()=>validateFirstWire({...wire,evidence:['facts.invented']},s));assert.throws(()=>validateFirstWire({...wire,evidence:[]},s));
});
test('compact FIRST BUY cannot replace a timed-out FINAL and original deadline remains bounded',async()=>{
 const timeouts=[],seen=[],advisoryTimeouts=[];const r=await dualEntryDecision(f.packet,{apiKey:'unit-key',now:()=>at,snapshotAtMs:at,deadlineMs:at+15000,
  counterCall:async(p,o)=>{advisoryTimeouts.push(o.timeoutMs);return {valid:false,attempted:false,error:'DEEPSEEK_KEY_MISSING'};},
  gptCall:async(p,o)=>{timeouts.push(o.timeoutMs);const req=o.payloadFn(p);seen.push(req);if(seen.length===2)return {valid:false,decision:'ABSTAIN',attempted:true,error:'API_TIMEOUT',completed_at_ms:at};const wire={c:p.candidate_id,d:'BUY',confidence:.9,evidence:['facts.trend.return_5m'],n:'Supported preliminary view'};return {valid:true,decision:'BUY',wire,answer:o.validate(wire,p),attempted:true,completed_at_ms:at};}});
 assert.equal(seen.length,2);assert.deepEqual(timeouts,[4000,8000]);assert.deepEqual(advisoryTimeouts,[6000]);assert.equal(r.valid,false);assert.equal(r.decision,'ABSTAIN');assert.equal(r.error,'API_TIMEOUT');assert.equal(r.arbitration.first_wire_version,'FD1_FIRST_COMPACT_1');
});
test('legacy journals retain their original FIRST contract',async()=>{
 const packet=structuredClone(f.packet);delete packet.dynamic_policy;const {hash}=await import('../supabase/functions/_shared/gpt-final-decision/api.mjs');packet.snapshot_hash=await hash({...packet,snapshot_hash:''});
 const s=await frozenReview(packet,{snapshotAtMs:at});assert.equal(firstPayload(s).text.format.name,'fd1_entry');assert.equal(firstPayload(s).text.format.schema.properties.why_buy_now,undefined);
});

test('short live output does not tighten historical dynamic wire validation',async()=>{
 const server=wireSchema('ENTRY',f.packet),before=JSON.stringify(server),s=await freeze(),live=expand(arbitrationPayload(s,s,reviewsFor(null,{valid:false})).text.format.schema);
 assert.equal(server.properties.structural_strength.maxLength,280);assert.equal(server.properties.dynamic_evidence.maxItems,8);
 assert.equal(live.properties.structural_strength.maxLength,120);assert.equal(live.properties.dynamic_evidence.maxItems,3);
 assert.equal(live.properties.why_buy_now.properties.horizons.properties.s120.properties.evidence.maxItems,1);
 assert.equal(JSON.stringify(server),before);
});
