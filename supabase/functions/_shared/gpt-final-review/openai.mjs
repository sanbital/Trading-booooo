import {wireSchema,wireInput,parseApiResponseWire,WIRE_PROFILES} from './wire-v4.mjs';
import {MODEL,LIMITS,ensure,validateAnswer} from './contract.mjs';
import {promptFor} from './prompt.mjs';
export const API_URL='https://api.openai.com/v1/responses';
export const PRICING=Object.freeze({inputPerMillion:.75,cachedPerMillion:.075,outputPerMillion:4.5,verified:'2026-09-23'});
/** Request profiles. V4 is the pre-optimization payload, kept byte-identical for A/B
 * measurement. The production profile is DEFAULT_PROFILE; it only changes transport
 * (output length/verbosity and duplicate input removal), never the verdict contract. */
export const PROFILES=Object.freeze({
  V4:Object.freeze({wire:'V4',maxOutputTokens:LIMITS.outputTokens,verbosity:null,cacheKey:'boo-final-review-v4-facts'}),
  V5:Object.freeze({wire:'V5',maxOutputTokens:900,verbosity:'low',cacheKey:'boo-final-review-v5-facts'}),
  /** Production since 2026-09-24: real-time risk review only (see contract.mjs V6). */
  V6:Object.freeze({wire:'V6',maxOutputTokens:700,verbosity:'low',cacheKey:'boo-final-review-v6-rtrisk'})
});
export const DEFAULT_PROFILE='V6';
export function profileOf(name=DEFAULT_PROFILE){ensure(Object.hasOwn(PROFILES,name),'API_PROFILE_UNKNOWN');return PROFILES[name];}
export function payloadFor(packet,profileName=DEFAULT_PROFILE){
  const p=profileOf(profileName),text={format:{type:'json_schema',name:WIRE_PROFILES[p.wire].schemaName,strict:true,schema:wireSchema(p.wire)}};
  if(p.verbosity)text.verbosity=p.verbosity;
  // Fixed prefix first (instructions + schema), candidate-specific data last.
  return {model:MODEL,store:false,tools:[],truncation:'disabled',service_tier:'default',prompt_cache_key:p.cacheKey,
    reasoning:{effort:'none'},max_output_tokens:p.maxOutputTokens,
    input:[{role:'system',content:promptFor(p.wire)},{role:'user',content:JSON.stringify(wireInput(packet,p.wire))}],text};
}
export function costOf(raw){
  const u=raw?.usage,c=u?.input_tokens_details?.cached_tokens;
  if(!u||![u.input_tokens,u.output_tokens,c].every(Number.isSafeInteger)||c<0||c>u.input_tokens||u.output_tokens<0||u.input_tokens<0)
    return {usd:null,usage:u??null,basis:'USAGE_UNCONFIRMED'};
  if(raw.service_tier&&raw.service_tier!=='default')return {usd:null,usage:u,basis:'SERVICE_TIER_UNCONFIRMED'};
  return {usd:((u.input_tokens-c)*PRICING.inputPerMillion+c*PRICING.cachedPerMillion+u.output_tokens*PRICING.outputPerMillion)/1e6,
    usage:u,basis:'DOCUMENTED_TOKEN_RATE_ESTIMATE_USD_NOT_USDT'};
}
/** One request, never repeat until PASS. Unknown billing is not reported as zero. */
export async function callFinalReviewer(packet,{apiKey,fetchFn=fetch,now=Date.now,deadlineMs,timeoutMs=LIMITS.requestMs,profile=DEFAULT_PROFILE}={}){
  const started=now(),limit=Math.min(timeoutMs,deadlineMs-started);
  const result={origin:'OPENAI_API',decision:'ABSTAIN',valid:false,answer:null,error:null,raw_response:null,http_status:null,
    started_at_ms:started,completed_at_ms:null,latency_ms:null,request_id:null,usage:null,api_cost_usd:null,attempted:false,model_requested:MODEL,wire_profile:profile};
  if(!apiKey){result.error='OPENAI_API_KEY_MISSING';return {...result,completed_at_ms:now(),latency_ms:0,api_cost_usd:0};}
  if(!(limit>0)){result.error='TRIGGER_EXPIRED';return {...result,completed_at_ms:now(),latency_ms:0,api_cost_usd:0};}
  let body;
  try{body=JSON.stringify(payloadFor(packet,profile));}
  catch(e){result.error=/^(INPUT_TOO_LARGE|API_PROFILE_UNKNOWN)$/.test(e?.message)?e.message:'API_OR_VALIDATION_ERROR';return {...result,completed_at_ms:now(),latency_ms:0,api_cost_usd:0};}
  const controller=new AbortController();let timer;
  try{
    result.attempted=true;
    const req=async()=>{
      const response=await fetchFn(API_URL,{method:'POST',redirect:'error',headers:{'content-type':'application/json',
        authorization:'Bearer '+apiKey,'X-Client-Request-Id':crypto.randomUUID()},body,signal:controller.signal});
      result.http_status=response.status;result.request_id=response.headers.get('x-request-id');
      const text=await response.text();ensure(text.length<=150000,'RESPONSE_TOO_LARGE');
      let raw;try{raw=JSON.parse(text);}catch{throw Error('RESPONSE_NOT_JSON');}
      result.raw_response=raw;
      const cost=costOf(raw);result.usage=cost.usage;result.api_cost_usd=cost.usd;result.cost_basis=cost.basis;
      ensure(response.ok,'HTTP_'+response.status);
      ensure(raw.model===MODEL,'RESPONSE_MODEL_MISMATCH');ensure(typeof result.request_id==='string'&&result.request_id.length>0,'REQUEST_ID_MISSING');
      return validateAnswer(parseApiResponseWire(raw,packet,profileOf(profile).wire),packet);
    };
    // The race also bounds body reading and test/custom transports ignoring AbortSignal.
    const expiry=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('API_TIMEOUT'));},limit);});
    result.answer=await Promise.race([req(),expiry]);
    ensure(now()<deadlineMs,'LATE_RESPONSE');result.decision=result.answer.decision;result.valid=true;
  }catch(e){
    // Never include an arbitrary network exception or URL in persisted errors.
    const safe=/^(API_TIMEOUT|LATE_RESPONSE|HTTP_\d+|RESPONSE_[A-Z_]+|REQUEST_ID_MISSING|API_[A-Z_]+|IDENTITY_MISMATCH|EVIDENCE_[A-Z_]+|PASS_[A-Z_]+|CURRENT_[A-Z_]+|ORIGINAL_[A-Z_]+|ASSESSMENT_CONFLICT|VETO_[A-Z_]+|V6_[A-Z_]+|NUMERICAL_[A-Z_]+|FALSE_MISSING|DUPLICATE_CLAIM|UNEXPECTED_API_TOOL|TYPE:|ENUM:|STRING:|REQUIRED:|EXTRA:|ARRAY:)/;
    result.error=safe.test(e?.message??'')?String(e.message).slice(0,180):'API_OR_VALIDATION_ERROR';
    result.decision='ABSTAIN';result.valid=false;
  }finally{clearTimeout(timer);result.completed_at_ms=now();result.latency_ms=result.completed_at_ms-started;}
  return result;
}
