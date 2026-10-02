import crypto from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
const mutationContext=new AsyncLocalStorage();
const READ_ACTIONS = new Set(['portfolio','accounts','p10_portfolio','v18_open_orders',
  'v18_entry_never_placed_proof','futures_position_mode','quote','p10_quotes','symbol_info',
  'order_test','get_order','open_orders','fees','trade_history','order_history',
  'v17_stop_fill','v17_query_stop','v17_protection_capabilities','v17_shadow_positions','v17_shadow_status']);
export function hasExchangeSideEffect(command) {
  // Unknown future actions fail closed when fencing is enabled.
  return !READ_ACTIONS.has(String(command?.action));
}
const refusal = code => Object.assign(new Error(code),{code,status:503});

/** Revalidate at each signed exchange mutation, after preparation/time sync and
 * again on timestamp retry. Read-only proofs and the venue's dry-run API remain
 * usable without DB ownership. Background writers cannot bypass the HTTP gate.
 */
export async function beforeExchangeMutation({required,venue,method,path}) {
  if(venue!=='binance_futures'||['GET','HEAD'].includes(method)||
    (method==='POST'&&path==='/fapi/v1/order/test'))return;
  const verify=mutationContext.getStore();
  if(!verify){if(required)throw refusal('WRITER_CONTEXT_REQUIRED');return;}
  await verify();
}

export function createOrderWriterFence({required=false,authorize,acquireLegacy}) {
  const tails=new Map();
  return {
    async run(command,execute) {
      if (['upbit','binance'].includes(command.exchange)||(!required&&!command.writer)||!hasExchangeSideEffect(command))return execute();
      let envelope=command.writer,legacy=null;
      if(!envelope&&acquireLegacy){
        // Retired P10 entry cannot use the management compatibility path. Existing
        // native stops/explicit reduce-only CLOSE remain supported under the account writer.
        if(command.action==='create_order'&&!(command.order?.side==='SELL'&&command.order?.position_effect==='CLOSE'))throw refusal('FINAL_BUY_WRITER_REQUIRED');
        if(!['create_order','cancel_order','v17_create_stop','v17_cancel_stop'].includes(command.action))throw refusal('LEGACY_MANAGEMENT_ACTION_REQUIRED');
        legacy=await acquireLegacy(command);envelope=legacy?.envelope;
      }
      if (!envelope?.account_key || !envelope.execution_key || !envelope.owner ||
        !/^[1-9][0-9]*$/.test(String(envelope.fence))){await legacy?.release();throw refusal('WRITER_ENVELOPE_REQUIRED');}
      const expectedAccount=`${command.exchange}:futures`;
      if (command.exchange !== 'binance_futures' || envelope.account_key !== expectedAccount) {
        await legacy?.release();throw refusal('WRITER_ACCOUNT_MISMATCH');
      }
      const {writer,...payload}=command;
      const boundPayload=structuredClone(payload);
      // Hold the local boundary through the actual network completion. A request
      // that waited in the gateway must revalidate its DB fence after that wait.
      const previous=tails.get(envelope.account_key)??Promise.resolve();
      let done;
      const tail=new Promise(resolve=>{done=resolve;});
      tails.set(envelope.account_key,tail);
      await previous;
      try {
        const verify=async()=>{
          if (legacy?.healthy?.()===false||!(await authorize(envelope,boundPayload))) throw refusal('WRITER_FENCED');
        };
        await verify();
        return await mutationContext.run(verify,execute);
      } finally {
        done(); if (tails.get(envelope.account_key)===tail) tails.delete(envelope.account_key);
        await legacy?.release();
      }
    },
    activeAccounts:()=>tails.size,
  };
}

export function createGatewayAuthorizer({url,key,fetchImpl=fetch,timeoutMs=2500}) {
  return async (envelope,command) => {
    if (!url || !key) throw refusal('WRITER_DB_CREDENTIALS_MISSING');
    let response;
    try{
      response=await fetchImpl(`${url}/rest/v1/rpc/v17_gateway_authorize`,{
        method:'POST',signal:AbortSignal.timeout(timeoutMs),
        headers:{'content-type':'application/json',apikey:key,Authorization:`Bearer ${key}`},
        body:JSON.stringify({p_key:envelope.execution_key,p_account:envelope.account_key,
          p_owner:envelope.owner,p_fence:envelope.fence,p_command:command}),
      });
    }catch(error){
      const code=error?.cause?.code??error?.code;
      throw refusal(['TimeoutError','AbortError'].includes(error?.name)?'WRITER_DB_TIMEOUT':
        ['ENOTFOUND','EAI_AGAIN'].includes(code)?'WRITER_DB_DNS_FAILURE':
        code==='ECONNRESET'?'WRITER_DB_CONNECTION_RESET':code==='ECONNREFUSED'?'WRITER_DB_CONNECTION_REFUSED':
        'WRITER_DB_UNAVAILABLE');
    }
    if (!response.ok) throw refusal('WRITER_DB_UNAVAILABLE');
    return (await response.json())===true;
  };
}

/** Only legacy management gets a short writer at the final gateway boundary. */
export function createGatewayLegacyLease({url,key,fetchImpl=fetch,timers=globalThis}){
 const rpc=async(name,args)=>{
  if(!url||!key)throw refusal('WRITER_DB_CREDENTIALS_MISSING');
  const r=await fetchImpl(`${url}/rest/v1/rpc/${name}`,{method:'POST',signal:AbortSignal.timeout(2500),
   headers:{'content-type':'application/json',apikey:key,Authorization:`Bearer ${key}`},body:JSON.stringify(args)});
  if(!r.ok)throw refusal('WRITER_DB_UNAVAILABLE');return r.json();
 };
 return async command=>{
  const owner=crypto.randomUUID();let active=false,heartbeatFailed=false,timer;
  const release=async()=>{timers.clearInterval(timer);try{await rpc('v17_release_execution_lease',{p_owner:owner});}catch{}};
  try{
   const acquired=await rpc('v17_acquire_gateway_writer',{p_owner:owner});
   if(!acquired)throw refusal('ACCOUNT_WRITER_BUSY');
   if(acquired.owner!==owner||!Number.isSafeInteger(Number(acquired.fence))||Number(acquired.fence)<1)throw refusal('WRITER_ACQUISITION_EVIDENCE_INVALID');active=true;
   const envelope={account_key:'binance_futures:futures',owner,fence:acquired.fence,
    execution_key:crypto.createHash('sha256').update(JSON.stringify(command)).digest('hex')};
   timer=timers.setInterval(()=>{if(!active)return;active=false;
    rpc('v17_heartbeat_execution_lease',{p_owner:owner,p_fence:acquired.fence}).then(ok=>{if(ok!==true)heartbeatFailed=true;},()=>{heartbeatFailed=true;}).finally(()=>active=true);
   },5000);timer?.unref?.();
   return {envelope,release,healthy:()=>!heartbeatFailed};
  }catch(error){await release();throw error;}
 };
}
