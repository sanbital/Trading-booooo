/** LE-SHADOW-1 network guard. Every outbound request of the shadow goes through here.
 *
 * Allowlist (anything else throws before a socket is opened):
 *   Binance  GET  fapi.binance.com /fapi/v1/{klines,depth,exchangeInfo,ticker/price,premiumIndex,premiumIndexKlines}
 *                                  /futures/data/openInterestHist
 *   OpenAI   POST api.openai.com /v1/responses
 * Binance protection: a per-cycle weight cap (documented request weights, counted before the
 * request), an immediate abort when the shared IP's x-mbx-used-weight-1m reaches 1,200 (the
 * production scanner stops at 2,100, so the shadow always yields first), and a day halt on
 * HTTP 418/429. There is exactly one Binance host: no fapi1/fapi2 rotation. */
export const BINANCE_HOST='fapi.binance.com';
export const OPENAI_HOST='api.openai.com';
export const BINANCE_PATHS=Object.freeze(['/fapi/v1/klines','/fapi/v1/depth','/fapi/v1/exchangeInfo','/fapi/v1/ticker/price',
  '/fapi/v1/premiumIndex','/fapi/v1/premiumIndexKlines','/futures/data/openInterestHist']);
export const OPENAI_PATHS=Object.freeze(['/v1/responses']);
export const WEIGHT_ABORT_AT=1200;
export const CYCLE_WEIGHT_CAP=100;
export const DAY_HALT_STATUSES=Object.freeze([418,429]);

export class GuardError extends Error{
  constructor(code,detail=null){super(code);this.code=code;this.detail=detail;}
}

/** Documented Binance USD-M request weights (conservative where the docs are silent). */
export function binanceWeight(path,params){
  const limit=Number(params.get('limit')??NaN);
  const byLimit=(l,d)=>!Number.isFinite(l)?d:l<100?1:l<500?2:l<=1000?5:10;
  switch(path){
    case '/fapi/v1/klines':case '/fapi/v1/premiumIndexKlines':return byLimit(limit,2);
    case '/fapi/v1/depth':{const l=Number.isFinite(limit)?limit:500;return l<=50?2:l<=100?5:l<=500?10:20;}
    case '/fapi/v1/exchangeInfo':return 1;
    case '/fapi/v1/ticker/price':return params.has('symbol')?1:2;
    case '/fapi/v1/premiumIndex':return params.has('symbol')?1:10;
    case '/futures/data/openInterestHist':return 1;
    default:throw new GuardError('FETCH_NOT_ALLOWED',path);
  }
}

function headerKeys(h){
  if(!h)return [];
  if(typeof h.keys==='function')return [...h.keys()].map(k=>k.toLowerCase());
  if(Array.isArray(h))return h.map(([k])=>String(k).toLowerCase());
  return Object.keys(h).map(k=>k.toLowerCase());
}

/**
 * @param {object} o
 * @param {Function} o.fetchFn underlying fetch
 * @param {number} [o.cycleWeightCap]
 * @param {number} [o.abortAt]
 * @returns {{fetch:Function,state:object}}
 */
export function createGuard({fetchFn=fetch,cycleWeightCap=CYCLE_WEIGHT_CAP,abortAt=WEIGHT_ABORT_AT}={}){
  const state={weight:0,usedMax:null,requests:0,openaiRequests:0,abort:null,dayHalt:null,log:[]};
  async function guarded(input,init={}){
    const url=new URL(typeof input==='string'?input:String(input?.url??input));
    const method=String(init.method??'GET').toUpperCase();
    if(url.protocol!=='https:'||url.username||url.password||url.port)throw new GuardError('FETCH_NOT_ALLOWED',url.origin);
    if(url.hostname===OPENAI_HOST){
      if(method!=='POST'||!OPENAI_PATHS.includes(url.pathname)||url.search)throw new GuardError('FETCH_NOT_ALLOWED',method+' '+url.pathname);
      state.openaiRequests++;
      return fetchFn(url.href,{...init,method:'POST',redirect:'error'});
    }
    if(url.hostname!==BINANCE_HOST)throw new GuardError('FETCH_NOT_ALLOWED',url.hostname);
    if(method!=='GET'||init.body!=null||!BINANCE_PATHS.includes(url.pathname))throw new GuardError('FETCH_NOT_ALLOWED',method+' '+url.pathname);
    // public market data only: no API key, no signed parameters
    if(headerKeys(init.headers).some(k=>k==='x-mbx-apikey'||k==='authorization')||url.searchParams.has('signature')||url.searchParams.has('timestamp'))
      throw new GuardError('FETCH_NOT_ALLOWED','SIGNED_REQUEST');
    if(state.dayHalt)throw new GuardError('BINANCE_DAY_HALT',state.dayHalt);
    if(state.abort)throw new GuardError('BINANCE_ABORTED',state.abort);
    const w=binanceWeight(url.pathname,url.searchParams);
    if(state.weight+w>cycleWeightCap){state.abort='CYCLE_WEIGHT_CAP';throw new GuardError('CYCLE_WEIGHT_CAP',state.weight+w);}
    state.weight+=w;state.requests++;
    const r=await fetchFn(url.href,{method:'GET',redirect:'error',signal:init.signal??AbortSignal.timeout(4000)});
    const used=Number(r.headers?.get?.('x-mbx-used-weight-1m'));
    if(Number.isFinite(used))state.usedMax=Math.max(state.usedMax??0,used);
    state.log.push({p:url.pathname,w,s:r.status,u:Number.isFinite(used)?used:null});
    if(DAY_HALT_STATUSES.includes(r.status)){state.dayHalt='BINANCE_HTTP_'+r.status;throw new GuardError('BINANCE_DAY_HALT',state.dayHalt);}
    if(Number.isFinite(used)&&used>=abortAt){state.abort='SHARED_IP_WEIGHT_HIGH';throw new GuardError('SHARED_IP_WEIGHT_HIGH',used);}
    return r;
  }
  return {fetch:guarded,state};
}

/** JSON GET through the guard (Binance only). */
export async function getJson(guard,path,params={}){
  const q=new URLSearchParams(Object.entries(params).map(([k,v])=>[k,String(v)]));
  const r=await guard.fetch('https://'+BINANCE_HOST+path+(q.size?'?'+q:''),{method:'GET'});
  if(!r.ok)throw new GuardError('BINANCE_HTTP_'+r.status);
  const t=await r.text();
  if(t.length>2_000_000)throw new GuardError('BINANCE_TOO_LARGE');
  return JSON.parse(t);
}
