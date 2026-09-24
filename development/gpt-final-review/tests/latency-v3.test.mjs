import {WIRE_OUTPUT_SCHEMA_V4} from '../../../supabase/functions/_shared/gpt-final-review/wire-v4.mjs';
import test from 'node:test';
import {V5_HOOKS} from '../executor-hooks-v5.mjs';
import {V30_HOOKS} from '../executor-hooks-v30.mjs';
import {FD1_HOOKS} from '../executor-hooks-fd1.mjs';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {WIRE_OUTPUT_SCHEMA,OUTPUT_SCHEMA,MODEL,LIMITS,VERSION,validateShape,validateAnswer,expandWireAnswer,toWireAnswer,compactInput,parseApiResponse,decisionIdentity} from '../../../supabase/functions/_shared/gpt-final-review/contract.mjs';
import {FinalReviewCoordinator,MemoryReviewStore} from '../../../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
import {CandleReadCache} from '../../../supabase/functions/_shared/gpt-final-review/candle-cache.mjs';
import {collectMarket} from '../../../supabase/functions/_shared/gpt-final-review/market.mjs';
import {payloadFor} from '../../../supabase/functions/_shared/gpt-final-review/openai.mjs';
import {gptFilterExecutable,gptReviewReadyToResume,runWithGptReview,setTestCoordinator} from '../../../supabase/functions/v10-lane-executor/gpt-final-review-adapter.mjs';
import {FAST_HOOKS,EXPECTED_EXECUTOR_BLOB,blob} from '../wire-executor-latency-v3.mjs';
import {T,candidate,bars,packet,answer,transport,config,marketData,rawResponse} from './helpers.mjs';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function service({decision='PASS',store=new MemoryReviewStore(),now=()=>T+1000,hold=null,mode='ENFORCE',fetchFn=null}={}){
 return new FinalReviewCoordinator({config:config(mode),store,now,apiKey:()=> 'MOCK_ONLY',market:async()=>marketData(),fetchFn:fetchFn??transport({decision,hold})});
}
test('V3 compact transport expands to the identical canonical verdict and facts',async()=>{
 const p=await packet(),a=answer(p),wire=toWireAnswer(a,p);
 assert.deepEqual(validateAnswer(expandWireAnswer(wire,p),p),a);
 assert.ok(Buffer.byteLength(JSON.stringify(wire))<Buffer.byteLength(JSON.stringify(a))*.65);
});
test('wire schemas disallow all additional fields',()=>{
 function walk(x){if(!x||typeof x!=='object')return;if(x.type==='object')assert.equal(x.additionalProperties,false);Object.values(x).forEach(v=>Array.isArray(v)?v.forEach(walk):walk(v));}walk(WIRE_OUTPUT_SCHEMA);
});
for(const index of [-1,.5,256])test('invalid evidence reference '+index+' cannot become PASS',async()=>{
 const p=await packet(),w=toWireAnswer(answer(p),p);w.s[0].p=index;assert.throws(()=>expandWireAnswer(w,p));
});
test('a valid integer outside the actual dictionary is also rejected',async()=>{
 const p=await packet(),w=toWireAnswer(answer(p),p);w.s[0].p=255;assert.throws(()=>expandWireAnswer(w,p),/REFERENCE_INVALID/);
});
test('compact transport still rejects invented numerical values and mismatched identity',async()=>{
 const p=await packet(),w=toWireAnswer(answer(p),p);w.s[0].v=999;
 assert.throws(()=>validateAnswer(expandWireAnswer(w,p),p),/EVIDENCE_VALUE/);
 w.c='another';assert.throws(()=>validateAnswer(expandWireAnswer(w,p),p),/IDENTITY/);
});
test('paid request requires compact format; canonical-shaped mock cannot pass as a new API response',async()=>{
 const p=await packet();assert.throws(()=>parseApiResponse(rawResponse(answer(p)),p));
});
test('same snapshot, same evidence references and no identity-dependent cache key',async()=>{
 const p=await packet(),q=await packet(candidate('other'));assert.deepEqual(compactInput(p).evidence_refs,compactInput(q).evidence_refs);
 // V4 baseline profile stays byte-compatible for A/B measurement.
 const a=payloadFor(p,'V4'),b=payloadFor(q,'V4');assert.equal(a.prompt_cache_key,b.prompt_cache_key);
 assert.equal(a.model,'gpt-5.4-mini-2026-03-17');assert.equal(a.reasoning.effort,'none');assert.equal(a.service_tier,'default');assert.equal(a.max_output_tokens,1800);
 assert.deepEqual(a.text.format.schema,WIRE_OUTPUT_SCHEMA_V4);assert.notDeepEqual(a.input[1],b.input[1]);
 // Production profile: same model/effort/tier, stable prefix, identity-free cache key.
 const x=payloadFor(p),y=payloadFor(q);assert.equal(x.prompt_cache_key,y.prompt_cache_key);assert.equal(x.input[0].content,y.input[0].content);
 assert.equal(x.model,a.model);assert.equal(x.reasoning.effort,'none');assert.equal(x.service_tier,'default');assert.deepEqual(x.tools,[]);
 assert.ok(!x.prompt_cache_key.includes(p.candidate_id));assert.notDeepEqual(x.input[1],y.input[1]);
});
test('public candle cache coalesces simultaneous reads and preserves availability timestamps',async()=>{
 const c=new CandleReadCache();let calls=0,clock=100,release;const wait=new Promise(r=>release=r);
 const load=async()=>{calls++;await wait;return {rows:[[1]],requestedAt:100,receivedAt:110};};
 const a=c.read('same-closed-bar',load,()=>clock),b=c.read('same-closed-bar',load,()=>clock);await flush();assert.equal(calls,1);clock=110;release();
 const [x,y]=await Promise.all([a,b]);assert.deepEqual(x,y);x.rows[0][0]=999;assert.equal(y.rows[0][0],1);
 clock=200;const z=await c.read('same-closed-bar',load,()=>clock);assert.equal(calls,1);assert.equal(z.requestedAt,100);assert.equal(z.receivedAt,110);
});
test('cache never reuses a different closed-bar URL or an expired read',async()=>{
 const c=new CandleReadCache();let clock=100,calls=0;const load=async()=>{calls++;return {rows:[],requestedAt:clock,receivedAt:clock};};
 await c.read('end=one',load,()=>clock);await c.read('end=two',load,()=>clock);clock=1200;await c.read('end=one',load,()=>clock);assert.equal(calls,3);
});
test('failed cached public fetch is evicted rather than becoming healthy data',async()=>{
 const c=new CandleReadCache();await assert.rejects(c.read('x',async()=>{throw Error('NETWORK');},()=>100));assert.equal(c.entries.size,0);
 const x=await c.read('x',async()=>({rows:[],requestedAt:100,receivedAt:100}),()=>100);assert.deepEqual(x.rows,[]);
});
test('two different candidates share only the identical BTC candle read: six requests become five',async()=>{
 const seen=[];const fetchFn=async url=>{seen.push(url);const u=new URL(url),iv=u.searchParams.get('interval')==='5m'?300000:60000;
 return new Response(JSON.stringify(bars(Number(u.searchParams.get('limit')),iv)));};
 const a=decisionIdentity(candidate('a')),b={...decisionIdentity(candidate('b')),symbol:'OTHERUSDT'};
 const results=await Promise.all([a,b].map(x=>collectMarket(x,{fetchFn,now:()=>T+1000,deadlineMs:T+9000})));
 assert.equal(seen.length,5);assert.ok(results.every(x=>x.quality.complete));
});
test('pending API never yields the observation loop; saved valid PASS may yield once',async()=>{
 let release;const hold=new Promise(r=>release=r),c=service({hold}),db={};setTestCoordinator(db,c);
 await gptFilterExecutable(db,[candidate()]);assert.equal(gptReviewReadyToResume(db),false);
 release();await Promise.all([...c.pending.values()]);assert.equal(gptReviewReadyToResume(db),true);assert.equal(gptReviewReadyToResume(db),false);
 assert.equal(c.check(candidate()).allowed,false);
 assert.equal((await c.consider(candidate())).allowed,true);
});
for(const decision of ['VETO','ABSTAIN'])test(decision+' never interrupts protection for a retry',async()=>{
 const c=service({decision}),db={};setTestCoordinator(db,c);await gptFilterExecutable(db,[candidate()]);await Promise.all([...c.pending.values()]);assert.equal(gptReviewReadyToResume(db),false);
});
test('storage failure cannot produce an actionable wake hint',async()=>{
 const store=new MemoryReviewStore();store.complete=async()=>{throw Error('DB_FAILURE');};const c=service({store}),db={};setTestCoordinator(db,c);
 await gptFilterExecutable(db,[candidate()]);await Promise.all([...c.pending.values()]);assert.equal(gptReviewReadyToResume(db),false);
});
test('expired PASS cannot interrupt X1 or extend signal validity',async()=>{
 let now=T+1000;const c=service({now:()=>now}),db={};setTestCoordinator(db,c);await gptFilterExecutable(db,[candidate()]);await Promise.all([...c.pending.values()]);now=T+17000;assert.equal(gptReviewReadyToResume(db),false);
});
for(const mode of ['OFF','SHADOW'])test(mode+' has no ready-yield effect',async()=>{
 const c=service({mode}),db={};setTestCoordinator(db,c);c.yieldArmed=true;c.readyHints.set('fake',{validUntil:T+15000});assert.equal(gptReviewReadyToResume(db),false);
});
test('virtual protection loop yields after a completed observation; ordinary leased cycle rechecks',async()=>{
 let clock=T+1000,resolveApi,held=false,runs=0;const hold=new Promise(r=>resolveApi=r),c=service({now:()=>clock,hold}),db={},events=[];setTestCoordinator(db,c);
 const first=async()=>{held=true;runs++;
   if(runs===2){events.push('second-cycle-protection');const out=await gptFilterExecutable(db,[candidate()]);assert.equal(out.candidates.length,1);events.push('original-guards-rechecked');held=false;return {ok:true,entry:{entered:false,reason:'TEST_NO_ORDER'}};}
   const out=await gptFilterExecutable(db,[candidate()]);
   for(let t=2;t<47;t++){clock=T+t*1000;events.push('protection-complete-'+t);if(t===4){resolveApi();await Promise.all([...c.pending.values()]);}if(gptReviewReadyToResume(db)){events.push('yield-after-protection');break;}}
   held=false;events.push('lease-released');return {ok:true,entry:{entered:false,reason:out.reason}};
 };
 const originalWait=c.waitReady.bind(c);c.waitReady=()=>{assert.equal(held,false);return originalWait();};
 await runWithGptReview(db,first);assert.equal(runs,2);assert.equal(clock,T+4000);
 assert.ok(events.indexOf('yield-after-protection')>events.indexOf('protection-complete-4'));
 assert.ok(events.indexOf('second-cycle-protection')>events.indexOf('lease-released'));
});
test('only two reversible executor wiring hooks; no exit policy or financial controls changed',()=>{
 assert.equal(FAST_HOOKS.length,2);const text=JSON.stringify(FAST_HOOKS);
 assert.ok(!/circuit_open=false|pause_new_entries|stopPct|trailGapPct|targetMarginUsdt|MAX_SLOTS=/.test(text));
 assert.match(FAST_HOOKS[1].to,/every detected protection action finish/);
 const path=new URL('../../../supabase/functions/v10-lane-executor/index.ts',import.meta.url);
 if(existsSync(path)){
   let source=readFileSync(path,'utf8');
   // FD1 + CEC-advisory hooks, V30 live-front hooks, then V5 operator/recovery hooks are removed; nothing else may differ.
   for(const h of [...FD1_HOOKS].reverse()){assert.equal(source.split(h.to).length,2);source=source.replace(h.to,h.from);}
   for(const h of [...V30_HOOKS].reverse()){assert.equal(source.split(h.to).length,2);source=source.replace(h.to,h.from);}
   for(const h of [...V5_HOOKS].reverse()){assert.equal(source.split(h.to).length,2);source=source.replace(h.to,h.from);}
   for(const h of [...FAST_HOOKS].reverse()){assert.equal(source.split(h.to).length,2);source=source.replace(h.to,h.from);}
   assert.equal(blob(source),EXPECTED_EXECUTOR_BLOB);
 }
});
