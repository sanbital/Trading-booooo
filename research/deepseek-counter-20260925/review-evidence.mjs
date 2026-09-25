// Read-only recomputation of inspected development samples; never calibrates a policy.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const sources={};
async function read(path){const b=await readFile(new URL(path,import.meta.url));sources[path]=createHash('sha256').update(b).digest('hex');return JSON.parse(b);}
const replay=await read('live-provider-replay.json'),diagnostics=await read('initial-provider-diagnostics.json');
const providers=rows=>Object.fromEntries(['deepseek-flash','deepseek-v4-pro'].map(model=>{
  const a=rows.flatMap(r=>r.candidates.filter(x=>x.candidate.model===model).map(x=>({task:r.task,...x.counter})));
  return [model,{n:a.length,valid:a.filter(x=>x.valid).length,timeouts:a.filter(x=>x.error==='COUNTER_TIMEOUT').length,
    timeouts_by_task:Object.fromEntries(['ENTRY','HOLD','RECHECK'].map(t=>[t,a.filter(x=>x.task===t&&x.error==='COUNTER_TIMEOUT').length]))}];}));
const outcomes=await read('connection-recheck-outcomes.json'),byKey=new Map(outcomes.map(x=>[x.final_job_key,x]));
const joined=replay.filter(x=>x.task==='RECHECK'&&byKey.get(x.job_key)?.counterfactual_net_usdt!=null).map(x=>{
  const o=byKey.get(x.job_key),f=x.candidates.find(x=>x.candidate.model==='deepseek-flash').counter;
  return {symbol:o.symbol,gpt:x.gpt.valid?x.gpt.decision:'INVALID',flash:f.valid?f.answer.decision:'INVALID',proxy:Number(o.counterfactual_net_usdt)*.75};});
const buys=joined.filter(x=>x.gpt==='BUY'),support=buys.filter(x=>x.flash==='SUPPORT_BUY');
const jobs=await read('../deepseek-temporal-20260925/provider-results.json'),labels=await read('../deepseek-temporal-20260925/development-labels.json');
const labelMap=new Map(labels.rows.map(x=>[x.id,x])),mismatch={with_history:{n:0,disagreements:0},without_history:{n:0,disagreements:0}};
const invalid={A:0,B:0},early=[];
for(const j of jobs){const a=j.result?.arms?.A,b=j.result?.arms?.B;if(!a||!b)continue;
  for(const arm of ['A','B'])if(!j.result.arms[arm].valid)invalid[arm]++;
  if(a.valid&&b.valid){const k=mismatch[j.result.history_count?'with_history':'without_history'];k.n++;k.disagreements+=a.answer.decision_preference!==b.answer.decision_preference;}
  const l=labelMap.get(j.id);if(!l||l.error||l.already_below_stop||!l.baseline_valid||l.baseline_decision!=='HOLD')continue;
  for(const arm of ['A','B'])if(j.result.arms[arm].valid&&j.result.arms[arm].answer.decision_preference==='EXIT')
    early.push({id:j.id,arm,history_count:j.result.history_count,incremental_proxy_usdt:-l.horizons[60].hold_minus_exit_now_usdt});
}
console.log(JSON.stringify({status:'INSPECTED_DEVELOPMENT_NOT_OOS',authority:[],sources,
  replay:providers(replay),diagnostics:providers(diagnostics),recheck:{labelled:joined.length,buy_count:buys.length,
    buy_proxy:buys.reduce((s,x)=>s+x.proxy,0),support_only:support,opposed_positive:joined.filter(x=>['XAIUSDT','SAGAUSDT'].includes(x.symbol)&&x.flash==='OPPOSE_BUY'&&x.proxy>0)},
  temporal:{invalid,disagreement:mismatch,early_exits:early}},null,2));
