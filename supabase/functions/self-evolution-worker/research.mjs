import {hash} from '../_shared/gpt-final-decision/api.mjs';
import {reviewTrade,researchCall,REVIEW_VERSION,PROPOSAL_SCHEMA,CRITIQUE_SCHEMA,candidateFrom} from '../_shared/self-evolution/review.mjs';
import {regimeOf,validatePolicy} from '../_shared/self-evolution/policy.mjs';
import {historicalPath} from '../_shared/self-evolution/market.mjs';
import {counterfactual} from '../_shared/self-evolution/replay.mjs';
import {metrics,calibrate,wilson} from '../_shared/self-evolution/statistics.mjs';
const compactDecision=d=>{const r=d.record?.result??{},a=r.arbitration??{};return {id:d.decision_id,stage:d.stage,at:d.snapshot_at,policy_version:d.policy_version,
 packet:d.record?.packet,first:a.first?.answer??null,deepseek:a.deepseek?.answer??null,final:r.answer??null,decision:r.decision,valid:r.valid,error:r.error,
 agreement:a.deepseek_agreement,arbitration_reason:a.arbitration_reason};};
const deepseekPeak=at=>{const d=new Date(at),day=d.getUTCDay(),h=d.getUTCHours();return day>=1&&day<=5&&((h>=1&&h<4)||(h>=6&&h<10));};
const reserveCost=(provider,input)=>{const bytes=new TextEncoder().encode(JSON.stringify(input)).length,inputTokens=Math.ceil(bytes/3),
 raw=provider==='gpt'?(inputTokens*.75+2400*4.5)/1e6:(inputTokens*.3+2400*1.2)/1e6;
 return Math.max(.001,Math.min(.25,Math.ceil(raw*1.25*1e6)/1e6));};
const actualCost=(provider,result,at=Date.now())=>{if(provider==='gpt'){const n=Number(result?.cost_usd);return Number.isFinite(n)&&n>=0?n:0;}
 const u=result?.usage??{},hit=Number(u.prompt_cache_hit_tokens??u.prompt_tokens_details?.cached_tokens??0)||0,
 prompt=Number(u.prompt_tokens??0)||0,miss=Number(u.prompt_cache_miss_tokens??Math.max(0,prompt-hit))||0,out=Number(u.completion_tokens??0)||0,
 mult=deepseekPeak(at)?1:.5;return (hit*.006+miss*.3+out*1.2)*mult/1e6;};
export function researchCaller(store,keys){return async(provider,opts)=>{const key=await hash({provider,kind:opts.kind,input:opts.input,version:REVIEW_VERSION});
 return store.cached(key,async()=>{const reserved=reserveCost(provider,opts.input),reservation=await store.reserve(provider,opts.kind,reserved);
  try{const result=await researchCall(provider,{...opts,apiKey:keys[provider]}),actual=actualCost(provider,result);let budget_settlement_error=null;
   try{if(!await store.settle(reservation,actual,true))budget_settlement_error='SETTLE_REJECTED';}catch(e){budget_settlement_error=String(e?.message??e).slice(0,120);}
   return {...result,cost_usd:actual,budget_reserved_usd:reserved,budget_settlement_error};
  }catch(e){try{await store.settle(reservation,0,false);}catch{}throw e;}});};}
export async function tradeReview(store,id,keys){
 const p=await store.trade(id);if(p.state!=='CLOSED')throw Error('TRADE_NOT_CLOSED');
 const existing=await store.read(store.table('evolution_reviews').select('trade_id').eq('trade_id',id).maybeSingle());if(existing)return {duplicate:true};
 const [journal,fills,capture,path]=await Promise.all([store.journalFor(p),store.fills(id),store.read(store.table('evolution_capture').select('at,received_at,payload').eq('position_id',id).order('at').limit(5000)),
  historicalPath(p.symbol,Date.parse(p.entry_at)-120000,Math.min(Date.now()-1000,Date.parse(p.closed_at)+600000))]);
 const micro=capture.map(x=>({at_ms:Date.parse(x.at),price:Number(x.payload?.book?.mid??x.payload?.mid)})).filter(x=>x.price>0);
 const decisions=journal.slice(-12).map(compactDecision),evidence_ids=['trade:'+id,...decisions.map(d=>d.id),'binance_path:'+id,'fills:'+id];
 const entryFacts=journal.find(d=>d.stage==='ENTRY')?.record?.packet?.facts?.values??{},feeRate=fills.length?fills.reduce((v,f)=>v+Number(f.fee_quote_amount??0),0)/fills.reduce((v,f)=>v+Number(f.price)*Number(f.quantity),0):null;
 const costs={fee_bps:Number.isFinite(feeRate)?2*feeRate*10000:14,spread_bps:entryFacts.spread_bps??null,impact_bps:entryFacts.est_buy_slippage_bps??null};
 const entryCF=counterfactual({at_ms:Date.parse(p.entry_at),price:Number(p.entry_price),path:micro,...costs});
 const exitCF=counterfactual({at_ms:Date.parse(p.closed_at),price:Number(p.exit_price),path:micro,...costs});
 const dataset={version:REVIEW_VERSION,evidence_ids,trade:{id:p.id,symbol:p.symbol,entry_at:p.entry_at,closed_at:p.closed_at,entry_price:p.entry_price,exit_price:p.exit_price,
  quantity:p.original_quantity,realized_net_usdt:p.realized_pnl_usdt,entry_fee:p.entry_fee_usdt,exit_reason:p.exit_reason,hard_stop:p.hard_stop_price},fills,
  decisions,observed_price_path:path.candles,actual_micro_path:micro,
  quantitative:{realized_net_usdt:Number(p.realized_pnl_usdt),entry_counterfactual:entryCF,exit_counterfactual:exitCF,
   funding_history:path.funding,candle_resolution_ms:path.resolution_ms,coverage_complete:path.coverage_complete,
   limitations:['Historical candle data cannot recover missing second-level book or fills. Missing costs/seconds stay null. Counterfactual is conditional, not proven executable.']},
  missing_decisions:journal.length===0,total_decisions:journal.length,shown_decisions:decisions.length};
 // Keep the recent full trajectories; older decisions still remain in the immutable journal.
 while(JSON.stringify(dataset).length>190000&&dataset.decisions.length>2)dataset.decisions.shift();
 const review=await reviewTrade(dataset,{keys,call:researchCaller(store,keys)});
 const policyVersion=journal.find(d=>d.stage==='ENTRY')?.policy_version??'LEGACY_UNVERSIONED',regime=regimeOf(journal[0]?.record?.packet?.facts);
 await store.write('evolution_reviews',{trade_id:id,dataset_hash:review.dataset_hash,dataset,review,policy_version:policyVersion,realized_net_usdt:p.realized_pnl_usdt,regime});
 const reviewed=await store.read(store.table('evolution_reviews').select('trade_id').limit(200));
 // Batch keys prevent a full backfill queue starving the first useful pattern review.
 if(reviewed.length===2||reviewed.length%20===0)await store.enqueue('patterns:batch:'+Math.floor(reviewed.length/20),'PATTERN_REVIEW',{},12);
 return {trade_id:id,gpt:review.reviews[0].valid,deepseek:review.reviews[1].valid,cross_critique:review.critiques.length,decisions:journal.length,net_usdt:p.realized_pnl_usdt};
}
export async function patternReview(store,keys,{full=false,failed_policy=null}={}){
 const rows=await store.read(store.table('evolution_reviews').select('*').order('created_at',{ascending:false}).limit(200));
 if(rows.length<2)return {waiting:'MORE_REVIEWED_TRADES',n:rows.length};
 const groups=new Map();for(const r of rows){const tags=[...new Set(r.review.reviews.flatMap(x=>x.output.taxonomy))];for(const tag of tags){
  if(!/^[A-Z][A-Z0-9_]{2,59}$/.test(tag))continue;const k=tag+':'+r.regime;const a=groups.get(k)??{tag,regime:r.regime,rows:[]};a.rows.push(r);groups.set(k,a);}}
 const patterns=[];for(const [key,g]of groups){const n=g.rows.length,w=g.rows.filter(r=>Number(r.realized_net_usdt)>0),stats=wilson(w.length,n),net=g.rows.reduce((s,r)=>s+Number(r.realized_net_usdt),0);
  const id='PAT_'+(await hash(key)).slice(0,24),data={pattern_id:id,category:g.tag,regime:g.regime,conditions:{source:'DUAL_REVIEW_TAXONOMY',association_only:true},sample_count:n,hit_rate:stats.accuracy,
   estimated_pnl_impact:net/n,confidence:Math.max(0,1-(stats.upper-stats.lower)),supporting_trade_ids:g.rows.map(r=>r.trade_id),contradicting_trade_ids:rows.filter(r=>r.regime===g.regime&&!g.rows.includes(r)).map(r=>r.trade_id),
   status:n<5?'WEAKENING':Math.abs(net)<.01?'INVALIDATED':'ACTIVE',last_seen:new Date().toISOString(),evidence_hash:await hash(g.rows.map(r=>r.dataset_hash))};
  await store.write('evolution_patterns',data,{upsert:true,onConflict:'pattern_id'});patterns.push(data);}
 const active=await store.rpc('evolution_active_policy'),day=new Date().toISOString().slice(0,10),hid='HYP_'+day.replaceAll('-','')+'_'+(await hash({parent:active.bundle.policy_version,failed_policy})).slice(0,12);
 const pending=await store.read(store.table('evolution_policy_states').select('version,state').in('state',['SIMULATING','VALIDATING','HOLDOUT_TEST','QUALIFIED','PROMOTING']));
 if(pending.length)return {patterns:patterns.length,waiting:'FROZEN_CHALLENGER_IN_VALIDATION',challengers:pending};
 const exists=await store.read(store.table('evolution_hypotheses').select('*').eq('id',hid).maybeSingle());
 if(exists){if(exists.state==='REJECTED_SCOPE_VIOLATION')return {patterns:patterns.length,hypothesis:hid,duplicate:true};
  const saved=await store.read(store.table('evolution_policy_bundles').select('version').eq('version',exists.policy_version).maybeSingle());
  if(saved)return {patterns:patterns.length,hypothesis:hid,duplicate:true};
  // Resume interrupted legacy registration using its original evidence cutoff and proposal.
  const cutoff=Date.parse(exists.created_at),outcomes=await store.read(store.table('evolution_outcomes').select('outcome').order('outcome_at',{ascending:false}).limit(1500));
  const candidate=exists.critique?.frozen_candidate??candidateFrom(active.bundle,exists.proposal.output,{version:exists.policy_version,cutoff,calibration:calibrate(outcomes.map(x=>x.outcome),cutoff)});
  return store.rpc('evolution_register_candidate',{p_hypothesis:exists,p_bundle:candidate,p_hash:await hash(candidate)});
 }
 const summary=rows.map(r=>({trade_id:r.trade_id,net:r.realized_net_usdt,regime:r.regime,reviews:r.review.reviews.map(x=>({provider:x.provider,lesson:x.output.lesson,candidate_improvement:x.output.candidate_improvement})),critiques:r.review.critiques.map(x=>({provider:x.provider,output:x.output}))}));
 const input={evidence_ids:rows.map(r=>r.trade_id),patterns,trade_reviews:summary,parent_policy:active.bundle,failed_policy,task:'Propose ONE bounded intelligence interpretation improvement. ENTRY/RECHECK decide BUY/SKIP/ABSTAIN; HOLD/EXIT interpret HOLD/PROTECT/EXIT. Use only allowed stage/rubric/features. No account, sizing, safety, code or time-only forced exit changes. Supporting/contradicting evidence must be exact supplied trade IDs.'};
 const call=researchCaller(store,keys),proposals=await Promise.all(['gpt','deepseek'].map(provider=>call(provider,{kind:'HYPOTHESIS',input,schema:PROPOSAL_SCHEMA})));
 for(const p of proposals)if([...p.output.supporting_evidence,...p.output.contradicting_evidence].some(id=>!input.evidence_ids.includes(id)))throw Error('HYPOTHESIS_EVIDENCE_MISMATCH');
 const critiques=await Promise.all(['gpt','deepseek'].map((provider,i)=>call(provider,{kind:'HYPOTHESIS_CRITIQUE',schema:CRITIQUE_SCHEMA,input:{...input,own_proposal:proposals[i].output,other_proposal:proposals[1-i].output}})));
 const cutoff=Date.now(),version='POLICY_'+day.replaceAll('-','')+'_'+(await hash(proposals)).slice(0,16);
 const outcomeRows=await store.read(store.table('evolution_outcomes').select('outcome').order('outcome_at',{ascending:false}).limit(1500));
 let candidate,state='PROPOSED',error=null;
 try{candidate=candidateFrom(active.bundle,proposals[0].output,{version,cutoff,calibration:calibrate(outcomeRows.map(x=>x.outcome),cutoff)});validatePolicy(candidate);}catch(e){state='REJECTED_SCOPE_VIOLATION';error=String(e.message);}
 const hypothesis={id:hid,description:proposals[0].output.hypothesis,proposal:proposals[0],critique:{cross_critiques:critiques,independent_proposal:proposals[1],frozen_candidate:candidate??null,synthesis:'Both independent proposals retained. Challenger freezes GPT proposal; no automatic preference vote.',error},supporting_patterns:patterns.map(p=>p.pattern_id),policy_version:candidate?version:null,state};
 if(candidate)return store.rpc('evolution_register_candidate',{p_hypothesis:hypothesis,p_bundle:candidate,p_hash:await hash(candidate)});
 await store.write('evolution_hypotheses',hypothesis);
 await store.write('evolution_events',{kind:state==='REJECTED_SCOPE_VIOLATION'?state:'CHALLENGER_FROZEN',policy_version:candidate?version:null,details:{hypothesis:hid,reviewed_trades:rows.length,full,failed_policy}});
 return {patterns:patterns.length,hypothesis:hid,policy_version:candidate?version:null,state};
}

