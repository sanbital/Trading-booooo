import {ENGINE,classifyMarket,revalidateEntry} from './market-state.mjs';
import {refreshUniverse} from './universe.mjs';
import {PROFILE} from './calibration.mjs';
import {createFeatureCache,normalizeCapture,mergeSnapshot} from './features.mjs';
import {SLOT_SIZING_CONTRACT} from '../leader-slot-sizing.mjs';
import {POLICY,STRATEGY} from '../leader-momentum-v17.mjs';
import {normalizeEntryBook} from './book.mjs';
export const features=createFeatureCache();
const memory=new Map();
export async function control(db){const r=await db.from('deterministic_control').select('*').eq('singleton',true).single();if(r.error||r.data?.version!==ENGINE)throw Error('DETERMINISTIC_CONTROL_INVALID');return r.data;}
export async function captures(db,symbols,at,positionId=null){
 const asOf=new Date(at).toISOString();
 const [r,d]=await Promise.all([
  db.rpc('deterministic_market_context',{p_symbols:symbols,p_as_of:asOf,p_position_id:positionId}),
  db.rpc('deterministic_derivative_context',{p_symbols:symbols,p_as_of:asOf})
 ]);
 if(r.error)throw Error('MARKET_CONTEXT_UNAVAILABLE');
 const derivatives=d.error?{}:(d.data??{});
 return Object.fromEntries(symbols.map(s=>{
  const raw=r.data?.[s],extra=derivatives?.[s];
  if(raw?.status==='AVAILABLE'&&Array.isArray(raw.trajectory)&&extra?.status==='AVAILABLE'&&Array.isArray(extra.trajectory)){
   const byBucket=new Map(extra.trajectory.map(p=>[Number(p.bucket_ms),p]));
   return [s,normalizeCapture({...raw,trajectory:raw.trajectory.map(p=>({...p,...(byBucket.get(Number(p.bucket_ms))??{})}))},at)];
  }
  return [s,normalizeCapture(raw,at)];
 }));
}
export function overlayExecutableBook(input,quote,at=Date.now()){
 const normalized=normalizeEntryBook(quote,1500,at),bids=normalized.bids,asks=normalized.asks,bid=Number(quote.best_bid),ask=Number(quote.best_ask),mid=(bid+ask)/2;
 const sum=(xs,fn)=>xs.filter(x=>fn(Number(x[0]))).reduce((s,x)=>s+Number(x[0])*Number(x[1]),0),bd=sum(bids,p=>p>=mid*.9975),ad=sum(asks,p=>p<=mid*1.0025);
 const notional=SLOT_SIZING_CONTRACT.targetMarginUsdt*SLOT_SIZING_CONTRACT.leverage;
 const walk=xs=>{let remaining=notional,quantity=0;
  for(const [p,q] of xs){const used=Math.min(remaining,Number(p)*Number(q));quantity+=used/Number(p);remaining-=used;if(remaining<=1e-8)break;}
  return remaining<=1e-8&&quantity>0?notional/quantity:null;};
 const buy=walk(asks),sell=walk(bids),original=input.capture;
 const execution_book={original_capture_status:original?.status??null,original_capture_reason:original?.reason??null,
  original_capture_end_ms:original?.end_ms??null,book_healthy:normalized.health.bookHealthy,book_reasons:normalized.health.reasons,
  book_age_ms:normalized.health.bookAgeMs,required_notional:notional,bid_depth_25_usdt:bd,ask_depth_25_usdt:ad,buy_vwap:buy,sell_vwap:sell};
 if(original?.status!=='AVAILABLE')return {...input,capture:original,execution_book,at,price:ask};
 if(!normalized.health.bookHealthy)return {...input,capture:{status:'UNAVAILABLE',reason:'CURRENT_EXECUTABLE_BOOK_INCOMPLETE'},execution_book,at,price:ask};
 if(!(bd>0&&ad>0&&buy>0&&sell>0))return {...input,capture:{status:'UNAVAILABLE',reason:'CURRENT_EXECUTABLE_DEPTH_INSUFFICIENT'},execution_book,at,price:ask};
 const point=original.trajectory.at(-1),spread=(ask-bid)/mid*10000,imbalance=(bd-ad)/(bd+ad),buyImpact=(buy/mid-1)*10000,sellImpact=(1-sell/mid)*10000;
 const horizons=Object.fromEntries(Object.entries(original.dynamics.horizons).map(([key,h])=>[key,{...h,spread,bid_depth:bd,ask_depth:ad,imbalance,
  buy_impact_450_bps:buyImpact,sell_impact_450_bps:sellImpact,
  bid_liquidity_change:(1+h.bid_liquidity_change)*bd/point.bid_depth_25_usdt-1,
  ask_liquidity_change:(1+h.ask_liquidity_change)*ad/point.ask_depth_25_usdt-1,
  imbalance_trend:imbalance-point.imbalance+h.imbalance_trend}]));
 return {...input,execution_book,capture:{...original,dynamics:{...original.dynamics,horizons}},facts:{...input.facts,values:{...input.facts.values,spread_bps:spread,
  book_imbalance_25bps:imbalance,expected_entry_vwap:buy,expected_exit_vwap:sell,expected_execution_cost_bps:buyImpact+sellImpact+10}},at,price:ask};
}
export async function currentMarket(db,symbol,{positionId=null,return24h=null,rank=null,quote=null}={}){
 const f=await features.read(symbol),at=Date.now(),cs=await captures(db,[symbol],at,positionId),capture=cs[symbol];
 const input={facts:mergeSnapshot(f,capture,{return24h,rank}),capture,profile:PROFILE,at:Date.now(),price:capture.trajectory?.at(-1)?.mid,return24h};
 return quote?overlayExecutableBook(input,quote):input;
}
export async function requireEntryAuthority(db,s,{refresh=false}={}){
 if(s?.features?.deterministic?.version!==ENGINE)throw Error('RETIRED_ENTRY_AUTHORITY');
 const r=await db.rpc('deterministic_entry_authority',{p_signal_id:s.id});if(r.error)throw Object.assign(Error('ENTRY_AUTHORITY_UNAVAILABLE'),{authority:r.data});
 if(refresh&&(r.data?.reason==='TOP20_REFRESH_DELAY'||r.data?.allowed===true&&Date.parse(r.data.next_refresh_at)-Date.now()<10000)){await refreshUniverse(db,{force:r.data?.allowed===true});const fresh=await db.rpc('deterministic_entry_authority',{p_signal_id:s.id});if(fresh.error||fresh.data?.allowed!==true)throw Object.assign(Error(fresh.data?.reason??'ENTRY_AUTHORITY_UNAVAILABLE'),{authority:fresh.data});return fresh.data;}
 if(r.data?.allowed!==true)throw Object.assign(Error(r.data?.reason??'ENTRY_AUTHORITY_UNAVAILABLE'),{authority:r.data});return r.data;
}
export const isLeader20=s=>s?.features?.strategy===STRATEGY;
export function detachAudit(db,row){
 const promise=Promise.resolve().then(()=>db.from('deterministic_decision_audit').insert(row)).then(r=>{if(r.error)console.error('DECISION_AUDIT_FAILED',r.error.code)}).catch(()=>console.error('DECISION_AUDIT_FAILED'));
 globalThis.EdgeRuntime?.waitUntil?.(promise);return promise;
}
export async function observe(db,{diagnostic=false}={}){
 const ctl=await control(db),universe=await db.rpc('deterministic_universe');if(universe.error)throw Error('UNIVERSE_READ_FAILED');
 const members=universe.data?.members??[];for(const key of memory.keys())if(!members.some(m=>m.symbol===key))memory.delete(key);if(!members.length)return {ok:true,version:ENGINE,reason:'UNIVERSE_NOT_READY',members:0};
 const reads=new Map(),results=[];
 // Shared BTC/minute cache. Bound public reads so one failed symbol cannot monopolize the batch.
 for(let i=0;i<members.length;i+=4){await Promise.allSettled(members.slice(i,i+4).map(async m=>{try{reads.set(m.symbol,await features.read(m.symbol));}catch{reads.set(m.symbol,null);}}));}
 const at=Date.now(),cs=await captures(db,members.map(m=>m.symbol),at);
 for(const m of members){
  const capture=cs[m.symbol],facts=mergeSnapshot(reads.get(m.symbol),capture,{return24h:m.price_change_percent/100,rank:m.rank}),
   ready=Date.now(),decision=classifyMarket({facts,capture,profile:PROFILE,at:ready,return24h:m.price_change_percent/100}),prior=memory.get(m.symbol);
  memory.set(m.symbol,{phase:decision.phase,decision:decision.decision,capture_end_ms:decision.capture_end_ms});
  const timings={market_event:capture?.trajectory?.at(-1)?.exchange_event_ms??null,bucket_end:capture?.end_ms??null,
   capture_complete:capture?.ingested_at_ms??capture?.trajectory?.at(-1)?.received_at_ms??null,
   feature_ready:ready,decision:Date.now()};
  if(!diagnostic&&(prior?.phase!==decision.phase||prior?.decision!==decision.decision))detachAudit(db,{symbol:m.symbol,observed_at:new Date(ready).toISOString(),kind:'ENTRY_STATE',state:decision.phase,decision:decision.decision,evidence:decision,timing:timings});
  let signalId=null;
  if(!diagnostic&&ctl.enabled&&decision.decision==='BUY'){
   const f={strategy:STRATEGY,referenceClose:decision.reference_price,atr:decision.reference_price*decision.atr_normalized,
    targetMarginUsdt:SLOT_SIZING_CONTRACT.targetMarginUsdt,leverage:SLOT_SIZING_CONTRACT.leverage,sizingContractVersion:SLOT_SIZING_CONTRACT.version,
    exitPolicy:{stopPct:POLICY.stopPct,trailArmPct:POLICY.trailArmPct,trailGapPct:POLICY.trailGapPct,staleMs:POLICY.staleMs,maxHoldMs:POLICY.maxHoldMs},
    deterministic:{version:ENGINE,generation:universe.data.generation,decision,facts: facts.values,timing:timings,rank:m.rank,return24h:m.price_change_percent/100}};
   const r=await db.rpc('deterministic_candidate',{p_symbol:m.symbol,p_bucket_ms:capture.end_ms,p_features:f});
   if(!r.error)signalId=r.data?.id??null;else console.error('CANDIDATE_LOCAL_FAILURE',m.symbol,r.error.code);
  }
  results.push({symbol:m.symbol,rank:m.rank,phase:decision.phase,structural_strength:decision.structural_strength,current_propulsion:decision.current_propulsion,
   exhaustion:decision.exhaustion.state,setup:decision.setup,trigger:decision.trigger,confirmation:decision.confirmation,decision:decision.decision,reasons:decision.reasons,signalId,
   capture_end_ms:capture?.end_ms??null,technical:facts?.quality?.candles_complete===true,timing:timings});
 }
 return {ok:true,version:ENGINE,authority:ctl.enabled?'LIVE':'ENTRY_PAUSED',members:members.length,observed_at:new Date().toISOString(),results};
}
export function validatePreparedOrder(s,input,quote){
 const current=overlayExecutableBook(input,quote,Date.now());return {...revalidateEntry(s.features.deterministic.decision,current),input:current};
}
export async function validateOrder(db,s,quote){
 const seed=s.features?.deterministic,input=await currentMarket(db,s.symbol,{quote,return24h:seed.return24h,rank:seed.rank});
 return {...revalidateEntry(seed.decision,input),input};
}
