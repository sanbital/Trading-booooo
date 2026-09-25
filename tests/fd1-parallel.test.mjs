import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildDecisionPacket,payloadFor,MODEL} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {computeFacts} from '../supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {buildRecheckPacket,recheckPayload,validateRecheck} from '../supabase/functions/_shared/gpt-final-decision/recheck.mjs';
import {sharedReview,callCounter,parallelReview,fuse,MODEL_CANDIDATES} from '../supabase/functions/_shared/gpt-final-decision/parallel.mjs';
import {src,T,entryWire} from '../development/gpt-final-decision/tests/fixtures.mjs';
const facts=()=>computeFacts(src(T),{asOf:T,referenceClose:1.1,dayReturn:.2,rank:1});
async function shared(task='ENTRY'){
  const packet=task==='RECHECK'?await buildRecheckPacket({signalId:'x',symbol:'ABCUSDT',facts:facts(),
    detection:{reasons:['INITIAL_ANSWER_AGED'],deltas:{elapsed_since_initial_ms:16000}}}):
    await buildDecisionPacket({task,subjectId:'x',symbol:'ABCUSDT',dataMode:'LIVE',facts:facts(),position:task==='HOLD'?{}:null});
  return sharedReview(packet,{snapshotAtMs:T,inputPayload:task==='RECHECK'?recheckPayload:payloadFor});
}
function answer(s){return {task:s.packet.task,candidate_id:s.packet.candidate_id,confidence:.8,evidence:['return_5m'],summary:'Trend evidence',
  ...(s.packet.task==='HOLD'?{thesis_state:'ALIVE',early_failure_risk:'LOW',winner_persistence:'HIGH',decision_preference:'HOLD'}:
    {decision:'SUPPORT_BUY',failure_risk:'LOW',continuation_strength:'STRONG',chase_risk:'LOW',expected_value:'POSITIVE'})};}
const config={...MODEL_CANDIDATES[0],apiKey:'test-secret'};
function response(s,wire=answer(s)){return Response.json({model:config.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(wire),reasoning_content:'DO NOT STORE'}}],usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20}});}
test('shared input is deep frozen, detached and hash changes with timestamp',async()=>{
  const s=await shared();assert.ok(Object.isFrozen(s.packet.facts.values));
  assert.throws(()=>{s.packet.facts.values.return_5m=0;});
  const t=await sharedReview(s.packet,{snapshotAtMs:T+1});assert.notEqual(s.snapshot_hash,t.snapshot_hash);
  assert.equal((await shared()).snapshot_hash,s.snapshot_hash);
  await assert.rejects(sharedReview({...s.packet,outcome:12},{snapshotAtMs:T}),/PACKET_FIELDS/);
});
for(const task of ['ENTRY','HOLD','RECHECK'])test(task+' fetch callback starts overlap; inputs identical; no duplicate invocation',async()=>{
  const s=await shared(task),starts=[],ends=[],inputs=[];let release;
  const barrier=new Promise(r=>{release=r;});
  const fetchFn=async(url,init)=>{
    starts.push({url,at:performance.now()});const p=JSON.parse(init.body);
    inputs.push(JSON.parse(url.includes('deepseek')?p.messages[1].content:p.input[1].content));
    if(starts.length===2)release();await barrier;ends.push(performance.now());
    if(url.includes('deepseek'))return response(s);
    const wire=task==='ENTRY'?entryWire({t:task,c:s.packet.candidate_id,d:'BUY',support:['return_5m','taker_buy_ratio_5m'],n:'상승 지속'}):
      {t:task,c:s.packet.candidate_id,d:task==='HOLD'?'HOLD':'BUY',reasons:[],support:['return_5m','taker_buy_ratio_5m'],n:'상승 지속'};
    return Response.json({model:MODEL,status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(wire)}]}]});
  };
  const r=await parallelReview(s,{now:()=>T+1,deadlineMs:T+1000,maxAgeMs:8000,
    openai:{apiKey:'test',fetchFn,...(task==='RECHECK'?{payloadFn:recheckPayload,validate:validateRecheck}:{})},deepseek:{...config,fetchFn}});
  assert.equal(starts.length,2);assert.ok(Math.max(...starts.map(x=>x.at))<=Math.min(...ends));
  assert.deepEqual(inputs[0],inputs[1]);assert.equal(r.counter.snapshot_hash,r.snapshot_hash);
  assert.equal(r.gpt.valid,true);assert.equal(r.counter.valid,true);
  assert.equal(JSON.stringify(r).includes('DO NOT STORE'),false);
  console.log(JSON.stringify({task,starts,ends,overlap:true}));
});
test('all saved production packets prepare offline without adding outcome fields',async()=>{
  const rows=JSON.parse(await readFile(new URL('../research/deepseek-counter-20260925/inputs.json',import.meta.url),'utf8'));
  assert.equal(rows.length,122);
  for(const row of rows){
    const s=await sharedReview(row.packet,{snapshotAtMs:row.snapshot_at_ms,inputPayload:row.packet.task==='RECHECK'?recheckPayload:payloadFor});
    assert.deepEqual(s.packet,row.packet);assert.equal(s.snapshot_at_ms,row.snapshot_at_ms);
    assert.equal(Object.hasOwn(s.market_input,'counterfactual_net_usdt'),false);
    assert.ok(Object.isFrozen(s.packet.facts.values));
  }
});
for(const [name,fetchFn,error] of [
  ['malformed',async()=>new Response('{'),'COUNTER_INVALID_RESPONSE'],
  ['http',async()=>new Response('private upstream error',{status:503}),'COUNTER_HTTP_503'],
  ['timeout',()=>new Promise(()=>{}),'COUNTER_TIMEOUT'],
  ['throw',()=>{throw Error('test-secret');},'COUNTER_INVALID_RESPONSE'],
])test('counter '+name+' preserves GPT result and redacts errors',async()=>{
  const s=await shared(),r=await parallelReview(s,{now:()=>T+1,deadlineMs:T+25,maxAgeMs:8000,
    gptCall:async()=>({valid:true,decision:'BUY'}),deepseek:{...config,fetchFn}});
  assert.equal(r.gpt.decision,'BUY');assert.equal(r.counter.error,error);assert.equal(r.fusion.decision,'BUY');
  assert.equal(JSON.stringify(r).includes('test-secret'),false);
});
test('missing key does not make a request',async()=>{
  const r=await callCounter(await shared(),{...config,apiKey:null,fetchFn:()=>assert.fail('network')});
  assert.equal(r.error,'COUNTER_KEY_MISSING');assert.equal(r.attempted,false);
});
for(const mutate of [a=>({...a,candidate_id:'other'}),a=>({...a,evidence:['unknown']}),
  a=>({...a,confidence:2}),a=>({...a,stop_price:0}),a=>({...a,evidence:['return_5m','return_5m']})])
test('invalid identity, evidence, confidence and extra authority rejected',async()=>{
  const s=await shared(),r=await callCounter(s,{...config,fetchFn:async()=>response(s,mutate(answer(s)))});assert.equal(r.valid,false);
});
test('OpenAI timeout and both timeouts never promote counter to authority',async()=>{
  const s=await shared();
  for(const both of [false,true]){
    const r=await parallelReview(s,{now:()=>T+1,deadlineMs:T+20,maxAgeMs:8000,
      openai:{apiKey:'test',fetchFn:()=>new Promise(()=>{})},deepseek:{...config,fetchFn:both?()=>new Promise(()=>{}):async()=>response(s)}});
    assert.equal(r.gpt.error,'API_TIMEOUT');assert.equal(r.fusion.decision,'ABSTAIN');assert.deepEqual(r.fusion.authority,[]);
  }
});
test('stale and future snapshots never invoke APIs',async()=>{
  const s=await shared();for(const at of [T-1,T+10000])await assert.rejects(parallelReview(s,{now:()=>at,deadlineMs:at+100,maxAgeMs:8000,gptCall:()=>assert.fail()}),/STALE/);
});
test('agreement/disagreement and confidence confer no uncalibrated authority',()=>{
  for(const decision of ['BUY','SKIP'])for(const d of ['SUPPORT_BUY','OPPOSE_BUY']){
    const r=fuse({valid:true,decision},{valid:true,answer:{decision:d,confidence:1}},'ENTRY');assert.equal(r.decision,decision);
    assert.equal(r.disagreement,decision+'/'+d);
  }
  for(const decision of ['HOLD','EXIT'])for(const thesis_state of ['STRONG','BROKEN']){
    const r=fuse({valid:true,decision},{valid:true,answer:{thesis_state,confidence:1}},'HOLD');assert.equal(r.decision,decision);
  }
});
