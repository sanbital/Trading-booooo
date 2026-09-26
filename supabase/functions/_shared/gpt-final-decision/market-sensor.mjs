/** BTC is a context sensor. This module grants no trade-context eligibility. */
export const SENSOR_CONTRACT='MARKET_SENSOR_CONTEXT_V1';
export const SENSOR_NOTE='market_sensor is BTCUSDT under MARKET_SENSOR_CONTEXT_V1; capture_context is the traded symbol under TRADE_CONTEXT_V3. These are separate trajectories and contracts. BTC observed depth covers only the supplied snapshot/band intersection: depth_coverage_complete=false means incomplete +/-25bp coverage. Never interpret observed depth/imbalance as full 25bp liquidity, extrapolate missing levels, or use sensor availability as trade eligibility. Returns are fractions; d_mid_bps is basis points. UNAVAILABLE means missing context, not an independent trading instruction.';
const unavailable=reason=>({symbol:'BTCUSDT',role:'MARKET_SENSOR',contract:SENSOR_CONTRACT,version:SENSOR_CONTRACT,status:'UNAVAILABLE',reason});
const finite=(p,keys)=>keys.every(k=>Number.isFinite(p[k]));
export function validateMarketSensor(raw,asOf){
 if(raw?.status!=='AVAILABLE')return unavailable(raw?.reason??'MISSING_SENSOR');
 const points=raw.market_sensor_trajectory;
 if(raw.contract!==SENSOR_CONTRACT||raw.version!==SENSOR_CONTRACT||raw.symbol!=='BTCUSDT'||raw.role!=='MARKET_SENSOR'||raw.buckets!==24||points?.length!==24)return unavailable('INVALID_SENSOR_CONTRACT');
 if(![raw.start_ms,raw.end_ms,raw.ingested_at_ms,raw.as_of_ms,asOf].every(Number.isSafeInteger)||raw.as_of_ms>asOf||
  raw.end_ms>raw.ingested_at_ms||raw.ingested_at_ms>raw.as_of_ms||asOf-raw.end_ms>25000||
  raw.end_ms-raw.start_ms<117000||raw.end_ms-raw.start_ms>123000)return unavailable('STALE_OR_FUTURE');
 let previous=null;
 for(const p of points){
  if(!['bucket_complete','book_complete','trade_sequence_complete','flow_causal','btc_candle_complete'].every(k=>p[k]===true))return unavailable('INCOMPLETE_OR_NONCAUSAL');
  if(!['bucket_ms','start_ms','end_ms','received_at_ms','exchange_event_ms','book_received_at_ms','btc_candle_end_ms','btc_candle_exchange_ms','btc_candle_received_ms','trade_count'].every(k=>Number.isSafeInteger(p[k])))return unavailable('INVALID_TIME');
  if(p.end_ms>raw.as_of_ms||p.received_at_ms>raw.as_of_ms||p.received_at_ms<p.end_ms||p.exchange_event_ms>p.end_ms||p.book_received_at_ms>p.end_ms||
   p.book_received_at_ms-p.exchange_event_ms < -1000||p.book_received_at_ms-p.exchange_event_ms>10000||p.end_ms-p.book_received_at_ms>10000)return unavailable('NONCAUSAL_BOOK');
  if(p.end_ms-p.start_ms<4000||p.end_ms-p.start_ms>6500||Math.abs(p.end_ms-p.bucket_ms)>=1000||
   previous&&(p.bucket_ms-previous.bucket_ms!==5000||p.start_ms!==previous.end_ms))return unavailable('NONCONTIGUOUS');
  if(p.trade_count<0||p.trade_count>0&&(!Number.isSafeInteger(p.flow_event_ms)||!Number.isSafeInteger(p.flow_received_at_ms)||
   p.flow_event_ms>p.end_ms||p.flow_received_at_ms>p.end_ms||p.flow_received_at_ms<=p.start_ms||
   p.flow_received_at_ms-p.flow_event_ms < -1000||p.flow_received_at_ms-p.flow_event_ms>10000))return unavailable('NONCAUSAL_FLOW');
  if(p.btc_candle_end_ms>p.end_ms||p.end_ms-p.btc_candle_end_ms>65000||p.btc_candle_exchange_ms<p.btc_candle_end_ms-1||
   p.btc_candle_exchange_ms>p.end_ms||p.btc_candle_received_ms>p.end_ms||p.btc_candle_received_ms-p.btc_candle_exchange_ms < -1000||
   p.btc_candle_received_ms-p.btc_candle_exchange_ms>10000)return unavailable('STALE_OR_NONCAUSAL_CANDLE');
  if(!finite(p,['mid','start_mid','best_bid','best_ask','spread_bps','taker_buy_quote_5s','taker_sell_quote_5s','btc_return_1m',
   'observed_bid_depth_usdt','observed_ask_depth_usdt','depth_bid_coverage_bps','depth_ask_coverage_bps','depth_bid_boundary','depth_ask_boundary'])||
   p.mid<=0||p.start_mid<=0||p.best_bid<=0||p.best_ask<p.best_bid||p.taker_buy_quote_5s<0||p.taker_sell_quote_5s<0||
   p.observed_bid_depth_usdt<0||p.observed_ask_depth_usdt<0||typeof p.depth_coverage_complete!=='boolean'||
   [p.depth_bid_coverage_bps,p.depth_ask_coverage_bps].some(x=>x<0||x>25)||
   p.depth_coverage_complete&&Math.min(p.depth_bid_coverage_bps,p.depth_ask_coverage_bps)<25||
   Object.keys(p).some(k=>/^(bid|ask)(_depth)?_25_usdt$|depth_25_pct/.test(k)))return unavailable('INVALID_SENSOR_METRIC');
  previous=p;
 }
 if(points[0].start_ms!==raw.start_ms||points.at(-1).end_ms!==raw.end_ms)return unavailable('WINDOW_MISMATCH');
 const last=points.at(-1),returns={};
 for(const seconds of [5,15,30,60,120])returns['return_'+seconds+'s']=last.mid/points[24-seconds/5].start_mid-1;
 return {...raw,age_ms:asOf-raw.end_ms,sensor_freshness_ms:asOf-last.book_received_at_ms,
  sensor_event_latency_ms:last.book_received_at_ms-last.exchange_event_ms,
  max_event_latency_ms:Math.max(...points.map(p=>p.book_received_at_ms-p.exchange_event_ms)),
  btc_return_1m:last.btc_return_1m,...returns,depth_coverage_complete:last.depth_coverage_complete,
  depth_coverage_bps:{bid:last.depth_bid_coverage_bps,ask:last.depth_ask_coverage_bps},
  depth_semantics:'OBSERVED_WITHIN_SNAPSHOT_AND_25BP_INTERSECTION_NO_EXTRAPOLATION'};
}
export async function readMarketSensor(asOf,{fetchFn=fetch,timeoutMs=350,env=k=>globalThis.Deno?.env?.get(k)}={}){
 const url=env('SUPABASE_URL'),key=env('SUPABASE_SERVICE_ROLE_KEY');if(!url||!key)return unavailable('NOT_CONFIGURED');
 const controller=new AbortController();let timer;
 try{
  const work=(async()=>{const r=await fetchFn(url+'/rest/v1/rpc/doa_market_sensor_context_v1',{method:'POST',redirect:'error',signal:controller.signal,
   headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({p_symbol:'BTCUSDT',p_as_of:new Date(asOf).toISOString()})});
   if(!r.ok)return unavailable('READ_FAILED');const text=await r.text();if(text.length>80000)return unavailable('TOO_LARGE');return validateMarketSensor(JSON.parse(text),asOf);})();
  return await Promise.race([work,new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(unavailable('TIMEOUT'));},Math.max(1,Math.min(350,timeoutMs)));})]);
 }catch{return unavailable('READ_FAILED');}finally{clearTimeout(timer);}
}
