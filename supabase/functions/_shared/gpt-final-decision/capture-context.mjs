export const CAPTURE_NOTE='capture_context는 판단 직전 약 60초를 5초 x 12구간으로 보존한 변화 경로다. 평균/총합 요약이 아니라 trajectory의 순서와 각 구간 변화량을 읽어라. 현재 실행 시점의 절대 호가·스프레드·깊이는 facts의 최신 microstructure를 우선하고, capture_context는 그 현재 상태에 도달한 방향·가속·반전 여부를 해석하는 데 사용한다. d_mid_bps는 구간 가격 변화, d_spread_bps는 스프레드 증감, d_*_depth_25_pct는 호가 깊이 증감, buy_share_5s와 d_buy_share는 5초 매수 체결 우위와 변화, net_taker_quote_5s와 d_net_taker_quote는 매수-매도 체결대금 및 변화, ask_book_net_5s는 표시 매도호가 순증감(추가-제거), *_impact_450_bps와 d_*_impact_bps는 450 USDT 체결 충격과 변화다. 특히 초반과 후반의 방향이 다르면 마지막 10~20초의 반전/가속을 명시적으로 고려하라. 단, 표시 호가 증감은 취소·이동·체결을 완전히 구분하지 못하므로 단독으로 진짜 매도벽/스푸핑이라 단정하지 마라. UNAVAILABLE은 추가 정보가 없다는 뜻이며 그 자체로 BUY 거부·청산·ABSTAIN 사유가 아니다. trajectory는 판단 증거이며 새 하드게이트를 만들지 않는다.';
const POINT_KEYS=['end_ms','d_mid_bps','d_spread_bps','d_ask_depth_25_pct','d_bid_depth_25_pct','buy_share_5s','d_buy_share','net_taker_quote_5s','d_net_taker_quote','ask_book_net_5s','buy_impact_450_bps','d_buy_impact_bps','sell_impact_450_bps','d_sell_impact_bps'];
const finiteOrNull=v=>v===null||Number.isFinite(v);
function unavailable(reason){return {version:'CAPTURE-CONTEXT-2-TRAJECTORY',status:'UNAVAILABLE',reason};}
export function contextForModel(c,now=Date.now()){
 if(c?.status!=='AVAILABLE')return c;
 if(c.end_ms>now||now-c.end_ms>25000)return unavailable('STALE_AT_MODEL_CALL');
 return {...c,age_ms:now-c.end_ms};
}
export function validateCapture(raw,asOf){
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
   trajectory.push(q);prevEnd=p.end_ms;
 }
 return {version:raw.version,status:'AVAILABLE',window_ms:end-start,age_ms:asOf-end,start_ms:start,end_ms:end,buckets:12,trajectory};
}
export async function readCapture(symbol,asOf,{fetchFn=fetch,timeoutMs=200,env=k=>globalThis.Deno?.env?.get(k)}={}){
 const url=env('SUPABASE_URL'),key=env('SUPABASE_SERVICE_ROLE_KEY');if(!url||!key)return unavailable('NOT_CONFIGURED');
 const controller=new AbortController();let timer;
 try{
  const work=(async()=>{const r=await fetchFn(url+'/rest/v1/rpc/doa_gpt_capture_context',{method:'POST',redirect:'error',signal:controller.signal,
   headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({p_symbol:symbol,p_as_of:new Date(asOf).toISOString()})});
   if(!r.ok)return unavailable('READ_FAILED');const text=await r.text();if(text.length>16384)return unavailable('TOO_LARGE');return validateCapture(JSON.parse(text),asOf);})();
  return await Promise.race([work,new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(unavailable('TIMEOUT'));},Math.max(1,Math.min(200,timeoutMs)));})]);
 }catch{return unavailable('READ_FAILED');}finally{clearTimeout(timer);}
}
