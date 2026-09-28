// Read-only replay. Paths are local exports, never API credentials. No model or order calls.
// node ops/leader20/replay-batch-audit.mjs <evidence-directory> <output.json>
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {buildBatch,unpackSymbol,TIME_COLUMNS} from '../../supabase/functions/_shared/leader20/batch.mjs';
import {entryCaptureSafety} from '../../supabase/functions/_shared/gpt-final-decision/dynamic-flow.mjs';
const folder=resolve(process.argv[2]),read=async f=>JSON.parse(await readFile(join(folder,f),'utf8'));
const stats=a=>{a=a.filter(Number.isFinite).sort((x,y)=>x-y);return {n:a.length,mean:a.reduce((s,x)=>s+x,0)/a.length,
 p50:a[Math.ceil(a.length*.5)-1],p95:a[Math.ceil(a.length*.95)-1],max:a.at(-1),sum:a.reduce((s,x)=>s+x,0)};};
const probes=await Promise.all([1,2,3].map(async n=>(await read(`batch-probe-${n}.json`))[0].content));
const packets=[...(await read('probe-packets.json')).map(r=>r.packet),...(await read('probe3-packet.json')).map(r=>r.packet)];
const restore=packets.map(b=>({hash:b.batch_hash,symbols:b.symbols.map(s=>{
 const trajectory=unpackSymbol(b,s),last=trajectory.at(-1);
 assert.equal(trajectory.length,24);
 for(let i=1;i<24;i++)assert.equal(trajectory[i].bucket_ms-trajectory[i-1].bucket_ms,5000);
 // Exact round trip of the measured wire, including absolute time reconstruction.
 assert.deepEqual(trajectory.map(p=>b.columns.map(k=>p[k]!==null&&TIME_COLUMNS.has(k)?p[k]-s.time_origin_ms:p[k])),s.matrix);
 return {id:s.id,last_ms:last.end_ms,buckets:24};})}));
const reviews=await read('reviews-3d.json'),prod=reviews.filter(r=>r.purpose==='PRODUCTION');
const dsDecision=r=>r.deepseek?.decision_preference??r.deepseek?.answer?.decision_preference??r.deepseek?.answer?.recommended_action;
const paired=prod.filter(r=>r.task==='ENTRY'&&r.valid===true&&r.deepseek?.valid===true),buys=paired.filter(r=>r.decision==='BUY');
const missed=buys.filter(r=>dsDecision(r)==='SKIP');
const history=await read('skip-buy-replay-packets.json');
const historySafety=history.map(r=>{const at=Number(r.final_at??r.at),raw=r.packet?.facts?.capture_context;
 // Stored packets already contain the validated context, without the raw RPC's
 // top-level ingestion field. Recheck its causal buckets directly; never invent it.
 const s=entryCaptureSafety(raw,at);
 return {job_key:r.job_key,symbol:r.symbol,at,capture_end:raw?.end_ms,buckets:raw?.trajectory?.length??0,safety:s};});
const ds=stats(probes.map(p=>p.result.cost_usd)),uncached=stats(probes.map(p=>p.result.uncached_peak_usd));
const count=probes.flatMap(p=>p.result.results).reduce((o,r)=>(o[r.decision]=(o[r.decision]??0)+1,o),{});
const cost=u=>u?.input_tokens!=null&&u?.output_tokens!=null?((u.input_tokens-(u.input_tokens_details?.cached_tokens??0))*.75+(u.input_tokens_details?.cached_tokens??0)*.075+u.output_tokens*4.5)/1e6:null;
const finalStats=stats(prod.filter(r=>r.task==='ENTRY').map(r=>cost(r.usage)));
const recent=prod.filter(r=>r.task==='ENTRY'&&Date.parse(r.created_at)>=Date.parse('2026-09-27T00:00:00Z'));
const recentFinal=stats(recent.map(r=>cost(r.usage)));
const out={order_calls:0,model_calls:0,live_samples:probes.map(p=>({job_key:p.job_key,as_of_ms:p.as_of_ms,batch_size:p.batch_size,
 ready:p.ready,valid_ids:p.result.results.filter(r=>r.valid).length,input_tokens:p.result.input_tokens,output_tokens:p.result.output_tokens,
 cached_tokens:p.result.cached_input_tokens,cost_peak:p.result.cost_usd,latency_ms:p.result.latency_ms})),
 temporal_replay:restore,historical:{production_records:prod.length,paired_valid_entry:paired.length,gpt_buy:buys.length,
 skip_would_miss:missed.length,skip_miss_fraction:missed.length/buys.length,missed:missed.map(r=>({job_key:r.job_key,symbol:r.symbol})),capture_replay:historySafety,
 limitation:'Historical advisory SKIP veto counterfactual, not measured recall of the new Top10 prompt or profitable trades.'},
 measured_batch:{cost_peak:ds,cost_uncached_peak:uncached,input:stats(probes.map(p=>p.result.input_tokens)),output:stats(probes.map(p=>p.result.output_tokens)),
 latency:stats(probes.map(p=>p.result.latency_ms)),decisions:count,prompt_pass_fraction:(count.PASS??0)/30,
 month_5m:ds.mean*8928,month_10m:ds.mean*4464,month_5m_uncached_max:uncached.max*8928,
 min_minutes_using_100:Math.ceil(44640*uncached.max/100),min_minutes_using_80:Math.ceil(44640*uncached.max/80)},
 gpt_final_existing:{entry_3d:finalStats,entry_since_20260927_utc:recentFinal,
 projected_at_sample_pass_fraction_3d_cost:2880*((count.PASS??0)/30)*finalStats.mean*31,
 projected_at_sample_pass_fraction_recent_cost:2880*((count.PASS??0)/30)*recentFinal.mean*31,
 note:'New batch GPT FINAL path was not paid-tested. Existing FINAL usage excludes GPT FIRST and DeepSeek, and excludes unknown usage.'},
 known_grounding_failure:{job_key:probes[2].job_key,symbol:'SOONUSDT',claimed_net_taker:160508,
 actual_last_net_taker:-8289.893800000014,other_symbol:'NEARUSDT',other_last_net_taker:160508.59700000007},
 deployment_gate:{budget:false,recall:false,grounding:false,concurrent_live_slot_transition:false,allowed:false}};
await writeFile(process.argv[3],JSON.stringify(out,null,2)+'\n');
console.log(JSON.stringify({samples:out.live_samples,misses:out.historical.skip_would_miss,buyDenominator:buys.length,
 historical_valid:historySafety.filter(r=>r.safety.ok).length,measured:out.measured_batch,gpt:out.gpt_final_existing},null,2));
