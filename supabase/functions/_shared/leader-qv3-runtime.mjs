import {entryGate,exitSignal} from './leader-qv3-rules.mjs';
export const QV3_VERSION='QV3_ENTRY_EXIT_TWO_1';
export const QV3_VARIANT='ENTRY_EXIT_TWO';
export const QV3_INPUT_EVIDENCE_VERSION='QV3_INPUT_EVIDENCE_1';
// The research protocol remains DEFER. This fixed cutover records the operator's
// explicit live override; no environment or HTTP request can move it.
export const QV3_ACTIVATION_BASIS='OPERATOR_OVERRIDE_PROTOCOL_DEFER_20260911';
export const QV3_LIVE_CUTOVER=Date.parse('2026-09-11T15:20:00.000Z');
const MINUTE=60000;
const unavailable=reason=>({available:false,reason,executionEnabled:false});
export function validCandle(b){
  if(!Array.isArray(b)||b.length<7||[0,1,2,3,4,6].some(i=>b[i]===null||b[i]===''||b[i]===undefined))return false;
  const [t,o,h,l,c]=b.map(Number),end=Number(b[6]);
  return [t,o,h,l,c,end].every(Number.isFinite)&&Number.isSafeInteger(t)&&t>=0&&t%MINUTE===0&&end===t+MINUTE-1&&o>0&&l>0&&c>0&&h>=Math.max(o,c)&&l<=Math.min(o,c);
}
export function candleWindow(bars,now,start){
  if(!Number.isSafeInteger(now)||!Array.isArray(bars))return unavailable('CANDLE_INPUT_INVALID');
  const last=Math.floor(now/MINUTE)*MINUTE-MINUTE;
  if(!Number.isSafeInteger(start)||start%MINUTE!==0||start>last)return unavailable('NO_COMPLETED_POST_ENTRY_CANDLE');
  const selected=[],seen=new Set();
  for(const b of bars){
    if(!Array.isArray(b)||!Number.isFinite(Number(b[0])))return unavailable('CANDLE_INVALID');
    const t=Number(b[0]);if(t<start||t>last)continue;
    if(!validCandle(b))return unavailable('CANDLE_INVALID');
    if(seen.has(t))return unavailable('CANDLE_DUPLICATE');seen.add(t);selected.push(b);
  }
  selected.sort((a,b)=>Number(a[0])-Number(b[0]));
  const count=(last-start)/MINUTE+1;
  if(selected.length!==count||selected.some((b,i)=>Number(b[0])!==start+i*MINUTE))return unavailable('CANDLE_MISSING');
  return {available:true,bars:selected,through:last+MINUTE-1};
}
export function qv3Entry(bars,now){
  const checked=candleWindow(bars,now,Math.floor(now/MINUTE)*MINUTE-3*MINUTE);
  if(!checked.available)return {...checked,wouldBlock:true,version:QV3_VERSION};
  const result=entryGate(checked.bars,now,QV3_VARIANT);
  return {version:QV3_VERSION,available:true,wouldBlock:result.reject,
    reason:result.reject?'QV3_ENTRY_WEAKENING':'QV3_ENTRY_PASS',through:checked.through,executionEnabled:false};
}
export function qv3Stamp(activation,entryAt){
  return Number.isSafeInteger(activation)&&Number.isSafeInteger(entryAt)&&entryAt>=activation
    ?{version:QV3_VERSION,activation,entryAt,basis:QV3_ACTIVATION_BASIS}:null;
}
export function qv3Scope(p,activation){
  const s=p.qv3;
  return p.ownership==='AUTO'&&p.side==='LONG'&&p.state==='OPEN'&&
    Number.isSafeInteger(activation)&&s?.version===QV3_VERSION&&s.basis===QV3_ACTIVATION_BASIS&&s.activation===activation&&
    s.entryAt===p.entryAt&&p.entryAt>=activation&&Number.isFinite(p.entryPrice)&&p.entryPrice>0;
}
/**
 * Capture the exact two most recent completed rows from the already-fetched QV3
 * market response. This function is audit-only: it performs no fetch, never mutates
 * the input, and always returns a serializable value instead of affecting a decision.
 */
export function qv3AuditEvidence(bars,now,through=null,requestedAt=null){
  const empty={version:QV3_INPUT_EVIDENCE_VERSION,source:'BINANCE_FAPI_PUBLIC_1M_KLINES_LIVE_RESPONSE',
    status:'INVALID_INPUT',requestedAtMs:Number.isSafeInteger(requestedAt)?requestedAt:null,
    responseParsedAtMs:Number.isSafeInteger(now)?now:null,evaluatedAtMs:Number.isSafeInteger(now)?now:null,
    requestToEvaluationMs:Number.isSafeInteger(requestedAt)&&Number.isSafeInteger(now)&&now>=requestedAt?now-requestedAt:null,
    through:Number.isSafeInteger(through)?through:null,
    responseRows:Array.isArray(bars)?bars.length:null,validCompletedRows:0,invalidRows:0,tail:[]};
  try{
    if(!Array.isArray(bars)||!Number.isSafeInteger(now))return empty;
    const cutoff=Number.isSafeInteger(through)?through:Math.floor(now/MINUTE)*MINUTE-1;
    const completed=[];let invalidRows=0;
    for(const row of bars){
      if(!validCandle(row)){invalidRows++;continue;}
      if(Number(row[6])>cutoff)continue;
      completed.push({openTimeMs:Number(row[0]),open:String(row[1]),high:String(row[2]),low:String(row[3]),
        close:String(row[4]),volume:String(row[5]),closeTimeMs:Number(row[6])});
    }
    completed.sort((a,b)=>a.openTimeMs-b.openTimeMs);
    return {...empty,status:'CAPTURED',through:cutoff,validCompletedRows:completed.length,invalidRows,tail:completed.slice(-2)};
  }catch{return {...empty,status:'CAPTURE_FAILED'};}
}
/** State contains an observed completed candle, not a peak/high or a leveraged return.
 * A restart validates that proof against this position; it never trusts a bare boolean.
 */
export function qv3Exit(p,bars,now,prior=null){
  if(p.ownership!=='AUTO'||p.side!=='LONG'||p.state!=='OPEN')return {available:true,wouldClose:false,reason:'QV3_PRESERVE',executionEnabled:false};
  if(!Number.isSafeInteger(p.entryAt)||!(p.entryPrice>0)||!Number.isSafeInteger(now)||now<p.entryAt)return unavailable('POSITION_INPUT_INVALID');
  const first=Math.ceil(p.entryAt/MINUTE)*MINUTE,last=Math.floor(now/MINUTE)*MINUTE-MINUTE;
  let proof=null;
  if(prior){
    if(prior.version!==QV3_VERSION||prior.positionId!==p.id||prior.entryAt!==p.entryAt||prior.entryPrice!==p.entryPrice||
      !Number.isSafeInteger(prior.observedAt)||prior.observedAt>now)return unavailable('QV3_STATE_MISMATCH');
    if(prior.favorableCandle){
      const b=prior.favorableCandle;
      if(!validCandle(b)||Number(b[0])<first||Number(b[6])>=prior.observedAt||Number(b[6])>=now||!(Number(b[4])>p.entryPrice*1.002))return unavailable('QV3_ARM_PROOF_INVALID');
      proof=b;
    }
  }
  const checked=candleWindow(bars,now,proof?Math.max(first,last-MINUTE):first);
  if(!checked.available)return checked;
  if(!proof)proof=checked.bars.find(b=>Number(b[4])>p.entryPrice*1.002)??null;
  const xs=checked.bars.slice();if(proof&&!xs.some(b=>Number(b[0])===Number(proof[0])))xs.unshift(proof);
  const state={version:QV3_VERSION,positionId:p.id,entryAt:p.entryAt,entryPrice:p.entryPrice,observedAt:now,favorableCandle:proof};
  const wouldClose=exitSignal(p,xs,now,QV3_VARIANT);
  return {version:QV3_VERSION,available:true,wouldClose,reason:wouldClose?'QV3_TWO_BEARISH_CLOSED':'QV3_HOLD',state,through:checked.through,executionEnabled:false};
}
/** Public GET only. No authenticated exchange endpoint or gateway dependency. */
export async function qv3Candles(symbol,now,start,fetchFn=fetch){
  if(typeof symbol!=='string'||!symbol.endsWith('USDT')||symbol.length>64||!Number.isSafeInteger(now)||!Number.isSafeInteger(start))throw Error('QV3_MARKET_INPUT');
  const end=Math.floor(now/MINUTE)*MINUTE-1,count=Math.ceil((end-start+1)/MINUTE);
  if(count<1||count>499)throw Error('QV3_HISTORY_LIMIT');
  const params=new URLSearchParams({symbol,interval:'1m',startTime:String(start),endTime:String(end),limit:String(count)});
  const r=await fetchFn('https://fapi.binance.com/fapi/v1/klines?'+params,{method:'GET',signal:AbortSignal.timeout(2000)});
  if(!r.ok)throw Error('QV3_MARKET_'+r.status);
  return r.json();
}
