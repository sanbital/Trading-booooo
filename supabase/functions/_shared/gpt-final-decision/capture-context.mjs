export const CAPTURE_NOTE='추가 capture_context는 판단 시점 전에 수집한 최근 약 일 분 호가·체결 변화다. AVAILABLE인 경우 진입 기대값과 보유 상승 논리의 지속 여부를 비교할 때 함께 고려하라. 이는 현재 실행 호가가 아니며 값의 나이(age_ms)를 확인하라. 비용은 기존 사실과 함께 검토하고 스프레드를 VWAP 영향에 다시 더하지 마라. 표시 매도호가 추가량은 취소·이동·체결을 구분하지 못하므로 진짜 매도벽이나 스푸핑으로 단정하지 마라. UNAVAILABLE은 추가 정보가 없다는 뜻이며 그 자체로 매수 거부·청산·ABSTAIN 사유가 아니다. 기존 reasons/support/evidence 허용 키와 판정 조건은 그대로 지켜라. 추가 시계열은 기존 근거의 해석에 사용하고 새 임계값이나 주문 권한을 만들지 마라.';
const KEYS=['spread_bps','spread_vs_60s_median','mid_return_60s','bid_depth_25_change','ask_depth_25_change','buy_share_5s','buy_share_60s','buy_quote_60s','sell_quote_60s','max_sell_quote_1s','displayed_ask_added_per_s','displayed_ask_removed_per_s','buy_impact_450_bps','sell_impact_450_bps'];
export function contextForModel(c,now=Date.now()){
 if(c.status!=='AVAILABLE')return c;
 if(c.end_ms>now||now-c.end_ms>25000)return {version:'CAPTURE-CONTEXT-1',status:'UNAVAILABLE',reason:'STALE_AT_MODEL_CALL'};
 return {...c,age_ms:now-c.end_ms};
}
export function validateCapture(raw,asOf){
 const unavailable=reason=>({version:'CAPTURE-CONTEXT-1',status:'UNAVAILABLE',reason});
 if(raw?.status!=='AVAILABLE')return unavailable('MISSING_OR_INCOMPLETE');
 if(raw.version!=='CAPTURE-CONTEXT-1'||raw.buckets!==12)return unavailable('INVALID');
 const {start_ms:start,end_ms:end,ingested_at_ms:ingested}=raw;
 if(![start,end,ingested,asOf].every(Number.isSafeInteger)||end>ingested||ingested>asOf||end>asOf||asOf-end>25000||end-start<57000||end-start>63000)return unavailable('STALE_OR_FUTURE');
 if(KEYS.some(k=>!Object.hasOwn(raw.values??{},k)||(raw.values[k]!==null&&!Number.isFinite(raw.values[k]))))return unavailable('INVALID');
 return {version:raw.version,status:'AVAILABLE',window_ms:end-start,age_ms:asOf-end,start_ms:start,end_ms:end,buckets:12,
   values:Object.fromEntries(KEYS.map(k=>[k,raw.values[k]]))};
}
export async function readCapture(symbol,asOf,{fetchFn=fetch,timeoutMs=200,env=k=>globalThis.Deno?.env?.get(k)}={}){
 const missing=reason=>({version:'CAPTURE-CONTEXT-1',status:'UNAVAILABLE',reason});
 const url=env('SUPABASE_URL'),key=env('SUPABASE_SERVICE_ROLE_KEY');if(!url||!key)return missing('NOT_CONFIGURED');
 const controller=new AbortController();let timer;
 try{
  const work=(async()=>{const r=await fetchFn(url+'/rest/v1/rpc/doa_gpt_capture_context',{method:'POST',redirect:'error',signal:controller.signal,
   headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({p_symbol:symbol,p_as_of:new Date(asOf).toISOString()})});
   if(!r.ok)return missing('READ_FAILED');const text=await r.text();if(text.length>8192)return missing('TOO_LARGE');return validateCapture(JSON.parse(text),asOf);})();
  return await Promise.race([work,new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(missing('TIMEOUT'));},Math.max(1,Math.min(200,timeoutMs)));})]);
 }catch{return missing('READ_FAILED');}finally{clearTimeout(timer);}
}
