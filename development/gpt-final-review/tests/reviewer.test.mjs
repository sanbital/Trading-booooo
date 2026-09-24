import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {baselineAllowed,decisionIdentity,validateAnswer,parseApiResponse,canonical,MODEL,OUTPUT_SCHEMA,LIMITS,arithmeticCheck} from '../../../supabase/functions/_shared/gpt-final-review/contract.mjs';
import {payloadFor,callFinalReviewer,costOf,API_URL} from '../../../supabase/functions/_shared/gpt-final-review/openai.mjs';
import {buildPacket,computeMarket,normalizeBars} from '../../../supabase/functions/_shared/gpt-final-review/market.mjs';
import {FinalReviewCoordinator,MemoryReviewStore,configFromEnv} from '../../../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
import {gptFilterExecutable,gptFinalCheck,runWithGptReview,setTestCoordinator} from '../../../supabase/functions/v10-lane-executor/gpt-final-review-adapter.mjs';
import {transform,checkedTransform,replacements} from '../apply-current.mjs';
import {T,candidate,bars,marketData,microData,packet,answer,rawResponse,transport,config} from './helpers.mjs';
function service(options={}){
  const requests=options.requests??[],store=options.store??new MemoryReviewStore();
  const c=new FinalReviewCoordinator({config:options.config??config(),store,apiKey:()=> 'TEST_KEY_NOT_A_SECRET',
    now:options.now??(()=>T+1000),fetchFn:options.fetchFn??transport({requests}),market:async()=>marketData(),...options});
  return {c,store,requests};
}
async function completed(c,s=candidate()){await c.consider(s);await Promise.all([...c.pending.values()]);return c.consider(s);}
test('existing valid decision recognized without changing its settings',()=>{const s=candidate();assert.equal(baselineAllowed(s),true);assert.equal(arithmeticCheck(decisionIdentity(s)).consistent,true);});
test('existing rejection is not upgraded',async()=>{const {c,requests}=service();const s=candidate();s.features.b06133.allowed=false;assert.equal((await c.consider(s)).allowed,false);assert.equal(requests.length,0);});
test('CEC effective denial is not upgraded',async()=>{const {c,requests}=service();const s=candidate();s.features.cec0040.effectiveAllowed=false;assert.equal((await c.consider(s)).allowed,false);assert.equal(requests.length,0);});
test('packet includes original BUY decision and its basis',async()=>{const p=await packet();assert.equal(p.original_model.proposed_action,'BUY_LONG');assert.match(p.original_model.decision_basis,/absorption/);assert.ok(p.original_model.metrics.return15m);});
test('does not send raw symbol/account/secrets/PNL from arbitrary feature fields',async()=>{const s=candidate();s.account_id='PRIVATE';s.features.OPENAI_API_KEY='PRIVATE';s.features.pnl=123;s.features.b06133.source.exchange_secret='PRIVATE';const p=await packet(s);const text=JSON.stringify(p);assert.ok(!text.includes('PRIVATE'));assert.ok(!text.includes('TESTUSDT'));assert.ok(!text.includes('pnl'));});
test('strict schema objects all disallow additional fields',()=>{function walk(x){if(!x||typeof x!=='object')return;if(x.type==='object')assert.equal(x.additionalProperties,false);Object.values(x).forEach(v=>Array.isArray(v)?v.forEach(walk):walk(v));}walk(OUTPUT_SCHEMA);});
test('Responses request has strict schema, no tools and server-side auth',async()=>{const requests=[];const p=await packet();const out=await callFinalReviewer(p,{apiKey:'TEST',fetchFn:transport({requests}),now:()=>T+1000,deadlineMs:T+10000});assert.equal(out.decision,'PASS');assert.equal(requests[0].url,API_URL);assert.equal(requests[0].payload.model,MODEL);assert.equal(requests[0].payload.text.format.strict,true);assert.deepEqual(requests[0].payload.tools,[]);assert.equal(requests[0].payload.store,false);assert.ok(requests[0].init.headers.authorization.startsWith('Bearer '));});
test('VETO retained as candidate-specific rejection',async()=>{const wide={bids:[['105','500']],asks:[['106.2','500']]};const {c}=service({fetchFn:transport({decision:'VETO'}),market:async()=>marketData(candidate(),T+1000,microData({book:wide}))});const r=await completed(c);assert.equal(r.allowed,false);assert.equal(r.decision,'VETO');});
test('ABSTAIN does not become PASS',async()=>{const {c}=service({fetchFn:transport({decision:'ABSTAIN'})});assert.equal((await completed(c)).allowed,false);});
test('valid PASS can proceed only to existing guards',async()=>{const {c}=service();assert.equal((await completed(c)).allowed,true);assert.equal(c.check(candidate()).allowed,true);});
test('SHADOW preserves existing queue even with invalid review',async()=>{const {c}=service({config:config('SHADOW'),fetchFn:transport({decision:'VETO'})});assert.equal((await completed(c)).allowed,true);assert.equal(c.check(candidate()).allowed,true);});
test('OFF has no DB/API calls',async()=>{const c=new FinalReviewCoordinator({config:config('OFF'),store:{get(){throw Error('called')}},apiKey:()=>{throw Error('called')}});assert.equal((await c.consider({})).allowed,true);assert.equal(c.check({}).allowed,true);});
test('unknown mode does not silently fail open',()=>{const c=configFromEnv(n=>n==='GPT_FINAL_REVIEW_MODE'?'TYPO':'');assert.equal(c.mode,'ENFORCE');assert.equal(c.modeValid,false);});
test('explicit enforcement approval is required',async()=>{const {c,requests}=service({config:{...config(),enforceApproved:false}});assert.equal((await c.consider(candidate())).allowed,false);assert.equal(requests.length,0);});
test('missing API key makes zero calls',async()=>{const p=await packet();let calls=0;const r=await callFinalReviewer(p,{apiKey:'',fetchFn:()=>{calls++},now:()=>T+1000,deadlineMs:T+10000});assert.equal(calls,0);assert.equal(r.decision,'ABSTAIN');});
test('unapproved budget makes zero calls',async()=>{const {c,requests}=service({config:{...config(),apiBudgetUsd:0}});assert.equal((await c.consider(candidate())).allowed,false);assert.equal(requests.length,0);});
test('candidate mismatch invalidates response',async()=>{const p=await packet(),a=answer(p);a.candidate_id='wrong';assert.throws(()=>validateAnswer(a,p),/IDENTITY/);});
test('snapshot mismatch invalidates response',async()=>{const p=await packet(),a=answer(p);a.snapshot_hash='a'.repeat(64);assert.throws(()=>validateAnswer(a,p),/IDENTITY/);});
test('fabricated field invalidates response',async()=>{const p=await packet(),a=answer(p);a.supporting_evidence[0].field_path='/current_market/metrics/invented';assert.throws(()=>validateAnswer(a,p),/EVIDENCE/);});
test('fabricated numerical observation invalidates response',async()=>{const p=await packet(),a=answer(p);a.supporting_evidence[0].observed_value=999;assert.throws(()=>validateAnswer(a,p),/EVIDENCE/);});
test('changed units invalidate response',async()=>{const p=await packet(),a=answer(p);a.supporting_evidence[0].unit='percent';assert.throws(()=>validateAnswer(a,p),/EVIDENCE/);});
test('numeric prediction in prose is rejected',async()=>{const p=await packet(),a=answer(p);a.summary='예상 승률 90%';assert.throws(()=>validateAnswer(a,p),/NUMERICAL/);});
test('PASS cannot only echo original factors',async()=>{const p=await packet(),a=answer(p);a.supporting_evidence=a.supporting_evidence.map((e,i)=>({...e,field_path:i?'/original_model/factors/volumeTails':'/original_model/factors/absorption',observed_value:true,unit:'boolean'}));assert.throws(()=>validateAnswer(a,p),/TWO_FACTS/);});
test('wrong original arithmetic cannot be confirmed',async()=>{const s=candidate();s.features.b06133.factors.fresh15over30=false;const p=await packet(s);assert.throws(()=>validateAnswer(answer(p),p),/ORIGINAL_CALCULATION/);});
test('missing fresh market data cannot be confirmed',async()=>{const p=await packet();p.current_market.quality.complete=false;assert.throws(()=>validateAnswer(answer(p),p),/CURRENT_INPUT/);});
test('response refusal is not a valid PASS',()=>{assert.throws(()=>parseApiResponse({status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'no'}]}]}),/REFUSAL/);});
test('incomplete response is rejected',()=>{assert.throws(()=>parseApiResponse({status:'incomplete'}),/INCOMPLETE/);});
for(const status of [429,500,401])test('HTTP '+status+' is isolated with no repeat-until-PASS',async()=>{const requests=[];const r=await callFinalReviewer(await packet(),{apiKey:'TEST',fetchFn:transport({requests,status}),now:()=>T+1000,deadlineMs:T+10000});assert.equal(r.decision,'ABSTAIN');assert.equal(requests.length,1);assert.equal(r.error,'HTTP_'+status);});
test('timeout also bounds transports ignoring abort',async()=>{const r=await callFinalReviewer(await packet(),{apiKey:'TEST',fetchFn:()=>new Promise(()=>{}),now:Date.now,deadlineMs:Date.now()+1000,timeoutMs:15});assert.equal(r.error,'API_TIMEOUT');assert.equal(r.api_cost_usd,null);});
test('late PASS is discarded',async()=>{let clock=T+1000;const fetchFn=async(...args)=>{const r=await transport()(...args);clock=T+10000;return r;};const r=await callFinalReviewer(await packet(),{apiKey:'TEST',fetchFn,now:()=>clock,deadlineMs:T+9000});assert.equal(r.valid,false);assert.equal(r.decision,'ABSTAIN');});
test('same decision concurrent across coordinators has one paid request',async()=>{const store=new MemoryReviewStore(),requests=[];let resolve;const hold=new Promise(r=>resolve=r);const f=transport({requests,hold});const a=service({store,fetchFn:f}).c,b=service({store,fetchFn:f}).c;await Promise.all([a.consider(candidate()),b.consider(candidate())]);try{for(let i=0;i<100&&requests.length===0;i++)await new Promise(r=>setTimeout(r,2));assert.equal(store.calls,1);assert.equal(requests.length,1);}finally{resolve();await Promise.all([...a.pending.values(),...b.pending.values()]);}});
test('pending GPT returns promptly and independent management can run',async()=>{let resolve;const hold=new Promise(r=>resolve=r),{c}=service({fetchFn:transport({hold})});const r=await c.consider(candidate());assert.equal(r.reason,'GPT_REVIEW_PENDING');let managed=false;await Promise.resolve().then(()=>managed=true);assert.equal(managed,true);resolve();await Promise.all([...c.pending.values()]);});
test('changing candidate features invalidates cached authorization',async()=>{const {c}=service();await completed(c);const s=candidate();s.features.b06133.source.featureValues.return15m=.05;assert.equal(c.check(s).allowed,false);});
test('claim transition NEW to CLAIMED does not invalidate same decision',async()=>{const {c}=service();await completed(c);const s=candidate();s.status='CLAIMED';assert.equal(c.check(s).allowed,true);});
test('old PASS expires without extending trigger',async()=>{let now=T+1000;const {c}=service({now:()=>now});await completed(c);now=T+17000;assert.equal(c.check(candidate()).allowed,false);});
test('saved decision string is not trusted without raw evidence',async()=>{const {c,store}=service();await completed(c);const row=[...store.rows.values()][0];row.record.result.raw_response.output[0].content[0].text='{}';assert.equal((await c.consider(candidate())).allowed,false);});
test('future completed candles are removed',()=>{const raw=bars(61,60000);raw.push([T,'100','101','99','100','100',T+59999,'1000',1,'50','500']);assert.equal(normalizeBars(raw,60000,T+100).length,61);});
test('bar gaps and duplicate bars are errors',()=>{const raw=bars(5,60000);assert.throws(()=>normalizeBars([...raw,raw[2]],60000,T),/GAP/);assert.throws(()=>normalizeBars(raw.filter((_,i)=>i!==2),60000,T),/GAP/);});
test('unknown usage is not zero cost',()=>assert.equal(costOf({}).usd,null));
test('known token cost is kept in USD',()=>{const x=costOf(rawResponse({}));assert.ok(Math.abs(x.usd-.001425)<1e-12);assert.match(x.basis,/NOT_USDT/);});
test('budget stops additional distinct calls',async()=>{const {c,store}=service({config:{...config(),apiBudgetUsd:.1}});await completed(c);const r=await c.consider(candidate('second'));assert.equal(r.allowed,false);assert.equal(store.calls,1);});
test('adapter filters before signal CLAIMED and never orders',async()=>{const db={}, {c}=service();setTestCoordinator(db,c);const s=candidate();const first=await gptFilterExecutable(db,[s]);assert.equal(first.candidates.length,0);assert.equal(s.status,'NEW');await Promise.all([...c.pending.values()]);assert.equal((await gptFilterExecutable(db,[s])).candidates.length,1);assert.equal(gptFinalCheck(db,s).allowed,true);});
test('resumption waits outside original lease and reuses ordinary cycle',async()=>{const db={};let held=false,runs=0;setTestCoordinator(db,{config:{mode:'ENFORCE'},waitReady:async()=>{assert.equal(held,false);return true;}});const run=async()=>{held=true;runs++;held=false;return {ok:true,entry:{entered:runs===2,reason:'GPT_REVIEW_PENDING'}};};const r=await runWithGptReview(db,run);assert.equal(runs,2);assert.equal(r.entry.entered,true);});
test('no GPT-triggered retry after an ordinary engine rejection',async()=>{const db={};let runs=0;setTestCoordinator(db,{config:{mode:'ENFORCE'},waitReady:()=>{throw Error('must not wait')}});await runWithGptReview(db,async()=>{runs++;return {ok:true,entry:{entered:false,reason:'ENTRY_MARGIN_INSUFFICIENT'}};});assert.equal(runs,1);});
test('local connector patch has five unique narrow regions',()=>{const fixture=replacements.map(r=>r.from).join('\n// untouched original segment\n');const out=transform(fixture);for(const r of replacements)assert.ok(out.includes(r.to));assert.equal((out.match(/untouched original segment/g)||[]).length,4);assert.throws(()=>transform(out),/ALREADY_PATCHED/);});
test('local installer refuses an unverified current source blob',()=>assert.throws(()=>checkedTransform('unknown source'),/BASELINE_CHANGED/));
test('SQL uses private review tables and no trading mutations',()=>{const sql=readFileSync(new URL('../create_review_store.UNAPPLIED.sql',import.meta.url),'utf8');assert.match(sql,/SECURITY INVOKER/);assert.match(sql,/ENABLE ROW LEVEL SECURITY/);assert.match(sql,/REVOKE ALL/);assert.ok(!/UPDATE public\.(v11|trading_)|ALTER TABLE public\.(v11|trading_)/.test(sql));});
test('trade constants, exits and native protection have no replacement patch',()=>{const text=JSON.stringify(replacements);assert.ok(!/maxHoldMs|stopPct|trailGapPct|NATIVE_STOP_ENABLED|SETUP_MAX_CONCURRENT|const MARGIN|const MAX_SLOTS/.test(text));});
test('PASS requires checking original active branch, not current movement only',async()=>{const p=await packet(),a=answer(p);a.checked_claims=a.checked_claims.filter(c=>c.claim_id==='CURRENT_REACCELERATION');assert.throws(()=>validateAnswer(a,p),/ORIGINAL_CLAIM/);});
test('missing original taker share cannot become measured zero',async()=>{const s=candidate();s.features.b06133.source.prebars[0].takerBuyQuote=null;const p=await packet(s);assert.equal(p.original_model.arithmetic_check.expected.absorption,null);assert.throws(()=>validateAnswer(answer(p),p),/ORIGINAL_FACTS/);});
test('failed stored revalidation clears prior valid ticket',async()=>{const {c,store}=service();await completed(c);assert.equal(c.check(candidate()).allowed,true);[...store.rows.values()][0].record.result.raw_response.output[0].content[0].text='{}';await c.consider(candidate());assert.equal(c.check(candidate()).allowed,false);});
test('market collector ends at closed candles, retaining required complete counts',async()=>{
  const {collectMarket}=await import('../../../supabase/functions/_shared/gpt-final-review/market.mjs');const seen=[];
  const market=await collectMarket(decisionIdentity(candidate()),{now:()=>T+20000,deadlineMs:T+30000,fetchFn:async(url)=>{
    const u=new URL(url),n=Number(u.searchParams.get('limit')),iv=u.searchParams.get('interval')==='5m'?300000:60000;
    seen.push(u);return new Response(JSON.stringify(bars(n,iv)));}});
  assert.equal(seen.length,3);for(const u of seen)assert.equal(Number(u.searchParams.get('endTime')),T-1);assert.equal(market.quality.complete,true);
});
test('local journal persists deduplication across store instances',async()=>{
  const {FileReviewStore}=await import('../file-store.mjs'),{mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
  const dir=mkdtempSync(join(tmpdir(),'gpt-journal-')),a=new FileReviewStore(dir),b=new FileReviewStore(dir),key='a'.repeat(64);
  try{const one=await a.claim(key,{result:null},config());assert.equal(one.created,true);assert.equal((await b.claim(key,{result:null},config())).created,false);await a.snapshot(key,one.row.owner,{packet:'TEST'});await a.save(key,one.row.owner,'DONE',{decision:'TEST'});assert.equal((await b.get(key)).state,'DONE');await assert.rejects(b.save(key,one.row.owner,'DONE',{}),/CAS/);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('local runner cannot call API without explicit option',async()=>{const {main}=await import('../review-once.mjs');await assert.rejects(main([]),/EXPLICIT_API_CALL_REQUIRED/);});
test('SHADOW adapter does not await even journal I/O',async()=>{let complete;const waiting=new Promise(r=>complete=r),db={};const scheduled=[];setTestCoordinator(db,{config:{mode:'SHADOW'},consider:()=>waiting,schedule:p=>scheduled.push(p)});const s=candidate(),r=await gptFilterExecutable(db,[s]);assert.deepEqual(r.candidates,[s]);assert.equal(scheduled.length,1);complete();await Promise.all(scheduled);});
test('review purpose is part of the job binding (no cross-purpose reuse)',async()=>{
  const store=new MemoryReviewStore(),requests=[];
  const a=service({store,requests,purpose:'PRODUCTION'}).c,b=service({store,requests,purpose:'DRYRUN'}).c;
  await completed(a);await completed(b);assert.equal(requests.length,2);assert.equal(store.rows.size,2);
  assert.notEqual(await a.binding,await b.binding);
});
