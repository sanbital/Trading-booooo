/** FD1 packet construction and the single OpenAI request. No exchange client, no DB. */
import {FACT_DEFS,FACTS_VERSION} from './facts.mjs';
import {FD_VERSION,DATA_MODES,riskFlags,wireSchema,validateDecision} from './contract.mjs';
import {PROMPTS} from './prompt.mjs';
export const MODEL='gpt-5.4-mini-2026-03-17';
export const API_URL='https://api.openai.com/v1/responses';
export const PRICING=Object.freeze({inputPerMillion:.75,cachedPerMillion:.075,outputPerMillion:4.5});
export const REQUEST_MS=8000;
function ensure(ok,reason){if(!ok)throw Error(reason);}
function canonical(x){
  if(x===null||['string','boolean'].includes(typeof x))return JSON.stringify(x);
  if(typeof x==='number'){ensure(Number.isFinite(x),'NONFINITE');return JSON.stringify(x);}
  if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';
  return '{'+Object.keys(x).sort().filter(k=>x[k]!==undefined).map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
}
export async function hash(x){
  const b=new TextEncoder().encode(typeof x==='string'?x:canonical(x));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(v=>v.toString(16).padStart(2,'0')).join('');
}
/** @param position {event, deterministicExitCandidate, stopStage} for HOLD
 *  @param chase    ENTRY only: late-entry context of a LIVE_MOMENTUM_CHASE candidate (absent otherwise,
 *                  so an ordinary candidate's packet is byte-identical to before). */
export async function buildDecisionPacket({task,subjectId,symbol,dataMode,facts,judgments,position=null,chase=null}){
  ensure(task==='ENTRY'||task==='HOLD','FD_TASK');ensure(DATA_MODES.includes(dataMode),'FD_DATA_MODE');
  ensure(facts?.version===FACTS_VERSION,'FD_FACTS_VERSION');ensure(task==='ENTRY'||position,'FD_POSITION_REQUIRED');
  const packet={version:FD_VERSION,task,candidate_id:'c_'+(await hash(String(subjectId))).slice(0,24),symbol:String(symbol).toUpperCase(),
    data_mode:dataMode,facts,model_judgments:judgments??null,
    position:task==='HOLD'?{event:String(position.event??'REVIEW'),deterministic_exit_candidate:position.deterministicExitCandidate??null,
      stop_stage:position.stopStage??null}:null,...(task==='ENTRY'&&chase?{chase}:{}),snapshot_hash:''};
  packet.snapshot_hash=await hash({...packet,snapshot_hash:''});
  return packet;
}
const round=v=>v===null?null:Number(Number(v).toPrecision(5));
/** What GPT sees: grouped facts, unavailable keys, non-clear risk flags, model judgments. */
export function modelInput(packet){
  const sections={},v=packet.facts.values;
  for(const [k,[s]] of Object.entries(FACT_DEFS)){if(v[k]===null)continue;(sections[s]??={})[k]=round(v[k]);}
  const risk=riskFlags(packet);
  return {t:packet.task,candidate_id:packet.candidate_id,symbol:packet.symbol,data_mode:packet.data_mode,facts:sections,
    unavailable:Object.keys(FACT_DEFS).filter(k=>v[k]===null&&(packet.task==='HOLD'||FACT_DEFS[k][0]!=='position')),
    risk_flags:Object.fromEntries(Object.entries(risk.flags).filter(([,x])=>x.level!=='CLEAR').map(([k,x])=>[k,x.level])),
    model_judgments:packet.model_judgments,...(packet.position?{position:packet.position}:{}),...(packet.chase?{chase:packet.chase}:{})};
}
/** ENTRY now writes its evidence and expected value before the decision, so it gets more room. */
export const MAX_OUTPUT_TOKENS=Object.freeze({ENTRY:1000,HOLD:600});
export function payloadFor(packet){
  return {model:MODEL,store:false,tools:[],truncation:'disabled',service_tier:'default',
    prompt_cache_key:'boo-fd1-'+packet.task.toLowerCase(),reasoning:{effort:'none'},max_output_tokens:MAX_OUTPUT_TOKENS[packet.task],
    input:[{role:'system',content:PROMPTS[packet.task]},{role:'user',content:JSON.stringify(modelInput(packet))}],
    text:{verbosity:'low',format:{type:'json_schema',name:'fd1_'+packet.task.toLowerCase(),strict:true,schema:wireSchema(packet.task,packet)}}};
}
export function costOf(raw){
  const u=raw?.usage,c=u?.input_tokens_details?.cached_tokens??0;
  if(!u||!Number.isSafeInteger(u.input_tokens)||!Number.isSafeInteger(u.output_tokens))return null;
  return ((u.input_tokens-c)*PRICING.inputPerMillion+c*PRICING.cachedPerMillion+u.output_tokens*PRICING.outputPerMillion)/1e6;
}
export function parseOutput(raw){
  ensure(raw?.status==='completed'&&!raw.error&&!raw.incomplete_details,'FD_API_INCOMPLETE');
  const chunks=[];for(const m of raw.output??[]){ensure(m.type==='message'||m.type==='reasoning','FD_UNEXPECTED_TOOL');
    for(const c of m.content??[]){ensure(c.type!=='refusal','FD_API_REFUSAL');if(c.type==='output_text')chunks.push(c.text);}}
  ensure(chunks.length===1,'FD_API_OUTPUT_COUNT');return JSON.parse(chunks[0]);
}
const SAFE=/^((FD|RC)_[A-Z_]+(:[A-Za-z0-9_,]*)?|HTTP_\d+|API_TIMEOUT|TYPE:|ENUM:|STRING:|REQUIRED:|EXTRA:|ARRAY:)/;
/** One request, never retried. Any failure => ABSTAIN (entry: no order; hold: deterministic engine). */
export async function callDecision(packet,{apiKey,fetchFn=fetch,now=Date.now,timeoutMs=REQUEST_MS,payloadFn=payloadFor,validate=validateDecision}={}){
  const started=now(),out={origin:'OPENAI_API',model:MODEL,decision:'ABSTAIN',valid:false,answer:null,error:null,wire:null,
    request_id:null,http_status:null,usage:null,api_cost_usd:null,started_at_ms:started,completed_at_ms:null,latency_ms:null,attempted:false};
  if(!apiKey){out.error='FD_API_KEY_MISSING';out.api_cost_usd=0;out.completed_at_ms=now();out.latency_ms=0;return out;}
  const controller=new AbortController();let timer;
  try{
    const body=JSON.stringify(payloadFn(packet));out.attempted=true;
    const req=(async()=>{
      const res=await fetchFn(API_URL,{method:'POST',redirect:'error',signal:controller.signal,body,
        headers:{'content-type':'application/json',authorization:'Bearer '+apiKey}});
      out.http_status=res.status;out.request_id=res.headers?.get?.('x-request-id')??null;
      const text=await res.text();ensure(text.length<=150000,'FD_RESPONSE_TOO_LARGE');
      let raw;try{raw=JSON.parse(text);}catch{throw Error('FD_RESPONSE_NOT_JSON');}
      out.usage=raw?.usage??null;out.api_cost_usd=costOf(raw);
      if(!res.ok){const e=raw?.error??{};out.error_detail={type:String(e.type??'').slice(0,60)||null,code:String(e.code??'').slice(0,60)||null,
        retry_after:res.headers?.get?.('retry-after')??null,limit_requests:res.headers?.get?.('x-ratelimit-remaining-requests')??null,limit_tokens:res.headers?.get?.('x-ratelimit-remaining-tokens')??null};}
      ensure(res.ok,'HTTP_'+res.status);ensure(raw.model===MODEL,'FD_MODEL_MISMATCH');
      out.wire=parseOutput(raw);return validate(out.wire,packet);
    })();
    const expiry=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('API_TIMEOUT'));},timeoutMs);});
    out.answer=await Promise.race([req,expiry]);out.decision=out.answer.decision;out.valid=true;
  }catch(e){out.error=SAFE.test(e?.message??'')?String(e.message).slice(0,160):'FD_API_OR_VALIDATION_ERROR';out.decision='ABSTAIN';out.valid=false;}
  finally{clearTimeout(timer);out.completed_at_ms=now();out.latency_ms=out.completed_at_ms-started;}
  return out;
}
