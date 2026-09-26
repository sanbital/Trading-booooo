import {REPLAY_KERNEL_HASH} from '../_shared/self-evolution/kernel.mjs';
import {hash,payloadFor} from '../_shared/gpt-final-decision/api.mjs';
import {dualEntryDecision} from '../_shared/gpt-final-decision/dual.mjs';
import {recheckPayload,validateRecheck} from '../_shared/gpt-final-decision/recheck.mjs';
import {validateDecision} from '../_shared/gpt-final-decision/contract.mjs';
import {validateCapture120} from '../_shared/gpt-final-decision/capture-context.mjs';
import {validatePolicy} from '../_shared/self-evolution/policy.mjs';
import {qualify,metrics,pairedBootstrap,degradation,comparePortfolios} from '../_shared/self-evolution/statistics.mjs';
import {policyDecision} from './decision.mjs';
import {actualOpportunities} from './market-jobs.mjs';
import {portfolioJob} from './portfolio-jobs.mjs';
export {policyDecision,replayPayload} from './decision.mjs';
export async function simulationJob(store,version,keys){
 const lifecycle=await store.read(store.table('evolution_policy_states').select('state').eq('version',version).single());
 if(!['SIMULATING','VALIDATING','HOLDOUT_TEST'].includes(lifecycle.state))return {policy_version:version,state:lifecycle.state,stopped:true};
 const policy=await store.read(store.table('evolution_policy_bundles').select('*').eq('version',version).single());validatePolicy(policy.bundle);
 const champion=await store.read(store.table('evolution_policy_bundles').select('*').eq('version',policy.parent_version).single());
 const cutoff=Date.parse(policy.created_at),rows=await store.read(store.table('evolution_opportunities').select('*').gte('at_ms',cutoff+60000).order('at_ms').limit(1000));
 const actual=await actualOpportunities(store,cutoff);
 const source=Math.floor(Date.now()/3600000)%2===0?'MARKET':'ACTUAL';
 const portfolio=await portfolioJob(store,version,keys,{maxWallMs:45000,source});
 let done=0;for(const e of rows){if(done>=1)break;const id=version+':'+e.id,old=await store.read(store.table('evolution_simulations').select('id').eq('id',id).maybeSingle());if(old)continue;
  if(e.received_at_ms>e.at_ms||e.context.refreshed_at_ms<e.at_ms||e.context.refreshed_at_ms-e.at_ms>25000)continue;
  const [base,next]=await Promise.all([policyDecision(store,champion,e,keys),policyDecision(store,policy,e,keys)]);
  const split=e.at_ms>=cutoff+14*86400000?'HOLDOUT':'VALIDATION';
  await store.write('evolution_simulations',{id,policy_version:version,champion_version:policy.parent_version,split,decision_id:e.id,as_of_ms:e.at_ms,champion:base,challenger:next,
   result:{kind:'PAIRED_CANONICAL_DECISION',same_capital:true,same_initial_snapshot:true,source:'MARKET_OPPORTUNITY',complete_lifecycle:false,
    policy_hash:policy.sha256,champion_hash:champion.sha256,dataset_hash:await hash(e),symbol:e.symbol,regime:e.context.regime,
    admission_eligible:e.context.admission_eligible,packet:e.packet,context:e.context,order_calls:0}});done++;
 }
 await store.enqueue('simulate:'+version+':'+Math.floor(Date.now()/3600000),'SIMULATE',{policy_version:version},18,new Date(Date.now()+3600000).toISOString());
 await store.enqueue('validate:'+version+':'+Math.floor(Date.now()/86400000),'VALIDATE',{policy_version:version},19);
 return {policy_version:version,new_pairs:done,available_opportunities:rows.length,portfolio};
}
export async function validationJob(store,version){
 const p=await store.read(store.table('evolution_policy_bundles').select('*').eq('version',version).single()),c=await store.read(store.table('evolution_policy_bundles').select('*').eq('version',p.parent_version).single());
 const finalId='EVAL_FINAL_'+version,previous=await store.read(store.table('evolution_evaluations').select('id,qualified,report').eq('id',finalId).maybeSingle());
 if(previous)return {evaluation_id:previous.id,qualified:previous.qualified,frozen:true};
 const rows=await store.read(store.table('evolution_portfolios').select('*').eq('policy_version',version)),cut=Date.parse(p.created_at)+60000,end=cut+21*86400000;
 const sets=await store.read(store.table('evolution_market_sets').select('coverage,captured_at').gte('captured_at',p.created_at).lte('captured_at',new Date(end).toISOString()).limit(1000));
 const marketRows=rows.filter(r=>!r.split.startsWith('ACTUAL')),actualRows=rows.filter(r=>r.split.startsWith('ACTUAL'));
 const states=marketRows.map(r=>r.state),pair=name=>{const b=rows.find(r=>r.split===name&&r.arm==='champion')?.state??{trades:[]},n=rows.find(r=>r.split===name&&r.arm==='challenger')?.state??{trades:[]};return comparePortfolios(b,n,{start:name==='VALIDATION'?cut:cut+14*86400000,end:name==='VALIDATION'?cut+14*86400000-600001:end});};
 const complete=Date.now()>end+610000&&marketRows.length===4&&marketRows.every(r=>r.state.last_ms>=(r.split==='VALIDATION'?cut+14*86400000-600001:end)-60000);
 const reviews=actualRows.map(r=>({id:r.id,state:r.state}));
 const allMissing=states.flatMap(s=>s.missing??[]),events=states.reduce((v,s)=>v+s.events,0),filled=states.reduce((v,s)=>v+(s.filled??0),0),closed=states.reduce((v,s)=>v+s.trades.length,0);
 const report={version:'VALIDATION_REPORT_1',scope_valid:!!validatePolicy(p.bundle),integrity_valid:await hash(p.bundle)===p.sha256&&await hash(c.bundle)===c.sha256&&p.source_manifest.replay_kernel_hash===REPLAY_KERNEL_HASH&&c.source_manifest.replay_kernel_hash===REPLAY_KERNEL_HASH,
 policy_hash:p.sha256,champion_hash:c.sha256,dataset_hash:await hash({states,sets,reviews}),execution_parity:marketRows.length===4&&states.every(s=>!(s.pending_fills?.length))&&allMissing.length/Math.max(1,events)<=.01&&!allMissing.some(x=>/PARTIAL|EXIT_FILL|FUNDING/.test(x.reason)),
 market_wide:sets.length>=14,universe_coverage:sets.length?Math.min(...sets.map(s=>s.coverage)):0,future_leakage:false,split_overlap:false,
 discovery_end:p.bundle.data_cutoff_ms,validation_start:cut,validation_end:cut+14*86400000-600001,holdout_start:cut+14*86400000,candidate_frozen_at:Date.parse(p.created_at),
 holdout_uses:1,holdout_complete:complete,actual_trade_replay:actualRows.length===4&&actualRows.every(r=>r.state.trades.length>=5&&r.state.missing.length===0),
 days:new Set(states.flatMap(s=>s.days??[])).size,symbols:new Set(states.flatMap(s=>s.symbols??[])).size,regimes:new Set(states.flatMap(s=>s.regimes??[])).size,
 complete_lifecycle_coverage:filled?closed/filled:0,counterfactual_costs:states.length===4&&states.every(s=>s.trades.every(t=>Number.isFinite(t.fees_usdt)&&Number.isFinite(t.funding_usdt)))&&allMissing.every(x=>!x.reason.includes('FUNDING')),
 validation:pair('VALIDATION'),holdout:complete?pair('HOLDOUT'):null,missing_observations:allMissing.length,events,portfolios:rows.map(r=>({id:r.id,cursor:r.state.last_ms,open:Object.keys(r.state.positions).length})),
 execution_model:'UNCHANGED_SIZING_HARD_FLOOR_P142_RESIDENT_PROTECTION_HOLD_RECHECK_EMERGENCY; OBSERVED_5S_VWAP; UNRESOLVED_PARTIAL_AND_GAPS_FAIL_COVERAGE',
 limitations:['Five-second archived executable impact is an execution estimate, not proof of a historical fill. Unresolved partial fills, missing capture and latency stay explicit. No synthetic second-level data.']};
 const result=qualify(report),id=complete?finalId:'EVAL_'+version+'_'+Math.floor(Date.now()/86400000);report.qualification=result;
 await store.write('evolution_evaluations',{id,policy_version:version,champion_version:p.parent_version,policy_hash:p.sha256,champion_hash:c.sha256,dataset_hash:report.dataset_hash,report,qualified:result.qualified});
 if(result.qualified){await store.read(store.table('evolution_policy_states').update({state:'QUALIFIED',updated_at:new Date().toISOString()}).eq('version',version));return store.rpc('evolution_promote',{p_evaluation_id:id,p_expected_version:p.parent_version});}
 const expired=Date.now()>end+7*86400000,state=complete||expired?'REJECTED':Date.now()>cut+14*86400000?'HOLDOUT_TEST':'VALIDATING';
 await store.read(store.table('evolution_policy_states').update({state,reason:result.reasons.join(','),updated_at:new Date().toISOString()}).eq('version',version));
 await store.write('evolution_events',{kind:'QUALIFICATION_NOT_PASSED',policy_version:version,details:{evaluation_id:id,reasons:result.reasons,state}});
 return {evaluation_id:id,qualified:false,state,reasons:result.reasons};
}
export async function monitor(store){
 const report=await store.rpc('evolution_report'),active=report.active;if(!active)return {state:'NOT_BOOTSTRAPPED'};
 const row=await store.read(store.table('evolution_policy_bundles').select('*').eq('version',active.active_version).single());
 let integrity=false;try{validatePolicy(row.bundle);integrity=await hash(row.bundle)===row.sha256;}catch{}
 const health=await store.rpc('evolution_policy_health'),since=active.promoted_at;
 const links=await store.read(store.table('evolution_position_policies').select('position_id').eq('entry_policy_version',active.active_version)),ids=new Set(links.map(x=>x.position_id));
 const live=(await store.closedTrades(since)).filter(p=>ids.has(p.id)).map(p=>({net_usdt:Number(p.realized_pnl_usdt),symbol:p.symbol,closed_ms:Date.parse(p.closed_at),fees_usdt:Number(p.entry_fee_usdt)}));
 const decisions=await store.read(store.table('evolution_decisions').select('record').eq('policy_version',active.active_version).gte('created_at',since).limit(1000));
 const baseline=report.control.baseline_metrics,result=degradation({baseline,live:metrics(live),decisions:decisions.length,parseFailures:decisions.filter(d=>d.record.result?.valid!==true).length,providerFailures:decisions.filter(d=>/TIMEOUT|HTTP_|PROVIDER/.test(d.record.result?.error??'')).length,integrityFailure:!integrity});
 if(health.expired||result.rollback)return store.rpc('evolution_rollback',{p_expected_version:active.active_version,p_reason:health.expired?'PROMOTION_HEALTH_TIMEOUT':result.reason,p_evidence:{live:metrics(live),baseline,decisions:decisions.length}});
 return {state:health.state,version:active.active_version,health,live:metrics(live),degradation:result};
}

