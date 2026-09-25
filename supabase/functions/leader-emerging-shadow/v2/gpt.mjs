/** LE-SHADOW-2 ALT GPT V2 caller and packet builders.
 * Separate key (OPENAI_API_KEY_SHADOW only), separate lane-aware ledger (shadow_le.v2_budget via
 * definer functions: DISCOVERY and PARITY counted apart), production stand-down (V1 rule), one
 * request, no retry, invalid => ABSTAIN, budget exhausted => SHADOW_BUDGET_EXHAUSTED (no call). */
import {ALT2_VERSION,MODEL,REQUEST_MS,wireSchema,validateAnswer} from './contract.mjs';
import {ALT2_PROMPT} from './prompt.mjs';
import {costOf,parseOutput,hashOf,standDown} from '../gpt.mjs';

export const API_URL='https://api.openai.com/v1/responses';
export const BUDGET_V2=Object.freeze({
  DISCOVERY:{callsPerDay:300,usdPerDay:1.50,perCycle:2},
  PARITY:{callsPerDay:200,usdPerDay:1.00,perRun:3},
  reserveUsd:.012,
});

/** Gate for a lane: control flags, key, production stand-down. null = open. */
export function v2Gate({control,apiKey,health,lane}){
  if(control?.enabled!==true)return 'CONTROL_DISABLED';
  if(lane==='DISCOVERY'&&control?.v2_discovery_gpt!==true)return 'V2_DISCOVERY_GPT_DISABLED';
  if(lane==='PARITY'&&control?.v2_parity_enabled!==true)return 'V2_PARITY_DISABLED';
  if(!apiKey)return 'SHADOW_KEY_MISSING';
  return standDown(health);
}

const noPosition=v=>Object.fromEntries(Object.entries(v??{}).filter(([k])=>!k.startsWith('position_')));

/**
 * Packet for ALT GPT V2. Contains ONLY point-in-time facts, the axes computed from them, rank
 * context, advisory legacy judgments and explicit costs. Never a production decision.
 */
export function buildPacketV2({lane,symbol,eventKey,facts,axes,rankContext,legacy,cost,hardSafety=[],attempt=1,initial=null,current=null,delta=null,trigger=null}){
  return {version:ALT2_VERSION,lane_source:lane,attempt,event_key:eventKey,symbol,
    rank_context:rankContext??null,facts:noPosition(facts),axes,cost,hard_safety:hardSafety,
    legacy:legacy??null,
    ...(attempt===2?{initial,current,delta,trigger}:{})};
}

export function payloadV2(packet){
  return {model:MODEL,store:false,tools:[],truncation:'disabled',service_tier:'default',
    prompt_cache_key:'boo-le-shadow-alt2',reasoning:{effort:'none'},max_output_tokens:700,
    input:[{role:'system',content:ALT2_PROMPT},{role:'user',content:JSON.stringify(packet)}],
    text:{verbosity:'low',format:{type:'json_schema',name:'le_alt2',strict:true,schema:wireSchema({recheck:packet.attempt===2})}}};
}

const SAFE=/^(ALT2?_[A-Z0-9_]+(:[A-Za-z0-9_]*)?|HTTP_\d+|API_TIMEOUT|TYPE:|ENUM:|STRING:|REQUIRED:|EXTRA:|ARRAY:|SHADOW_BUDGET_EXHAUSTED)/;

/**
 * One budgeted request. reserve(lane, usd, purpose) / settle(id, usd) are the v2 ledger functions.
 * Always returns a usable record (ABSTAIN, valid=false on any failure).
 */
export async function callAlt2(packet,{lane,apiKey,fetchFn,reserve,settle,now=Date.now,timeoutMs=REQUEST_MS}){
  const out={model:MODEL,decision:'ABSTAIN',valid:false,answer:null,error:null,request_id:null,http_status:null,
    tokens_in:null,tokens_out:null,cost_usd:null,asked_at:now(),answered_at:null,latency_ms:null,attempted:false,reservation:null};
  if(!apiKey){out.error='ALT2_KEY_MISSING';out.answered_at=now();out.latency_ms=0;return out;}
  const res=await reserve(lane,BUDGET_V2.reserveUsd,'LE_ALT2_'+lane+'_A'+packet.attempt);
  out.reservation=res;
  if(!res?.ok){out.error='SHADOW_BUDGET_EXHAUSTED:'+String(res?.reason??'UNKNOWN').replace(/[^A-Z_]/g,'');out.answered_at=now();out.latency_ms=0;return out;}
  const controller=new AbortController();let timer;
  try{
    const body=JSON.stringify(payloadV2(packet));out.attempted=true;out.asked_at=now();
    const req=(async()=>{
      const r=await fetchFn(API_URL,{method:'POST',signal:controller.signal,body,headers:{'content-type':'application/json',authorization:'Bearer '+apiKey}});
      out.http_status=r.status;out.request_id=r.headers?.get?.('x-request-id')??null;
      const text=await r.text();if(text.length>150000)throw Error('ALT2_RESPONSE_TOO_LARGE');
      let raw;try{raw=JSON.parse(text);}catch{throw Error('ALT2_RESPONSE_NOT_JSON');}
      out.tokens_in=raw?.usage?.input_tokens??null;out.tokens_out=raw?.usage?.output_tokens??null;out.cost_usd=costOf(raw);
      if(!r.ok)throw Error('HTTP_'+r.status);
      if(raw.model!==MODEL)throw Error('ALT2_MODEL_MISMATCH');
      return validateAnswer(parseOutput(raw),packet);
    })();
    const expiry=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('API_TIMEOUT'));},timeoutMs);});
    out.answer=await Promise.race([req,expiry]);out.decision=out.answer.decision;out.valid=true;
  }catch(e){out.error=SAFE.test(e?.message??'')?String(e.message).slice(0,120):'ALT2_API_OR_VALIDATION_ERROR';out.decision='ABSTAIN';out.valid=false;}
  finally{
    clearTimeout(timer);out.answered_at=now();out.latency_ms=out.answered_at-out.asked_at;
    try{await settle(res.reservation_id,out.cost_usd??BUDGET_V2.reserveUsd);}catch{/* reservation stays at its reserved amount */}
  }
  return out;
}

export const promptHashV2=()=>hashOf(ALT2_PROMPT);
export const schemaHashV2=(recheck=false)=>hashOf(wireSchema({recheck}));
export {hashOf};
