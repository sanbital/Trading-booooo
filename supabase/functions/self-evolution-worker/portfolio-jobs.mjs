import {emptyPortfolio,advancePortfolio} from '../_shared/self-evolution/portfolio.mjs';
import {readSources} from '../_shared/gpt-final-decision/market.mjs';
import {computeFacts} from '../_shared/gpt-final-decision/facts.mjs';
import {buildDecisionPacket,hash} from '../_shared/gpt-final-decision/api.mjs';
import {validateCapture120} from '../_shared/gpt-final-decision/capture-context.mjs';
import {publicMarket} from '../_shared/self-evolution/market.mjs';
import {policyDecision} from './decision.mjs';
import {positionGeneration} from '../_shared/exit-authority.mjs';
import {initialContext,detectChange,buildRecheckPacket,AGED_REASON} from '../_shared/gpt-final-decision/recheck.mjs';
import {metrics} from '../_shared/self-evolution/statistics.mjs';
export function quote(frame){const p=frame.payload;return {at_ms:Date.parse(frame.at),received_at_ms:Date.parse(frame.received_at),bid:Number(p.best_bid),ask:Number(p.best_ask),
 buy_vwap:Number(p.buy_vwap_450),sell_vwap:Number(p.sell_vwap_450),ask_depth_usdt:Number(p.ask_25_usdt),bid_depth_usdt:Number(p.bid_25_usdt),
 coverage:p.book_complete===true&&p.coverage_25===true&&Date.parse(p.exchange_at)<=Date.parse(p.received_at)&&Date.parse(p.received_at)-Date.parse(p.exchange_at)<=10000};}
async function frameAfter(store,symbol,at){const r=await store.read(store.table('evolution_market_frames').select('*').eq('symbol',symbol).gte('received_at',new Date(at).toISOString()).lte('received_at',new Date(at+7000).toISOString()).order('received_at').limit(1));return r[0]??null;}
async function packetAt(store,event,p,task,at,frame){
 const key='source:'+event.symbol+':'+at,source=await store.cached(await hash(key),()=>readSources(event.symbol,at,{mode:'REPLAY',ms:3500}));
 const raw=await store.rpc('evolution_capture_context',{p_symbol:event.symbol,p_as_of:new Date(at).toISOString(),p_position_id:null}),c=validateCapture120(raw,at),q=quote(frame);
 source.src.captureContext=c;source.src.marketSensor=await store.rpc('evolution_market_sensor',{p_symbol:'BTCUSDT',p_as_of:new Date(at).toISOString()});
 const facts=computeFacts(source.src,{asOf:at,referenceClose:event.reference_close??q.bid,dayReturn:event.day_return,rank:event.rank});
 Object.assign(facts.values,{spread_bps:(q.ask/q.bid-1)*10000,ask_depth_25bps_usdt:q.ask_depth_usdt,bid_depth_25bps_usdt:q.bid_depth_usdt,
  book_imbalance_25bps:(q.bid_depth_usdt-q.ask_depth_usdt)/(q.bid_depth_usdt+q.ask_depth_usdt),ask_depth_to_order:q.ask_depth_usdt/450,bid_depth_to_order:q.bid_depth_usdt/450,
  est_buy_slippage_bps:q.buy_vwap>0?(q.buy_vwap/((q.ask+q.bid)/2)-1)*10000:null});
 if(p)Object.assign(facts.values,{position_return:q.bid/p.entry_price-1,position_peak_return:p.peak_price/p.entry_price-1,position_drawdown_from_peak:q.bid/p.peak_price-1,
  position_minutes_held:(at-p.entry_at_ms)/60000,position_minutes_since_new_high:(at-p.last_high_at)/60000,position_stop_distance:q.bid/p.hard_stop_price-1});
 const packet=await buildDecisionPacket({task,subjectId:event.id+(p?':'+p.id:''),symbol:event.symbol,dataMode:'REPLAY',facts,
  judgments:event.judgments??null,position:p?{event:event.event_name??'MARKET_CHANGE',positionId:p.id,generation:positionGeneration(p),exitContext:event.exit_context,valuation:{snapshot_at_ms:at,bid:q.bid}}:null});
 packet.execution_ref={bid:q.bid,ask:q.ask,mid:(q.bid+q.ask)/2,at};packet.snapshot_hash=await hash({...packet,snapshot_hash:''});return packet;
}
/** Each arm resumes independently. Cache identity includes policy, position state and exact causal market input. */
export async function portfolioJob(store,version,keys,{maxWallMs=65000,source='MARKET'}={}){
 const started=Date.now(),p=await store.read(store.table('evolution_policy_bundles').select('*').eq('version',version).single()),champ=await store.read(store.table('evolution_policy_bundles').select('*').eq('version',p.parent_version).single());
 const control=await store.read(store.table('evolution_control').select('capital_manifest').single()),capital=control.capital_manifest,cut=Date.parse(p.created_at)+60000;
 const now=Date.now(),result={};
 for(const window of ['VALIDATION','HOLDOUT']){
  const split=source==='ACTUAL'?'ACTUAL_'+window:window;
  const begin=window==='VALIDATION'?cut:cut+14*86400000,end=Math.min(now-610000,window==='VALIDATION'?cut+14*86400000-600001:cut+21*86400000);
  if(end<=begin)continue;
  const armRows=await store.read(store.table('evolution_portfolios').select('arm,state').eq('policy_version',version).eq('split',split));
  const cursors=Object.fromEntries(armRows.map(x=>[x.arm,x.state.last_ms]));
  for(const [arm,policy]of [['champion',champ],['challenger',p]].sort((a,b)=>(cursors[a[0]]??begin)-(cursors[b[0]]??begin))){
   const id=version+':'+split+':'+arm,old=await store.read(store.table('evolution_portfolios').select('state').eq('id',id).maybeSingle());let state=old?.state??emptyPortfolio(capital,begin);
   const ops=await store.read(store.table('evolution_opportunities').select('*').eq('context->>source',source).gte('at_ms',state.last_ms-7000).lte('at_ms',end).order('at_ms').limit(40));
   const symbols=[...new Set([...Object.keys(state.positions),...ops.map(x=>x.symbol)])];
   if(!symbols.length)continue;
   const pageEnd=ops.length===40?Math.min(end,ops.at(-1).at_ms):end;
   const frames=await store.read(store.table('evolution_market_frames').select('*').in('symbol',symbols).gte('received_at',new Date(state.last_ms).toISOString()).lte('received_at',new Date(pageEnd).toISOString()).order('received_at').order('symbol').limit(1200));
   if(!frames.length)continue;const maxAt=Date.parse(frames.at(-1).received_at);
   const events=frames.map(f=>({id:'frame:'+f.symbol+':'+f.at,symbol:f.symbol,at_ms:Date.parse(f.received_at),received_at_ms:Date.parse(f.received_at),quote:quote(f),frame:f}));
   for(const o of ops.filter(o=>o.at_ms<=maxAt)){const frame=frames.find(f=>f.symbol===o.symbol&&Date.parse(f.received_at)>=o.at_ms);if(!frame)continue;
    // Admission cannot backdate a quote received after the original packet.
    events.push({id:o.id,symbol:o.symbol,at_ms:Date.parse(frame.received_at),received_at_ms:Date.parse(frame.received_at),quote:quote(frame),frame,
     opportunity:true,original:o,admission_eligible:o.context.admission_eligible,filters:o.context.filters,branch:o.context.feature?.b06133?.branch??'V30_SCORE',regime:o.context.regime,
     judgments:o.packet.model_judgments,reference_close:o.context.feature?.referenceClose,day_return:o.context.feature?.dayReturn,rank:o.context.feature?.rank});}
   events.sort((a,b)=>a.at_ms-b.at_ms||(a.id<b.id?-1:a.id>b.id?1:0));
   for(const e of events){if(Date.now()-started>maxWallMs)break;if(e.at_ms<state.last_ms||e.at_ms===state.last_ms&&e.id<=String(state.last_id??''))continue;
    const before=state;try{state=await advancePortfolio(state,e,{capital,
     fillQuote:async(symbol,at)=>{const f=await frameAfter(store,symbol,at);return f?quote(f):null;},
     capture:async(symbol,at)=>validateCapture120(await store.rpc('evolution_capture_context',{p_symbol:symbol,p_as_of:new Date(at).toISOString(),p_position_id:null}),at),
     candles:async(symbol,entry,last,at)=>store.cached(await hash({kind:'p142bars',symbol,last,at}),()=>publicMarket('/fapi/v1/klines',{symbol,interval:'1m',startTime:String(Math.floor(last/60000)*60000),endTime:String(Math.floor(at/60000)*60000-1),limit:'499'})),
     funding:async(symbol,entry,exit,qty)=>{const rows=await store.cached(await hash({kind:'funding',symbol,entry,exit}),()=>publicMarket('/fapi/v1/fundingRate',{symbol,startTime:String(entry),endTime:String(exit),limit:'1000'}));return rows.every(r=>Number(r.markPrice)>0)?rows.reduce((v,r)=>v+Number(r.fundingRate)*Number(r.markPrice)*qty,0):null;},
     recheck:async(event,decision)=>{
      const dispatchAt=event.at_ms+decision.latency_ms,f=await frameAfter(store,event.symbol,dispatchAt);
      if(!f)return {required:true,result:{valid:false,error:'RECHECK_DISPATCH_MISSING'}};
      const at=Date.parse(f.received_at),q=quote(f),base=decision.final_packet;
      const initial=initialContext({packet:base,snapshot_at_ms:decision.final_snapshot_at_ms,result:{completed_at_ms:dispatchAt}},decision.answer);
      const currentPacket=await packetAt(store,event,null,'ENTRY',at,f),trajectory=currentPacket.facts.capture_context?.trajectory??[],tail=trajectory.slice(-2);
      const total=tail.reduce((v,b)=>v+Number(b.buy_quote_5s??b.aggressive_buy??0)+Number(b.sell_quote_5s??b.aggressive_sell??0),0);
      const tape=tail.length===2&&total>0?{return:Math.expm1(tail.reduce((v,b)=>v+Math.log1p(Number(b.d_mid_bps??0)/10000),0)),buyShare:tail.reduce((v,b)=>v+Number(b.buy_quote_5s??b.aggressive_buy??0),0)/total,tradeCount:tail.reduce((v,b)=>v+Number(b.trade_count??0),0),windowMs:10000}:null;
      const current={at,mid:(q.bid+q.ask)/2,book:currentPacket.facts.values,tape};
      const detection=detectChange(initial,current,undefined,{force:at-initial.snapshotAt>=12500?[AGED_REASON]:[]});
      if(!detection.triggered)return {required:false};
      const next=await frameAfter(store,event.symbol,at+5000);if(!next)return {required:true,result:{valid:false,error:'RECHECK_REFRESH_MISSING'}};
      const nextAt=Date.parse(next.received_at),fresh=await packetAt(store,event,null,'ENTRY',nextAt,next);
      const packet=await buildRecheckPacket({signalId:event.id,symbol:event.symbol,dataMode:'REPLAY',facts:currentPacket.facts,initial,detection,judgments:event.judgments,currentRef:currentPacket.execution_ref,preDispatch:current});
      const refreshed=await buildRecheckPacket({signalId:event.id,symbol:event.symbol,dataMode:'REPLAY',facts:fresh.facts,initial,detection,judgments:event.judgments,currentRef:fresh.execution_ref,preDispatch:current});
      const result=await policyDecision(store,policy,{id:event.id+':RECHECK',at_ms:at,packet,context:{refreshed_packet:refreshed,refreshed_at_ms:nextAt}},keys);
      return {required:true,result,completed_at_ms:at+result.latency_ms};
     },
     decide:async({event,position,task,exit_context,event_name})=>{const f=await frameAfter(store,event.symbol,event.at_ms+5000);if(!f)return {valid:false,decision:'ABSTAIN',error:'REPLAY_REFRESH_MISSING'};
      const nextAt=Date.parse(f.received_at),nextEvent={...event,exit_context,event_name},initial=await packetAt(store,nextEvent,position,task,event.at_ms,event.frame),refreshed=await packetAt(store,nextEvent,position,task,nextAt,f);
      const input={id:event.id+':'+(position?.id??'ENTRY'),at_ms:event.at_ms,packet:initial,context:{refreshed_packet:refreshed,refreshed_at_ms:nextAt}};
      return policyDecision(store,policy,input,keys);}
    });}catch(error){await store.write('evolution_portfolios',{id,policy_version:version,split,arm,state:before,updated_at:new Date().toISOString()},{upsert:true,onConflict:'id'});throw error;}
   }
   await store.write('evolution_portfolios',{id,policy_version:version,split,arm,state,updated_at:new Date().toISOString()},{upsert:true,onConflict:'id'});
   result[split+':'+arm]={metrics:metrics(state.trades),open:Object.keys(state.positions).length,events:state.events,missing:state.missing.length,cursor:state.last_ms};
   if(Date.now()-started>maxWallMs)return result;
  }
 }
 return result;
}
