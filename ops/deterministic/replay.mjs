/** Causal archive replay. No API clients, credentials, DB writes or venue orders.
 * Usage: node ops/deterministic/replay.mjs <entry50.json> <archive.json> <candles.json> <output.json>
 * Historical user/account data are inputs outside the repository, never committed fixtures.
 */
import fs from 'node:fs';import {performance} from 'node:perf_hooks';
import {normalizeCapture,completedFeatures,mergeSnapshot} from '../../supabase/functions/_shared/deterministic/features.mjs';
import {classifyMarket,decidePosition} from '../../supabase/functions/_shared/deterministic/market-state.mjs';
import {PROFILE} from '../../supabase/functions/_shared/deterministic/calibration.mjs';
const date=x=>Date.parse(x),N=x=>x==null?NaN:Number(x);
export function archiveCapture(rows,at){
 if(rows.length<25)return {status:'UNAVAILABLE',reason:'INCOMPLETE_TRAJECTORY'};
 const last=rows.slice(-25),valid=last.every((x,i)=>{
  const p=x.payload;return ['bucket_complete','book_complete','trade_sequence_complete','coverage_25','flow_causal'].every(k=>p[k]===true)&&
   date(x.received_at)<=at&&date(p.interval_end)<=at&&Math.abs(date(p.interval_end)-date(x.at))<1000&&
   (i===0||date(x.at)-date(last[i-1].at)===5000);
 });
 if(!valid)return {status:'UNAVAILABLE',reason:'INVALID_OR_NONCAUSAL_BUCKET'};
 const points=last.slice(1).map((x,i)=>{
  const p=x.payload,prev=last[i].payload,buy=N(p.buy_quote_5s),sell=N(p.sell_quote_5s),mid=N(p.mid),bd=N(p.bid_25_usdt),ad=N(p.ask_25_usdt),net=buy-sell,
   share=buy+sell>0?buy/(buy+sell):null,oldShare=N(prev.buy_quote_5s)+N(prev.sell_quote_5s)>0?N(prev.buy_quote_5s)/(N(prev.buy_quote_5s)+N(prev.sell_quote_5s)):null;
  return {bucket_ms:date(x.at),start_ms:date(p.interval_start),end_ms:date(p.interval_end),received_at_ms:date(x.received_at),
   exchange_event_ms:date(p.exchange_at),book_received_at_ms:date(p.received_at),flow_event_ms:date(p.trade_event_at),flow_received_at_ms:date(p.trade_received_at),
   mid,start_mid:N(prev.mid),aggressive_buy:buy,aggressive_sell:sell,aggressive_notional:buy+sell,net_taker_quote_5s:net,
   buy_share_5s:share,trade_count:N(p.trade_count),arrival_rate:N(p.trade_count)/(N(p.interval_ms)/1000),
   bid_depth_25_usdt:bd,ask_depth_25_usdt:ad,imbalance:(bd-ad)/(bd+ad),spread_bps:N(p.spread_bps),
   buy_impact_450_bps:(N(p.buy_vwap_450)/mid-1)*10000,sell_impact_450_bps:(1-N(p.sell_vwap_450)/mid)*10000,
   d_mid_bps:(mid/N(prev.mid)-1)*10000,d_bid_depth_25_pct:bd/N(prev.bid_25_usdt)-1,d_ask_depth_25_pct:ad/N(prev.ask_25_usdt)-1,
   d_net_taker_quote:net-(N(prev.buy_quote_5s)-N(prev.sell_quote_5s)),d_buy_share:oldShare===null||share===null?null:share-oldShare,
   bid_book_net_5s:N(p.displayed_bid_added_5s)-N(p.displayed_bid_removed_5s),ask_book_net_5s:N(p.displayed_ask_added_5s)-N(p.displayed_ask_removed_5s),
   btc_return_1m:N(p.btc_return_1m)};
 });
 return normalizeCapture({status:'AVAILABLE',buckets:24,start_ms:points[0].start_ms,end_ms:points.at(-1).end_ms,trajectory:points},at);
}
const compact=d=>({at:new Date(d.at).toISOString(),phase:d.phase,decision:d.decision,structural_strength:d.structural_strength,current_propulsion:d.current_propulsion,
 exhaustion:d.exhaustion,setup:d.setup,trigger:d.trigger,confirmation:d.confirmation,reasons:d.reasons,families:d.families});
export function replay({positions,entries},archive,series){
 const incidents=[],times=[];
 for(const item of archive){
  const historical=positions.find(p=>p.symbol===item.symbol),entry=entries.find(e=>e.signal_id===historical.signal_id),v=entry.facts.values,
   rank=v.signal_rank??entry.leader20?.rank??null,day=v.day_return??v.return_24h??null,
   one=series.series.find(x=>x.symbol===item.symbol&&x.interval==='1m')?.rows,five=series.series.find(x=>x.symbol===item.symbol&&x.interval==='5m')?.rows,btc=series.btc.find(x=>x.key===item.symbol)?.rows;
  let opened=null,previous=null,firstBuy=null,firstWeakening=null,firstProtection=null,estimatedExit=null;
  const observations=[],forcedOwnership=[];
  let oldPrevious=null,handoffExited=false;
  for(let i=24;i<item.rows.length;i++){
   const available=item.rows.slice(0,i+1),at=Math.ceil(Math.max(...available.slice(-25).map(x=>date(x.received_at)),date(item.rows[i].payload.interval_end)))+1,
    capture=archiveCapture(available,at);let facts;
   // Match the live cache's lookback and EMA/RSI seed exactly, without future bars.
   const completed=(rows,n)=>rows?.filter(x=>Number(x[6])<at).slice(-n);
   try{facts=mergeSnapshot(completedFeatures({one:completed(one,121),five:completed(five,49),btc:completed(btc,121),at}),capture,{return24h:day,rank});}catch{facts={values:{},quality:{candles_complete:false}};}
   const input={facts,capture,profile:PROFILE,at,return24h:day},started=performance.now(),decision=classifyMarket(input);times.push(performance.now()-started);
   if(at>=date(entry.created_at)&&at<=date(historical.closed_at)){
    observations.push({...compact(decision),capture_valid:capture.status==='AVAILABLE',capture_reason:capture.reason??null});
    if(!opened&&!estimatedExit&&decision.decision==='BUY'){
     const ask=N(item.rows[i].payload.buy_vwap_450);if(ask>0){
      firstBuy={...compact(decision),estimated_price:ask,price_basis:'ARCHIVED_450_USDT_BOOK_VWAP;NOT_A_FILL'};
      opened={id:'replay',symbol:item.symbol,entry_price:ask,peak_price:ask,entry_at:new Date(at).toISOString(),original_quantity:450/ask,remaining_quantity:450/ask,entry_fee_usdt:.225,hard_stop_price:ask*.975,metadata:{}};
     }
    }
    if(opened){const bid=N(item.rows[i].payload.sell_vwap_450),p=decidePosition({...input,position:opened,bid,previous});
     previous=p;opened.peak_price=p.peak;opened.hard_stop_price=Math.max(opened.hard_stop_price,p.level);
     if(p.weak_families.length>=2&&!firstWeakening)firstWeakening={at:new Date(at).toISOString(),state:p.state,weak_families:p.weak_families};
     if(p.action==='PROTECT'&&!firstProtection)firstProtection={at:new Date(at).toISOString(),state:p.state,level:p.level};
     if(p.action==='EXIT'){estimatedExit={at:new Date(at).toISOString(),state:p.state,reason:p.reason,estimated_price:bid,price_basis:'ARCHIVED_450_USDT_BOOK_VWAP;NOT_A_FILL',return:bid/opened.entry_price-1,mfe:p.mfe,mae:p.mae};opened=null;}
    }
   }
   // Also evaluate ownership hand-off of the ACTUAL historical position. No hindsight peak:
   // peak updates from prior sampled executable bids, starting at the recorded entry price.
   if(!handoffExited&&at>=date(historical.entry_at)&&at<=date(historical.closed_at)){
    const priorPeak=oldPrevious?.peak??Number(historical.entry_price),old={...historical,peak_price:priorPeak,hard_stop_price:oldPrevious?.level??Number(historical.entry_price)*.975,metadata:{}},bid=N(item.rows[i].payload.sell_vwap_450);
    if(bid>0){const p=decidePosition({...input,position:old,bid,previous:oldPrevious});oldPrevious=p;
     if(!forcedOwnership.length||forcedOwnership.at(-1).state!==p.state||p.action==='EXIT')forcedOwnership.push({at:new Date(at).toISOString(),action:p.action,state:p.state,reason:p.reason,estimated_price:bid,mfe:p.mfe,mae:p.mae,weak_families:p.weak_families,data_valid:p.data_valid});
     if(p.action==='EXIT')handoffExited=true;
    }
   }
  }
  const nearest=observations.length?observations.reduce((best,x)=>Math.abs(date(x.at)-date(entry.created_at))<Math.abs(date(best.at)-date(entry.created_at))?x:best,observations[0]):null;
  incidents.push({symbol:item.symbol,rank_at_historical_entry:rank,day_return_at_historical_entry:day,original:{entry_at:historical.entry_at,entry_price:historical.entry_price,closed_at:historical.closed_at,exit_price:historical.exit_price,net_pnl:historical.realized_pnl_usdt,exit_reason:historical.exit_reason},
   archive_buckets:item.rows.length,entry_observation:nearest,states:observations,first_buy:firstBuy,first_weakening:firstWeakening,first_protection:firstProtection,estimated_exit:estimatedExit,actual_position_handoff_replay:forcedOwnership,
   caveat:'Replay quotes are sampled and executions are hypothetical. No queue/capacity/IOC/fees/funding counterfactual is asserted. The real-position replay stops at its first EXIT; later entry states remain visible. This is not a full-period strategy performance backtest.'});
 }
 const ordered=times.sort((a,b)=>a-b),q=p=>ordered[Math.floor((ordered.length-1)*p)];return {profile:PROFILE,incidents,local_model_latency_ms:{samples:times.length,median:q(.5),p95:q(.95),max:Math.max(...times)},production_deployed:false};
}
if(process.argv[1]?.endsWith('/replay.mjs')){
 const [entry,archive,candles,output]=process.argv.slice(2);if(!output)throw Error('REPLAY_INPUTS_AND_OUTPUT_REQUIRED');
 const result=replay(JSON.parse(fs.readFileSync(entry)),JSON.parse(fs.readFileSync(archive)),JSON.parse(fs.readFileSync(candles)));
 fs.writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({incidents:result.incidents.map(x=>({symbol:x.symbol,observations:x.states.length,initial:x.entry_observation?.decision,structural:x.entry_observation?.structural_strength,propulsion:x.entry_observation?.current_propulsion,first_buy:x.first_buy?.at,estimated_exit:x.estimated_exit?.at,handoff_exit:x.actual_position_handoff_replay.find(p=>p.action==='EXIT'),valid:x.states.filter(x=>x.capture_valid).length})),latency:result.local_model_latency_ms}));
}
