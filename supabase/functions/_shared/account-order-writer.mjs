/** Infrastructure only. Strategy validation and attribution remain existing adapters.
 * One turn claims AFTER ownership, reconciles ambiguous submissions, and never replays
 * an entry. The exchange adapter must enforce the fence at its side-effect boundary.
 */
export class WriterError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function executionErrorCode(error) {
  if (error?.code && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.code)) return error.code;
  const text = String(error?.message ?? error);
  if (/WRITER_FENCED|COMMAND_FENCED/.test(text)) return 'LEASE_FENCED';
  if (/ENOTFOUND|EAI_AGAIN|DNS/i.test(text)) return 'DNS_TEMPORARY_FAILURE';
  if (/ECONNRESET|connection reset/i.test(text)) return 'DB_CONNECTION_RESET';
  if (/ECONNREFUSED|connection refused/i.test(text)) return 'DB_CONNECTION_REFUSED';
  if (/DB.*timeout|connection.*timeout/i.test(text)) return 'DB_TIMEOUT';
  if (/timeout|AbortError|timed out/i.test(text)) return 'EXCHANGE_TIMEOUT';
  return 'INTERNAL_SYSTEM_ERROR';
}
export function assertCurrentEntry(row, now, verdict) {
  if (row.kind !== 'ENTRY') return;
  const deadline = Date.parse(row.deadline);
  if (!Number.isFinite(deadline) || now >= deadline) throw new WriterError('DEADLINE_EXPIRED');
  if (verdict?.authority !== true) throw new WriterError('AUTHORITY_EXPIRED');
  if (verdict?.freshness !== true) throw new WriterError('MARKET_DATA_STALE');
  if (verdict?.buckets !== true) throw new WriterError('CAPTURE_VALIDATION_FAILED');
  if (verdict?.capacity !== true) throw new WriterError('CAPACITY_REJECTED');
  if (verdict?.circuitClosed !== true) throw new WriterError('CIRCUIT_OPEN');
  if (verdict?.recoveryComplete !== true) throw new WriterError('RECOVERY_INCOMPLETE');
  if (verdict?.sameOrderAbsent !== true) throw new WriterError('ORDER_IDENTITY_UNRESOLVED');
}
const REFUSALS = new Set(['DEADLINE_EXPIRED','AUTHORITY_EXPIRED','MARKET_DATA_STALE',
  'CAPTURE_VALIDATION_FAILED','CAPACITY_REJECTED','CIRCUIT_OPEN','RECOVERY_INCOMPLETE',
  'ORDER_IDENTITY_UNRESOLVED','EXCHANGE_REJECTED']);
export function assertSettlementResult(row,receipt,result) {
  if (result?.state!=='FILLED') return;
  const observed=receipt?.receipt??receipt;
  const quantity=Number(observed?.quantity??observed?.q),requested=Number(row.payload?.order?.quantity);
  if (!(requested>0&&quantity>0)||Math.abs(quantity-requested)>Math.max(1e-10,requested*1e-8)||
    observed?.status==='PARTIALLY_FILLED') throw new WriterError('PARTIAL_FILL_CANNOT_BE_FILLED');
}

export function createWriterRepository(db) {
  const rpc = async (name, args) => {
    const r = await db.rpc(name, args);
    if (r.error) throw new Error(`${name}:${r.error.message}`);
    return r.data;
  };
  const args = lease => ({p_account:lease.account_key,p_owner:lease.owner,p_fence:lease.fence});
  return {
    enqueue:request=>rpc('trading_execution_enqueue',{p_request:request}),
    acquire:(account,owner)=>rpc('trading_writer_acquire',{p_account:account,p_owner:owner}),
    verify:lease=>rpc('trading_writer_verify',args(lease)),
    heartbeat:lease=>rpc('trading_writer_heartbeat',args(lease)),
    release:lease=>rpc('trading_writer_release',args(lease)),
    claim:lease=>rpc('trading_execution_claim',args(lease)),
    recoveryStatus:account=>rpc('trading_writer_recovery_status',{p_account:account}),
    completeRecovery:(lease,generation,evidence)=>rpc('trading_writer_recovery_complete',
      {...args(lease),p_generation:generation,p_evidence:evidence}),
    transition:(row,lease,state,reason=null,evidence={})=>rpc('trading_execution_transition',
      {...args(lease),p_key:row.execution_key,p_state:state,p_reason:reason,p_evidence:evidence}),
  };
}

export async function writerTurn({account,owner,repository,exchange,validate,settle,
  now=Date.now,timers=globalThis,onEvent=()=>{}}) {
  let lease;
  try { lease=await repository.acquire(account,owner); }
  catch (error) {
    const code=executionErrorCode(error);
    try {onEvent({state:'WRITER_UNAVAILABLE',reason:code,at:new Date(now()).toISOString()});}catch{}
    // An acknowledgement may be lost after acquisition committed. The owner is
    // unique to this turn; without a returned fence it cannot safely do work.
    return {status:code,error:code,terminal:false};
  }
  if (!lease) return {status:'WRITER_BUSY',terminal:false};
  const abort = new AbortController();
  let lost = false, timer, row, submitting = false, heartbeatRunning = false;
  const event = (state,reason=null) => {
    // Observability failures must not replace the durable order outcome.
    try { onEvent({correlation_id:row?.correlation_id,
      execution_key:row?.execution_key,state,reason,fence:lease.fence,at:new Date(now()).toISOString()}); } catch {}
  };
  const verify = async () => {
    if (lost || !(await repository.verify(lease))) {
      lost=true; abort.abort(); throw new WriterError('LEASE_FENCED');
    }
  };
  const heartbeat = async () => {
    if (heartbeatRunning || lost) return;
    heartbeatRunning=true;
    try { if (!(await repository.heartbeat(lease))) throw new WriterError('HEARTBEAT_FAILED'); }
    catch { lost=true; abort.abort(); event('WRITER_LOST','HEARTBEAT_FAILED'); }
    finally { heartbeatRunning=false; }
  };
  const move = async (state,reason=null,evidence={}) => {
    await verify(); row=await repository.transition(row,lease,state,reason,evidence); event(state,reason);
  };
  try {
    timer=timers.setInterval(heartbeat,Math.max(100,Math.floor(lease.ttl_ms/3)));
    row=await repository.claim(lease);
    if (!row) return {status:'IDLE'};
    event(row.state);
    if (row.submitting_at || row.state === 'UNKNOWN') {
      // Never expire, reset to PENDING, or submit an ambiguous command. Only complete
      // exchange evidence and the existing attribution adapter can settle its truth.
      const existing=await exchange.lookup(row,{signal:abort.signal});
      await verify();
      if (existing?.complete !== true) {
        await move('UNKNOWN','EXCHANGE_LOOKUP_INCOMPLETE'); return {status:'UNKNOWN'};
      }
      if (existing.found !== true) {
        if (existing.neverPlaced !== true) {
          await move('UNKNOWN','ORDER_NOT_FOUND_UNPROVEN'); return {status:'UNKNOWN'};
        }
        await move('RECONCILED','ORDER_NEVER_PLACED_CONFIRMED',existing.evidence??{});
        return {status:'RECONCILED',resubmitted:false};
      }
      await move('ACKNOWLEDGED',null,{exchange_order_id:existing.orderId});
      const result=await settle(row,existing,{lease,signal:abort.signal,verify});
      assertSettlementResult(row,existing,result);
      await move(result.state,result.reason,result.evidence); return {status:result.state};
    }
    await move('VALIDATING');
    const verdict=await validate(row,{lease,signal:abort.signal});
    assertCurrentEntry(row,now(),verdict);
    if (row.kind !== 'ENTRY' && verdict?.allowed !== true) throw new WriterError(verdict?.reason??'VALIDATION_FAILED');
    await verify();
    // Durable SUBMITTING precedes the exchange call. A lost acknowledgement remains
    // reconcilable even if the process dies before writing UNKNOWN.
    await move('SUBMITTING'); submitting=true;
    await verify();
    assertCurrentEntry(row,now(),verdict);
    // Re-read the existing production guards after durable DB I/O. Reusing a
    // boolean verdict would conceal data/authority expiry spent in that I/O.
    const boundaryVerdict=await validate(row,{lease,signal:abort.signal,phase:'SUBMIT_BOUNDARY'});
    assertCurrentEntry(row,now(),boundaryVerdict);
    if (row.kind !== 'ENTRY' && boundaryVerdict?.allowed !== true) throw new WriterError(boundaryVerdict?.reason??'VALIDATION_FAILED');
    await verify();
    const receipt=await exchange.submitFenced(row,{lease,signal:abort.signal,verify});
    await move('ACKNOWLEDGED',null,{exchange_order_id:receipt.orderId});
    const result=await settle(row,receipt,{lease,signal:abort.signal,verify});
    assertSettlementResult(row,receipt,result);
    await move(result.state,result.reason,result.evidence);
    return {status:result.state};
  } catch (error) {
    const code=executionErrorCode(error); event('ERROR',code);
    if (row && !lost) {
      try {
        const ambiguous=submitting || Boolean(row.submitting_at);
        await move(ambiguous?'UNKNOWN':REFUSALS.has(code)?code==='DEADLINE_EXPIRED'?'EXPIRED':'REJECTED':'PENDING',code);
      } catch { /* Durable prior state remains the recovery source of truth. */ }
    }
    return {status:row?.submitting_at?'UNKNOWN':lost?'LEASE_FENCED':code,error:code};
  } finally {
    if (timer !== undefined) timers.clearInterval(timer);
    abort.abort();
    try { await repository.release(lease); } catch { /* Expiry permits recovery. */ }
  }
}
