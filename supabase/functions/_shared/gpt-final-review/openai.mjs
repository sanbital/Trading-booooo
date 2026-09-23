import {WIRE_OUTPUT_SCHEMA_V4 as WIRE_OUTPUT_SCHEMA,compactInputV4 as compactInput,parseApiResponseV4 as parseApiResponse} from './wire-v4.mjs';
import {MODEL,LIMITS,ensure,validateAnswer} from './contract.mjs';
import {SYSTEM_PROMPT} from './prompt.mjs';
export const API_URL='https://api.openai.com/v1/responses';
export const PRICING=Object.freeze({inputPerMillion:.75,cachedPerMillion:.075,outputPerMillion:4.5,verified:'2026-09-23'});
export function payloadFor(packet){return {model:MODEL,store:false,tools:[],truncation:'disabled',service_tier:'default',prompt_cache_key:'boo-final-review-v4-facts',
  reasoning:{effort:'none'},max_output_tokens:LIMITS.outputTokens,
  input:[{role:'system',content:SYSTEM_PROMPT},{role:'user',content:JSON.stringify(compactInput(packet))}],
  text:{format:{type:'json_schema',name:'entry_final_review_v4_factref',strict:true,schema:WIRE_OUTPUT_SCHEMA}}};}
export function costOf(raw){
  const u=raw?.usage,c=u?.input_tokens_details?.cached_tokens;
  if(!u||![u.input_tokens,u.output_tokens,c].every(Number.isSafeInteger)||c<0||c>u.input_tokens||u.output_tokens<0||u.input_tokens<0)
    return {usd:null,usage:u??null,basis:'USAGE_UNCONFIRMED'};
  if(raw.service_tier&&raw.service_tier!=='default')return {usd:null,usage:u,basis:'SERVICE_TIER_UNCONFIRMED'};
  return {usd:((u.input_tokens-c)*PRICING.inputPerMillion+c*PRICING.cachedPerMillion+u.output_tokens*PRICING.outputPerMillion)/1e6,
    usage:u,basis:'DOCUMENTED_TOKEN_RATE_ESTIMATE_USD_NOT_USDT'};
}
/** One request, never repeat until PASS. Unknown billing is not reported as zero. */
export async function callFinalReviewer(packet,{apiKey,fetchFn=fetch,now=Date.now,deadlineMs,timeoutMs=LIMITS.requestMs}={}){
  const started=now(),limit=Math.min(timeoutMs,deadlineMs-started);
  const result={origin:'OPENAI_API',decision:'ABSTAIN',valid:false,answer:null,error:null,raw_response:null,
    started_at_ms:started,completed_at_ms:null,latency_ms:null,request_id:null,usage:null,api_cost_usd:null,attempted:false,model_requested:MODEL};
  if(!apiKey){result.error='OPENAI_API_KEY_MISSING';return {...result,completed_at_ms:now(),latency_ms:0,api_cost_usd:0};}
  if(!(limit>0)){result.error='TRIGGER_EXPIRED';return {...result,completed_at_ms:now(),latency_ms:0,api_cost_usd:0};}
  const controller=new AbortController();let timer;
  try{
    result.attempted=true;
    const req=async()=>{
      const response=await fetchFn(API_URL,{method:'POST',redirect:'error',headers:{'content-type':'application/json',
        authorization:'Bearer '+apiKey,'X-Client-Request-Id':crypto.randomUUID()},body:JSON.stringify(payloadFor(packet)),signal:controller.signal});
      result.request_id=response.headers.get('x-request-id');
      const text=await response.text();ensure(text.length<=150000,'RESPONSE_TOO_LARGE');
      let raw;try{raw=JSON.parse(text);}catch{throw Error('RESPONSE_NOT_JSON');}
      result.raw_response=raw;
      const cost=costOf(raw);result.usage=cost.usage;result.api_cost_usd=cost.usd;result.cost_basis=cost.basis;
      ensure(response.ok,'HTTP_'+response.status);
      ensure(raw.model===MODEL,'RESPONSE_MODEL_MISMATCH');ensure(typeof result.request_id==='string'&&result.request_id.length>0,'REQUEST_ID_MISSING');
      return validateAnswer(parseApiResponse(raw,packet),packet);
    };
    // The race also bounds body reading and test/custom transports ignoring AbortSignal.
    const expiry=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('API_TIMEOUT'));},limit);});
    result.answer=await Promise.race([req(),expiry]);
    ensure(now()<deadlineMs,'LATE_RESPONSE');result.decision=result.answer.decision;result.valid=true;
  }catch(e){
    // Never include an arbitrary network exception or URL in persisted errors.
    const safe=/^(API_TIMEOUT|LATE_RESPONSE|HTTP_\d+|RESPONSE_[A-Z_]+|REQUEST_ID_MISSING|API_[A-Z_]+|IDENTITY_MISMATCH|EVIDENCE_[A-Z_]+|PASS_[A-Z_]+|CURRENT_[A-Z_]+|ORIGINAL_[A-Z_]+|ASSESSMENT_CONFLICT|VETO_REQUIRES_FACT|NUMERICAL_[A-Z_]+|FALSE_MISSING|DUPLICATE_CLAIM|UNEXPECTED_API_TOOL|TYPE:|ENUM:|STRING:|REQUIRED:|EXTRA:|ARRAY:)/;
    result.error=safe.test(e?.message??'')?String(e.message).slice(0,180):'API_OR_VALIDATION_ERROR';
    result.decision='ABSTAIN';result.valid=false;
  }finally{clearTimeout(timer);result.completed_at_ms=now();result.latency_ms=result.completed_at_ms-started;}
  return result;
}
