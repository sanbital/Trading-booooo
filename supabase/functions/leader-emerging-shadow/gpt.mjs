/** LE-SHADOW-1 GPT ALT1 caller. Separate key (OPENAI_API_KEY_SHADOW only), separate ledger
 * (shadow_le.budget via definer functions), production stand-down, one request, no retry,
 * 8 s timeout, invalid => ABSTAIN. Nothing here can touch the production GPT ledger/journal. */
import {ALT1_VERSION,MODEL,REQUEST_MS,wireSchema,validateAnswer} from './contract.mjs';
import {ALT1_PROMPT} from './prompt.mjs';

export const API_URL='https://api.openai.com/v1/responses';
export const PRICING=Object.freeze({inputPerMillion:.75,cachedPerMillion:.075,outputPerMillion:4.5});
export const BUDGET=Object.freeze({callsPerDay:250,usdPerDay:1.00,perCycle:3,maxInflight:2,reserveUsd:.01});
export const STAND_DOWN=Object.freeze({errorRate:.20,minSample:5,productionCallsPerDay:250});

async function sha256(s){const b=new TextEncoder().encode(s),h=await crypto.subtle.digest('SHA-256',b);return [...new Uint8Array(h)].map(x=>x.toString(16).padStart(2,'0')).join('');}
export const hashOf=x=>sha256(typeof x==='string'?x:JSON.stringify(x));

/** Production-protection rule. Any hit => shadow GPT stands down for this cycle. */
export function standDown(h,S=STAND_DOWN){
  if(!h||typeof h!=='object')return 'PRODUCTION_HEALTH_UNKNOWN';
  const n=Number(h.n_60m),err=Number(h.n_err_60m),quota=Number(h.n_quota_60m),calls=Number(h.ledger_calls_today);
  if(![n,err,quota,calls].every(Number.isFinite))return 'PRODUCTION_HEALTH_UNKNOWN';
  if(quota>0)return 'PRODUCTION_429_OR_QUOTA_60M';
  if(n>=S.minSample&&err/n>S.errorRate)return 'PRODUCTION_ERROR_RATE_60M';
  if(n>0&&n<S.minSample&&err>=2)return 'PRODUCTION_ERROR_RATE_60M';
  if(calls>=S.productionCallsPerDay)return 'PRODUCTION_CALLS_TODAY';
  return null;
}

/** Stage gate: every condition must hold or GPT is not called at all. */
export function gptGate({control,apiKey,health}){
  if(control?.enabled!==true)return 'CONTROL_DISABLED';
  if(control?.gpt_enabled!==true)return 'GPT_DISABLED';
  if(!apiKey)return 'SHADOW_KEY_MISSING';
  return standDown(health);
}

export function buildPacket({candidate,rich,attempt=1,initial=null,current=null,delta=null}){
  const v=rich.facts?.values??{};
  const facts=Object.fromEntries(Object.entries(v).filter(([k])=>!k.startsWith('position_')));
  return {version:ALT1_VERSION,attempt,candidate_id:'le_'+candidate.symbol+'_'+candidate.observedAt,symbol:candidate.symbol,
    lane:candidate.lane,rank_now:candidate.rank,rank_15m:candidate.rank15m,rank_30m:candidate.rank30m,rank_60m:candidate.rank60m,
    velocity:{v15:candidate.velocity15,v60:candidate.velocity60},first_top10_today:candidate.firstTop10Today,
    minutes_in_top10_today:candidate.minutesInTop10Today,day_return_live:candidate.dayReturn,vr15:rich.vr15,
    facts,cost:rich.cost,soft:rich.soft,
    b06133_factors:rich.b06133?.factors??null,
    v30:rich.v30?{admitted:rich.v30.admitted,failed:rich.v30.failed,note:'reference judgment (fresh5over15=true AND volumeTails=false)'}:null,
    cec:rich.cec?{ewma_usdt_per_trade:rich.cec.ewma_usdt,training_count:rich.cec.training_count,
      label:'production 전략 실현성과, 이 후보와 무관 (strategy-wide realized result, not about this candidate)'}:null,
    ...(attempt===2?{initial,current,delta}:{})};
}

export function payloadFor(packet){
  const factKeys=Object.keys(packet.facts).filter(k=>packet.facts[k]!==null);
  return {model:MODEL,store:false,tools:[],truncation:'disabled',service_tier:'default',
    prompt_cache_key:'boo-le-shadow-alt1',reasoning:{effort:'none'},max_output_tokens:600,
    input:[{role:'system',content:ALT1_PROMPT},{role:'user',content:JSON.stringify(packet)}],
    text:{verbosity:'low',format:{type:'json_schema',name:'le_alt1',strict:true,schema:wireSchema({recheck:packet.attempt===2,factKeys})}}};
}

export function costOf(raw){
  const u=raw?.usage,c=u?.input_tokens_details?.cached_tokens??0;
  if(!u||!Number.isSafeInteger(u.input_tokens)||!Number.isSafeInteger(u.output_tokens))return null;
  return ((u.input_tokens-c)*PRICING.inputPerMillion+c*PRICING.cachedPerMillion+u.output_tokens*PRICING.outputPerMillion)/1e6;
}
export function parseOutput(raw){
  if(!(raw?.status==='completed'&&!raw.error&&!raw.incomplete_details))throw Error('ALT_API_INCOMPLETE');
  const chunks=[];
  for(const m of raw.output??[]){
    if(m.type!=='message'&&m.type!=='reasoning')throw Error('ALT_UNEXPECTED_TOOL');
    for(const c of m.content??[]){if(c.type==='refusal')throw Error('ALT_API_REFUSAL');if(c.type==='output_text')chunks.push(c.text);}
  }
  if(chunks.length!==1)throw Error('ALT_API_OUTPUT_COUNT');
  return JSON.parse(chunks[0]);
}
const SAFE=/^(ALT_[A-Z_]+(:[A-Za-z0-9_]*)?|HTTP_\d+|API_TIMEOUT|TYPE:|ENUM:|STRING:|REQUIRED:|EXTRA:|ARRAY:)/;

/**
 * One budgeted request. `reserve`/`settle` are the ledger functions (DB). Returns a record
 * that is ALWAYS usable: decision ABSTAIN with valid=false on any failure.
 */
export async function callAlt1(packet,{apiKey,fetchFn,reserve,settle,now=Date.now,timeoutMs=REQUEST_MS}){
  const out={model:MODEL,decision:'ABSTAIN',valid:false,answer:null,error:null,request_id:null,http_status:null,
    tokens_in:null,tokens_out:null,cost_usd:null,started_at:now(),answered_at:null,latency_ms:null,attempted:false,reservation:null};
  if(!apiKey){out.error='ALT_KEY_MISSING';out.answered_at=now();out.latency_ms=0;return out;}
  const res=await reserve(BUDGET.reserveUsd,'LE_ALT1_A'+packet.attempt);
  out.reservation=res;
  if(!res?.ok){out.error='ALT_BUDGET:'+String(res?.reason??'UNKNOWN').replace(/[^A-Z_]/g,'');out.answered_at=now();out.latency_ms=0;return out;}
  const controller=new AbortController();let timer;
  try{
    const body=JSON.stringify(payloadFor(packet));out.attempted=true;
    const req=(async()=>{
      const r=await fetchFn(API_URL,{method:'POST',signal:controller.signal,body,
        headers:{'content-type':'application/json',authorization:'Bearer '+apiKey}});
      out.http_status=r.status;out.request_id=r.headers?.get?.('x-request-id')??null;
      const text=await r.text();if(text.length>150000)throw Error('ALT_RESPONSE_TOO_LARGE');
      let raw;try{raw=JSON.parse(text);}catch{throw Error('ALT_RESPONSE_NOT_JSON');}
      out.tokens_in=raw?.usage?.input_tokens??null;out.tokens_out=raw?.usage?.output_tokens??null;out.cost_usd=costOf(raw);
      if(!r.ok)throw Error('HTTP_'+r.status);
      if(raw.model!==MODEL)throw Error('ALT_MODEL_MISMATCH');
      return validateAnswer(parseOutput(raw),packet);
    })();
    const expiry=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('API_TIMEOUT'));},timeoutMs);});
    out.answer=await Promise.race([req,expiry]);out.decision=out.answer.decision;out.valid=true;
  }catch(e){out.error=SAFE.test(e?.message??'')?String(e.message).slice(0,120):'ALT_API_OR_VALIDATION_ERROR';out.decision='ABSTAIN';out.valid=false;}
  finally{
    clearTimeout(timer);out.answered_at=now();out.latency_ms=out.answered_at-out.started_at;
    try{await settle(res.reservation_id,out.cost_usd??BUDGET.reserveUsd);}catch{/* reservation stays at its reserved amount */}
  }
  return out;
}

export const promptHash=()=>hashOf(ALT1_PROMPT);
