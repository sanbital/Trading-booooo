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
  if(!required||venue!=='binance_futures'||['GET','HEAD'].includes(method)||
    (method==='POST'&&path==='/fapi/v1/order/test'))return;
  const verify=mutationContext.getStore();
  if(!verify)throw refusal('WRITER_CONTEXT_REQUIRED');
  await verify();
}

export function createOrderWriterFence({required=false,authorize}) {
  const tails=new Map();
  return {
    async run(command,execute) {
      if (!required || !hasExchangeSideEffect(command)) return execute();
      const envelope=command.writer;
      if (!envelope?.account_key || !envelope.execution_key || !envelope.owner ||
        !/^[1-9][0-9]*$/.test(String(envelope.fence))) throw refusal('WRITER_ENVELOPE_REQUIRED');
      const expectedAccount=`${command.exchange}:futures`;
      if (command.exchange !== 'binance_futures' || envelope.account_key !== expectedAccount) {
        throw refusal('WRITER_ACCOUNT_MISMATCH');
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
          if (!(await authorize(envelope,boundPayload))) throw refusal('WRITER_FENCED');
        };
        await verify();
        return await mutationContext.run(verify,execute);
      } finally {
        done(); if (tails.get(envelope.account_key)===tail) tails.delete(envelope.account_key);
      }
    },
    activeAccounts:()=>tails.size,
  };
}

export function createGatewayAuthorizer({url,key,fetchImpl=fetch,timeoutMs=2500}) {
  return async (envelope,command) => {
    if (!url || !key) throw refusal('WRITER_DB_CREDENTIALS_MISSING');
    const response=await fetchImpl(`${url}/rest/v1/rpc/trading_gateway_authorize`,{
      method:'POST',signal:AbortSignal.timeout(timeoutMs),
      headers:{'content-type':'application/json',apikey:key,Authorization:`Bearer ${key}`},
      body:JSON.stringify({p_key:envelope.execution_key,p_account:envelope.account_key,
        p_owner:envelope.owner,p_fence:envelope.fence,p_command:command}),
    });
    if (!response.ok) throw refusal('WRITER_DB_UNAVAILABLE');
    return (await response.json())===true;
  };
}
