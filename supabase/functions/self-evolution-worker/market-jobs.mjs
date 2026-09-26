import {marketUniverse,historicalPath} from '../_shared/self-evolution/market.mjs';
import {scanMarket} from '../_shared/leader-market-v17.mjs';
import {readSources} from '../_shared/gpt-final-decision/market.mjs';
import {computeFacts,modelJudgments} from '../_shared/gpt-final-decision/facts.mjs';
import {buildDecisionPacket,hash} from '../_shared/gpt-final-decision/api.mjs';
import {counterfactual} from '../_shared/self-evolution/replay.mjs';
import {regimeOf} from '../_shared/self-evolution/policy.mjs';
export async function marketScan(store){
 const start=Date.now(),universe=await marketUniverse(),observations=[];
 // Reuse current production candidate discovery. Intercept public candle reads to retain causal input.
 const fetchFn=async(url,opts)=>{const r=await fetch(url,opts);if(r.ok&&String(url).includes('/klines?')){
   const copy=r.clone(),data=await copy.json(),u=new URL(url);observations.push({symbol:u.searchParams.get('symbol'),interval:u.searchParams.get('interval'),end_ms:Number(u.searchParams.get('endTime')),rows:data});}return r;};
 const scan=await scanMarket({fetchFn,now:Date.now(),concurrency:4,maxWeight:1600,timeoutMs:75000});
 const roster=universe.universe.map(s=>({symbol:s.symbol,onboard_ms:s.onboard_ms,filters:s.filters}));
 const id='MARKET_'+start,dataset_hash=await hash({roster,observations,scan});
 await store.write('evolution_market_sets',{id,captured_at:new Date(start).toISOString(),source:'PRODUCTION_SCANNER_FULL_BINANCE_USDT_PERPETUAL',
  manifest:{version:1,start_ms:start,end_ms:Date.now(),raw_candle_hash:await hash(observations),expected:scan.expected,evaluated:scan.evaluated,excluded:scan.excluded,
   selection:'UNCHANGED_PRODUCTION_SCANNER',order_calls:0,point_in_time_universe:true},roster,scan:{...scan,observations},coverage:scan.coverage,dataset_hash});
 // One job per actually discovered symbol, not a list restricted to previously traded assets.
 for(const f of scan.top10??[])await store.enqueue('opportunity:'+id+':'+f.symbol,'MARKET_SCAN',{market_set_id:id,symbol:f.symbol,feature:f,
   eligible:(scan.candidates??[]).some(c=>c.symbol===f.symbol),roster:roster.find(s=>s.symbol===f.symbol)},12);
 return {market_set_id:id,expected:scan.expected,evaluated:scan.evaluated,coverage:scan.coverage,leaders:scan.top10?.length,candidates:scan.candidates?.length,blocked:scan.blocked??null};
}
export async function opportunity(store,job){
 const {symbol,feature,market_set_id}=job,asof=Date.now(),initial=await readSources(symbol,asof,{mode:'LIVE',ms:2500}),at=Date.now();
 const facts=computeFacts(initial.src,{asOf:at,referenceClose:feature.referenceClose??feature.close,dayReturn:feature.dayReturn,rank:feature.rank});
 const packet=await buildDecisionPacket({task:'ENTRY',subjectId:'opportunity:'+market_set_id+':'+symbol,symbol,dataMode:'LIVE',facts,judgments:modelJudgments(feature)});
 const refresh=await readSources(symbol,Date.now(),{mode:'LIVE',ms:2500}),refreshedAt=Date.now();
 const refreshed=await buildDecisionPacket({task:'ENTRY',subjectId:'opportunity:'+market_set_id+':'+symbol,symbol,dataMode:'LIVE',
  facts:computeFacts(refresh.src,{asOf:refreshedAt,referenceClose:feature.referenceClose??feature.close,dayReturn:feature.dayReturn,rank:feature.rank}),judgments:modelJudgments(feature)});
 const id=market_set_id+':'+symbol;
 await store.write('evolution_opportunities',{id,market_set_id,symbol,at_ms:at,received_at_ms:at,packet,
  context:{source:'MARKET',feature,admission_eligible:job.eligible,filters:job.roster?.filters,initial_src:initial.src,initial_errors:initial.errors,refreshed_packet:refreshed,
   refreshed_at_ms:refreshedAt,refreshed_src:refresh.src,refresh_errors:refresh.errors,regime:regimeOf(facts),input_hash:await hash(packet),order_calls:0}});
 return {id,symbol,capture:packet.facts.capture_context?.status??'UNAVAILABLE',initial_at_ms:at,refresh_at_ms:refreshedAt};
}
export async function matureOutcomes(store){
 const rows=await store.read(store.table('evolution_decisions').select('*').lt('snapshot_at',new Date(Date.now()-610000).toISOString()).order('snapshot_at',{ascending:false}).limit(600));
 let written=0;for(const d of rows){if(written>=8)break;const old=await store.read(store.table('evolution_outcomes').select('decision_id').eq('decision_id',d.decision_id).maybeSingle());if(old)continue;
  const at=Date.parse(d.snapshot_at),end=at+610000,frames=await store.read(store.table('evolution_market_frames').select('at,payload').eq('symbol',d.symbol).gte('at',d.snapshot_at).lte('at',new Date(end).toISOString()).order('at').limit(2000));
  const points=[...new Map(frames.map(f=>[f.at,{at_ms:Date.parse(f.at),price:Number(f.payload.mid)}])).values()].filter(x=>x.price>0);
  const packet=d.record.packet,r=d.record.result,a=r?.arbitration??{},price=Number(packet?.execution_ref?.mid??packet?.current_ref?.mid??points[0]?.price);
  const cf=price>0?counterfactual({at_ms:at,price,path:points,spread_bps:packet.facts?.values?.spread_bps??null,impact_bps:packet.facts?.values?.est_buy_slippage_bps??null}):null;
  let candles=null;if(!cf?.horizons[60])candles=await historicalPath(d.symbol,at,end,{maxPages:1});
  // 1m outcomes can explain a trade, but never silently substitute for an exact +60s label.
  const output={decision_id:d.decision_id,stage:d.stage,regime:regimeOf(packet.facts),gpt:a.initial_gpt_decision??null,deepseek:a.deepseek_valid?a.deepseek_preference:null,
   final:r.decision,valid:r.valid,agreement:a.deepseek_agreement,net_return_60s:cf?.horizons[60]?.net_bps??null,outcome_at_ms:end,
   quantitative:cf,candle_path:candles,coverage:cf?.horizons[600]?'SECOND_LEVEL_OBSERVED':'PARTIAL_OR_CANDLE_ONLY'};
  await store.write('evolution_outcomes',{decision_id:d.decision_id,outcome:output,outcome_at:new Date(end).toISOString()});written++;
 }return {outcomes:written};
}

/** Actual-trigger replay uses the recorded pre-trade packet, never the realized outcome as an input. */
export async function actualOpportunities(store,cutoff){
 const trades=await store.closedTrades(new Date(cutoff).toISOString());let added=0;
 for(const p of trades.slice(-30)){
  if(Date.parse(p.entry_at)<cutoff)continue;
  const decisions=await store.journalFor(p),d=decisions.find(d=>['ENTRY','RECHECK'].includes(d.stage)&&d.record.result?.valid&&d.record.result?.decision==='BUY');
  if(!d||d.stage==='RECHECK')continue;
  const market=await store.read(store.table('evolution_market_sets').select('id,roster').lte('captured_at',d.snapshot_at).order('captured_at',{ascending:false}).limit(1));
  const spec=market[0]?.roster?.find(s=>s.symbol===p.symbol);if(!spec)continue;
  const fills=await store.fills(p.id),verified=fills.some(f=>f.side==='BUY'&&Number(f.quantity)>0)&&fills.some(f=>f.side==='SELL'&&Number(f.quantity)>0);
  const at=Date.parse(d.snapshot_at),id='ACTUAL_'+p.id;
  const inserted=await store.write('evolution_opportunities',{id,market_set_id:market[0].id,symbol:p.symbol,at_ms:at,received_at_ms:at,packet:d.record.packet,
   context:{source:'ACTUAL',trade_id:p.id,actual_execution_verified:verified,admission_eligible:true,filters:spec.filters,feature:{},regime:regimeOf(d.record.packet.facts),
    refreshed_packet:d.record.result.final_packet??d.record.packet,refreshed_at_ms:d.record.result.final_snapshot_at_ms??at,order_calls:0}});if(inserted)added++;
 }
 return {actual_opportunities:added};
}
