import {hash} from '../gpt-final-decision/snapshot-hash.mjs';

/** Reserve before a physical provider call, settle even invalid model JSON. No automatic
 * retries. An ambiguous timeout retains its reservation until usage is reconciled. */
export function paidTransport(db,{parentKey,purpose,fetchFn=fetch,now=Date.now}={}) {
 let sequence=0;
 return async(url,init={})=>{
  const provider=url==='https://api.openai.com/v1/responses'?'openai':
   url==='https://api.deepseek.com/chat/completions'?'deepseek':null;
  if(!provider)return fetchFn(url,init);
  const body=JSON.parse(init.body), bytes=new TextEncoder().encode(init.body).length;
  const output=body.max_output_tokens??body.max_tokens;
  if(!Number.isSafeInteger(output)||output<1)throw Error('API_UNBOUNDED_OUTPUT');
  // One UTF-8 byte per token plus framing is a deliberately conservative bound.
  const reserve=((bytes+4096)*(provider==='deepseek'?.3:.75)+output*(provider==='deepseek'?1.2:4.5))/1e6;
  const version=await hash({body,sequence:sequence++}),key=await hash({parentKey,provider,version});
  const requestedOwner=crypto.randomUUID();let claim;
  for(let attempt=0;attempt<3;attempt++){
   claim=await db.rpc('ai_call_reserve_owned',{p_owner:requestedOwner,p_key:key,p_provider:provider,p_model:body.model,
    p_purpose:purpose,p_parent:parentKey,p_version:version,p_reserve:reserve});
   if(!claim.error)break;
   if(attempt<2)await new Promise(resolve=>setTimeout(resolve,100*(attempt+1)));
  }
  if(claim.error||!claim.data?.created){
   const e=Error(claim.error?'API_LEDGER_RESERVATION_FAILED':claim.data?.reason??'API_CALL_ALREADY_RESERVED');
   e.budget=claim.data??{reason:'API_LEDGER_RESERVATION_FAILED'};throw e;
  }
  const owner=claim.data.row.owner;
  const transition=async(state,extra={})=>{
   for(let attempt=0;attempt<3;attempt++){
    const r=await db.rpc('ai_call_transition',{p_key:key,p_owner:owner,p_state:state,...extra});
    if(!r.error)return r.data;
    // These PostgreSQL errors guarantee rollback. Retry only the same ledger
    // transition, never the provider request or an ambiguous dispatch.
    if(!['55P03','57014','40001','40P01'].includes(r.error.code)||attempt===2)throw Error('API_LEDGER_WRITE_FAILED');
    await new Promise(resolve=>setTimeout(resolve,100*(attempt+1)));
   }
  };
  if(init.signal?.aborted){await transition('CANCELLED');throw Error('API_CANCELLED_BEFORE_DISPATCH');}
  await transition('DISPATCHED');
  const start=now();let response;
  try{response=await fetchFn(url,init);}
  catch(e){await transition('UNKNOWN',{p_error:'TRANSPORT_OUTCOME_UNKNOWN',p_latency_ms:Math.max(0,now()-start)});throw e;}
  let raw;
  try{raw=await response.clone().json();}catch{}
  const u=raw?.usage;
  const usage=provider==='openai'?{input_tokens:u?.input_tokens,output_tokens:u?.output_tokens,
   cached_input_tokens:u?.input_tokens_details?.cached_tokens??0}:
   {input_tokens:u?.prompt_tokens,output_tokens:u?.completion_tokens,
    cached_input_tokens:u?.prompt_cache_hit_tokens??u?.prompt_tokens_details?.cached_tokens??0};
  if([usage.input_tokens,usage.output_tokens,usage.cached_input_tokens].every(x=>Number.isSafeInteger(x)&&x>=0)&&usage.cached_input_tokens<=usage.input_tokens)
   await transition('SETTLED',{p_usage:usage,p_request_id:raw.id??response.headers.get('x-request-id'),p_latency_ms:now()-start});
  else await transition('UNKNOWN',{p_error:'USAGE_UNAVAILABLE_HTTP_'+response.status,
   p_request_id:raw?.id??response.headers.get('x-request-id'),p_latency_ms:Math.max(0,now()-start)});
  return response;
 };
}
