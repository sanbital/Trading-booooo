/** Exact durable command transport. Signing/credentials are never persisted or logged.
 * The caller puts the existing engine_version in payload before enqueue; transport
 * does not change strategy, order fields, or the command bound by the DB fence.
 */
export function createWriterGateway({url,secret,networkBoundMs,fetchImpl=fetch}) {
  if (!Number.isInteger(networkBoundMs)||networkBoundMs<100||networkBoundMs>30000) throw Error('WRITER_NETWORK_BOUND_REQUIRED');
  return async (command,{signal}={}) => {
    if (!url||!secret) throw Error('GATEWAY_CONFIG_MISSING');
    signal?.throwIfAborted();
    const raw=JSON.stringify(command),ts=String(Date.now()),nonce=crypto.randomUUID();
    const encoder=new TextEncoder(),key=await crypto.subtle.importKey('raw',encoder.encode(secret),
      {name:'HMAC',hash:'SHA-256'},false,['sign']);
    const bytes=await crypto.subtle.sign('HMAC',key,encoder.encode(`${ts}\n${nonce}\n${raw}`));
    const signature=[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
    const timeout=AbortSignal.timeout(networkBoundMs);
    const r=await fetchImpl(`${url}/v1/command`,{method:'POST',
      signal:signal?AbortSignal.any([signal,timeout]):timeout,
      headers:{'content-type':'application/json','x-gateway-ts':ts,'x-gateway-nonce':nonce,
        'x-gateway-signature':signature},body:raw});
    const data=await r.json();
    if(!r.ok||data?.ok!==true) {
      // Retain only the narrow definitive-not-found signal needed for existing
      // reconciliation. Arbitrary gateway bodies never enter an error/log message.
      const missing=/-2013|order does not exist/i.test(String(data?.error??''));
      const canonical={WRITER_FENCED:'LEASE_FENCED',WRITER_DB_TIMEOUT:'DB_TIMEOUT',
        WRITER_DB_DNS_FAILURE:'DNS_TEMPORARY_FAILURE',WRITER_DB_CONNECTION_RESET:'DB_CONNECTION_RESET',
        WRITER_DB_CONNECTION_REFUSED:'DB_CONNECTION_REFUSED',WRITER_DB_UNAVAILABLE:'DB_UNAVAILABLE',
        WRITER_CONTEXT_REQUIRED:'WRITER_CONTEXT_REQUIRED',WRITER_DB_CREDENTIALS_MISSING:'WRITER_DB_CREDENTIALS_MISSING'};
      const code=Object.hasOwn(canonical,data?.code)?canonical[data.code]:null;
      throw Object.assign(Error(missing?'EXCHANGE_ORDER_NOT_FOUND_-2013':code??`GATEWAY_HTTP_${r.status}`),
        {status:r.status,...(code?{code}:{})});
    }
    return data.result;
  };
}
