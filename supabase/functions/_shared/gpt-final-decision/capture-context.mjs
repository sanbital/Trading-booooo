import {trajectoryDynamics,bucketDynamics} from './trajectory.mjs';
import {entryCaptureSafety,DYNAMIC_POLICY} from './dynamic-flow.mjs';
import {hash} from './snapshot-hash.mjs';
export const CAPTURE_VERSION='CAPTURE-CONTEXT-3-TRAJECTORY-120S';
export const CAPTURE_NOTE='capture_context는 판단 직전 약 120초를 5초 x 24구간으로 보존한 변화 경로다. 평균/총합 요약이 아니라 trajectory의 순서와 각 구간 변화량을 읽어라. 현재 실행 시점의 절대 호가·스프레드·깊이는 facts의 최신 microstructure를 우선하고, capture_context는 그 현재 상태에 도달한 방향·가속·반전 여부를 해석하는 데 사용한다. d_mid_bps는 구간 가격 변화, d_spread_bps는 스프레드 증감, d_*_depth_25_pct는 호가 깊이 증감, buy_share_5s와 d_buy_share는 5초 매수 체결 우위와 변화, net_taker_quote_5s와 d_net_taker_quote는 매수-매도 체결대금 및 변화, ask_book_net_5s는 표시 매도호가 순증감(추가-제거), *_impact_450_bps와 d_*_impact_bps는 450 USDT 체결 충격과 변화다. 특히 초반과 후반의 방향이 다르면 마지막 10~20초의 반전/가속을 명시적으로 고려하라. 단, 표시 호가 증감은 취소·이동·체결을 완전히 구분하지 못하므로 단독으로 진짜 매도벽/스푸핑이라 단정하지 마라. ENTRY에서 UNAVAILABLE 또는 10초 이상 된 trajectory는 WAIT이며 신규 주문을 허용하지 않는다. OPEN POSITION에서는 DATA_DEGRADED로 표시하고 최신 emergency 자료와 직전 valid snapshot age/drift를 함께 재심사한다. 자료 누락은 자동 HOLD나 EXIT 근거가 아니다.';
const POINT_KEYS=['end_ms','d_mid_bps','d_spread_bps','d_ask_depth_25_pct','d_bid_depth_25_pct','buy_share_5s','d_buy_share','net_taker_quote_5s','d_net_taker_quote','ask_book_net_5s','buy_impact_450_bps','d_buy_impact_bps','sell_impact_450_bps','d_sell_impact_bps'];
const OPTIONAL_KEYS=['trade_count','arrival_rate','aggressive_notional','bid_book_net_5s','spread_bps','bid_depth_25_usdt','ask_depth_25_usdt','imbalance','btc_return_1m'];
const finiteOrNull=v=>v===null||Number.isFinite(v);
function unavailable(reason){return {version:CAPTURE_VERSION,status:'UNAVAILABLE',reason,valid:false,causal:false,complete:false,bucket_count:0};}
export function contextForModel(c,now=Date.now()){
 if(c?.status!=='AVAILABLE')return c;
 if(c.end_ms>now||now-c.end_ms>=10000)return unavailable('STALE_AT_MODEL_CALL');
 return {...c,age_ms:now-c.end_ms};
}
export function validateCapture(raw,asOf){
 if(raw?.version===CAPTURE_VERSION)return validateCapture120(raw,asOf);
 if(raw?.status!=='AVAILABLE')return unavailable(raw?.reason||'MISSING_OR_INCOMPLETE');
 if(raw.version!=='CAPTURE-CONTEXT-2-TRAJECTORY'||raw.buckets!==12||!Array.isArray(raw.trajectory)||raw.trajectory.length!==12)return unavailable('INVALID');
 const {start_ms:start,end_ms:end,ingested_at_ms:ingested}=raw;
 if(![start,end,ingested,asOf].every(Number.isSafeInteger)||end>ingested+1000||ingested>asOf+1000||end>asOf+1000||asOf-end>25000||end-start<57000||end-start>63000)return unavailable('STALE_OR_FUTURE');
 let prevEnd=null;
 const trajectory=[];
 for(let i=0;i<raw.trajectory.length;i++){
   const p=raw.trajectory[i];
   if(!p||typeof p!=='object'||POINT_KEYS.some(k=>!Object.hasOwn(p,k)))return unavailable('INVALID_POINT');
   if(!Number.isSafeInteger(p.end_ms)||p.end_ms<start||p.end_ms>end+1000||prevEnd!==null&&(p.end_ms-prevEnd<4000||p.end_ms-prevEnd>6500))return unavailable('NONCONTIGUOUS');
   const q={};for(const k of POINT_KEYS){const v=p[k];if(k==='end_ms')q[k]=v;else{if(!finiteOrNull(v))return unavailable('INVALID_POINT');q[k]=v;}}
   for(const k of OPTIONAL_KEYS)if(Object.hasOwn(p,k)){if(!finiteOrNull(p[k]))return unavailable('INVALID_POINT');q[k]=p[k];}
   trajectory.push(q);prevEnd=p.end_ms;
 }
 return {version:raw.version,status:'AVAILABLE',window_ms:end-start,age_ms:asOf-end,start_ms:start,end_ms:end,buckets:12,trajectory};
}
export async function readCapture(symbol,asOf,{fetchFn=fetch,timeoutMs=350,positionId=null,rpc='doa_context_for_role_v1',env=k=>globalThis.Deno?.env?.get(k)}={}){
 const url=env('SUPABASE_URL'),key=env('SUPABASE_SERVICE_ROLE_KEY');if(!url||!key)return unavailable('NOT_CONFIGURED');
 const controller=new AbortController();let timer;
 try{
  const work=(async()=>{const r=await fetchFn(url+'/rest/v1/rpc/'+rpc,{method:'POST',redirect:'error',signal:controller.signal,
   headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({p_symbol:symbol,p_as_of:new Date(asOf).toISOString(),p_position_id:positionId,...(rpc==='doa_context_for_role_v1'?{p_role:positionId?'OPEN_POSITION':'TRADE_CANDIDATE'}:{})})});
   if(!r.ok)return unavailable('READ_FAILED');const text=await r.text();if(text.length>65536)return unavailable('TOO_LARGE');const c=validateCapture120(JSON.parse(text),asOf);if(c.status==='AVAILABLE')c.trajectory_hash=await hash(c.trajectory);return c;})();
  return await Promise.race([work,new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(unavailable('TIMEOUT'));},Math.max(1,Math.min(1500,timeoutMs)));})]);
 }catch{return unavailable('READ_FAILED');}finally{clearTimeout(timer);}
}

/** Retry once, then reconstruct through the raw-bucket RPC. Never fills a gap synthetically. */
export async function readCaptureWithRecovery(symbol,asOf,{now=Date.now,read=readCapture,...options}={}){
 const attempts=[];
 let capture;
 for(const [method,timeoutMs] of [['ROLE',350],['REFRESH',550],['RAW_RECONSTRUCTION',550]]){
  const at=method==='ROLE'?asOf:now();
  capture=await read(symbol,at,{...options,timeoutMs,rpc:method==='RAW_RECONSTRUCTION'?'doa_gpt_capture_context_v3':'doa_context_for_role_v1'});
  const safety=entryCaptureSafety(capture,now());
  attempts.push({method,at_ms:at,received_at_ms:now(),status:capture?.status??'UNAVAILABLE',reason:safety.reason});
  if(safety.ok&&(!safety.refresh_recommended||method!=='ROLE'))return {...capture,recovery_attempts:attempts};
 }
 return {...(capture??unavailable('READ_FAILED')),recovery_attempts:attempts};
}

/** Wait for a genuinely newer completed bucket BEFORE freezing any model input.
 * Never changes event timestamps and never substitutes a partial trajectory. */
export async function captureForInference(symbol,capture,{now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),
 read=readCapture,deadlineMs=Infinity,maxWaitMs=6500,targetAgeMs=1500,...options}={}){
 if(capture?.status!=='AVAILABLE')return capture;
 const started=now(),initialEnd=capture.end_ms,until=Math.min(deadlineMs,started+maxWaitMs);
 const ready=c=>entryCaptureSafety(c,now()).ok&&now()-c.end_ms<=targetAgeMs;
 if(ready(capture))return capture;
 const attempts=[];let current=capture;
 for(let i=0;i<32&&now()+350<until;i++){
  // Most DB buckets arrive about one second after the five-second boundary.
  // Poll only inside the bounded acquisition budget, not the inference lifetime.
  const delay=Math.min(1000,Math.max(100,initialEnd+6000-now()),until-now()-350);
  const before=now();await sleep(delay);
  if(now()<=before)break; // A frozen replay/test clock must not start a live wait loop.
  const at=now();current=await read(symbol,at,{...options,timeoutMs:Math.min(350,until-at)});
  attempts.push({requested_at_ms:at,received_at_ms:now(),status:current?.status,end_ms:current?.end_ms??null});
  if(now()<=until&&current?.end_ms>initialEnd&&ready(current))return {...current,pre_inference_refresh:{
    requested_at_ms:started,received_at_ms:now(),previous_end_ms:initialEnd,previous_age_ms:started-initialEnd,
    advanced:true,wait_ms:now()-started,attempts}};
 }
 return {...unavailable('INFERENCE_CAPTURE_NOT_READY'),pre_inference_refresh:{requested_at_ms:started,received_at_ms:now(),
  previous_end_ms:initialEnd,previous_age_ms:started-initialEnd,advanced:false,wait_ms:now()-started,
  latest_end_ms:current?.end_ms??null,attempts}};
}

/** Minimal current evidence for OPEN positions only; explicitly not a full capture. */
export async function emergencyDynamicPacket(symbol,{fetchFn=fetch,now=Date.now,timeoutMs=800}={}){
 const requested=now();
 const get=async path=>{const r=await fetchFn('https://fapi.binance.com'+path,{method:'GET',redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
  if(!r.ok)throw Error('EMERGENCY_HTTP');return r.json();};
 const settled=await Promise.allSettled([
  get('/fapi/v1/depth?symbol='+encodeURIComponent(symbol)+'&limit=100'),
  get('/fapi/v1/aggTrades?'+new URLSearchParams({symbol,startTime:String(requested-15000),endTime:String(requested),limit:'1000'}))]);
 const book=settled[0].status==='fulfilled'?settled[0].value:null,rows=settled[1].status==='fulfilled'?settled[1].value:null;
 const bid=Number(book?.bids?.[0]?.[0]),ask=Number(book?.asks?.[0]?.[0]),received=now();
 const trades=Array.isArray(rows)?rows.filter(x=>Number.isSafeInteger(x.T)&&x.T<=requested&&x.T>=requested-15000&&Number(x.p)>0&&Number(x.q)>0):[];
 let buy=0,sell=0;for(const x of trades){const q=Number(x.p)*Number(x.q);if(x.m===true)sell+=q;else if(x.m===false)buy+=q;}
 const depth=levels=>Array.isArray(levels)?levels.reduce((sum,x)=>sum+Number(x[0])*Number(x[1]),0):null;
 const b=depth(book?.bids),a=depth(book?.asks),bookOk=bid>0&&ask>=bid&&Number.isFinite(b)&&Number.isFinite(a)&&
  Number.isSafeInteger(book?.T??book?.E)&&(book.T??book.E)<=received&&received-(book.T??book.E)<DYNAMIC_POLICY.absoluteAgeMs;
 return {status:bookOk||trades.length?'EMERGENCY_PARTIAL':'UNAVAILABLE',full_trajectory:false,entry_allowed:false,
  requested_at_ms:requested,received_at_ms:received,executable_bid:bookOk?bid:null,spread_bps:bookOk?(ask-bid)/((bid+ask)/2)*10000:null,
  book_imbalance:bookOk&&b+a>0?(b-a)/(b+a):null,aggressive_buy:trades.length?buy:null,aggressive_sell:trades.length?sell:null,
  net_taker_flow:trades.length?buy-sell:null,buy_share:buy+sell>0?buy/(buy+sell):null,trade_count:trades.length,
  tape_may_be_truncated:Array.isArray(rows)&&rows.length>=1000,errors:settled.map((x,i)=>x.status==='rejected'?['BOOK','TAPE'][i]:null).filter(Boolean)};
}

const V3_KEYS=['flow_event_ms','flow_received_at_ms','bucket_ms','start_ms','received_at_ms','exchange_event_ms','book_received_at_ms','mid','start_mid','aggressive_buy','aggressive_sell'];
export function validateCapture120(raw,asOf){
 if(raw?.status!=='AVAILABLE')return unavailable(raw?.reason??'INCOMPLETE_TRAJECTORY');
 if(raw.version!==CAPTURE_VERSION||raw.buckets!==24||raw.trajectory?.length!==24)return unavailable('INCOMPLETE_TRAJECTORY');
 const {start_ms:start,end_ms:end,ingested_at_ms:ingested}=raw;
 if(![start,end,ingested,asOf].every(Number.isSafeInteger)||end>asOf||ingested>asOf||end>ingested||asOf-end>25000||end-start<117000||end-start>123000)
  return unavailable('STALE_OR_FUTURE');
 const trajectory=[];let previous=null;
 for(const p of raw.trajectory){
  if(!p||[...POINT_KEYS,...V3_KEYS].some(k=>!Object.hasOwn(p,k)))return unavailable('INVALID_POINT');
  if(!['bucket_ms','start_ms','end_ms','received_at_ms','exchange_event_ms','book_received_at_ms'].every(k=>Number.isSafeInteger(p[k])))
   return unavailable('INVALID_TIME');
  if(p.received_at_ms>asOf||p.end_ms>asOf||p.exchange_event_ms>p.end_ms||p.book_received_at_ms>p.end_ms||
   p.received_at_ms<p.end_ms||p.book_received_at_ms<p.exchange_event_ms-1000||
   p.book_received_at_ms-p.exchange_event_ms>10000||p.end_ms-p.book_received_at_ms>10000)return unavailable('NONCAUSAL_BUCKET');
  if(p.end_ms-p.start_ms<4000||p.end_ms-p.start_ms>6500||Math.abs(p.end_ms-p.bucket_ms)>=1000||
   previous&&(p.bucket_ms-previous.bucket_ms!==5000||p.start_ms!==previous.end_ms))return unavailable('NONCONTIGUOUS');
  if(!Number.isSafeInteger(p.trade_count)||p.trade_count<0||p.trade_count>0&&
   (!Number.isSafeInteger(p.flow_event_ms)||!Number.isSafeInteger(p.flow_received_at_ms)||p.flow_event_ms>p.end_ms||
    p.flow_received_at_ms>p.end_ms||p.flow_received_at_ms<=p.start_ms))return unavailable('NONCAUSAL_FLOW');
  if(!(p.mid>0)||!(p.aggressive_buy>=0)||!(p.aggressive_sell>=0))return unavailable('INVALID_POINT');
  const q={};
  for(const k of [...POINT_KEYS,...OPTIONAL_KEYS,...V3_KEYS]){
   if(!Object.hasOwn(p,k))continue;
   if(!finiteOrNull(p[k]))return unavailable('INVALID_POINT');
   q[k]=p[k]===null?null:/_ms$/.test(k)?p[k]:Number(p[k].toPrecision(8));
  }
  trajectory.push(q);previous=p;
 }
 if(trajectory[0].start_ms!==start||trajectory.at(-1).end_ms!==end)return unavailable('WINDOW_MISMATCH');
 return {version:CAPTURE_VERSION,status:'AVAILABLE',coverage_policy:'ALL_24_REQUIRED',position_id:raw.position_id??null,
  trajectory_started_at:start,trajectory_ended_at:end,snapshot_at:asOf,bucket_count:24,valid:true,causal:true,complete:true,
  window_ms:end-start,age_ms:asOf-end,start_ms:start,end_ms:end,buckets:24,trajectory:bucketDynamics(trajectory),dynamics:trajectoryDynamics(trajectory)};
}
