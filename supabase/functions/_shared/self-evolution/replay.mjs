/** Deterministic event replay. AI selects actions; this module alone simulates fills and costs. */
import {metrics} from './statistics.mjs';
import {hash} from '../gpt-final-decision/api.mjs';
const ensure=(x,e)=>{if(!x)throw Error(e);};
export function assertCausal(event,cutoff){
 ensure(Number.isSafeInteger(cutoff),'REPLAY_CUTOFF');
 ensure(event.at_ms<=cutoff&&event.received_at_ms<=cutoff&&event.source_cutoff_ms<=cutoff,'FUTURE_LEAKAGE');
 for(const p of event.trajectory??[])ensure(p.end_ms<=cutoff&&p.received_at_ms<=cutoff,'FUTURE_TRAJECTORY');
 return true;
}
export function splitWindows({discoveryStart,discoveryEnd,validationStart,validationEnd,holdoutStart,holdoutEnd,embargoMs=600000}){
 const x=[discoveryStart,discoveryEnd,validationStart,validationEnd,holdoutStart,holdoutEnd];
 ensure(x.every(Number.isSafeInteger)&&x.every((v,i)=>!i||v>x[i-1]),'SPLIT_OVERLAP');
 ensure(validationStart-discoveryEnd>=embargoMs&&holdoutStart-validationEnd>=embargoMs,'SPLIT_EMBARGO');
 return {discovery:[discoveryStart,discoveryEnd],validation:[validationStart,validationEnd],holdout:[holdoutStart,holdoutEnd],embargoMs};
}
export function counterfactual({at_ms,price,side='LONG',path,fee_bps=10,spread_bps=null,impact_bps=null}){
 ensure(side==='LONG'&&price>0,'COUNTERFACTUAL_INPUT');
 const sorted=[...path].filter(p=>p.at_ms>=at_ms&&p.price>0).sort((a,b)=>a.at_ms-b.at_ms),cost=Number.isFinite(spread_bps)&&Number.isFinite(impact_bps)?fee_bps+spread_bps+2*impact_bps:null;
 const horizons={};for(const sec of [5,10,20,30,60,120,300,600]){
  const target=at_ms+sec*1000,p=sorted.find(p=>p.at_ms>=target&&p.at_ms<=target+5000);
  horizons[sec]=p?{at_ms:p.at_ms,price:p.price,gross_bps:(p.price/price-1)*10000,net_bps:cost===null?null:(p.price/price-1)*10000-cost}:null;
 }
 const prices=sorted.filter(p=>p.at_ms<=at_ms+600000).map(p=>p.price),best=prices.length?(Math.max(...prices)/price-1)*10000:null,worst=prices.length?(Math.min(...prices)/price-1)*10000:null;
 return {version:'COUNTERFACTUAL_1',resolution:'OBSERVED_POINTS_ONLY',horizons,cost_bps:cost,missing_cost:cost===null,
  no_entry_net_bps:0,missed_upside_bps:best,avoided_loss_bps:worst===null?null:-Math.min(0,worst),
  entry_delay_regret_bps:Object.fromEntries([5,10,20].map(s=>[s,horizons[s]?.gross_bps??null])),
  exit_hold_regret_bps:Object.fromEntries([30,60].map(s=>[s,horizons[s]?.net_bps??null]))};
}
function economicConfig(c){
 const required=['capital_usdt','margin_usdt','leverage','max_slots','taker_fee','latency_ms','ioc_max_bps'];
 ensure(required.every(k=>Number.isFinite(c[k])&&c[k]>=0)&&c.capital_usdt>0&&c.margin_usdt>0&&c.leverage>0&&Number.isSafeInteger(c.max_slots),'CAPITAL_MANIFEST_INVALID');
 return Object.freeze({...c});
}
function fillAt(event,side,quantity,config){
 const q=event.execution_quotes?.find(q=>q.at_ms>=event.at_ms+config.latency_ms&&q.at_ms<=event.at_ms+config.latency_ms+2000);
 if(!q||q.rejected||!(q.bid>0&&q.ask>=q.bid)||!Number.isFinite(q.impact_bps)||!Number.isFinite(q.available_qty))return {filled:false,reason:'EXECUTION_DATA_UNAVAILABLE'};
 const tick=event.filters?.tick_size,step=event.filters?.step_size,min=event.filters?.min_notional;
 if(!(tick>0&&step>0&&min>0))return {filled:false,reason:'FILTERS_UNAVAILABLE'};
 const px=side==='BUY'?Math.ceil(q.ask*(1+q.impact_bps/10000)/tick)*tick:Math.floor(q.bid*(1-q.impact_bps/10000)/tick)*tick;
 const qty=Math.floor(Math.min(quantity,q.available_qty)/step)*step;
 if(!(qty>0&&px*qty>=min))return {filled:false,reason:'LOT_OR_NOTIONAL_REJECTION'};
 if(side==='BUY'&&px>event.ask*(1+config.ioc_max_bps/10000))return {filled:false,reason:'IOC_CAP'};
 return {filled:true,price:px,quantity:qty,fee:px*qty*config.taker_fee,at_ms:q.at_ms,partial:qty<quantity};
}
/** No time-based forced exit. Unclosed episodes remain marked, never counted as closed wins. */
export async function simulate(events,{policy,capital,decide,policyHash,datasetHash}){
 const config=economicConfig(capital),positions=new Map(),trades=[],journal=[],missing=[],seen=new Set();let cash=config.capital_usdt;
 for(const e of [...events].sort((a,b)=>a.at_ms-b.at_ms||a.id.localeCompare(b.id))){
  ensure(!seen.has(e.id),'DUPLICATE_EVENT');seen.add(e.id);assertCausal(e,e.at_ms);
  let p=positions.get(e.symbol);if(p&&e.hard_floor>p.floor)p.floor=e.hard_floor;
  const hard=p&&e.bid<=p.floor;
  if(!e.market_valid){missing.push({id:e.id,reason:'MARKET_INVALID'});continue;}
  let decision;
  if(hard)decision={decision:'EXIT',valid:true,authority:'HARD_SAFETY'};
  else{decision=await decide({event:e,position:p?{...p}:null,policy});
   if(!decision.valid||decision.authority!=='GPT_FINAL_ONLY'){journal.push({id:e.id,decision:'ABSTAIN'});continue;}}
  journal.push({id:e.id,decision:decision.decision,authority:decision.authority});
  if(p&&decision.decision==='EXIT'){
   const f=fillAt(e,'SELL',p.qty,config);if(!f.filled){missing.push({id:e.id,reason:f.reason});continue;}
   const fraction=f.quantity/p.qty,entryFee=p.entryFee*fraction,funding=Number.isFinite(e.funding_usdt)?e.funding_usdt*fraction:null;
   if(funding===null){missing.push({id:e.id,reason:'FUNDING_UNAVAILABLE'});continue;}
   const net=(f.price-p.entry)*f.quantity-entryFee-f.fee-funding;
   trades.push({symbol:e.symbol,entry_ms:p.opened,closed_ms:f.at_ms,net_usdt:net,fees_usdt:entryFee+f.fee,notional_usdt:p.entry*f.quantity,
    regime:p.regime,partial:f.partial,decision_id:e.id,exit_authority:decision.authority});cash+=p.margin*fraction+net;p.qty-=f.quantity;p.margin*=1-fraction;p.entryFee*=1-fraction;
   if(p.qty<1e-10)positions.delete(e.symbol);
  }else if(!p&&decision.decision==='BUY'&&e.admission_eligible===true){
   if(positions.size>=config.max_slots||cash<config.margin_usdt)continue;
   if(!(e.initial_hard_floor>0&&e.initial_hard_floor<e.ask)){missing.push({id:e.id,reason:'INITIAL_PROTECTION_UNAVAILABLE'});continue;}
   const f=fillAt(e,'BUY',config.margin_usdt*config.leverage/e.ask,config);if(!f.filled){missing.push({id:e.id,reason:f.reason});continue;}
   const margin=f.price*f.quantity/config.leverage;if(margin>config.margin_usdt*1.003){missing.push({id:e.id,reason:'SIZE_PARITY_REJECTION'});continue;}
   positions.set(e.symbol,{entry:f.price,qty:f.quantity,entryFee:f.fee,margin,floor:e.initial_hard_floor,opened:f.at_ms,regime:e.regime});cash-=margin;
  }
 }
 return {policy_hash:policyHash,dataset_hash:datasetHash,capital_hash:await hash(config),trades,metrics:metrics(trades),journal,unclosed:[...positions.entries()],missing,
  complete_lifecycle_coverage:trades.length/(trades.length+positions.size||1),execution_coverage:(events.length-missing.length)/(events.length||1),order_calls:0};
}
