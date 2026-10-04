// @ts-nocheck
// Decision authority is deterministic. Existing lease, receipt and reconciliation infrastructure remains intact.
import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import {admitSchedulerRequest} from '../_shared/scheduler-admission.mjs';
import {authenticateInternalToken} from '../_shared/internal-token-auth.mjs';
import {createAnalysisReadCoalescer} from './analysis-read-coalescer.mjs';
import {createHostAccountScopes} from './account-host-scopes.mjs';
import {currentExecutionContext,currentAccountOwner,contextualOwners,contextualState,executionContextHeaders,assertActiveExecutionRequest} from './account-scope-context.mjs';
import {ENGINE,decidePosition,entrySignalWindow} from '../_shared/deterministic/market-state.mjs';
import {PROFILE} from '../_shared/deterministic/calibration.mjs';
import {control,currentMarket,requireEntryAuthority,isLeader20,detachAudit,validateOrder,validatePreparedOrder} from '../_shared/deterministic/runtime.mjs';
import {entryEvidence,cancellationCategory} from '../_shared/deterministic/entry-evidence.mjs';
import {normalizeEntryBook,gatewayTakerFeeRate,supportedFuturesMode} from '../_shared/deterministic/book.mjs';
import {plannedEntryRiskView} from '../_shared/deterministic/planned-entry-risk.mjs';
import {EXIT_AUTHORITY_VERSION,EXIT_CLASS,exitClass,hardSafetyState,approvedProtection,assertExitAuthority,positionGeneration} from '../_shared/deterministic/exit-authority.mjs';
import {POLICY,STRATEGY,ENTRY_EXECUTION_POLICY_VERSION,postFillEntryGuard} from '../_shared/leader-momentum-v17.mjs';
import {exitAttemptId,classifyExitResponse} from '../_shared/leader-exit-review.mjs';
import {SLOT_SIZING_CONTRACT,floorStep,planSlotEntry,slotSizingBounds} from '../_shared/leader-slot-sizing.mjs';
import {protectNewLeaderPosition} from '../_shared/leader-entry-protection.mjs';
import {createGatewayProtection} from '../_shared/leader-protection-adapter.mjs';
import {classifyPortfolio,freshPortfolio,ownedEntry,riskOrders,classifyFailure,operatorAllowsRecovery,recoveryEvidence,confirmedLiveProtection,createBudget,boundedMap} from '../_shared/leader-ops-isolation.mjs';
import {entryReceipt,entryExposureMatches} from '../_shared/leader-entry-settlement.mjs';
import {classifyEntryOrderState} from '../_shared/entry-order-state.mjs';
import {applyExitReceipt} from '../_shared/leader-exit-settlement.mjs';
import {analyzeDbOnlyExit} from '../_shared/leader-db-only-reconciliation.mjs';
import {ENTRY_CONTROL_VERSION,CONTROL_SCOPE,evaluateEntryDecision,symbolRecoveryEvidence} from '../_shared/leader-entry-control.mjs';
import {IOC_RETRY_POLICY,planAggressiveIocRetry} from './entry-ioc-retry.mjs';
import {RETRY_RECONCILIATION_VERSION,retryProofCandidate,parentTradeStart,proveUnplacedPartialRetry} from './entry-retry-reconciliation.mjs';
import {entryCapacity,slotCostUsdt,ledgerEntry} from '../_shared/deterministic/capacity.mjs';
const REVISION='V11-LONG-REGIME-1.0.1',PATCH=ENGINE,OBSERVER_REVISION='MARKET-REGIME-OBSERVER-v2-C01-HYSTERESIS-v1-FULLMARKET',PROTOCOL='8.0.0-P10-DONCHIAN-SLOW4R';
const MARGIN=SLOT_SIZING_CONTRACT.targetMarginUsdt,LEV=SLOT_SIZING_CONTRACT.leverage,NOTIONAL=MARGIN*LEV;
const SLOT_BOUNDS=slotSizingBounds(SLOT_SIZING_CONTRACT),MAX_ORDER_MARGIN_USDT=SLOT_BOUNDS.maxOrderMarginUsdt;
const MAX_SLOTS=10,SETUP_MAX_CONCURRENT=MAX_SLOTS,ENTRY_CASH_BUFFER_USDT=.10,IOC_MAX_BPS=SLOT_SIZING_CONTRACT.iocMaxBps,SNAP_MAX=90000;
const ENTRY_SLOT_COST_USDT=slotCostUsdt({maxOrderMarginUsdt:MAX_ORDER_MARGIN_USDT,leverage:LEV,takerFeeRate:.0005,iocMaxBps:IOC_MAX_BPS});
const RELEASE_SCOPE=Object.freeze({SYMBOL:'SYMBOL',ACCOUNT:'ACCOUNT'}),CAPACITY_REFRESH_BUDGET=Object.freeze({ms:6000,calls:4}),NEVER_PLACED_PROOF_MAX_AGE_MS=6*3600000;
const env=n=>(Deno.env.get(n)||'').trim(),GW=env('BINANCE_FUTURES_ORDER_GATEWAY_URL').replace(/\/$/,'')||env('BINANCE_ORDER_GATEWAY_URL').replace(/\/$/,'')||env('ORDER_GATEWAY_URL').replace(/\/$/,''),SEC=env('BINANCE_FUTURES_GATEWAY_SHARED_SECRET')||env('BINANCE_GATEWAY_SHARED_SECRET')||env('GATEWAY_SHARED_SECRET');
const NATIVE_STOP_ENABLED=env('V17_NATIVE_STOP')==='true',EXECUTION_LEASE_TTL_SECONDS=150;
const leaseOwners=contextualOwners(),cycleBudgets=contextualState('budget');
const shortWriterModes=new WeakMap(),accountHostScopes=new WeakMap(),analysisGatewayReads=new WeakMap();
async function loadAccountExecutionMode(db){
 const r=await db.from('v17_execution_infrastructure_control').select('short_writer_enabled').eq('singleton',true).single();
 if(r.error||!r.data)throw Error('EXECUTION_INFRASTRUCTURE_CONTROL_UNAVAILABLE');
 shortWriterModes.set(db,r.data.short_writer_enabled===true);
 if(r.data.short_writer_enabled===true)accountHostScopes.set(db,createHostAccountScopes(db,{
  budget:()=>createBudget({ms:90000,calls:240}),onEvent:event=>console.log(JSON.stringify(event))}));
}
function shortAccountWriter(db){return shortWriterModes.get(db)===true;}
async function withAccountMutation(db,operation,options={}){
 if(!shortAccountWriter(db)||currentAccountOwner(db))return operation();
 const result=await accountHostScopes.get(db).critical(db,operation,options);
 if(result?.deferred===true)throw Object.assign(Error(result.reason),{writerDeferred:true,exchangeSubmissionAttempted:false,submissionPhase:'PRE_SEND'});
 return result;
}
async function runWithLease(db,operation=run){
  const owner=crypto.randomUUID(),invocationId=crypto.randomUUID(),startedAt=Date.now();
  let lock;
  try{
    lock=await db.rpc("v17_acquire_execution_lease",{p_owner:owner});
    if(lock.error)throw new Error("V17_LEASE_UNAVAILABLE");
  }catch{
    // Acquisition may have committed before its acknowledgement was lost.
    // Never execute on uncertain ownership. Release only this unstarted request's
    // owner; the RPC cannot release another worker's lease. The bounded 150 s TTL
    // remains the crash-recovery backstop if acknowledgement and cleanup both fail.
    let cleaned=false;
    for(let attempt=0;attempt<3;attempt++){
      const released=await db.rpc("v17_release_execution_lease",{p_owner:owner}).catch(()=>null);
      if(released&&!released.error){cleaned=true;break;}
      if(attempt<2)await new Promise(resolve=>setTimeout(resolve,100*(attempt+1)));
    }
    if(!cleaned)console.error("V17_UNCERTAIN_LEASE_CLEANUP_FAILED");
    throw new Error("V17_LEASE_UNAVAILABLE");
  }
  if(lock.data!==true){
    console.log(JSON.stringify({event:"SKIPPED_ALREADY_RUNNING",invocation_id:invocationId,
      started_at:new Date(startedAt).toISOString(),lease_owner:owner,skipped_already_running:true,
      total_runtime_ms:Date.now()-startedAt}));
    return {ok:true,skipped:"V17_EXECUTOR_BUSY"};
  }
  const acquiredAt=Date.now();
  console.log(JSON.stringify({event:"EXECUTOR_LEASE_ACQUIRED",invocation_id:invocationId,
    started_at:new Date(startedAt).toISOString(),lease_acquired_at:new Date(acquiredAt).toISOString(),
    lease_owner:owner,lease_expires_at:new Date(acquiredAt+EXECUTION_LEASE_TTL_SECONDS*1000).toISOString(),
    active_executor_concurrency:1}));
  leaseOwners.set(db,owner);cycleBudgets.set(db,createBudget({ms:90000,calls:240}));
  try{return await operation(db);}finally{
    leaseOwners.delete(db);cycleBudgets.delete(db);
    const released=await db.rpc("v17_release_execution_lease",{p_owner:owner});
    if(released.error)console.error("V17_LEASE_RELEASE_FAILED");
    console.log(JSON.stringify({event:"EXECUTOR_INVOCATION_FINISHED",invocation_id:invocationId,
      started_at:new Date(startedAt).toISOString(),lease_acquired_at:new Date(acquiredAt).toISOString(),
      lease_owner:owner,skipped_already_running:false,finished_at:new Date().toISOString(),
      total_runtime_ms:Date.now()-startedAt,active_executor_concurrency:0}));
  }
}
async function verifyExecutionLease(db,allowBudgetExceeded=false){
  if(!allowBudgetExceeded&&cycleBudgets.get(db)?.remaining()===0)throw Error("EXCHANGE_TRANSPORT_BUDGET_EXHAUSTED");
  if(shortAccountWriter(db))return accountHostScopes.get(db).verify();
  const owner=leaseOwners.get(db);if(!owner)throw new Error("V17_EXECUTION_LEASE_MISSING");
  const r=await db.rpc("v17_verify_execution_lease",{p_owner:owner});
  if(r.error||r.data!==true)throw new Error("V17_EXECUTION_LEASE_EXPIRED");
}
async function opsControls(db) {
  const [runtime,control,settings]=await Promise.all([
    db.from("v11_long_regime_runtime").select("*").eq("singleton",true).single(),
    db.from("v17_operator_control").select("*").eq("singleton",true).single(),
    db.from("trading_settings").select("*").eq("id",1).single()]);
  if(runtime.error||control.error||settings.error)throw Error("V18_CONTROLS_UNAVAILABLE");
  return {runtime:runtime.data,control:control.data,settings:settings.data};
}
async function requireLeaderEntryControls(db){
  const [c,s,rt]=await Promise.all([
    db.from("v17_operator_control").select("entry_enabled,legacy_entries_retired").eq("singleton",true).single(),
    db.from("trading_settings").select("mode,pause_new_entries,withdrawal_mode,manual_intervention_required,scalp_kill_switch,emergency_liquidation,pause_lock_reason,binance_futures_allocation_usdt").eq("id",1).single(),
    db.from("v11_long_regime_runtime").select("live_enabled,circuit_open,revision").eq("singleton",true).single()]);
  if(c.error||s.error||rt.error)throw new Error("V17_CONTROLS_UNAVAILABLE");
  if(c.data?.entry_enabled!==true||c.data?.legacy_entries_retired!==true)throw new Error("V17_OPERATOR_CUTOVER_NOT_ENABLED");
  if(rt.data?.live_enabled!==true||rt.data?.circuit_open===true||rt.data?.revision!==REVISION)throw new Error("V17_RUNTIME_BLOCKED");
  const x=s.data;
  if(!x||x.mode!=="LIVE_LIMITED"||x.pause_new_entries||x.withdrawal_mode||x.manual_intervention_required||x.scalp_kill_switch||x.emergency_liquidation||x.pause_lock_reason)throw new Error("V17_ENTRY_KILL_SWITCH");
  // MARGIN and binance_futures_allocation_usdt must move TOGETHER. Changing only
  // one halts every entry with V17_MARGIN_CONFIG_MISMATCH -- which is the safe
  // failure, but it is a full stop, not a resize. Operator-requested on
  // 2026-09-16: 40 -> 30 USDT per slot.
  if(!Number.isFinite(Number(x.binance_futures_allocation_usdt))||Math.abs(Number(x.binance_futures_allocation_usdt)-MARGIN)>1e-9)throw new Error("V17_MARGIN_CONFIG_MISMATCH");
}
async function readOpsPair(db,gw=opsGateway(db),candidateSymbol=null) {
  const candidate=candidateSymbol==null?null:String(candidateSymbol).toUpperCase();
  // The gateway serves a live, generation-bound user-stream observation. DB order
  // ownership remains independently fresh; final BUY rechecks both under its writer.
  const [pf,positions,manual,quarantines,candidateOrders]=await Promise.all([gw({action:"p10_portfolio"},3000),readOpsPositions(db),manualPositionAllowances(db),
    db.from("v18_ops_incidents").select("id,generation,kind,reason,symbol,status,control_scope,exposure_state,accounting_state,order_source,evidence_version,recheck_conditions,last_checked_at,evidence")
      .eq("exchange","binance_futures").eq("account_scope","futures").eq("control_scope","SYMBOL_QUARANTINE")
      .in("status",["OPEN","VERIFYING"]).order("last_checked_at",{ascending:true}).limit(101),
    candidate?db.from("v11_long_regime_orders").select("*").eq("symbol",candidate)
      .in("state",["PLANNED","DISPATCHED","PARTIALLY_FILLED","UNKNOWN","RECONCILIATION_FAILED","RECONCILIATION_PENDING"])
      .order("updated_at",{ascending:true}).limit(101):Promise.resolve({data:[]})]);
  if(quarantines.error)throw Error("SYMBOL_QUARANTINE_READ");
  if((quarantines.data??[]).length>100)throw Error("SYMBOL_QUARANTINE_BACKLOG_OVERFLOW");
  if(candidateOrders.error)throw Error("CANDIDATE_ORDERS_READ");
  if((candidateOrders.data??[]).length>100)throw Error("CANDIDATE_ORDER_BACKLOG_OVERFLOW");
  const baseOrders=await readOpsOrders(db,positions);
  const orders=candidate?[...new Map([...baseOrders,...(candidateOrders.data??[])].map(o=>[o.id,o])).values()]:baseOrders;
  return {pf,positions,manual,orders,quarantines:quarantines.data??[],match:classifyPortfolio(positions,pf,{manual,orders})};
}
async function recordMismatch(db,match) {
  const all=[...(match.issues??[]),...(match.accounting??[])];if(!all.length)return[];
  const rank=x=>x.controlScope===CONTROL_SCOPE.ACCOUNT_RISK_BLOCK?4:x.controlScope===CONTROL_SCOPE.ACCOUNT_ENTRY_HOLD?3:
    x.accountingState==="CONFLICT"?2:1,results=[];
  const account=all.filter(x=>[CONTROL_SCOPE.ACCOUNT_ENTRY_HOLD,CONTROL_SCOPE.ACCOUNT_RISK_BLOCK].includes(x.controlScope));
  if(account.length){
    const chosen=[...account].sort((a,b)=>rank(b)-rank(a)||String(a.kind).localeCompare(String(b.kind)))[0],
      kind=chosen.kind==="UNKNOWN_ORDER_OUTCOME"&&chosen.orderId?"KNOWN_ORDER_PENDING_RECONCILIATION":chosen.kind;
    results.push(await incident(db,{reason:account.map(x=>`${x.kind}:${x.symbol||"ACCOUNT"}`).sort().join(";"),kind,
      controlScope:chosen.controlScope,state:{exposureState:chosen.exposureState,accountingState:chosen.accountingState,
        orderSource:chosen.orderSource,recheck:chosen.recheck},evidence:{issues:account,observation:match.snapshot}}));
  }
  const bySymbol=new Map();
  for(const issue of all.filter(x=>x.controlScope===CONTROL_SCOPE.SYMBOL_QUARANTINE&&x.symbol)){
    const old=bySymbol.get(issue.symbol);if(!old||rank(issue)>rank(old))bySymbol.set(issue.symbol,issue);
  }
  for(const [symbol,issue] of [...bySymbol].sort(([a],[b])=>a.localeCompare(b))){
    const related=all.filter(x=>x.symbol===symbol&&x.controlScope===CONTROL_SCOPE.SYMBOL_QUARANTINE);
    results.push(await incident(db,{reason:related.map(x=>`${x.kind}:${symbol}`).sort().join(";"),kind:issue.kind,
      controlScope:CONTROL_SCOPE.SYMBOL_QUARANTINE,symbol,state:{exposureState:issue.exposureState,
        accountingState:issue.accountingState,orderSource:issue.orderSource,recheck:issue.recheck},
      evidence:{...issue,related,observation:match.snapshot}}));
  }
  return results;
}
async function reconcileOps(db,pair,budget=createBudget({ms:8000,calls:18})) {
  if(shortAccountWriter(db)&&!currentAccountOwner(db)){
    const closed=await readClosedProtectionBacklog(db);
    if(!pair.orders.some(o=>["PLANNED","DISPATCHED","PARTIALLY_FILLED","UNKNOWN","RECONCILIATION_PENDING","RECONCILIATION_FAILED"].includes(o.state))&&
      !pair.match.issues.some(i=>i.positionId&&pair.positions.some(p=>p.id===i.positionId))&&!closed.rows.length)return[];
    // Work is discovered under analysis, then reread and CAS-fenced under the
    // writer. An incomplete backlog still blocks entries through its own gate.
    return withAccountMutation(db,async()=>reconcileOps(db,{...await readOpsPair(db),recoveryOnly:true},budget));
  }
  const gw=scopedGateway(db,budget),results=[];
  // Exposure-uncertain order identity gets the first reconciliation budget.
  // Closed native-stop cleanup remains bounded and runs immediately afterward.
  for(const o of pair.orders.filter(o=>["PLANNED","DISPATCHED","PARTIALLY_FILLED","UNKNOWN","RECONCILIATION_PENDING","RECONCILIATION_FAILED"].includes(o.state)).slice(0,3)){
    if(budget.remaining()<500)break;
    try{
      await verifyExecutionLease(db);
      const touched=await db.from("v11_long_regime_orders").update({response_payload:{...rec(o.response_payload),v18LastReconcileAt:new Date().toISOString()},updated_at:new Date(Math.max(Date.now(),Date.parse(o.updated_at)+1)).toISOString()}).eq("id",o.id).eq("updated_at",o.updated_at).select("*").maybeSingle();
      if(touched.error||!touched.data)throw Error("ORDER_RECONCILE_CAS_CONFLICT");
      const raw=await gw({action:"get_order",market:o.symbol,identifier:o.client_order_id,exchange_order_id:o.exchange_order_id});
      if(o.intent==="OPEN_LONG") {
        const pos=await settleKnownEntry(db,o,raw,gw);
        if(pos?.state==="OPEN")await protectNewLeaderPosition({enabled:NATIVE_STOP_ENABLED,position:pos,manualSymbols:pair.manual.map(x=>x.symbol),readPortfolio:()=>gw({action:"p10_portfolio"}),installNative:(p,c)=>installEntryNativeProtection(db,p,gw,c.manualSymbols),manage:ctx=>manageLeader(db,ctx.positionSnapshot??pos,{...ctx,gateway:gw,recoveryOnly:pair.recoveryOnly===true})});
        const complete=!pos||pos.metadata?.v18EntryAccountingPending!==true;
        results.push({orderId:o.id,outcome:complete?"RESOLVED":"UNRESOLVED",inspectionPerformed:true,evidenceSecured:true,
          quantityResolved:true,attributionComplete:true,accountingComplete:complete,settled:complete,
          reason:complete?null:"ACCOUNTING_DETAILS_PENDING"});continue;
      }
      const row=await db.from("v11_long_regime_positions").select("*").eq("id",o.position_id).single();
      if(row.error||!row.data)throw Error("RECONCILE_POSITION_READ");
      const settled=await applyExitReceipt(db,row.data,o,raw,await gw({action:"p10_portfolio"}),{verifyLease:()=>verifyExecutionLease(db)}),
        complete=settled.accountingPending!==true;
      results.push({orderId:o.id,outcome:complete?"RESOLVED":"UNRESOLVED",inspectionPerformed:true,evidenceSecured:true,
        quantityResolved:true,attributionComplete:true,accountingComplete:complete,settled:complete,
        reason:complete?null:"ACCOUNTING_DETAILS_PENDING"});
    }catch(e){
      if(classifyFailure(e).fatal)throw e;
      // An order this gateway refused in its OWN validation was never signed, never
      // sent, and cannot have an identity on the exchange -- but the executor only
      // saw a failed create_order, which it must treat as ambiguous. The query above
      // then asks Binance about it, gets -2013, and throws. Every cycle. The intent
      // stays in riskOrders, recoveryEvidence stays ineligible, and the account is
      // held forever over exposure that does not exist: 2026-09-18, DYDXUSDT refused
      // at 10:21:09 for a 40 USDT floor the slot had not used since 2026-09-16, still
      // holding the account 45 minutes later with a flat book and a flat exchange.
      //
      // So the not-found is ESTABLISHED rather than assumed, and only then settles.
      // Anything short of the full proof leaves the order exactly where it is.
      const settled=await settleNeverPlacedEntry(db,o,e,gw);
      results.push(settled??{orderId:o.id,error:String(e.message??e)});
    }
  }
  // Management has already had its turn. Work only three oldest affected items per cycle.
  const ids=new Set(pair.match.issues.map(i=>i.positionId).filter(Boolean));
  const closedPending=await readClosedProtectionBacklog(db);
  const byAge=(a,b)=>Date.parse(a.metadata?.v18ReconcileAt??a.updated_at)-Date.parse(b.metadata?.v18ReconcileAt??b.updated_at),
    affected=pair.positions.filter(p=>ids.has(p.id)).sort(byAge),closed=closedPending.rows.sort(byAge);
  // An observed live mismatch gets the first turn; closed-stop cleanup uses the
  // remaining bounded slots and cannot starve the incident that raised the circuit.
  const candidates=[...affected.slice(0,2),...closed.slice(0,Math.max(0,3-Math.min(2,affected.length)))];
  for(const candidate of candidates){
    if(budget.remaining()<500)break;
    try{
      let p=candidate;
      // Persist progress/fairness with CAS before any exchange read; failure never changes exposure.
      await verifyExecutionLease(db);
      const touched=await db.from("v11_long_regime_positions").update({metadata:{...p.metadata,v18ReconcileAt:new Date().toISOString()},updated_at:new Date(Math.max(Date.now(),Date.parse(p.updated_at)+1)).toISOString()}).eq("id",p.id).eq("updated_at",p.updated_at).select("*").maybeSingle();
      if(touched.error||!touched.data)throw Error("RECONCILE_CAS_CONFLICT");
      p=touched.data;
      if((p.metadata?.exitProtection?.orders??[]).length){
        const manager=createGatewayProtection(db,gw,()=>verifyExecutionLease(db));
        const refreshed=p.state==="CLOSED"?await manager.ensure(p.id,{stopPrice:1,priceTick:1,quantityStep:1,
          exchangeQuantity:0,positionMode:"ONE_WAY",manualSymbols:[]}):await manager.refresh(p.id);
        const state=refreshed.state??refreshed;
        if(state.position.remainingQuantity<N(p.remaining_quantity))results.push({positionId:p.id,outcome:"RESOLVED",
          inspectionPerformed:true,evidenceSecured:true,quantityResolved:true,attributionComplete:true,
          accountingComplete:state.position.accountingPending!==true,executedQuantity:N(p.remaining_quantity)-state.position.remainingQuantity});
        if(state.protection.orders.some(o=>!o.terminal&&(o.lastQueryError||o.accountingPending)))throw Error("NATIVE_RECONCILIATION_PENDING");
        if(p.state!=="CLOSED"&&state.position.state==="CLOSED")continue;
        if(p.state==="CLOSED"){
          const done=state.protection.orders.every(o=>o.terminal===true),accountingComplete=state.position.accountingPending!==true;
          results.push({positionId:p.id,operation:"CLOSED_PROTECTION_CLEANUP",outcome:done&&accountingComplete?"RESOLVED":"UNRESOLVED",
            inspectionPerformed:true,evidenceSecured:done,quantityResolved:true,attributionComplete:true,
            accountingComplete,protectionHealth:state.protection.health});
          continue;
        }
        const latest=await db.from("v11_long_regime_positions").select("*").eq("id",p.id).single();
        if(latest.error||!latest.data)throw Error("RECONCILE_POSITION_REFRESH");p=latest.data;
      }
      const issue=pair.match.issues.find(i=>i.positionId===p.id);
      if(issue?.kind==="DB_ONLY_POSITION"||issue?.kind==="KNOWN_EXIT_PENDING_RECONCILIATION"||issue?.kind==="QUANTITY_MISMATCH")
        results.push({positionId:p.id,...await reconcileDbOnlyPosition(db,p,gw,pair.quarantines.find(i=>i.symbol===p.symbol&&
          i.evidence?.positionId===p.id&&["DB_ONLY_POSITION","KNOWN_EXIT_PENDING_RECONCILIATION","QUANTITY_MISMATCH"].includes(i.kind)))});
      else results.push({positionId:p.id,outcome:"UNRESOLVED",inspectionPerformed:true,evidenceSecured:false,
        quantityResolved:false,attributionComplete:false,accountingComplete:false,reason:"NO_SETTLEMENT_EVIDENCE_PATH"});
    }catch(e){if(classifyFailure(e).fatal)throw e;results.push({positionId:candidate.id,error:String(e.message??e)});}
  }
  return results;
}
async function attemptSymbolRecoveries(db,pair) {
  if(!pair.quarantines.length)return[];
  if(shortAccountWriter(db)&&!currentAccountOwner(db))return withAccountMutation(db,async()=>attemptSymbolRecoveries(db,await readOpsPair(db,recoveryGateway(db))));
  const live=await recoveryGateway(db)({action:"v18_open_orders"},5000),results=[];
  for(const active of pair.quarantines.slice(0,5)){
    const evidence=symbolRecoveryEvidence({incident:active,classification:pair.match,portfolio:pair.pf,
      openOrders:live,positions:pair.positions,orders:pair.orders});
    if(!evidence.clean){results.push({incidentId:active.id,symbol:active.symbol,resolved:false,reason:"EVIDENCE_INCOMPLETE"});continue;}
    await verifyExecutionLease(db);
    const r=await db.rpc("v19_symbol_recovery_observation",{p_owner:leaseOwners.get(db),p_incident_id:active.id,
      p_generation:Number(active.generation),p_evidence_version:ENTRY_CONTROL_VERSION,p_evidence:evidence});
    if(r.error)throw Error(`SYMBOL_RECOVERY_CAS:${r.error.message}`);results.push(r.data);
  }
  return results;
}
async function attemptOpsRecovery(db,pair,protectedIds) {
  const c=await opsControls(db);
  // A healthy account has no recovery mutation. Eligible recovery rereads all
  // controls and execution truth after acquiring its writer, exactly as before.
  if(!c.runtime.circuit_open)return {resolved:false,reason:"EVIDENCE_INCOMPLETE"};
  if(shortAccountWriter(db)&&!currentAccountOwner(db))return withAccountMutation(db,async()=>attemptOpsRecovery(db,await readOpsPair(db,recoveryGateway(db)),protectedIds));
  let incidentResolution=null;
  if(c.runtime.incident_id){
    const ir=await db.from("v18_ops_incidents").select("id,generation,resolution_evidence").eq("id",c.runtime.incident_id).maybeSingle();
    if(ir.error)throw Error("INCIDENT_EVIDENCE_READ");incidentResolution=ir.data?.resolution_evidence??null;
  }
  const evidence=recoveryEvidence({...c,classification:pair.match,orders:pair.orders,protectedIds,incidentResolution});
  if(!evidence.eligible)return {resolved:false,reason:"EVIDENCE_INCOMPLETE"};
  // The gateway independently fetches all ordinary AND algo orders; ACTIVE owned stops
  // are allowed. Unknown entry/close/algo orders are not a clean recovery observation.
  const live=await recoveryGateway(db)({action:"v18_open_orders"},5000);
  if(!confirmedLiveProtection(live,pair.positions,Date.now(),{manual:pair.manual,exchangePositions:pair.pf.positions}))return {resolved:false,reason:"LIVE_ORDER_RISK"};
  // Changes during the read invalidate the proof. SQL validates this exact DB manifest
  // and locks the same incident generation + operator rows before the CAS.
  const after=await readOpsPair(db,recoveryGateway(db)),again=await opsControls(db);
  if(!after.match.ok||JSON.stringify(after.positions.map(p=>[p.id,p.updated_at]))!==JSON.stringify(pair.positions.map(p=>[p.id,p.updated_at]))||
    again.runtime.incident_id!==evidence.incidentId||again.runtime.incident_generation!==evidence.generation)return {resolved:false,reason:"RECOVERY_CHANGED"};
  await verifyExecutionLease(db);
  const r=await db.rpc("v19_account_recovery_observation",{p_owner:leaseOwners.get(db),p_incident_id:evidence.incidentId,p_generation:evidence.generation,
    p_evidence_version:ENTRY_CONTROL_VERSION,p_evidence:{...evidence,observation:after.pf.observation,
      positions:after.positions.map(p=>({id:p.id,updated_at:p.updated_at,quantity:p.remaining_quantity})),ordersObservedAt:live.observed_at_ms}});
  // A lock timeout rolls the whole recovery transaction back: nothing changed and no
  // observation was recorded. Report it in this cycle's recovery result and retry on a
  // later cycle (SQL still enforces freshness/independence). Other errors stay fatal.
  if(r.error&&/lock timeout|55P03/i.test(`${r.error.code??""} ${r.error.message??""}`))
    return {resolved:false,reason:"RECOVERY_LOCK_BUSY",retryable:true};
  if(r.error)throw Error(`RECOVERY_CAS:${r.error.message}`);return r.data;
}
async function closePos(db,p,fraction,reason,ctx={}) {
  if(shortAccountWriter(db)&&!currentAccountOwner(db))return withAccountMutation(db,()=>closePos(db,p,fraction,reason,ctx));
  const gw=ctx.gateway??opsGateway(db);
  await verifyExecutionLease(db);
  const current=await db.from("v11_long_regime_positions").select("*").eq("id",p.id).single();
  if(current.error||!current.data)throw Error("EXIT_POSITION_READ");
  // A LEGACY/stale invocation cannot resurrect a closed position or create another exit.
  if(current.data.state!=="OPEN")return {closed:current.data.state==="CLOSED",position:current.data};
  p={...current.data,peak_price:Math.max(N(current.data.peak_price),N(p.peak_price))};
  assertExitAuthority(reason,p,ctx.finalApproval,Date.now());
  const orders=await readOpsOrders(db,[p]);
  if(!ownedEntry(p,orders))throw Error("EXIT_OWNERSHIP_UNPROVEN");
  const pending=riskOrders(orders).find(o=>o.position_id===p.id&&o.intent!=="OPEN_LONG");
  if(pending){
    const raw=await gw({action:"get_order",market:p.symbol,identifier:pending.client_order_id,exchange_order_id:pending.exchange_order_id});
    return applyExitReceipt(db,p,pending,raw,await gw({action:"p10_portfolio"}),{verifyLease:()=>verifyExecutionLease(db)});
  }
  // Read the allowlist BEFORE the account observation: classifyPortfolio only accepts an
  // observation younger than 3s, and a DB round trip taken after the fetch spends that
  // budget on us rather than the exchange. On this path a false stale reading blocks an
  // exit, so the ordering matters more here than on entry.
  const manual=await manualPositionAllowances(db);
  let pf=await gw({action:"p10_portfolio"});
  const match=classifyPortfolio([p],{...pf,positions:pf?.positions?.filter(x=>sym(x)===p.symbol)},{manual,orders});
  if(!match.ok){
    if(match.issues.some(x=>x.kind==="KNOWN_EXIT_PENDING_RECONCILIATION")){
      const nativeClosed=await reconcileNativeCloseBeforeDispatch(db,p,1,gw);
      if(nativeClosed)return nativeClosed;
    }
    throw Error("EXIT_EXPOSURE_RECONCILIATION_PENDING");
  }
  const i=await gw({action:"symbol_info",market:p.symbol}),step=N(i?.quantity_step??i?.step_size);
  const amount=floorStep(N(p.remaining_quantity)*Math.max(0,Math.min(1,fraction)),step);
  if(!(amount>0))throw Error("EXIT_QTY_ZERO");
  const id=await exitAttemptId(p.id,crypto.randomUUID(),reason==="BULL_T1"?"v11p":"v11x");
  const rp={action:"create_order",order:{market:p.symbol,side:"SELL",type:"MARKET",quantity:amount,
    identifier:id,position_side:"LONG",position_effect:"CLOSE"},wait_for_final_ms:4000};
  const exitTiming={market_event:ctx.finalApproval?.input?.capture?.trajectory?.at(-1)?.exchange_event_ms??null,
    market_deterioration:ctx.marketDeteriorationAt??null,state_change:ctx.stateChangedAt??null,
    decision:ctx.finalApproval?.at??Date.now(),order_intent:Date.now()};
  await verifyExecutionLease(db);
  const oi=await db.from("v11_long_regime_orders").insert({revision:REVISION,signal_id:p.signal_id,position_id:p.id,
    symbol:p.symbol,intent:fraction<1?"PARTIAL_CLOSE":"CLOSE_LONG",reason,client_order_id:id,requested_quantity:amount,
    state:"PLANNED",request_payload:{...rp,quantity_step:step,fraction,executor_patch:PATCH,exit_latency:exitTiming}}).select("*").single();
  if(oi.error)throw Error(`EXIT_INTENT:${oi.error.message}`);
  try{
    await verifyExecutionLease(db);
    try{assertExitAuthority(reason,p,ctx.finalApproval,Date.now());}
    catch(error){
      // This branch is provably pre-send. Do not invent an ambiguous exchange order
      // or trip the account circuit because a strategic answer aged during DB IO.
      const stopped=await db.from("v11_long_regime_orders").update({state:"REJECTED",
        reject_reason:"DETERMINISTIC_EXIT_EVIDENCE_EXPIRED",updated_at:new Date().toISOString()}).eq("id",oi.data.id);
      if(stopped.error)throw Error("EXIT_PRE_SEND_REJECTION_WRITE");
      return {closed:false,position:p,strategyDeferred:true,reason:"DETERMINISTIC_EXIT_EVIDENCE_EXPIRED"};
    }
    const freshExit=await ctx.revalidateExit?.(p);
    if(freshExit?.allowed!==true){const cancel=await db.from('v11_long_regime_orders').update({state:'REJECTED',reject_reason:'LATEST_EXIT_THESIS_CHANGED',updated_at:new Date().toISOString()}).eq('id',oi.data.id);if(cancel.error)throw Error('EXIT_REJECTION_WRITE');return {closed:false,position:p,strategyDeferred:true,reason:'LATEST_EXIT_THESIS_CHANGED'};}
    ctx.finalApproval=freshExit.proof;assertExitAuthority(reason,p,ctx.finalApproval,Date.now());
    exitTiming.pre_order_validation=Date.now();exitTiming.order_dispatch_started=Date.now();
    const raw=await gw(rp),z=fill(raw);exitTiming.exchange_ack=Date.now();
    exitTiming.order_sent=raw?.timing?.order_sent_at_ms??exitTiming.order_dispatch_started;
    exitTiming.fill=raw?.order?.raw?.updateTime??null;
    raw.exitLatency={...exitTiming};
    await verifyExecutionLease(db);
    const wr=await db.from("v11_long_regime_orders").update({state:"RECONCILIATION_PENDING",exchange_order_id:z.exchangeOrderId,
      response_payload:raw,updated_at:new Date().toISOString()}).eq("id",oi.data.id);
    if(wr.error)throw Error("EXIT_ACK_WRITE");
    pf=await gw({action:"p10_portfolio"});
    return await applyExitReceipt(db,p,oi.data,raw,pf,{verifyLease:()=>verifyExecutionLease(db)});
  }catch(e){
    // Even HTTP 408 is ambiguous. Persist the same intent and only query its identity later.
    if(classifyFailure(e).fatal)throw e;
    await verifyExecutionLease(db);
    const wr=await db.from("v11_long_regime_orders").update({state:"RECONCILIATION_FAILED",
      reject_reason:String(e.message??e).slice(0,500),updated_at:new Date().toISOString()}).eq("id",oi.data.id);
    if(wr.error)throw Error("EXIT_UNKNOWN_WRITE");
    await circuit(db,`EXIT_PENDING:${p.symbol}`,"KNOWN_ORDER_PENDING_RECONCILIATION",{positionId:p.id,orderId:oi.data.id,clientOrderId:id,error:String(e.message??e)});
    throw e;
  }
}
function sizeEntry(ask,step,filters={}){
  const plan=planSlotEntry({ask,quantityStep:step,priceTick:N(filters.priceTick,0),
    minNotionalUsdt:N(filters.minNotionalUsdt,0),minQuantity:N(filters.minQuantity,0)});
  return{...plan,amount:plan.quantity,sizedNotional:plan.referenceNotionalUsdt,
    sizedMargin:plan.orderMarginUsdt};
}
function admissionCapacity(view,ledger){
  return entryCapacity({maxSlots:MAX_SLOTS,slotCost:ENTRY_SLOT_COST_USDT,cashBufferUsdt:ENTRY_CASH_BUFFER_USDT,...view,ledger});
}
async function refreshCapacityInputs(db){
  // This is the mandatory post-fill proof before another slot may be admitted.
  // It deliberately has a separate READ-ONLY budget: exhausting the general cycle
  // budget after a valid fill must not make this safety proof impossible.
  // The typeof fallback keeps the isolated queue harness on its injected readOpsPair
  // seam; production always defines capacityRefreshGateway above.
  const safetyGateway=typeof capacityRefreshGateway==="function"?capacityRefreshGateway(db):undefined;
  const [fresh,sn]=await Promise.all([readOpsPair(db,safetyGateway),snap(db)]);
  if(!freshPortfolio(fresh.pf))throw Error("CAPACITY_PORTFOLIO_STALE");
  return capacityInputs(fresh,sn);
}
async function readClosedProtectionBacklog(db,limit=100) {
  const r=await db.rpc("v18_closed_protection_backlog",{p_limit:limit});
  if(r.error)throw Error("CLOSED_PROTECTION_READ");
  if(!Array.isArray(r.data?.rows)||typeof r.data?.complete!=="boolean")throw Error("CLOSED_PROTECTION_RESPONSE");
  return {rows:r.data.rows,complete:r.data.complete};
}
async function leaderQuote(p,ctx){
  if(ctx?.observedQuote){
    const q=ctx.observedQuote,bid=Number(q.bid),ask=Number(q.ask),detectedAtMs=Number(q.detectedAtMs),
      bidSize=Number(q.bidSize),protectedQuantity=Number(p.remaining_quantity),
      timing={requested_at_ms:Number(q.requestedAtMs),received_at_ms:Number(q.receivedAtMs),
        book_captured_at_ms:q.bookCapturedAtMs??null,source:q.source??"P10_TOP_OF_BOOK_BATCH"};
    if(!(bid>0&&ask>=bid)||!Number.isSafeInteger(detectedAtMs)||!Number.isSafeInteger(timing.received_at_ms)||
        detectedAtMs-timing.received_at_ms<0||detectedAtMs-timing.received_at_ms>1000||q.fullQuantityExecutable!==true||
        !(bidSize>0&&protectedQuantity>0&&bidSize+Math.max(1e-12,protectedQuantity*1e-10)>=protectedQuantity))
      throw Error("X1_EXIT_QUOTE_INVALID_STALE_OR_SHALLOW");
    return{bid,ask,detectedAtMs,timing,observedBidPeak:Number(q.observedBidPeak),
      observedBidPeakAt:Number(q.observedBidPeakAt),executableVwapPeak:Number(q.executableVwapPeak),
      observationId:q.observationId??null,bidSize};
  }
  const read=async(timeoutMs)=>{
    const quotes=await (ctx?.gateway??gateway)({action:"p10_quotes",markets:[p.symbol]},timeoutMs);
    const q=Array.isArray(quotes)?quotes.find(x=>x.market===p.symbol):null;
    const bid=Number(q?.best_bid),ask=Number(q?.best_ask);
    const detectedAtMs=Date.now(),timing=q?.timing||{};
    if(q?.error||!(bid>0&&ask>=bid)||!Number.isFinite(timing.received_at_ms)||
        detectedAtMs-timing.received_at_ms>3000||timing.received_at_ms-detectedAtMs>1000)
      throw new Error("V17_EXIT_QUOTE_INVALID_OR_STALE");
    return {bid,ask,detectedAtMs,timing};
  };
  try{return await read(3000)}
  catch(first){
    if(classifyFailure(first).fatal)throw first;
    const budget=ctx?.quoteRetryBudget;
    if(!budget||!(budget.remaining>0))throw first;
    budget.remaining-=1;
    console.error("V17_EXIT_QUOTE_RETRY",p.symbol,String(first instanceof Error?first.message:first));
    return await read(2500);
  }
}
function cid(p,x){return`tb-${p}-${String(x).toLowerCase().replace(/[^a-z0-9]/g,"").slice(0,24)}`.slice(0,36)}
function terminal(z){return z.qty<=0&&["CANCELED","CANCELLED","REJECTED","EXPIRED","PARTIALLY_FILLED_CANCELED"].includes(z.status)}
function fill(p){const o=p?.order??p??{},f=p?.fill??{},q=Math.max(0,N(f.executedVolume??f.executed_quantity??o.executed_volume??o.executedQty)),a=Math.max(0,N(f.averagePrice??f.average_price??o.average_price??o.avgPrice));return{status:String(o?.status??p?.status??"UNKNOWN").toUpperCase(),exchangeOrderId:o?.exchange_order_id==null?o?.orderId==null?null:String(o.orderId):String(o.exchange_order_id),qty:q,avg:a,fee:Math.max(0,N(f.paidFeeQuote??f.paidFee??o.paid_fee??o.commission)),raw:p}}
function N(v,d=0){const x=Number(v);return Number.isFinite(x)?x:d}
function rec(v){return v&&typeof v==="object"&&!Array.isArray(v)?v:{}}
function res(s,b){return new Response(JSON.stringify(b),{status:s,headers:{"content-type":"application/json","cache-control":"no-store"}})}
async function auth(db,req){return authenticateInternalToken({db,request:req,name:'v10-lane-executor',header:'x-v10-executor-token'});}
function scopedGateway(db,budget,{allowCycleBudgetExceeded=false}={}) {
  return async(cmd,timeout=20000,{beforeTransport=null}={})=>{
    const cycle=cycleBudgets.get(db),cost=cmd.action==="v17_stop_fill"?3:["v18_open_orders","trade_history","order_history"].includes(cmd.action)?2:1;
    // A post-fill capacity refresh is a read-only safety barrier, not another trading
    // attempt. Give that one barrier its own tiny budget so the previous fill cannot
    // consume the very read required to prove whether another slot is safe.
    const write=["create_order","cancel_order","v17_create_stop","v17_cancel_stop","prepare_entry"].includes(cmd.action);
    let left;
    try{
      const cycleLeft=!allowCycleBudgetExceeded&&cycle&&cycle!==budget?cycle.take(cost):Infinity;
      left=Math.min(budget.take(cost),cycleLeft);
      if(shortAccountWriter(db)&&write&&!currentAccountOwner(db))throw Error('ACCOUNT_WRITER_CONTEXT_REQUIRED');
      if(!beforeTransport)await verifyExecutionLease(db,allowCycleBudgetExceeded);
      if(allowCycleBudgetExceeded&&write)throw Error("CAPACITY_REFRESH_WRITE_FORBIDDEN");
    }catch(error){
      // Never stamp the verification AFTER transport as a pre-send refusal.
      if(write)throw Object.assign(new Error(String(error?.message??error)),
        {exchangeSubmissionAttempted:false,submissionPhase:"PRE_SEND"});
      throw error;
    }
    let outgoing=cmd;
    if(write){
      let c=currentExecutionContext(db);
      if(!shortAccountWriter(db)){
        const l=await db.from('v17_execution_lease').select('owner,fence').eq('singleton',true).single();
        if(l.error||l.data?.owner!==leaseOwners.get(db)||!Number.isSafeInteger(Number(l.data?.fence))||Number(l.data.fence)<1)throw Object.assign(Error('WRITER_ENVELOPE_FENCE_UNAVAILABLE'),{exchangeSubmissionAttempted:false,submissionPhase:'PRE_SEND'});
        c={owner:l.data.owner,fence:Number(l.data.fence)};
      }
      outgoing={...cmd,writer:{account_key:'binance_futures:futures',owner:c.owner,fence:c.fence,execution_key:await hashJson(cmd)}};
      if(beforeTransport){const proof=await beforeTransport();if(proof?.owner!==c.owner||Number(proof?.fence)!==c.fence||!proof?.execution_key)throw Object.assign(Error('SUBMISSION_WRITER_BINDING_INVALID'),{exchangeSubmissionAttempted:false,submissionPhase:'PRE_SEND'});outgoing.writer.execution_key=proof.execution_key;}
    }
    let coalescer=analysisGatewayReads.get(db);
    if(!coalescer){coalescer=createAnalysisReadCoalescer();analysisGatewayReads.set(db,coalescer);}
    let result;const transportStarted=Date.now(),transportTimeout=Math.max(1,Math.min(timeout,left,write&&cmd.action!=="cancel_order"?12000:2500));
    try{result=await coalescer(outgoing,()=>exchangeGateway(outgoing,transportTimeout),
      {kind:shortAccountWriter(db)?currentExecutionContext(db)?.kind:null});}
    catch(error){throw Object.assign(error,{gatewayAction:cmd.action,transportStartedAt:transportStarted,transportFailedAt:Date.now(),transportTimeoutMs:transportTimeout});}
    await verifyExecutionLease(db,allowCycleBudgetExceeded);return result;
  };
}
function opsGateway(db){return scopedGateway(db,cycleBudgets.get(db)??createBudget({ms:55000,calls:160}));}
function recoveryGateway(db){const read=opsGateway(db);return(cmd,tm,options)=>read(['p10_portfolio','v18_open_orders'].includes(cmd.action)?{...cmd,force_rest:true}:cmd,tm,options);}
function controlReleaseScope(decision){
  return decision?.scope===CONTROL_SCOPE.SYMBOL_QUARANTINE?RELEASE_SCOPE.SYMBOL:RELEASE_SCOPE.ACCOUNT;
}
async function persistDecisionRisk(db,pair,decision) {
  for(const q of decision.discoveredQuarantines??[]){
    if(pair.quarantines.some(x=>x.symbol===q.symbol&&["OPEN","VERIFYING"].includes(x.status)))continue;
    await incident(db,{reason:`${q.kind}:${q.symbol}:${q.orderId||"UNKNOWN"}`,kind:q.kind,
      controlScope:CONTROL_SCOPE.SYMBOL_QUARANTINE,symbol:q.symbol,
      state:{exposureState:q.exposureState,accountingState:q.accountingState,orderSource:q.orderSource,recheck:q.recheck},
      evidence:{...q,decisionEvidence:decision.evidence}});
  }
  if(decision.allowed||decision.scope===CONTROL_SCOPE.OPERATOR_HALT)return;
  const reasons=decision.reasons??[],alreadyClassified=(pair.match.issues??[]).some(x=>
    [CONTROL_SCOPE.ACCOUNT_ENTRY_HOLD,CONTROL_SCOPE.ACCOUNT_RISK_BLOCK].includes(x.controlScope))||
    decision.scope===CONTROL_SCOPE.SYMBOL_QUARANTINE&&((pair.match.issues??[]).some(x=>x.symbol===decision.symbol)||
      (pair.match.accounting??[]).some(x=>x.symbol===decision.symbol)||pair.quarantines.some(x=>x.symbol===decision.symbol));
  if(alreadyClassified||reasons.every(x=>/ACCOUNT_(MARGIN|SLOT)_LIMIT|LIVE_EXPOSURE_EXISTS/.test(x)))return;
  const symbol=decision.scope===CONTROL_SCOPE.SYMBOL_QUARANTINE?decision.symbol:null,
    exposure=symbol&&pair.pf.positions.some(x=>sym(x)===symbol&&qty(x)>0)?"HELD":
      reasons.some(x=>/INCOMPLETE|UNPROVEN|UNBOUNDED/.test(x))?"UNKNOWN":"FLAT",
    kind=reasons.some(x=>/EVIDENCE_INCOMPLETE_OR_STALE|OPEN_ORDER_EVIDENCE/.test(x))?"INCOMPLETE_OR_STALE_SNAPSHOT":
      reasons.some(x=>/ORDINARY_ORDER/.test(x))?"UNKNOWN_ORDER_OUTCOME":
      reasons.some(x=>/CONDITIONAL_ORDER/.test(x))?"IDENTITY_OR_SIDE_MISMATCH":"ACCOUNT_RISK_UNBOUNDED";
  await incident(db,{reason:reasons.join(";")||"ENTRY_RISK_UNVERIFIED",kind,controlScope:decision.scope,symbol,
    state:{exposureState:exposure,accountingState:"ATTRIBUTION_INVESTIGATING",orderSource:"UNKNOWN",recheck:decision.recheck},
    evidence:{decision,accountObservation:pair.pf.observation}});
}
function symbolFilters(info){return{quantityStep:N(info?.quantity_step??info?.step_size),
  priceTick:N(info?.price_tick??info?.tick_size),
  minNotionalUsdt:Math.max(1,N(info?.min_notional,5)),
  minQuantity:N(info?.min_quantity)}}
function iocAttemptEvidence({attemptNo,quote,quantity,limitPrice,at,prior=null,plan=null,filledBefore=null,firstStatus=null}){
  const num=v=>Number.isFinite(Number(v))&&v!==null&&v!==""?Number(v):null;
  const bid=num(quote?.best_bid),ask=num(quote?.best_ask),recv=num(quote?.timing?.received_at_ms),lim=num(limitPrice);
  const asks=(Array.isArray(quote?.asks)?quote.asks:[]).map(l=>Array.isArray(l)?[num(l[0]),num(l[1])]:[num(l?.price),num(l?.size)])
    .filter(([p,z])=>p>0&&z>0);
  return {version:"IOC_ATTEMPT_EVIDENCE_1",attemptNo,at,bestBid:bid,bestAsk:ask,
    spreadBps:bid>0&&ask>=bid?(ask-bid)/((ask+bid)/2)*10000:null,quoteReceivedAt:recv,quoteAgeMs:recv===null?null:at-recv,
    askLevels:asks.length,askDepthQty:asks.reduce((a,[,z])=>a+z,0),
    executableQtyAtLimit:lim===null?null:asks.filter(([p])=>p<=lim*(1+1e-12)).reduce((a,[,z])=>a+z,0),
    requestedQty:num(quantity),limitPrice:lim,offsetBps:lim!==null&&ask>0?(lim/ask-1)*10000:null,
    lastPrice:num(quote?.last_price??quote?.last??quote?.raw?.lastPrice),
    ...(prior?{sinceFirstAttemptMs:at-prior.at,askChangeBpsSinceFirst:ask>0&&prior.bestAsk>0?(ask/prior.bestAsk-1)*10000:null,
      firstLimitPrice:prior.limitPrice,firstStatus,filledBeforeQty:filledBefore}:{}),
    ...(plan?{retryPlan:{version:IOC_RETRY_POLICY.version,upliftBps:plan.upliftBps??null,depthLimitPrice:plan.depthLimitPrice??null,
      expectedVwap:plan.expectedVwap??null,slippageBps:plan.slippageBps??null,chaseBps:plan.chaseBps??null,
      budgetShrunk:plan.budgetShrunk===true,requestedRemainingQuantity:plan.requestedRemainingQuantity??null,
      totalWorstMargin:plan.totalWorstMargin??null}}:{})};
}
async function decideEntry(db,pair,candidateSymbol,openOrders,opts={}) {
  const controls=await opsControls(db);
  if(shortAccountWriter(db)&&!freshPortfolio(pair.pf)){
    Object.assign(pair,await readOpsPair(db,opsGateway(db),candidateSymbol));
    openOrders=await opsGateway(db)({action:'v18_open_orders'},5000);
  }
  return decideEntryWith(controls,pair,candidateSymbol,openOrders,opts);
}
function decideEntryWith(controls,pair,candidateSymbol,openOrders,{proposedMargin=0,cashBuffer=0,managementFailures=[],existingPositionId=null}={}) {
  return evaluateEntryDecision({candidateSymbol,classification:pair.match,portfolio:pair.pf,openOrders,
    positions:pair.positions,orders:pair.orders,quarantines:pair.quarantines,
    manualSymbols:pair.manual.map(x=>x.symbol),managementFailures,runtime:controls.runtime,operator:controls.control,settings:controls.settings,
    maxSlots:MAX_SLOTS,proposedMargin,cashBuffer,requireNativeProtection:NATIVE_STOP_ENABLED,existingPositionId});
}
async function incident(db,{reason,kind="UNKNOWN_ORDER_OUTCOME",controlScope=CONTROL_SCOPE.ACCOUNT_RISK_BLOCK,
  symbol=null,state={},evidence={}}){
  if(shortAccountWriter(db)&&!currentAccountOwner(db))return withAccountMutation(db,()=>incident(db,{reason,kind,controlScope,symbol,state,evidence}));
  await verifyExecutionLease(db);
  const r=await db.rpc("v19_record_incident",{p_owner:leaseOwners.get(db),p_kind:kind,
    p_reason:String(reason).slice(0,500),p_control_scope:controlScope,p_symbol:symbol,
    p_state:state,p_evidence:evidence,p_evidence_version:ENTRY_CONTROL_VERSION});
  if(r.error)throw Error(`INCIDENT_WRITE:${r.error.message}`);
  return r.data;
}
function sym(p){return String(p?.market??p?.symbol??"").toUpperCase()}
function qty(p){return Math.abs(N(p?.quantity??p?.positionAmt??p?.position_amount))}
async function market(db){const o=await db.from("market_regime_observations").select("id,observed_at,predicted_regime,bull_score,confidence").eq("model_revision",OBSERVER_REVISION).eq("trading_influence",true).order("observed_at",{ascending:false}).limit(1).maybeSingle();if(o.error)throw new Error(`OBSERVER:${o.error.message}`);const age=o.data?Date.now()-Date.parse(o.data.observed_at):Infinity;return{route:age<=12*60000?route(o.data?.predicted_regime):"CASH",ageMs:age,observer:o.data||null}}
function eq(a,b){if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0}
function route(v){const x=String(v||"").toUpperCase();return x==="RISK_OFF"?"BEAR":x==="NEUTRAL"?"RANGE":x==="BULL"||x==="STRONG_BULL"?"BULL":"CASH"}
async function gateway(cmd,tm=20000){if(!GW||!SEC)throw new Error("GATEWAY_CONFIG");const x=["create_order","v17_create_stop","v17_cancel_stop"].includes(cmd.action)?{...cmd,engine_version:PROTOCOL}:["p10_portfolio","v18_open_orders","quote","p10_quotes"].includes(cmd.action)?{...cmd,accept_stream:true}:cmd,raw=JSON.stringify({exchange:"binance_futures",...x}),ts=String(Date.now()),nonce=crypto.randomUUID(),sig=await hmac(SEC,`${ts}\n${nonce}\n${raw}`),c=new AbortController,t=setTimeout(()=>c.abort(),tm);try{const r=await fetch(`${GW}/v1/command`,{method:"POST",signal:c.signal,headers:{"content-type":"application/json","x-gateway-ts":ts,"x-gateway-nonce":nonce,"x-gateway-signature":sig},body:raw}),txt=await r.text();let d;try{d=txt?JSON.parse(txt):null}catch{d={raw:txt}}if(!r.ok||!d?.ok)throw Object.assign(new Error(`GW_${r.status}:${d?.error||txt}`),d?.submissionPhase?{submissionPhase:d.submissionPhase,exchangeSubmissionAttempted:d.exchangeSubmissionAttempted,writerEvidence:d.writerEvidence,writerValidation:d.writerValidation}:{});return d.result}finally{clearTimeout(t)}}
async function hmac(s,m){const k=await crypto.subtle.importKey("raw",new TextEncoder().encode(s),{name:"HMAC",hash:"SHA-256"},false,["sign"]),g=await crypto.subtle.sign("HMAC",k,new TextEncoder().encode(m));return[...new Uint8Array(g)].map(x=>x.toString(16).padStart(2,"0")).join("")}
function capacityRefreshGateway(db){
  return scopedGateway(db,createBudget(CAPACITY_REFRESH_BUDGET),{allowCycleBudgetExceeded:true});
}
async function snap(db){
  const s=await db.from("trading_account_snapshots")
    .select("captured_at,available_quote,positions,positions_complete")
    .eq("exchange","binance_futures").order("captured_at",{ascending:false}).limit(1).maybeSingle();
  const age=s.data?Date.now()-Date.parse(s.data.captured_at):Infinity;
  if(!s.error&&s.data&&s.data.positions_complete===true&&Number.isFinite(age)&&age>=0&&age<=SNAP_MAX)
    return {...s.data,ageMs:age,source:"DB_SNAPSHOT"};
  // A delayed DB snapshot is not proof that the account lacks capacity. Re-read the
  // authoritative Binance futures portfolio immediately. This is read-only and cannot
  // submit an order. If the live read is incomplete/unreadable, fail closed as before.
  try{
    const pf=await gateway({action:"p10_portfolio"},3000),live=livePortfolioSnapshot(pf,age);
    if(live)return live;
  }catch{}
  if(s.error||!s.data)throw new Error("SNAPSHOT_MISSING");
  throw new Error(`SNAPSHOT_INVALID:${age}:LIVE_REFRESH_FAILED`);
}
function capacityInputs(pair,snapshot){
  return {livePositions:Array.isArray(pair?.pf?.positions)?pair.pf.positions:[],liveAvailableUsdt:pair?.pf?.available_quote,
    dbPositions:Array.isArray(pair?.positions)?pair.positions:[],orders:Array.isArray(pair?.orders)?pair.orders:[],
    quarantinedOrderIds:(pair?.match?.issues??[]).filter(i=>i?.controlScope===CONTROL_SCOPE.SYMBOL_QUARANTINE&&i?.orderId!=null).map(i=>String(i.orderId)),
    snapshot:snapshot?{availableUsdt:snapshot.available_quote,capturedAtMs:Date.parse(snapshot.captured_at)}:null};
}
function livePortfolioSnapshot(pf,dbSnapshotAgeMs){
  const available=N(pf?.available_quote,NaN),positions=pf?.positions;
  if(pf?.positions_complete!==true||!Number.isFinite(available)||!Array.isArray(positions))return null;
  return {captured_at:new Date().toISOString(),available_quote:available,positions,
    positions_complete:true,ageMs:0,source:"LIVE_PORTFOLIO_FALLBACK",
    dbSnapshotAgeMs:Number.isFinite(dbSnapshotAgeMs)?dbSnapshotAgeMs:null};
}
async function readOpsOrders(db,positions=[]) {
  const [pending,accounting,entries]=await Promise.all([
    db.from("v11_long_regime_orders").select("*").in("state",["PLANNED","DISPATCHED","PARTIALLY_FILLED","UNKNOWN","RECONCILIATION_FAILED","RECONCILIATION_PENDING"]).or("response_payload->>v18ExposureFinal.is.null,response_payload->>v18ExposureFinal.neq.true").order("updated_at",{ascending:true}).limit(101),
    db.from("v11_long_regime_orders").select("*").in("state",["PARTIALLY_FILLED","UNKNOWN","RECONCILIATION_FAILED","RECONCILIATION_PENDING"]).eq("response_payload->>v18ExposureFinal","true").order("updated_at",{ascending:true}).limit(3),
    positions.length?db.from("v11_long_regime_orders").select("*").in("position_id",positions.map(p=>p.id)):Promise.resolve({data:[]})]);
  if(pending.error||accounting.error||entries.error)throw Error("ORDERS_READ");
  if(pending.data?.length>100)throw Error("RECONCILIATION_BACKLOG_OVERFLOW");
  return [...new Map([...(pending.data??[]),...(accounting.data??[]),...(entries.data??[])].map(o=>[o.id,o])).values()];
}
async function manualPositionAllowances(db){
  const r=await db.from("trading_asset_locks").select("exchange,asset,state,metadata")
    .eq("exchange","binance_futures").eq("state","LOCKED");
  if(r.error)throw new Error(`MANUAL_POSITION_ALLOWLIST:${r.error.message}`);
  return (r.data||[]).filter(x=>rec(x.metadata).v17ManualPosition===true).map(x=>({
    symbol:`${String(x.asset||"").toUpperCase()}USDT`,
    side:String(rec(x.metadata).side||"").toUpperCase(),
    maxQuantity:N(rec(x.metadata).maxQuantity,Number.NaN)
  }));
}
async function reconcileNativeCloseBeforeDispatch(db,p,fraction,gw=opsGateway(db)){
  if(shortAccountWriter(db)&&!currentAccountOwner(db))return withAccountMutation(db,()=>reconcileNativeCloseBeforeDispatch(db,p,fraction,gw));
  const meta=rec(p.metadata);
  // A recovered native stop closes the WHOLE position. Reporting that back to a caller
  // that asked to sell a fraction would book a full close against a partial intent, so
  // the shortcut is only ever valid for a full close. V17 only ever exits in full today;
  // this keeps that assumption from breaking silently if a partial exit is ever wired in.
  if(!(fraction>=1))return null;
  if(!NATIVE_STOP_ENABLED||meta.executionMode!==STRATEGY||p.side!=="LONG"||
      p.state!=="OPEN"||meta.v17ManualPosition===true)return null;
  const orders=rec(meta.exitProtection).orders;
  if(!Array.isArray(orders)||!orders.some(o=>o&&o.terminal!==true))return null;
  try{
    const state=await createGatewayProtection(db,gw,()=>verifyExecutionLease(db)).refresh(p.id);
    const confirmed=(state.protection?.orders||[]).some(o=>o.actualOrderId&&o.terminal===true&&
      o.fillStatus==="FILLED"&&Number(o.appliedQuantity)>0&&Number(o.appliedFunds)>0&&
      Number.isFinite(o.appliedFee));
    if(!confirmed||state.position?.state!=="CLOSED"||state.position.remainingQuantity!==0)return null;
    const row=await db.from("v11_long_regime_positions").select("*").eq("id",p.id).single();
    if(row.error||!row.data||row.data.state!=="CLOSED"||Number(row.data.remaining_quantity)!==0)
      throw new Error("NATIVE_CLOSE_NOT_DURABLE");
    return {closed:true,position:row.data,exitPrice:row.data.exit_price,
      realizedPnlUsdt:Number(row.data.realized_pnl_usdt),nativeReconciled:true};
  }catch(e){
    if(classifyFailure(e).fatal)throw e;
    console.error("V17_NATIVE_CLOSE_RECONCILE_FAILED",p.id,String(e instanceof Error?e.message:e));
    return null;
  }
}
async function circuit(db,reason,kind="UNKNOWN_ORDER_OUTCOME",evidence={}){
  const hold=["KNOWN_ORDER_PENDING_RECONCILIATION","INCOMPLETE_OR_STALE_SNAPSHOT","TRANSIENT_DEPENDENCY","DB_CAS_CONFLICT"].includes(kind);
  return incident(db,{reason,kind,controlScope:hold?CONTROL_SCOPE.ACCOUNT_ENTRY_HOLD:CONTROL_SCOPE.ACCOUNT_RISK_BLOCK,
    state:{exposureState:"UNKNOWN",accountingState:"ATTRIBUTION_INVESTIGATING",orderSource:evidence?.orderId?"BOT":"UNKNOWN",
      recheck:["QUERY_SAME_ORDER_IDENTITY","FRESH_COMPLETE_ACCOUNT_SNAPSHOT","FRESH_COMPLETE_OPEN_ORDERS"]},evidence});
}
function active(p){return(Array.isArray(p?.positions)?p.positions:[]).filter(x=>Math.abs(N(x?.quantity??x?.positionAmt??x?.position_amount))>1e-12)}
async function settleNeverPlacedEntry(db,order,error,gw){
  if(shortAccountWriter(db)&&!currentAccountOwner(db))return withAccountMutation(db,()=>settleNeverPlacedEntry(db,order,error,gw));
  const message=String(error?.message??error??"");
  if(order.intent!=="OPEN_LONG"||order.exchange_order_id!=null)return null;
  if(!/-2013|order does not exist/i.test(message))return null;
  const createdAt=Date.parse(order.created_at);
  if(!Number.isFinite(createdAt)||Date.now()-createdAt>NEVER_PLACED_PROOF_MAX_AGE_MS)return null;
  let proof;
  try{proof=await gw({action:"v18_entry_never_placed_proof",market:order.symbol,
    identifier:order.client_order_id},5000);}
  catch(e){
    if(classifyFailure(e).fatal)throw e;
    return {orderId:order.id,error:`NEVER_PLACED_PROOF_UNAVAILABLE:${String(e?.message??e)}`};
  }
  if(proof?.proven!==true||proof.found!==false||N(proof.position_quantity,NaN)!==0||
     proof.position_read_ok!==true||proof.trade_read_ok!==true){
    let retry;
    try{retry=await settleNeverPlacedPartialRetry(db,order,proof,gw);}
    catch(error){
      if(classifyFailure(error).fatal)throw error;
      return {orderId:order.id,outcome:"UNRESOLVED",inspectionPerformed:true,evidenceSecured:false,
        reason:"RETRY_NEVER_PLACED_PROOF_UNAVAILABLE",error:String(error?.message??error).slice(0,300)};
    }
    if(retry)return retry;
    return {orderId:order.id,outcome:"UNRESOLVED",inspectionPerformed:true,evidenceSecured:false,
      reason:"NEVER_PLACED_NOT_PROVEN",proof:proof??null};
  }
  await verifyExecutionLease(db);
  const evidence={neverPlaced:true,provenAt:new Date().toISOString(),
    lookupCode:proof.lookup_code??null,positionQuantity:proof.position_quantity,
    recentTradeCount:proof.recent_trade_count,source:proof.source,
    observedAtMs:proof.observed_at_ms,gatewayRejection:order.reject_reason??null,
    // The flag riskOrders reads. Setting it is what lets the account resume, so it is
    // written only on the proven branch and only together with the evidence above.
    v18ExposureFinal:true};
  const wr=await db.from("v11_long_regime_orders").update({state:"REJECTED",
    reject_reason:`ORDER_NEVER_PLACED:${String(order.reject_reason??message).slice(0,400)}`,
    response_payload:{...rec(order.response_payload),v18EntryNeverPlaced:evidence,
      v18ExposureFinal:true},
    updated_at:new Date().toISOString()}).eq("id",order.id).eq("state",order.state);
  if(wr.error)throw Error(`NEVER_PLACED_WRITE:${wr.error.message}`);
  // The signal is retired with the same fact, so the candidate is not reopened and
  // re-refused on the next cycle.
  await db.from("v11_long_regime_signals").update({status:"REJECTED",
    reject_reason:`ORDER_NEVER_PLACED:${String(order.reject_reason??message).slice(0,400)}`,
    updated_at:new Date().toISOString()}).eq("id",order.signal_id).neq("status","REJECTED");
  await audit(db,null,"BULL","BULL","ENTRY_REJECT","ORDER_NEVER_PLACED",
    {signalId:order.signal_id,symbol:order.symbol,stage:"NEVER_PLACED_SETTLEMENT",
      finalAdmission:false,orderDispatched:false,orderId:order.id,evidence})
    .catch(()=>console.error("V17_NEVER_PLACED_AUDIT_FAILED",order.id));
  return {orderId:order.id,outcome:"RESOLVED",inspectionPerformed:true,evidenceSecured:true,
    quantityResolved:true,attributionComplete:true,accountingComplete:true,settled:true,
    executedQuantity:0,reason:"ORDER_NEVER_PLACED"};
}
async function reconcileDbOnlyPosition(db,p,gw,scopeIncident=null) {
  if(shortAccountWriter(db)&&!currentAccountOwner(db))return withAccountMutation(db,()=>reconcileDbOnlyPosition(db,p,gw,scopeIncident));
  const start=new Date(Date.parse(p.entry_at)-5000).toISOString(),startMs=Date.parse(start),endMs=Date.now();
  const [fills,lifecycles,laneOrders,accountTrades,orderHistory,portfolio,openOrders]=await Promise.all([
    db.from("exchange_trade_fills").select("exchange,account_scope,market,exchange_trade_id,exchange_order_id,client_order_id,side,price,quantity,quote_amount,fee_quote_amount,realized_pnl_quote,accounting_status,executed_at,v17_order_id,v17_position_id,source")
      .eq("exchange","binance_futures").eq("account_scope","futures").eq("market",p.symbol).eq("side","SELL")
      .gte("executed_at",start).order("executed_at",{ascending:true}).limit(1001),
    db.from("v11_long_regime_positions").select("*").eq("symbol",p.symbol).order("entry_at",{ascending:true}).limit(101),
    db.from("v11_long_regime_orders").select("*").eq("position_id",p.id).order("created_at",{ascending:true}).limit(101),
    gw({action:"trade_history",market:p.symbol,limit:1000},5000),
    gw({action:"order_history",market:p.symbol,start_time:startMs,end_time:endMs,limit:1000},5000),
    gw({action:"p10_portfolio"},5000),gw({action:"v18_open_orders"},5000)
  ]);
  if(fills.error||lifecycles.error||laneOrders.error)throw Error("DB_ONLY_EVIDENCE_READ");
  const trades=Array.isArray(accountTrades)?accountTrades:[],orders=Array.isArray(orderHistory)?orderHistory:[];
  const after=trades.filter(x=>x?.isBuyer===false&&Number(x?.time)>Date.parse(p.entry_at));
  const ids=[...new Set(after.map(x=>String(x?.orderId??"")).filter(Boolean))];
  const exact=ids.length===1?orders.find(x=>String(x?.orderId??"")===ids[0]):null;
  let algo=null;
  if(exact?.clientOrderId){
    const owners=(lifecycles.data??[]).flatMap(position=>(position.metadata?.exitProtection?.orders??[])
      .filter(o=>String(o?.clientId??o?.spec?.params?.clientAlgoId??"")===String(exact.clientOrderId)).map(order=>({position,order})));
    if(owners.length===1){
      try{algo=await gw({action:"v17_query_stop",symbol:p.symbol,clientAlgoId:String(exact.clientOrderId)},5000);}
      catch(e){return {outcome:"UNRESOLVED",inspectionPerformed:true,evidenceSecured:false,quantityResolved:false,
        attributionComplete:false,accountingComplete:false,reason:`NATIVE_ALGO_QUERY:${String(e.message??e)}`};}
    }
  }
  const complete=(fills.data??[]).length<1001&&(lifecycles.data??[]).length<101&&(laneOrders.data??[]).length<101;
  const proof=analyzeDbOnlyExit({position:p,lifecyclePositions:lifecycles.data,laneOrders:laneOrders.data,
    ledgerFills:fills.data,accountTrades:trades,orderHistory:orders,algo,portfolio,openOrders,
    tradeHistoryComplete:complete&&trades.length<1000,orderHistoryComplete:complete&&orders.length<1000});
  if(!proof.settlementPermitted)return proof;
  const controls=await opsControls(db),selected=scopeIncident??(controls.runtime.circuit_open?{
    id:controls.runtime.incident_id,generation:controls.runtime.incident_generation}:null);
  if(!selected?.id||!Number.isFinite(Number(selected.generation)))return {...proof,outcome:"UNRESOLVED",
    accountingComplete:false,reason:"SETTLEMENT_INCIDENT_MISSING"};
  await verifyExecutionLease(db);
  const settled=await db.rpc("v18_settle_db_only_exit",{p_owner:leaseOwners.get(db),
    p_incident_id:selected.id,p_generation:Number(selected.generation),
    p_position_id:p.id,p_evidence:proof.evidence});
  if(settled.error)throw Error(`DB_ONLY_SETTLEMENT:${settled.error.message}`);
  if(settled.data?.settled!==true)return {...proof,outcome:"UNRESOLVED",accountingComplete:false,
    reason:settled.data?.reason??"SETTLEMENT_REJECTED"};
  return {...proof,outcome:"RESOLVED",accountingComplete:true,settlement:sortedRecord(settled.data),
    executedQuantity:proof.evidence.quantity};
}
function sortedRecord(x){return rec(x);}
async function settleNeverPlacedPartialRetry(db,order,proof,gw){
  if(shortAccountWriter(db)&&!currentAccountOwner(db))return withAccountMutation(db,()=>settleNeverPlacedPartialRetry(db,order,proof,gw));
  if(!retryProofCandidate(order))return null;
  const pr=await db.from("v11_long_regime_orders").select("*").eq("id",order.request_payload.retry_of_order_id).maybeSingle();
  if(pr.error||!pr.data)return {orderId:order.id,outcome:"UNRESOLVED",reason:"RETRY_PARENT_UNAVAILABLE"};
  const parent=pr.data,fromId=parentTradeStart(parent);
  if(fromId===null)return {orderId:order.id,outcome:"UNRESOLVED",reason:"RETRY_PARENT_FILL_UNAVAILABLE"};
  const readsStartedAt=Date.now(),[orderHistory,trades]=await Promise.all([
    gw({action:"order_history",market:order.symbol,start_time:Date.parse(parent.created_at)-1000,end_time:readsStartedAt,limit:1000},3000),
    gw({action:"trade_history",market:order.symbol,from_id:fromId,limit:1000},3000)]),readsFinishedAt=Date.now(),
    pair=await readOpsPair(db,gw),evidence=proveUnplacedPartialRetry({order,parent,proof,orderHistory,trades,pair,readsStartedAt,readsFinishedAt});
  if(!evidence.proven)return {orderId:order.id,outcome:"UNRESOLVED",inspectionPerformed:true,evidenceSecured:false,reason:evidence.reason};
  await verifyExecutionLease(db);
  const wr=await db.from("v11_long_regime_orders").update({state:"REJECTED",
    reject_reason:`PARTIAL_RETRY_NEVER_PLACED:${String(order.reject_reason).slice(0,380)}`,
    response_payload:{...rec(order.response_payload),v18EntryNeverPlaced:{...evidence,neverPlaced:true,provenAt:new Date().toISOString()},v18ExposureFinal:true},
    updated_at:new Date().toISOString()}).eq("id",order.id).eq("state",order.state).is("exchange_order_id",null).select("id").maybeSingle();
  if(wr.error||!wr.data)throw Error("RETRY_NEVER_PLACED_CAS_CONFLICT");
  // The first entry remains FILLED; rejecting its unaccepted remainder must not erase it.
  const signal=await db.from("v11_long_regime_signals").update({status:"FILLED",reject_reason:null,updated_at:new Date().toISOString()})
    .eq("id",order.signal_id).eq("status","ORDERED");
  if(signal.error)throw Error("RETRY_PARTIAL_SIGNAL_WRITE");
  await audit(db,{id:evidence.positionId},"BULL","BULL","ENTRY_PARTIAL_RECONCILED","PARTIAL_RETRY_NEVER_PLACED",
    {signalId:order.signal_id,symbol:order.symbol,orderId:order.id,version:RETRY_RECONCILIATION_VERSION,evidence})
    .catch(()=>console.error("RETRY_NEVER_PLACED_AUDIT_FAILED",order.id));
  return {orderId:order.id,outcome:"RESOLVED",inspectionPerformed:true,evidenceSecured:true,quantityResolved:true,
    attributionComplete:true,accountingComplete:true,settled:true,executedQuantity:0,reason:"PARTIAL_RETRY_NEVER_PLACED",
    retainedPositionId:evidence.positionId,retainedQuantity:evidence.retainedQuantity,version:RETRY_RECONCILIATION_VERSION};
}
function audit(db,p,b,a,action,reason,details={}){const task=Promise.resolve().then(()=>db.from("v11_long_regime_decisions").insert({revision:REVISION,position_id:p?.id||null,observed_regime:details.marketRoute||null,active_lane_before:b||null,active_lane_after:a||null,action,reason,details:{...details,executorPatch:PATCH}})).then(r=>{if(r.error)console.error("AUDIT_WRITE_FAILED",r.error.code)}).catch(()=>console.error("AUDIT_WRITE_FAILED"));globalThis.EdgeRuntime?.waitUntil?.(task);return Promise.resolve();}
async function readOpsPositions(db) {
  const r=await db.from("v11_long_regime_positions").select("*").eq("state","OPEN").order("entry_at",{ascending:true}).limit(101);
  if(r.error)throw Error(`POSITIONS:${r.error.message}`);if((r.data??[]).length>100)throw Error("POSITION_RECONCILIATION_BACKLOG_OVERFLOW");return r.data??[];
}
const exchangeGateway=gateway;
async function dispatchEntryIocAttempt(db,s,gw,{attemptNo,quantity,limitPrice,step,payload,authorize,attempt={}}){
  await requireEntryAuthority(db,s);
  if(!Number.isInteger(attemptNo)||attemptNo<1||attemptNo>IOC_RETRY_POLICY.maxAttempts)throw Error("IOC_RETRY_EXHAUSTED");
  payload.entry_latency??={};payload.entry_latency.order_intent=Date.now();
  const id=cid(attemptNo===1?"v11e":`v11r${attemptNo}`,s.id),
    rp={action:"create_order",leverage:LEV,order:{market:s.symbol,side:"BUY",type:"LIMIT",price:limitPrice,
      time_in_force:"IOC",quantity,identifier:id,position_side:"LONG",position_effect:"OPEN"},wait_for_final_ms:4000},
    oi=await db.from("v11_long_regime_orders").insert({revision:REVISION,signal_id:s.id,position_id:null,symbol:s.symbol,
      intent:"OPEN_LONG",reason:attemptNo===1?"V17_LEADER_ENTRY_IOC":"V17_LEADER_ENTRY_IOC_RETRY",
      client_order_id:id,requested_quantity:quantity,state:"PLANNED",
      request_payload:{...rp,...payload,quantity_step:step,entry_ioc_attempt:attemptNo,
        entry_ioc_max_attempts:IOC_RETRY_POLICY.maxAttempts,executor_patch:PATCH}}).select("*").single();
  if(oi.error)throw Error(`ORDER_INTENT:${oi.error.message}`);
  payload.entry_latency.order_intent_completed=Date.now();
  try{
    await verifyExecutionLease(db);
    // Re-evaluate after durable intent/lease I/O. A slow database must not spend the
    // approval or quote budget and then send a stale order. No venue call on refusal.
    let generationError=null;
    try{await requireEntryAuthority(db,s);}catch(error){generationError=String(error.message);attempt.evidence={...attempt.evidence,universe:error.authority??null};}
    const authority=generationError?{allowed:false,reason:generationError}:await authorize?.({order:oi.data,signal:s,attemptNo,request:rp});
    if(authority?.allowed!==true){
      const reason=authority?.reason??"IOC_DISPATCH_AUTHORITY_MISSING";
      const wr=await db.from("v11_long_regime_orders").update({state:"REJECTED",reject_reason:reason,
        response_payload:{notDispatched:true,entryLatency:{...payload.entry_latency},
          dispatchAuthority:{allowed:false,reason},entryEvidence:{...attempt.evidence,order_id:oi.data.id,reason,category:cancellationCategory(reason,attempt.evidence?.latest)}},updated_at:new Date().toISOString()}).eq("id",oi.data.id);
      if(wr.error)throw Error("IOC_NO_DISPATCH_WRITE");
      return {blocked:true,reason,oi:oi.data};
    }
    if(authority.accountEvidence)rp.account_stream={required:true,observation:authority.accountEvidence};
    const beforeTransport=async()=>{
      payload.entry_latency.submission_started=Date.now();
      const submit=await db.rpc('deterministic_begin_submit',{p_order_id:oi.data.id,p_owner:leaseOwners.get(db),p_state:authority.deterministic});
      payload.entry_latency.submission_completed=Date.now();
      attempt.evidence={...attempt.evidence,submission:submit.data?.proof??submit.data??{updated:false,reason:submit.error?.code??'ACKNOWLEDGEMENT_MISSING'}};
      if(submit.error||submit.data?.updated!==true||String(submit.data?.order_id)!==String(oi.data.id))throw Object.assign(Error('DETERMINISTIC_SUBMIT_FENCE:'+String(submit.error?.code??submit.data?.reason??'ACKNOWLEDGEMENT_MISSING')),{exchangeSubmissionAttempted:false,submissionPhase:'PRE_SEND'});
      attempt.evidence={...attempt.evidence,submission:submit.data.proof};return submit.data.proof;
    };
    const sentAt=Date.now();
    attempt.dispatched=true;payload.entry_latency.order_sent=sentAt;const initialRaw=await gw(rp,12000,{beforeTransport}),respondedAt=Date.now(),initial=fill(initialRaw);payload.entry_latency.exchange_ack=respondedAt;
    await verifyExecutionLease(db);
    const pending=await db.from("v11_long_regime_orders").update({state:"RECONCILIATION_PENDING",
      exchange_order_id:initial.exchangeOrderId,response_payload:{...oi.data.response_payload,...initialRaw,v22ImmediateEntryQueryPending:true,entryLatency:{...payload.entry_latency},entryEvidence:attempt.evidence},
      reject_reason:`IOC_CONFIRMING:${initial.status}`,updated_at:new Date().toISOString()}).eq("id",oi.data.id);
    if(pending.error)throw Error("ENTRY_PENDING_WRITE");
    // The create response is acknowledgement evidence, never final settlement truth.
    // Always query this exact venue order before reconciling the actual position.
    const finalRaw=await gw({action:"get_order",market:s.symbol,identifier:id,exchange_order_id:initial.exchangeOrderId},5000),
      receipt=entryReceipt(finalRaw,oi.data),finalitySource="SAME_ORDER_QUERY";
    const fillAt=Number.isSafeInteger(receipt?.lastAt)?receipt.lastAt:Number.isSafeInteger(receipt?.updateTime)?receipt.updateTime:null;
    payload.entry_latency.fill=fillAt;
    const evidence={source:finalitySource,initialStatus:initial.status,confirmedAt:new Date().toISOString(),attemptNo,
      sentAt,respondedAt,latencyMs:respondedAt-sentAt,finalStatus:receipt?.status??null,executedQty:receipt?.quantity??null,
      avgPrice:receipt?.price??null,requestedQty:quantity,limitPrice,
      entryLatency:{...payload.entry_latency}};
    return {oi:oi.data,rp,id,receipt,initial,evidence,settledRaw:{...finalRaw,v22EntryFinality:evidence,entryEvidence:attempt.evidence,writer_evidence:initialRaw.writer_evidence}};
  }catch(error){
    if(classifyFailure(error).fatal)throw error;
    const msg=String(error?.message??error);await verifyExecutionLease(db);
    if(error?.submissionPhase==='PRE_SEND'&&error.exchangeSubmissionAttempted===false){
      attempt.dispatched=false;
      const stopped=await db.from('v11_long_regime_orders').update({state:'REJECTED',reject_reason:msg,response_payload:{...oi.data.response_payload,notDispatched:true,submissionPhase:'PRE_SEND',exchangeSubmissionAttempted:false,entryLatency:{...payload.entry_latency},entryEvidence:{...attempt.evidence,order_id:oi.data.id,reason:msg,category:cancellationCategory(msg)},writerEvidence:error.writerEvidence,writerValidation:error.writerValidation},updated_at:new Date().toISOString()}).eq('id',oi.data.id);
      if(stopped.error)throw Error('PRE_SEND_REFUSAL_WRITE');return {blocked:true,reason:msg,oi:oi.data};
    }
    await db.from("v11_long_regime_orders").update({state:"RECONCILIATION_FAILED",reject_reason:msg.slice(0,500),response_payload:{...oi.data.response_payload,entryEvidence:{...attempt.evidence,order_id:oi.data.id,phase:'RESULT_UNCERTAIN',reason:msg},writerEvidence:error.writerEvidence},
      updated_at:new Date().toISOString()}).eq("id",oi.data.id);
    await db.from("v11_long_regime_signals").update({status:"ORDERED",updated_at:new Date().toISOString()}).eq("id",s.id);
    await circuit(db,`BULL_ENTRY_AMBIGUOUS:${msg}`,"KNOWN_ORDER_PENDING_RECONCILIATION",
      {orderId:oi.data.id,clientOrderId:id,error:msg,attemptNo});
    throw error;
  }
}
async function settleKnownEntry(db,intent,raw,gw=opsGateway(db),opts={}) {
  if(shortAccountWriter(db)&&!currentAccountOwner(db))return withAccountMutation(db,()=>settleKnownEntry(db,intent,raw,gw,opts));
  const receipt=entryReceipt(raw,intent),sig=await db.from("v11_long_regime_signals").select("*").eq("id",intent.signal_id).single();
  if(sig.error||!sig.data||sig.data.features?.strategy!==STRATEGY||intent.request_payload?.order?.side!=="BUY"||intent.request_payload?.order?.position_effect!=="OPEN")throw Error("ENTRY_INTENT_OWNERSHIP_UNPROVEN");
  // Exchange position is the final truth for every order outcome, including zero-fill
  // expiry and terminal IOC partials. This read occurs after create + get_order.
  const pf=await gw({action:"p10_portfolio"}),reconciledAt=Date.now();
  if(!freshPortfolio(pf,reconciledAt))throw Error("ENTRY_POSITION_RECONCILIATION_STALE");
  const exchangeRows=(pf?.positions??[]).filter(p=>(p.market??p.symbol)===intent.symbol&&Number(p.quantity)!==0);
  if(exchangeRows.length>1||exchangeRows.some(p=>String(p.side??"LONG").toUpperCase()!=="LONG"))
    throw Error("ENTRY_POSITION_RECONCILIATION_AMBIGUOUS");
  const actualPositionQty=exchangeRows.length?Number(exchangeRows[0].quantity):0,
    reconciliation={source:"BINANCE_FUTURES_P10_PORTFOLIO",reconciledAt,
      actualPositionQty,positionRows:exchangeRows.length,positionsComplete:pf?.positions_complete===true};
  if(!Number.isFinite(actualPositionQty)||actualPositionQty<0)throw Error("ENTRY_POSITION_RECONCILIATION_QUANTITY");
  if(receipt.quantity===0){
    const held=opts.existingPosition;
    const exposureProven=held?held.symbol===intent.symbol&&held.state==="OPEN"&&exchangeRows.length===1&&
      Math.abs(actualPositionQty-Number(held.remaining_quantity))<=Math.max(1e-12,actualPositionQty*1e-9):exchangeRows.length===0;
    if(!exposureProven)throw Error("ENTRY_ZERO_EXPOSURE_UNPROVEN");
    const orderState=classifyEntryOrderState({requestedQty:receipt.requested,executedQty:receipt.quantity,
      remainingQty:receipt.remaining,rawStatus:receipt.status,fills:receipt.fills,updateTime:receipt.updateTime,
      reconciledPositionQty:actualPositionQty,positionReconciled:true});
    await verifyExecutionLease(db);
    const wr=await db.from("v11_long_regime_orders").update({state:orderState.state,exchange_order_id:receipt.id,
      response_payload:{...raw,v18ExposureFinal:true,positionReconciliation:reconciliation,orderStateEvidence:orderState},
      reject_reason:`IOC_NO_FILL:${receipt.status}`,updated_at:new Date().toISOString()}).eq("id",intent.id);
    if(wr.error)throw Error("ENTRY_TERMINAL_WRITE");
    if(opts.retireZeroFillSignal!==false){
      const sr=await db.from("v11_long_regime_signals").update({status:"REJECTED",reject_reason:`IOC_NO_FILL:${receipt.status}`,updated_at:new Date().toISOString()}).eq("id",intent.signal_id);
      if(sr.error)throw Error("ENTRY_SIGNAL_WRITE");
    }
    return null;
  }
  const row=sig.data,f=rec(row.features),atr=N(f.atr),z={qty:receipt.quantity,avg:receipt.price,fee:receipt.fee,exchangeOrderId:receipt.id};
  const found=await db.from("v11_long_regime_positions").select("*").eq("signal_id",row.id).maybeSingle();
  if(found.error)throw Error("ENTRY_POSITION_LOOKUP");
  let position=found.data;
  if(position){
    const meta=rec(position.metadata),fills=Array.isArray(meta.entryFillOrders)?meta.entryFillOrders:[],
      already=fills.find(x=>String(x.exchangeOrderId)===receipt.id||String(x.intentId)===String(intent.id));
    if(already){
      const reconciledExisting=position.state==="CLOSED"?actualPositionQty===0:
        entryExposureMatches(pf,row.symbol,N(position.remaining_quantity));
      if(!reconciledExisting)throw Error("ENTRY_EXISTING_POSITION_EXPOSURE_UNPROVEN");
      if(Math.abs(N(already.quantity)-receipt.quantity)>1e-8||Math.abs(N(already.price)-receipt.price)>Math.max(1e-12,receipt.price*1e-7))
        throw Error("ENTRY_RETRY_IDEMPOTENCY_MISMATCH");
      // A terminal order may be known before its canonical fills/fees arrive. Resolve
      // that SAME entry leg exactly once without mistaking it for another top-up.
      if(receipt.exact===true&&already.exact!==true){
        const nextFills=fills.map(x=>(String(x.exchangeOrderId)===receipt.id||String(x.intentId)===String(intent.id))?
          {...x,fee:receipt.fee,exact:true,filledAt:receipt.lastAt??x.filledAt??null}:x),
          allExact=nextFills.every(x=>x.exact===true&&Number.isFinite(Number(x.fee))),
          totalFee=allExact?nextFills.reduce((a,x)=>a+N(x.fee),0):null,
          pendingExit=(meta.exitProtection?.orders??[]).some(x=>x.accountingPending)||
            Object.values(meta.v18Exits??{}).some(x=>x.quantity>0&&!x.detailsComplete),
          settled=N(meta.v18SettledPnl)-receipt.fee,now=new Date(Math.max(Date.now(),Date.parse(position.updated_at)+1)).toISOString();
        await verifyExecutionLease(db);
        const up=await db.from("v11_long_regime_positions").update({entry_fee_usdt:totalFee,
          realized_pnl_usdt:allExact&&!pendingExit?settled:null,
          metadata:{...meta,entryFillOrders:nextFills,v18SettledPnl:settled,v18EntryAccountingPending:!allExact,
            exitAccountingPending:!allExact||pendingExit},updated_at:now})
          .eq("id",position.id).eq("updated_at",position.updated_at).select("*").maybeSingle();
        if(up.error||!up.data)throw Error("ENTRY_ACCOUNTING_CAS_CONFLICT");position=up.data;
      }
    }else{
      // A retry may only top up an untouched partial entry. If protection/exit changed
      // quantity in the meantime, stop rather than re-expand the position.
      if(Math.abs(N(position.original_quantity)-N(position.remaining_quantity))>1e-8)throw Error("PARTIAL_FILL_POSITION_CHANGED");
      const manual=await manualPositionAllowances(db),
        newQty=N(position.original_quantity)+receipt.quantity;
      if(manual.some(x=>x.symbol===row.symbol)||!entryExposureMatches(pf,row.symbol,newQty))throw Error("ENTRY_RETRY_EXPOSURE_UNPROVEN");
      const oldQty=N(position.original_quantity),oldAvg=N(position.entry_price),newAvg=(oldQty*oldAvg+receipt.quantity*receipt.price)/newQty,
        stopPct=Number(f.exitPolicy?.stopPct);
      if(!(stopPct>0&&stopPct<1&&newAvg>0))throw Error("STOP_POLICY_INVALID");
      const hardStop=Math.max(N(position.hard_stop_price),newAvg*(1-stopPct)),oldFee=position.entry_fee_usdt==null?null:N(position.entry_fee_usdt),
        feesExact=receipt.exact&&oldFee!==null&&meta.v18EntryAccountingPending!==true,
        entryFee=feesExact?oldFee+receipt.fee:null,settledBase=N(meta.v18SettledPnl,Number.NaN),
        settled=feesExact&&Number.isFinite(settledBase)?settledBase-receipt.fee:settledBase,
        now=new Date(Math.max(Date.now(),Date.parse(position.updated_at)+1)).toISOString(),
        nextMeta={...meta,entryFillOrders:[...fills,{intentId:intent.id,exchangeOrderId:receipt.id,quantity:receipt.quantity,
          price:receipt.price,fee:receipt.fee,exact:receipt.exact,filledAt:receipt.lastAt??null}],
          lastAppliedOrderId:intent.id,entryFillAt:receipt.lastAt??meta.entryFillAt??null,
          sizedMarginUsdt:newQty*newAvg/LEV,v18SettledPnl:Number.isFinite(settled)?settled:meta.v18SettledPnl,
          v18EntryAccountingPending:!feesExact,exitAccountingPending:!feesExact||meta.exitAccountingPending===true};
      await verifyExecutionLease(db);
      const up=await db.from("v11_long_regime_positions").update({original_quantity:newQty,remaining_quantity:newQty,entry_price:newAvg,
        hard_stop_price:hardStop,peak_price:Math.max(N(position.peak_price),receipt.price,newAvg),
        entry_fee_usdt:entryFee,realized_pnl_usdt:feesExact&&meta.exitAccountingPending!==true?settled:null,
        metadata:nextMeta,updated_at:now}).eq("id",position.id).eq("updated_at",position.updated_at).select("*").maybeSingle();
      if(up.error||!up.data)throw Error("ENTRY_RETRY_POSITION_CAS_CONFLICT");
      position=up.data;
    }
  }else{
    const manual=await manualPositionAllowances(db);
    if(manual.some(x=>x.symbol===row.symbol)||!entryExposureMatches(pf,row.symbol,receipt.quantity))throw Error("ENTRY_EXPOSURE_UNPROVEN");
    const sized={sizedMargin:receipt.quantity*receipt.price/LEV};
    await verifyExecutionLease(db);
    const stopPct=Number(f.exitPolicy?.stopPct);if(!(stopPct>0&&stopPct<1))throw new Error("STOP_POLICY_INVALID");const stop=z.avg*(1-stopPct);if(!(stop>0&&stop<z.avg))throw new Error("STOP_INVALID");
    const settledAt=Date.now(),intentAt=Date.parse(intent.created_at),fillAt=Number(receipt.lastAt),
      entryAt=Number.isFinite(fillAt)&&fillAt>0&&fillAt<=settledAt+1000&&(!Number.isFinite(intentAt)||fillAt>=intentAt-30000)?fillAt:settledAt,
      now=new Date(entryAt),entryPolicy=intent.request_payload?.entry_execution_policy,
      entryTiming=rec(intent.request_payload?.entry_timing_policy),entryController=rec(intent.request_payload?.entry_controller),
      fillGuard=entryPolicy?.version===ENTRY_EXECUTION_POLICY_VERSION?postFillEntryGuard(f,z.avg):null,
      pos=await db.from("v11_long_regime_positions").insert({signal_id:row.id,revision:REVISION,entry_lane:"BULL",active_lane:"BULL",transition_from:null,symbol:row.symbol,side:"LONG",original_quantity:z.qty,remaining_quantity:z.qty,entry_price:z.avg,entry_at:now.toISOString(),entry_atr:isLeader20(row)?null:atr,entry_bb_pos:N(f.bbPos,0),hard_stop_price:stop,hard_deadline:new Date(now.getTime()+POLICY.maxHoldMs).toISOString(),active_since:now.toISOString(),active_ref_bb:N(f.bbPos,0),active_target_delta:null,t1_completed:false,peak_price:z.avg,last_evaluated_at:now.toISOString(),state:"OPEN",realized_pnl_usdt:receipt.exact?-receipt.fee:null,entry_fee_usdt:receipt.fee,metadata:{deterministicEntry:intent.request_payload?.deterministic??null,entryLatency:raw.v22EntryFinality?.entryLatency??intent.request_payload?.entry_latency??null,
 v18SettledPnl:receipt.exact?-receipt.fee:0,v18EntryAccountingPending:!receipt.exact,exitAccountingPending:!receipt.exact,executionMode:STRATEGY,
 leaderExitPolicy:f.exitPolicy,leaderExitPolicyVersion:ENGINE,entryExecutionPolicyVersion:ENTRY_EXECUTION_POLICY_VERSION,
 entryMarketRules:{priceTick:N(intent.request_payload?.price_tick),quantityStep:N(intent.request_payload?.quantity_step)},
 leaderLastHighAt:now.toISOString(),entryFillAt:receipt.lastAt??null,entryRecordedAt:new Date(settledAt).toISOString(),executorPatch:PATCH,
 maxSlots:MAX_SLOTS,targetMarginUsdt:MARGIN,sizedMarginUsdt:sized.sizedMargin,lastAppliedOrderId:intent.id,entryOrderId:z.exchangeOrderId,
 entryFillOrders:[{intentId:intent.id,exchangeOrderId:receipt.id,quantity:receipt.quantity,price:receipt.price,fee:receipt.fee,exact:receipt.exact,filledAt:receipt.lastAt??null}],entryFeatures:f}}).select("*").single();
    if(pos.error)throw Error(`POSITION:${pos.error.message}`);position=pos.data;
  }
  const orderState=classifyEntryOrderState({requestedQty:receipt.requested,executedQty:receipt.quantity,
    remainingQty:receipt.remaining,rawStatus:receipt.status,fills:receipt.fills,updateTime:receipt.updateTime,
    reconciledPositionQty:actualPositionQty,positionReconciled:true});
  await verifyExecutionLease(db);
  const wr=await db.from("v11_long_regime_orders").update({state:orderState.state,exchange_order_id:receipt.id,
    response_payload:{...raw,v18ExposureFinal:true,positionReconciliation:reconciliation,orderStateEvidence:orderState},
    position_id:position.id,reject_reason:orderState.reason,updated_at:new Date().toISOString()}).eq("id",intent.id);
  if(wr.error)throw Error("ENTRY_ORDER_WRITE");
  const sr=await db.from("v11_long_regime_signals").update({status:position.state==="CLOSED"?"CLOSED":"FILLED",position_id:position.id,updated_at:new Date().toISOString()}).eq("id",row.id);
  if(sr.error)throw Error("ENTRY_SIGNAL_WRITE");
  return position;
}
async function installEntryNativeProtection(db,p,gw,manualSymbols=[]){
  if(shortAccountWriter(db)&&!currentAccountOwner(db))return withAccountMutation(db,()=>installEntryNativeProtection(db,p,gw,manualSymbols));
 await verifyExecutionLease(db);
 const fresh=await db.from('v11_long_regime_positions').select('*').eq('id',p.id).single();if(fresh.error)throw Error('PROTECTION_POSITION_READ');p=fresh.data;
 if(p.state!=='OPEN')return {status:p.state==='CLOSED'?'CLOSED':'RECONCILIATION_PENDING',position:p};
 const [q,info]=await Promise.all([leaderQuote(p,{gateway:gw,quoteRetryBudget:{remaining:1}}),gw({action:'symbol_info',market:p.symbol},2500)]);
 const tick=N(info.price_tick??info.tick_size),step=N(info.quantity_step??info.step_size),hard=hardSafetyState(p,{bid:q.bid,now:q.detectedAtMs,peak:Math.max(N(p.peak_price),q.bid),policy:POLICY,priceTick:tick});
 const resident=Math.max(0,...(p.metadata?.exitProtection?.orders??[]).filter(o=>!o.terminal&&['ACTIVE','NEW'].includes(o.status)).map(o=>N(o.spec?.params?.triggerPrice))),approved=approvedProtection(p,hard,q.bid,{residentLevel:resident});
 if(approved.crossed)return {status:'RESIDENT_EXIT_REQUIRED',position:p};
 const result=await createGatewayProtection(db,gw,()=>verifyExecutionLease(db)).ensure(p.id,{exitClass:approved.exitClass,authorityVersion:EXIT_AUTHORITY_VERSION,
  legacySoftOrderIds:[],protectionReason:approved.reason,stopPrice:approved.level,priceTick:tick,quantityStep:step,exchangeQuantity:N(p.remaining_quantity),positionMode:'ONE_WAY',manualSymbols,lastPrice:q.bid});
 const latest=await db.from('v11_long_regime_positions').select('*').eq('id',p.id).single();if(latest.error)throw Error('PROTECTION_POST_READ');return {...result,position:latest.data};
}
async function manageLeader(db,p,ctx={}){
 await verifyExecutionLease(db);const gw=ctx.gateway??opsGateway(db);let q=await leaderQuote(p,{...ctx,gateway:gw});
 const at=q.detectedAtMs,meta=rec(p.metadata),previous=meta.deterministicPosition??null;
 const hard=hardSafetyState(p,{bid:q.bid,now:at,peak:Math.max(N(p.peak_price),q.bid),policy:POLICY,priceTick:N(meta.entryMarketRules?.priceTick)});
 const resident=Math.max(N(p.hard_stop_price),...(meta.exitProtection?.orders??[]).filter(o=>!o.terminal&&['ACTIVE','NEW'].includes(o.status)).map(o=>N(o.spec?.params?.triggerPrice)));
 let input={position:p,facts:{values:{},quality:{}},capture:{status:'UNAVAILABLE'},profile:PROFILE,at,bid:q.bid,previous},decision;
 if(hard.hardHit||q.bid<=resident)decision={action:'EXIT',state:hard.hardHit?'HARD_STOP':'PROFIT_PROTECTION',reason:'DETERMINISTIC_RESIDENT_STOP',peak:hard.peak,level:resident,at};
 else if(ctx.recoveryOnly===true)decision={action:'HOLD',state:'RECOVERY_SAFETY_ONLY',reason:'RESIDENT_PROTECTION_INTACT',peak:hard.peak,level:resident,at};
 else{
  try{const current=await currentMarket(db,p.symbol,{positionId:p.id});
   if(Date.now()-q.detectedAtMs>=1000)q=await leaderQuote(p,{gateway:gw});
   input={...input,...current,at:Date.now(),position:p,bid:q.bid,previous};decision=decidePosition(input);}
  catch(e){if(classifyFailure(e).fatal)throw e;decision={action:'HOLD',state:'DATA_DEGRADED',reason:'NO_NEW_THESIS_DATA_INVALID',peak:hard.peak,level:resident,at:Date.now()};}
 }
 if(decision.action==='EXIT'){
  const proof={authority:ENGINE,positionId:String(p.id),generation:positionGeneration(p),at:Date.now(),input};
  const result=await closePos(db,p,1,decision.reason,{...ctx,gateway:gw,finalApproval:proof,
   marketDeteriorationAt:decision.market_deterioration_at??at,stateChangedAt:decision.state_changed_at??at,
   revalidateExit:async latest=>{const quote=await leaderQuote(latest,{gateway:gw}),h=hardSafetyState(latest,{bid:quote.bid,now:quote.detectedAtMs,peak:Math.max(N(latest.peak_price),quote.bid),policy:POLICY});
    if(decision.reason==='DETERMINISTIC_RESIDENT_STOP')return {allowed:quote.bid<=Math.max(h.hardFloor,resident),proof};
    const c=await currentMarket(db,latest.symbol,{positionId:latest.id}),i={...c,position:latest,at:Date.now(),bid:quote.bid,previous},d=decidePosition(i);
    return {allowed:d.action==='EXIT'&&d.reason===decision.reason,proof:{...proof,at:Date.now(),input:i}};
   }});
  const nativeStop=NATIVE_STOP_ENABLED?await withAccountMutation(db,()=>createGatewayProtection(db,ctx.cleanupGateway??gw,()=>verifyExecutionLease(db)).ensure(p.id,result.position?.state==='OPEN'?{
   stopPrice:Math.max(N(result.position.hard_stop_price),resident),priceTick:N(meta.entryMarketRules?.priceTick),quantityStep:N(meta.entryMarketRules?.quantityStep),
   exchangeQuantity:N(result.position.remaining_quantity),positionMode:'ONE_WAY',manualSymbols:ctx.manualSymbols??[],lastPrice:q.bid,exitClass:EXIT_CLASS.HARD_SAFETY,authorityVersion:ENGINE}:{})):null;
  detachAudit(db,{symbol:p.symbol,position_id:p.id,kind:'POSITION',state:decision.state,decision:'EXIT',evidence:decision,timing:{market_deterioration:decision.market_deterioration_at??at,decision:Date.now(),fill:result?.position?.closed_at??null}});
  return {action:result.strategyDeferred?'HOLD':'CLOSE',reason:decision.reason,result,nativeStop};
 }
 const level=Math.max(resident,hard.hardFloor,N(decision.level)),now=new Date(Math.max(Date.now(),Date.parse(p.updated_at)+1)).toISOString();
 const state={version:ENGINE,state:decision.state,action:decision.action,at:decision.at,mfe:decision.mfe??hard.mfe,mae:decision.mae??hard.mae,
  drawdown:decision.drawdown??null,giveback:decision.giveback??null,weak_families:decision.weak_families??[],last_high_ms:decision.last_high_ms??previous?.last_high_ms??at,
  market_deterioration_at:decision.market_deterioration_at??null,state_changed_at:decision.state_changed_at??at};
 const {write,nativeStop}=await withAccountMutation(db,async()=>{
 await verifyExecutionLease(db);
 const write=await db.from('v11_long_regime_positions').update({peak_price:decision.peak,hard_stop_price:level,last_evaluated_at:now,updated_at:now,
  metadata:{...meta,deterministicPosition:state,leaderLastHighAt:new Date(state.last_high_ms).toISOString(),exitAuthority:{...hard,residentLevel:level,approvedSoftLevel:level>hard.hardFloor?level:null,residentReason:level>hard.hardFloor?'DETERMINISTIC_PROFIT_PROTECTION':hard.hardReason}}})
  .eq('id',p.id).eq('state','OPEN').eq('updated_at',p.updated_at).select('*').single();if(write.error)throw Error('POSITION_STATE_CAS_CONFLICT');
 const nativeStop=NATIVE_STOP_ENABLED?await installEntryNativeProtection(db,write.data,gw,ctx.manualSymbols??[]):null;return {write,nativeStop};
 });
 if(previous?.state!==decision.state||decision.action==='PROTECT')detachAudit(db,{symbol:p.symbol,position_id:p.id,kind:'POSITION',state:decision.state,decision:decision.action,evidence:decision,timing:{market_deterioration:decision.market_deterioration_at??null,state_change:state.state_changed_at,decision:decision.at}});
 return {action:decision.action,reason:decision.reason,position:nativeStop?.position??write.data,nativeStop,state};
}
async function entryReadTiming(timing,stage,operation){
 timing[stage+'_started']=Date.now();try{return await operation();}catch(error){throw Object.assign(error,{entryStage:stage});}finally{timing[stage+'_completed']=Date.now();}
}
async function openBull(db,s,openPositions,manual=null,attempt={},managementFailures=[]){
 const signalWindow=entrySignalWindow(s.features?.deterministic?.decision,Date.now());
 if(!signalWindow.allowed)return {entered:false,reason:signalWindow.reason};
 const executorStarted=s.features?.executionClaim?.claimed_at_ms??Date.now();
 const universeAuthority=await requireEntryAuthority(db,s,{refresh:true});await requireLeaderEntryControls(db);
 attempt.evidence=entryEvidence(s,{authority:universeAuthority,timing:{candidate_started:Date.now()}});
 const f=s.features,seed=f.deterministic,gw=opsGateway(db),start=Date.now(),timing={...seed.timing,executor_started:executorStarted,candidate_started:start};
 attempt.evidence.timing=timing;
 if(f.sizingContractVersion!==SLOT_SIZING_CONTRACT.version||Number(f.targetMarginUsdt)!==MARGIN||Number(f.leverage)!==LEV||Number(f.exitPolicy?.stopPct)!==POLICY.stopPct)throw Error('SIZING_OR_STOP_CONTRACT_CHANGED');
 let [pair,openOrders,info,fees,mode,controls,initialMarket]=await Promise.all([
  entryReadTiming(timing,'initial_account',()=>readOpsPair(db,gw,s.symbol)),entryReadTiming(timing,'initial_open_orders',()=>gw({action:'v18_open_orders'},2500)),
  entryReadTiming(timing,'symbol_filters',()=>gw({action:'symbol_info',market:s.symbol},2500)),entryReadTiming(timing,'account_fees',()=>gw({action:'fees',market:s.symbol},2500)),entryReadTiming(timing,'account_mode',()=>gw({action:'futures_position_mode'},2000)),opsControls(db),
  entryReadTiming(timing,'initial_market',()=>currentMarket(db,s.symbol,{return24h:seed.return24h,rank:seed.rank}))]);
 if(shortAccountWriter(db)&&!freshPortfolio(pair.pf)){pair=await readOpsPair(db,gw,s.symbol);openOrders=await gw({action:'v18_open_orders'},5000);}
 const fee=gatewayTakerFeeRate(fees,s.symbol);if(!Number.isFinite(fee)||fee>0.0005||!supportedFuturesMode(mode,Date.now(),5000))return {entered:false,reason:'ACCOUNT_FEE_OR_POSITION_MODE_UNVERIFIED'};
 timing.account_reads_completed=Date.now();
 const filters=symbolFilters(info),initialQuote=await gw({action:'quote',market:s.symbol},2000),sized=sizeEntry(Number(initialQuote.best_ask),filters.quantityStep,filters),
  admission=decideEntryWith(controls,pair,s.symbol,openOrders,{proposedMargin:sized.sizedMargin,cashBuffer:ENTRY_CASH_BUFFER_USDT,managementFailures});
 await persistDecisionRisk(db,pair,admission);
 if(!admission.allowed)return {entered:false,reason:'ENTRY_CONTROL:'+admission.scope+':'+admission.reasons.join(','),releaseScope:controlReleaseScope(admission)};
 const validated=validatePreparedOrder(s,initialMarket,initialQuote);attempt.evidence=entryEvidence(s,{check:validated,quote:initialQuote,authority:universeAuthority,timing});if(!validated.allowed)return {entered:false,reason:validated.reason};
 const reservation=await withAccountMutation(db,()=>db.rpc('deterministic_reserve_entry_slot',{p_symbol:s.symbol,p_slot_ms:seed.decision.capture_end_ms,p_signal_id:s.id,p_expires_at:new Date(Date.now()+120000).toISOString()}));
 if(reservation.error||reservation.data?.reserved!==true)return {entered:false,reason:reservation.data?.reason??'ATOMIC_CAPACITY_RESERVATION_FAILED'};
 const reservationId=reservation.data.id;timing.pre_order_validation=Date.now();timing.capacity_claim=Date.now();
 let position=null,filled=0,firstIntent=null,lastAttempt=null,targetQuantity=sized.amount;
 try{
  await withAccountMutation(db,()=>gw({action:'prepare_entry',market:s.symbol,leverage:LEV},5000));
  for(let no=1;no<=IOC_RETRY_POLICY.maxAttempts;no++){
   if(no>1&&(!lastAttempt||!['EXPIRED','CANCELED','CANCELLED','PARTIALLY_FILLED_CANCELED'].includes(lastAttempt.receipt.status)))break;
   if(no>1&&position&&N(position.original_quantity)!==N(position.remaining_quantity))break;
   const currentQuote=await gw({action:'quote',market:s.symbol},2000),plan=no===1?sizeEntry(Number(currentQuote.best_ask),filters.quantityStep,filters):planAggressiveIocRetry({quote:currentQuote,quantityStep:filters.quantityStep,priceTick:filters.priceTick,targetQuantity:targetQuantity,filledQuantity:filled,leverage:LEV,maxTotalMarginUsdt:MAX_ORDER_MARGIN_USDT,currentPositionNotionalUsdt:position?N(position.original_quantity)*N(position.entry_price):0,minNotionalUsdt:filters.minNotionalUsdt,minQuantity:filters.minQuantity});
   if(no>1&&!plan.ok)break;
   if(no===1)targetQuantity=plan.amount;
   const quantity=no===1?plan.amount:plan.quantity,limitPrice=plan.limitPrice;
   const payload={price_tick:filters.priceTick,quantity_step:filters.quantityStep,entry_execution_policy:{version:ENTRY_EXECUTION_POLICY_VERSION},deterministic:{version:ENGINE,seed:seed.decision},entry_latency:timing,
    ...(firstIntent?{retry_of_order_id:firstIntent}:{}),entry_ioc:{attempt:no,target_quantity:targetQuantity,filled_before:filled}};
   await requireEntryAuthority(db,s,{refresh:true});const market=await entryReadTiming(timing,'market_revalidation',()=>currentMarket(db,s.symbol,{return24h:seed.return24h,rank:seed.rank}));
   const sent=await withAccountMutation(db,()=>dispatchEntryIocAttempt(db,s,gw,{attemptNo:no,quantity,limitPrice,step:filters.quantityStep,payload,attempt,
    authorize:async intent=>{
     await requireLeaderEntryControls(db);
     const [fresh,orders,c,authority]=await Promise.all([entryReadTiming(timing,'final_account',()=>readOpsPair(db,gw,s.symbol)),
      entryReadTiming(timing,'final_open_orders',()=>gw({action:'v18_open_orders'},2500)),opsControls(db),requireEntryAuthority(db,s)]);timing.final_account_reads_completed=Date.now();
     const scoped=plannedEntryRiskView(fresh,intent);
     if(!scoped.allowed)return {allowed:false,reason:scoped.reason};
     const risk=decideEntryWith(c,scoped.pair,s.symbol,orders,{proposedMargin:Math.max(0,quantity*limitPrice/LEV),cashBuffer:ENTRY_CASH_BUFFER_USDT,existingPositionId:position?.id??null,managementFailures});
     if(!risk.allowed)return {allowed:false,reason:'ENTRY_CONTROL:'+risk.reasons.join(',')};
     const quote=await gw({action:'quote',market:s.symbol},1500),check=validatePreparedOrder(s,market,quote),book=normalizeEntryBook(quote,1500,Date.now());
     attempt.evidence=entryEvidence(s,{check,quote,authority,timing,orderId:intent.order.id,writer:{owner:currentAccountOwner(db),fence:currentExecutionContext(db)?.fence}});
     attempt.evidence.account={observation:fresh.pf.observation,capacity_basis:fresh.pf.capacity_basis??null,available_quote:fresh.pf.available_quote,
      open_orders_observation:orders.observation??{source:'BINANCE_OPEN_ORDERS_REST',observed_at_ms:orders.observed_at_ms}};
     if(!check.allowed||!book.health.bookHealthy)return {allowed:false,reason:check.reason??'STALE_EXECUTION_BOOK'};
     if(limitPrice<Number(quote.best_ask))return {allowed:false,reason:'LATEST_PRICE_MOVED_ABOVE_LIMIT'};
     if(limitPrice>Number(quote.best_ask)*(1+IOC_MAX_BPS/10000))return {allowed:false,reason:'LATEST_PRICE_CHASE_INVALID'};
     if(quantity*limitPrice/LEV+(position?N(position.original_quantity)*N(position.entry_price)/LEV:0)>MAX_ORDER_MARGIN_USDT+1e-9)return {allowed:false,reason:'ACCOUNT_MARGIN_LIMIT'};
     timing.pre_order_validation=Date.now();return {allowed:true,deterministic:check.execution_state??check.latest,accountEvidence:fresh.pf.observation};
    }}),{correlationId:String(s.id)});
   if(sent.blocked){if(!position)return {entered:false,reason:sent.reason};break;}
   firstIntent??=sent.oi.id;lastAttempt=sent;
   const settled=await settleKnownEntry(db,sent.oi,sent.settledRaw,gw,{existingPosition:position,retireZeroFillSignal:false,registerTarget:false});
   attempt.dispatched=false; // Same-order receipt AND venue exposure were settled; no uncertain remainder.
   position=settled??position;
   filled=position?N(position.original_quantity):0;
   if(position&&NATIVE_STOP_ENABLED){const protect=await installEntryNativeProtection(db,position,gw,pair.manual.map(x=>x.symbol));position=protect.position??position;if(protect.status!=='PROTECTED')break;}
   if(position?.state==='CLOSED'||filled>=targetQuantity-filters.quantityStep/2)break;
  }
  if(!position){const w=await withAccountMutation(db,()=>db.from('v11_long_regime_signals').update({status:'REJECTED',reject_reason:'IOC_NO_FILL',updated_at:new Date().toISOString()}).eq('id',s.id));if(w.error)throw Error('SIGNAL_FINALITY_WRITE');return {entered:false,reason:'IOC_NO_FILL'};}
  const entryProtection=await protectNewLeaderPosition({enabled:NATIVE_STOP_ENABLED,position,manualSymbols:pair.manual.map(x=>x.symbol),readPortfolio:()=>gw({action:'p10_portfolio'}),installNative:(p,c)=>installEntryNativeProtection(db,p,gw,c.manualSymbols),manage:c=>manageLeader(db,c.positionSnapshot??position,{...c,gateway:gw,recoveryOnly:true})});
  return {entered:true,symbol:s.symbol,positionId:position.id,quantity:filled,entryPrice:N(position.entry_price),sizedMarginUsdt:filled*N(position.entry_price)/LEV,entryFinality:lastAttempt?.evidence,entryProtection,executionAttempts:lastAttempt?.evidence?.attemptNo,timing};
 }finally{
  // Ambiguous order exposure remains charged by the durable order, even after a reservation expires.
  await withAccountMutation(db,()=>db.from('leader20_entry_reservations').update({state:position?'FILLED':attempt.dispatched?'ORDER_PENDING':'RELEASED',updated_at:new Date().toISOString()}).eq('id',reservationId).in('state',['RESERVED','ORDER_PENDING']));
 }
}
async function runEntryQueue(db,pair,manual,blockedSymbols=new Set(),backlogComplete=true){
 const ctl=await control(db);if(!ctl.enabled)return {entered:false,reason:'DETERMINISTIC_ENTRY_PAUSED'};
 if(!backlogComplete)return {entered:false,reason:'CLOSED_PROTECTION_BACKLOG_INCOMPLETE'};
 await withAccountMutation(db,()=>db.rpc('deterministic_recover_claims')).then(r=>{if(r.error)throw Error('CLAIM_RECOVERY_UNAVAILABLE');});
 const rows=await db.from('v11_long_regime_signals').select('*').eq('status','NEW').eq('features->deterministic->>version',ENGINE).order('created_at',{ascending:false}).limit(30);
 if(rows.error)throw Error('CANDIDATE_QUEUE_UNAVAILABLE');let cap=admissionCapacity(capacityInputs(pair,null),[]),ledger=[],entries=[];const seen=new Set();
 for(const row of rows.data??[]){
  if(cap.capacity<1||cycleBudgets.get(db).remaining()<24000)break;if(seen.has(row.symbol)||blockedSymbols.has(row.symbol))continue;seen.add(row.symbol);
 const result=await (async()=>{
 const claimContext={analysis_owner:currentExecutionContext(db)?.owner,claimed_at_ms:Date.now()};
 const claim=await withAccountMutation(db,()=>db.from('v11_long_regime_signals').update({status:'CLAIMED',features:{...row.features,executionClaim:claimContext},updated_at:new Date().toISOString()}).eq('id',row.id).eq('status','NEW').select('*').maybeSingle());if(claim.error)throw Error('SIGNAL_CLAIM_FAILED');if(!claim.data)return null;
  const attempt={dispatched:false};let result;
  try{result=await openBull(db,claim.data,pair.positions,manual,attempt,pair.managementFailures??[]);}
  catch(e){if(classifyFailure(e).fatal||attempt.dispatched)throw e;const context=currentExecutionContext(db),cause=context?.signal?.aborted?String(context.signal.reason?.message??context.signal.reason):null;
   const reason=cause??String(e.message??e),rateLimited=/GW_(418|429)|BINANCE_(IP_BANNED|RATE_LIMITED|WEIGHT_BUDGET)|LOCAL_RATE_GUARD/.test(reason);result={entered:false,reason,releaseScope:rateLimited?RELEASE_SCOPE.ACCOUNT:RELEASE_SCOPE.SYMBOL};attempt.evidence??=entryEvidence(row,{authority:e.authority,reason:result.reason});
   attempt.evidence.failure={name:e.name??'Error',message:String(e.message??e).slice(0,500),cause,stage:e.entryStage??null,gateway_action:e.gatewayAction??null,
    transport_started_at_ms:e.transportStartedAt??null,transport_failed_at_ms:e.transportFailedAt??null,transport_timeout_ms:e.transportTimeoutMs??null,at_ms:Date.now()};}
  if(!result.entered){
   const reason=result.reason??'ENTRY_CANCELLED';const evidence={...attempt.evidence,reason,category:cancellationCategory(reason,attempt.evidence?.latest),cancelled_at_ms:Date.now()};
   const retire=await withAccountMutation(db,()=>db.from('v11_long_regime_signals').update({status:'REJECTED',reject_reason:reason.slice(0,500),features:{...row.features,entryExecution:evidence},updated_at:new Date().toISOString()}).eq('id',row.id).eq('status','CLAIMED'));if(retire.error)throw Error('NO_ORDER_TERMINAL_WRITE');
  }
  return result;
 })().catch(e=>{if(e?.writerDeferred)return {entered:false,reason:e.message,deferred:true};throw e;});
 if(!result)continue;entries.push(result);
 if(!result.entered){if(result.deferred||result.releaseScope===RELEASE_SCOPE.ACCOUNT)break;continue;}
  ledger.push(ledgerEntry(result,Date.now()));cap=admissionCapacity(await refreshCapacityInputs(db),ledger);
 }
 return {entered:entries.some(x=>x.entered),entryCount:entries.filter(x=>x.entered).length,entries,reason:entries.length?entries.at(-1).reason??null:'NO_DETERMINISTIC_BUY',capacity:cap};
}
async function run(db,{recoveryReady=true}={}){
 const started=Date.now();await verifyExecutionLease(db);let pair=await executorStage('initial_account',()=>readOpsPair(db)),managed=[],protectedIds=new Set();const initialIncidents=await recordMismatch(db,pair.match);
 const controls=await opsControls(db);
 if(controls.settings.manual_intervention_required||controls.settings.emergency_liquidation)return {ok:true,skipped:'OPERATOR_MANAGEMENT_OWNERSHIP'};
 // Position safety owns the first turn and is independent from universe/entry/capture authority.
 const work=await boundedMap(pair.match.safe,3,async p=>{
  const gw=scopedGateway(db,createBudget({ms:12000,calls:25})),fresh=await readOpsPair(db,gw),owned=fresh.match.safe.find(x=>x.id===p.id);
  if(!owned)return {symbol:p.symbol,skipped:'OWNERSHIP_CHANGED'};
  const action=await manageLeader(db,owned,{gateway:gw,cleanupGateway:scopedGateway(db,createBudget({ms:5000,calls:10})),manualSymbols:fresh.manual.map(x=>x.symbol),quoteRetryBudget:{remaining:1}});
  if(action.nativeStop?.status==='PROTECTED')protectedIds.add(p.id);return {id:p.id,symbol:p.symbol,action};
 });
 managed=work.map((x,i)=>x.error?{id:pair.match.safe[i].id,symbol:pair.match.safe[i].symbol,error:String(x.error.message??x.error)}:x.value);
 for(const x of work)if(x.error&&classifyFailure(x.error).fatal)throw x.error;
 if(work.length||initialIncidents.length)pair=await executorStage('post_management_account',()=>readOpsPair(db));
 const reconciliation=await executorStage('reconciliation',()=>reconcileOps(db,pair));
 if(reconciliation.length)pair=await executorStage('post_reconciliation_account',()=>readOpsPair(db));
 await recordMismatch(db,pair.match);
 const symbolRecovery=await executorStage('symbol_recovery',()=>attemptSymbolRecoveries(db,pair)),recovery=await executorStage('account_recovery',()=>attemptOpsRecovery(db,pair,protectedIds)),current=await opsControls(db);
 let entry={entered:false,reason:'ENTRY_ACCOUNT_BLOCKED'};
 if(recoveryReady&&!current.runtime.circuit_open&&operatorAllowsRecovery(current.runtime,current.control,current.settings)){
  pair.managementFailures=managed.filter(x=>x.error);const backlog=await readClosedProtectionBacklog(db,1000);
  entry=await executorStage('entry_queue',()=>runEntryQueue(db,pair,pair.manual,new Set(backlog.rows.map(p=>p.symbol)),backlog.complete));
 }
 pair=await executorStage('final_account',()=>readOpsPair(db));
 const at=new Date().toISOString(),health=managed.some(x=>x.error)||!pair.match.ok?'DEGRADED':pair.positions.length===0?'FLAT':
  pair.positions.every(p=>p.metadata?.exitProtection?.health==='PROTECTED'&&(p.metadata.exitProtection.orders??[]).some(o=>!o.terminal&&['ACTIVE','NEW'].includes(o.status)))?'PROTECTED':'SOFTWARE_ONLY';
 const heartbeat={last_cycle_started_at:new Date(started).toISOString(),last_cycle_completed_at:at,last_entry_evaluated_at:at,
  last_account_evidence_at:new Date(pair.pf.observation.requested_at_ms).toISOString(),protection_health:health,entry_block_reason:entry.entered?null:entry.reason,
  ...(managed.length&&!managed.some(x=>x.error)?{last_management_success_at:at}:{}),...(health==='PROTECTED'?{last_position_protection_success_at:at}:{}),...(entry.entered?{last_entry_at:at}:{}),updated_at:at};
 await writeRuntimeTelemetry(db,heartbeat,['FLAT','PROTECTED'].includes(health),at);
 return {ok:true,patch:PATCH,authority:ENGINE,managed,reconciliation,entry,recovery,symbolRecovery,protectionHealth:health,total_runtime_ms:Date.now()-started};
}
async function executorStage(stage,operation){
 const started=Date.now();let outcome='FAILED';
 try{const result=await operation();outcome='SUCCEEDED';return result;}
 finally{console.log(JSON.stringify({event:'DETERMINISTIC_EXECUTOR_STAGE',stage,outcome,duration_ms:Date.now()-started}));}
}
async function writeRuntimeTelemetry(db,heartbeat,successful,at){
 await withAccountMutation(db,async()=>{
  const wr=await db.from('v11_long_regime_runtime').update(heartbeat).eq('singleton',true);if(wr.error)throw Error('HEARTBEAT_WRITE');
  const diagnostic=successful?{last_error:null,last_success_at:at}:{last_error:'DETERMINISTIC_CYCLE_DEGRADED'};
  const dr=await db.from('v11_long_regime_runtime').update(diagnostic).eq('singleton',true).eq('circuit_open',false);if(dr.error)throw Error('HEARTBEAT_DIAGNOSTIC_WRITE');
 });
}
Deno.serve(async req=>{
 if(req.method!=='POST')return res(405,{ok:false,error:'POST_ONLY'});
 const url=env('SUPABASE_URL'),key=env('SUPABASE_SERVICE_ROLE_KEY');let db;
 db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(url,init={})=>{
 const context=assertActiveExecutionRequest(db);
 if(context?.kind==='CLEANUP'&&!/\/rpc\/v17_release_((execution|analysis)_lease|writer)$/.test(new URL(String(url)).pathname))throw Error('LEASE_CLEANUP_RPC_ONLY');
 const headers=new Headers(init.headers),owner=leaseOwners.get(db);
 for(const [name,value]of Object.entries(executionContextHeaders(db)))headers.set(name,value);
 if(owner)headers.set('x-v18-execution-owner',owner);
 return fetch(url,{...init,headers,signal:AbortSignal.any([AbortSignal.timeout(2500),...(init.signal?[init.signal]:[]),...(context?.signal?[context.signal]:[])])});
 }}});
 const authenticated=await auth(db,req);
 if(!authenticated.allowed){if(authenticated.status===503)console.error(authenticated.error);return res(authenticated.status,{ok:false,error:authenticated.error});}
 const body=await req.json().catch(()=>({})),mode=String(body.mode??'run').toLowerCase();
 try{
  if(['run','execute'].includes(mode)){
   const admission=await admitSchedulerRequest({endpoint:'v10-lane-executor',body,rpc:(name,args)=>db.rpc(name,args)});
   if(!admission.allowed)return res(200,{ok:true,skipped:admission.reason});
  }
  if(['preflight','diagnostic','ops-readiness'].includes(mode)){
   const symbol=String(body.symbol??'BTCUSDT'),[pf,info,quote,controls,ctl,universe,modeTruth]=await Promise.all([gateway({action:'p10_portfolio'},3000),gateway({action:'symbol_info',market:symbol},2500),gateway({action:'quote',market:symbol},2500),opsControls(db),control(db),db.rpc('deterministic_universe'),gateway({action:'futures_position_mode'},2000)]);
   const sizing=sizeEntry(Number(quote.best_ask),Number(info.quantity_step??info.step_size),symbolFilters(info));
   return res(200,{ok:true,patch:PATCH,authority:ENGINE,entry_enabled:ctl.enabled,maxSlots:MAX_SLOTS,hard_stop_pct:POLICY.stopPct,native_stop_enabled:NATIVE_STOP_ENABLED,
    sizingContract:SLOT_SIZING_CONTRACT,sizing,externalPositions:active(pf).map(x=>({symbol:sym(x),quantity:qty(x)})),positions_complete:pf.positions_complete,account_evidence:pf.observation,
    available_quote:pf.available_quote,position_mode:{supported:supportedFuturesMode(modeTruth),mode:modeTruth.position_mode},universe:universe.data,controls:{runtime:controls.runtime,operator:controls.control},
    decision_dependencies:['market_data','completed_candles','deterministic_state','capacity','execution_lease','exchange_truth'],provider_calls:0});
  }
  if(!['run','execute','account-recovery'].includes(mode))return res(400,{ok:false,error:'RETIRED_OR_INVALID_MODE'});
  await loadAccountExecutionMode(db);
  if(mode==='account-recovery'){
   if(!shortAccountWriter(db))return res(503,{ok:false,error:'SHORT_WRITER_REQUIRED'});
   const ready=await accountHostScopes.get(db).critical(db,()=>ensureShortWriterRecovery(db));
   return res(200,{ok:true,ready:ready===true,authority:ENGINE,entry_attempted:false});
  }
  return res(200,shortAccountWriter(db)?await accountHostScopes.get(db).periodic(async()=>{const recovered=await executorStage('short_writer_recovery',()=>ensureShortWriterRecovery(db));return run(db,{recoveryReady:recovered});}):await runWithLease(db,async()=>{const recovered=await ensureShortWriterRecovery(db);return run(db,{recoveryReady:recovered});}));
 }catch(e){console.error('DETERMINISTIC_EXECUTOR_ERROR',String(e.message??e));return res(503,{ok:false,patch:PATCH,error:String(e.message??e)});}
});

async function hashJson(value){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));return [...new Uint8Array(b)].map(v=>v.toString(16).padStart(2,'0')).join('');}

async function ensureShortWriterRecovery(db){
  const readiness=await db.rpc("v17_account_recovery_state");
  if(readiness.error)throw Error("ACCOUNT_RECOVERY_READINESS_UNAVAILABLE");
  if(readiness.data?.ready===true)return true;
  if(shortAccountWriter(db)&&!currentAccountOwner(db))return withAccountMutation(db,()=>ensureShortWriterRecovery(db));
  const gw=recoveryGateway(db);
  // Observe the venue before touching ambiguous identities; the existing reconciler
  // queries original IDs only and never creates another BUY.
  await gw({action:"v18_open_orders"},5000);
  let pair=await readOpsPair(db,gw);
  await reconcileOps(db,{...pair,recoveryOnly:true});
  pair=await readOpsPair(db,gw);
  for(const p of pair.match.safe){
    const protectedNow=await installEntryNativeProtection(db,p,gw,pair.manual.map(x=>x.symbol));
    if(protectedNow.status==="RESIDENT_EXIT_REQUIRED")await manageLeader(db,protectedNow.position,
      {gateway:gw,recoveryOnly:true,evaluateQv3:false,exchangeQuantity:new Map([[p.symbol,Number(p.remaining_quantity)]]),manualSymbols:pair.manual.map(x=>x.symbol)});
  }
  pair=await readOpsPair(db,gw);const live=await gw({action:"v18_open_orders"},5000);
  if(!pair.match.ok||riskOrders(pair.orders).length||!confirmedLiveProtection(live,pair.positions,Date.now(),{manual:pair.manual,exchangePositions:pair.pf.positions}))return false;
  const recovered=await db.rpc("v17_record_account_recovery",{p_owner:leaseOwners.get(db),
    p_postmaster:readiness.data.postmaster_at,p_positions:pair.positions.map(p=>({id:p.id,updated_at:p.updated_at,quantity:p.remaining_quantity})),
    p_observed_at:new Date(live.observed_at_ms).toISOString()});
  if(recovered.error)throw Error("ACCOUNT_RECOVERY_COMMIT_UNAVAILABLE");return recovered.data===true;
}
