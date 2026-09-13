/**
 * Scope-aware operational entry control.
 *
 * This module is deliberately pure.  It never opens/closes a circuit, writes an
 * incident, or submits an order.  The executor uses the same decision at queue
 * admission and immediately before persisting an order intent.
 */
export const ENTRY_CONTROL_VERSION='V19-SCOPE-AWARE-ENTRY-1';
export const EXPOSURE_STATE=Object.freeze({HELD:'HELD',FLAT:'FLAT',UNKNOWN:'UNKNOWN'});
export const ACCOUNTING_STATE=Object.freeze({SETTLED:'SETTLED',FILL_DETAILS_PENDING:'FILL_DETAILS_PENDING',
  ATTRIBUTION_INVESTIGATING:'ATTRIBUTION_INVESTIGATING',CONFLICT:'CONFLICT'});
export const ORDER_SOURCE=Object.freeze({BOT:'BOT',MANUAL_EXTERNAL:'MANUAL_EXTERNAL',
  EXCHANGE_FORCED:'EXCHANGE_FORCED',UNKNOWN:'UNKNOWN'});
export const CONTROL_SCOPE=Object.freeze({NORMAL:'NORMAL',SYMBOL_QUARANTINE:'SYMBOL_QUARANTINE',
  DIAGNOSTIC_ONLY:'DIAGNOSTIC_ONLY',ACCOUNT_ENTRY_HOLD:'ACCOUNT_ENTRY_HOLD',
  ACCOUNT_RISK_BLOCK:'ACCOUNT_RISK_BLOCK',OPERATOR_HALT:'OPERATOR_HALT'});

const upper=x=>String(x??'').trim().toUpperCase();
const number=x=>Number(x);
const finite=x=>Number.isFinite(number(x));
const quantity=x=>Math.abs(number(x?.quantity??x?.positionAmt??x?.position_amount));
const symbol=x=>upper(x?.symbol??x?.market);
const pending=o=>['PLANNED','DISPATCHED','RECONCILIATION_PENDING','RECONCILIATION_FAILED'].includes(o?.state);
const exposurePending=o=>pending(o)&&o?.response_payload?.v18ExposureFinal!==true;
const accountingPending=o=>['RECONCILIATION_PENDING','RECONCILIATION_FAILED'].includes(o?.state)&&
  o?.response_payload?.v18ExposureFinal===true;
const close=(a,b)=>finite(a)&&finite(b)&&Math.abs(number(a)-number(b))<=Math.max(1e-10,Math.abs(number(b))*1e-8);

export function operationalIssue(issue={}) {
  const kind=upper(issue.kind),hasSymbol=!!upper(issue.symbol);
  if(kind==='INCOMPLETE_OR_STALE_SNAPSHOT')return {controlScope:CONTROL_SCOPE.ACCOUNT_ENTRY_HOLD,
    exposureState:EXPOSURE_STATE.UNKNOWN,accountingState:ACCOUNTING_STATE.ATTRIBUTION_INVESTIGATING,orderSource:ORDER_SOURCE.UNKNOWN,
    recheck:['FRESH_COMPLETE_ACCOUNT_SNAPSHOT','FRESH_COMPLETE_OPEN_ORDERS']};
  if(kind==='UNKNOWN_ORDER_OUTCOME')return {controlScope:CONTROL_SCOPE.ACCOUNT_ENTRY_HOLD,
    exposureState:EXPOSURE_STATE.UNKNOWN,accountingState:ACCOUNTING_STATE.ATTRIBUTION_INVESTIGATING,
    orderSource:issue.orderId?ORDER_SOURCE.BOT:ORDER_SOURCE.UNKNOWN,
    recheck:['QUERY_SAME_ORDER_IDENTITY','FRESH_COMPLETE_ACCOUNT_SNAPSHOT','FRESH_COMPLETE_OPEN_ORDERS']};
  if(kind==='EXCHANGE_ONLY_POSITION')return {controlScope:CONTROL_SCOPE.ACCOUNT_RISK_BLOCK,
    exposureState:EXPOSURE_STATE.HELD,accountingState:ACCOUNTING_STATE.ATTRIBUTION_INVESTIGATING,orderSource:ORDER_SOURCE.UNKNOWN,
    recheck:['PROVE_POSITION_SOURCE','PROVE_ACCOUNT_RISK_BOUND','FRESH_COMPLETE_OPEN_ORDERS']};
  if(kind==='KNOWN_EXIT_PENDING_RECONCILIATION')return {controlScope:hasSymbol?CONTROL_SCOPE.SYMBOL_QUARANTINE:CONTROL_SCOPE.ACCOUNT_ENTRY_HOLD,
    exposureState:issue.exchangeQuantity==null?EXPOSURE_STATE.FLAT:EXPOSURE_STATE.HELD,
    accountingState:ACCOUNTING_STATE.ATTRIBUTION_INVESTIGATING,orderSource:ORDER_SOURCE.BOT,
    recheck:['SETTLE_EXACT_ORDER_LIFECYCLE','FRESH_COMPLETE_ACCOUNT_SNAPSHOT','FRESH_COMPLETE_OPEN_ORDERS']};
  if(kind==='DB_ONLY_POSITION')return {controlScope:hasSymbol?CONTROL_SCOPE.SYMBOL_QUARANTINE:CONTROL_SCOPE.ACCOUNT_ENTRY_HOLD,
    exposureState:EXPOSURE_STATE.FLAT,accountingState:ACCOUNTING_STATE.ATTRIBUTION_INVESTIGATING,orderSource:ORDER_SOURCE.UNKNOWN,
    recheck:['PROVE_EXIT_ATTRIBUTION','SETTLE_EXACT_TRADES_AND_FEES','FRESH_COMPLETE_ACCOUNT_SNAPSHOT']};
  if(kind==='QUANTITY_MISMATCH')return {controlScope:hasSymbol?CONTROL_SCOPE.SYMBOL_QUARANTINE:CONTROL_SCOPE.ACCOUNT_ENTRY_HOLD,
    exposureState:finite(issue.exchangeQuantity)?(number(issue.exchangeQuantity)>0?EXPOSURE_STATE.HELD:EXPOSURE_STATE.FLAT):EXPOSURE_STATE.UNKNOWN,
    accountingState:ACCOUNTING_STATE.ATTRIBUTION_INVESTIGATING,
    orderSource:issue.knownExitPending?ORDER_SOURCE.BOT:ORDER_SOURCE.UNKNOWN,
    recheck:['SETTLE_EXACT_QUANTITY_DELTA','FRESH_COMPLETE_ACCOUNT_SNAPSHOT','FRESH_COMPLETE_OPEN_ORDERS']};
  if(kind==='IDENTITY_OR_SIDE_MISMATCH')return {controlScope:hasSymbol?CONTROL_SCOPE.SYMBOL_QUARANTINE:CONTROL_SCOPE.ACCOUNT_RISK_BLOCK,
    exposureState:finite(issue.exchangeQuantity)?(number(issue.exchangeQuantity)>0?EXPOSURE_STATE.HELD:EXPOSURE_STATE.FLAT):EXPOSURE_STATE.UNKNOWN,
    accountingState:ACCOUNTING_STATE.CONFLICT,orderSource:ORDER_SOURCE.UNKNOWN,
    recheck:['PROVE_ACCOUNT_EXCHANGE_SYMBOL_LIFECYCLE','PROVE_PROTECTION_OR_FLAT']};
  if(kind==='ACCOUNTING_DETAILS_PENDING')return {controlScope:hasSymbol?CONTROL_SCOPE.SYMBOL_QUARANTINE:CONTROL_SCOPE.ACCOUNT_ENTRY_HOLD,
    exposureState:issue.exposureState??EXPOSURE_STATE.UNKNOWN,accountingState:ACCOUNTING_STATE.FILL_DETAILS_PENDING,
    orderSource:ORDER_SOURCE.BOT,recheck:['LOAD_EXACT_TRADES_AND_FEES','VERIFY_ORDER_LIFECYCLE']};
  return {controlScope:CONTROL_SCOPE.ACCOUNT_RISK_BLOCK,exposureState:EXPOSURE_STATE.UNKNOWN,
    accountingState:ACCOUNTING_STATE.CONFLICT,orderSource:ORDER_SOURCE.UNKNOWN,
    recheck:['OPERATOR_REVIEW','FRESH_COMPLETE_ACCOUNT_SNAPSHOT','FRESH_COMPLETE_OPEN_ORDERS']};
}

export function accountingIssue(order,portfolioPositions=[]) {
  if(!accountingPending(order))return null;
  const s=upper(order.symbol),held=(portfolioPositions??[]).some(x=>symbol(x)===s&&quantity(x)>1e-12);
  return {kind:'ACCOUNTING_DETAILS_PENDING',symbol:s,positionId:order.position_id??null,orderId:order.id??null,
    clientOrderId:order.client_order_id??null,exchange:'binance_futures',accountScope:'futures',
    ...operationalIssue({kind:'ACCOUNTING_DETAILS_PENDING',symbol:s,
      exposureState:held?EXPOSURE_STATE.HELD:EXPOSURE_STATE.FLAT})};
}

export function freshAccountEvidence(portfolio,now=Date.now(),maxAgeMs=3000) {
  const o=portfolio?.observation;
  return portfolio?.exchange==='binance_futures'&&portfolio?.account_scope==='futures'&&
    portfolio?.positions_complete===true&&Array.isArray(portfolio.positions)&&!!o?.id&&
    o.source==='BINANCE_ACCOUNT_REST'&&finite(o.requested_at_ms)&&finite(o.received_at_ms)&&
    number(o.requested_at_ms)<=number(o.received_at_ms)&&now-number(o.requested_at_ms)<=maxAgeMs&&
    now-number(o.received_at_ms)>=-1000;
}

export function freshOpenOrderEvidence(openOrders,now=Date.now(),maxAgeMs=5000) {
  return openOrders?.complete===true&&Array.isArray(openOrders.orders)&&Array.isArray(openOrders.algos)&&
    finite(openOrders.observed_at_ms)&&now-number(openOrders.observed_at_ms)<=maxAgeMs&&
    now-number(openOrders.observed_at_ms)>=-1000;
}

function expectedStops(positions=[]) {
  const out=new Map();
  for(const p of positions)for(const o of p?.metadata?.exitProtection?.orders??[]){
    const id=String(o?.clientId??o?.spec?.params?.clientAlgoId??'');
    if(id&&o?.terminal!==true)out.set(id,{position:p,order:o,params:o.spec?.params??{}});
  }
  return out;
}
function exactProtectiveAlgo(algo,expected,actualQuantity) {
  const p=expected?.params??{},ackId=String(algo?.clientAlgoId??algo?.clientOrderId??'');
  const requested=number(p.quantity),reported=number(algo?.quantity??algo?.origQty??requested);
  return !!expected&&ackId===String(expected.order.clientId??p.clientAlgoId)&&symbol(algo)===upper(p.symbol)&&
    upper(algo?.side)==='SELL'&&upper(algo?.positionSide)==='BOTH'&&String(algo?.reduceOnly)==='true'&&
    upper(algo?.orderType??algo?.type)==='STOP_MARKET'&&['NEW','ACTIVE'].includes(upper(algo?.algoStatus??algo?.status))&&
    String(algo?.algoId??'')===String(expected.order.algoId??'')&&finite(requested)&&requested>0&&
    finite(reported)&&reported>0&&requested+Math.max(1e-10,requested*1e-8)>=actualQuantity;
}

function decision(scope,reasons,evidence,recheck,extra={}) {
  return {allowed:scope===CONTROL_SCOPE.NORMAL,scope,reasons:[...new Set(reasons)],evidence,
    recheck:[...new Set(recheck)],...extra};
}

/**
 * Fail closed on account-wide uncertainty, but do not promote a bounded issue on
 * another symbol to an account circuit.  Every live exposure and conditional order
 * is included before an unrelated candidate can pass.
 */
export function evaluateEntryDecision({candidateSymbol,classification={issues:[],accounting:[]},portfolio,
  openOrders,positions=[],orders=[],quarantines=[],manualSymbols=[],runtime={},operator={},settings={},
  managementFailures=[],maxSlots=10,proposedMargin=0,cashBuffer=0,requireNativeProtection=true,now=Date.now()}={}) {
  const candidate=upper(candidateSymbol),reasons=[],recheck=[];
  const evidence={version:ENTRY_CONTROL_VERSION,evaluatedAt:now,candidateSymbol:candidate,
    accountObservationId:portfolio?.observation?.id??null,accountRequestedAtMs:portfolio?.observation?.requested_at_ms??null,
    accountReceivedAtMs:portfolio?.observation?.received_at_ms??null,ordersObservedAtMs:openOrders?.observed_at_ms??null,
    dbVersion:[...positions,...orders].map(x=>String(x?.updated_at??'')).sort().at(-1)??null};
  const operatorStopped=runtime?.live_enabled!==true||operator?.entry_enabled!==true||operator?.legacy_entries_retired!==true||
    settings?.mode!=='LIVE_LIMITED'||['pause_new_entries','withdrawal_mode','manual_intervention_required','scalp_kill_switch','emergency_liquidation']
      .some(k=>settings?.[k]!==false)||settings?.pause_lock_reason!=null;
  if(operatorStopped)return decision(CONTROL_SCOPE.OPERATOR_HALT,['OPERATOR_ENTRY_CONTROL'],evidence,['OPERATOR_EXPLICIT_RELEASE']);
  if(runtime?.circuit_open===true)return decision(CONTROL_SCOPE.ACCOUNT_RISK_BLOCK,
    [`ACCOUNT_CIRCUIT:${runtime.incident_kind??'UNKNOWN'}`],evidence,['RESOLVE_EXACT_ACCOUNT_INCIDENT_GENERATION']);
  if(!candidate)return decision(CONTROL_SCOPE.ACCOUNT_ENTRY_HOLD,['CANDIDATE_SYMBOL_MISSING'],evidence,['VALID_CANDIDATE_SYMBOL']);
  if(!freshAccountEvidence(portfolio,now))return decision(CONTROL_SCOPE.ACCOUNT_ENTRY_HOLD,
    ['ACCOUNT_EVIDENCE_INCOMPLETE_OR_STALE'],evidence,['FRESH_COMPLETE_ACCOUNT_SNAPSHOT']);
  if(!freshOpenOrderEvidence(openOrders,now))return decision(CONTROL_SCOPE.ACCOUNT_ENTRY_HOLD,
    ['OPEN_ORDER_EVIDENCE_INCOMPLETE_OR_STALE'],evidence,['FRESH_COMPLETE_OPEN_ORDERS']);

  const issues=[...(classification.issues??[])],accounting=[...(classification.accounting??[])];
  const accountIssues=issues.filter(x=>[CONTROL_SCOPE.ACCOUNT_ENTRY_HOLD,CONTROL_SCOPE.ACCOUNT_RISK_BLOCK].includes(x.controlScope));
  if(accountIssues.length){const hard=accountIssues.some(x=>x.controlScope===CONTROL_SCOPE.ACCOUNT_RISK_BLOCK);
    return decision(hard?CONTROL_SCOPE.ACCOUNT_RISK_BLOCK:CONTROL_SCOPE.ACCOUNT_ENTRY_HOLD,
      accountIssues.map(x=>`${x.kind}:${x.symbol||'ACCOUNT'}`),evidence,accountIssues.flatMap(x=>x.recheck??[]));}
  if(orders.some(exposurePending))return decision(CONTROL_SCOPE.ACCOUNT_ENTRY_HOLD,
    orders.filter(exposurePending).map(x=>`PENDING_ORDER_IDENTITY:${x.id}`),evidence,
    ['QUERY_SAME_ORDER_IDENTITY','FRESH_COMPLETE_ACCOUNT_SNAPSHOT','FRESH_COMPLETE_OPEN_ORDERS']);

  const targetIssues=issues.filter(x=>upper(x.symbol)===candidate),targetAccounting=accounting.filter(x=>upper(x.symbol)===candidate);
  const activeQuarantines=(quarantines??[]).filter(x=>['OPEN','VERIFYING'].includes(x.status));
  const targetQuarantines=activeQuarantines.filter(x=>upper(x.symbol)===candidate);
  if(targetIssues.length||targetAccounting.length||targetQuarantines.length)return decision(CONTROL_SCOPE.SYMBOL_QUARANTINE,
    [...targetIssues.map(x=>`${x.kind}:${candidate}`),...targetAccounting.map(x=>`ACCOUNTING_DETAILS_PENDING:${candidate}`),
      ...targetQuarantines.map(x=>`ACTIVE_QUARANTINE:${x.kind}:${candidate}`)],evidence,
    [...targetIssues,...targetAccounting,...targetQuarantines].flatMap(x=>x.recheck??x.recheck_conditions??[]),
    {symbol:candidate});

  const portfolioRows=portfolio.positions.filter(x=>quantity(x)>1e-12),seen=new Set();let invalidRisk=false;
  for(const x of portfolioRows){const s=symbol(x);if(!s||seen.has(s)||!['LONG','SHORT'].includes(upper(x.side))||
    !finite(quantity(x))||!(quantity(x)>0)||!finite(x.entry_price)||!(number(x.entry_price)>0)||
    !finite(x.leverage)||!(number(x.leverage)>0)||!finite(x.initial_margin_quote)||number(x.initial_margin_quote)<0)invalidRisk=true;seen.add(s);}
  if(!finite(portfolio.available_quote)||!finite(portfolio.total_equity_quote)||!finite(portfolio.total_initial_margin_quote)||invalidRisk)
    return decision(CONTROL_SCOPE.ACCOUNT_ENTRY_HOLD,['ACCOUNT_RISK_BOUND_UNPROVEN'],evidence,
      ['FRESH_COMPLETE_MARGIN_AND_POSITION_EVIDENCE']);
  if(seen.has(candidate))return decision(CONTROL_SCOPE.SYMBOL_QUARANTINE,[`LIVE_EXPOSURE_EXISTS:${candidate}`],evidence,
    ['CONFIRM_SYMBOL_FLAT_OR_CLOSE_EXISTING_LIFECYCLE'],{symbol:candidate});
  if(seen.size>=maxSlots)return decision(CONTROL_SCOPE.ACCOUNT_ENTRY_HOLD,['ACCOUNT_SLOT_LIMIT'],evidence,['ACCOUNT_SLOT_AVAILABLE']);
  if(!finite(proposedMargin)||number(proposedMargin)<0||!finite(cashBuffer)||number(cashBuffer)<0||
    number(portfolio.available_quote)+1e-9<number(proposedMargin)+number(cashBuffer))
    return decision(CONTROL_SCOPE.ACCOUNT_ENTRY_HOLD,['ACCOUNT_MARGIN_LIMIT'],evidence,['SUFFICIENT_VERIFIED_AVAILABLE_MARGIN']);

  // An ordinary open order can change exposure.  This executor has no persistent
  // resting entry order, so every such row requires same-identity reconciliation.
  if(openOrders.orders.length)return decision(CONTROL_SCOPE.ACCOUNT_ENTRY_HOLD,
    openOrders.orders.map(x=>`LIVE_ORDINARY_ORDER:${symbol(x)||'UNKNOWN'}:${x.clientOrderId??x.orderId??'UNKNOWN'}`),evidence,
    ['RECONCILE_EVERY_LIVE_ORDINARY_ORDER_IDENTITY']);

  const expected=expectedStops(positions),manual=new Set((manualSymbols??[]).map(upper)),unmatched=[],matched=new Set();
  for(const algo of openOrders.algos){
    const id=String(algo?.clientAlgoId??algo?.clientOrderId??''),e=expected.get(id),actual=portfolioRows.find(x=>symbol(x)===symbol(algo));
    if(e&&exactProtectiveAlgo(algo,e,actual?quantity(actual):0)){matched.add(id);continue;}
    const local=String(algo?.reduceOnly)==='true'&&upper(algo?.side)==='SELL'&&!!symbol(algo);
    unmatched.push({scope:local?CONTROL_SCOPE.SYMBOL_QUARANTINE:CONTROL_SCOPE.ACCOUNT_RISK_BLOCK,symbol:symbol(algo),id});
  }
  if(unmatched.some(x=>x.scope===CONTROL_SCOPE.ACCOUNT_RISK_BLOCK))return decision(CONTROL_SCOPE.ACCOUNT_RISK_BLOCK,
    unmatched.map(x=>`UNBOUNDED_CONDITIONAL_ORDER:${x.symbol||'UNKNOWN'}:${x.id||'UNKNOWN'}`),evidence,
    ['PROVE_OR_CANCEL_UNKNOWN_CONDITIONAL_ORDER']);
  if(unmatched.some(x=>x.symbol===candidate))return decision(CONTROL_SCOPE.SYMBOL_QUARANTINE,
    unmatched.filter(x=>x.symbol===candidate).map(x=>`UNMATCHED_REDUCE_ONLY_ORDER:${candidate}:${x.id||'UNKNOWN'}`),evidence,
    ['PROVE_OR_CANCEL_SYMBOL_CONDITIONAL_ORDER'],{symbol:candidate});

  // A transient manager error need not block unrelated entry when the affected live
  // exposure is independently bounded by its exact active exchange-resident stop.
  // Software-only protection cannot provide that independent proof after its manager
  // just failed, so that case remains an account risk block.
  const failedUnbounded=(managementFailures??[]).filter(f=>{
    const p=positions.find(x=>String(x?.id)===String(f?.id)),actual=p&&portfolioRows.find(x=>symbol(x)===upper(p.symbol));
    if(!p||!actual)return false;
    return !(p.metadata?.exitProtection?.orders??[]).some(o=>o.terminal!==true&&
      matched.has(String(o.clientId??o.spec?.params?.clientAlgoId??'')));
  });
  if(failedUnbounded.length)return decision(CONTROL_SCOPE.ACCOUNT_RISK_BLOCK,
    failedUnbounded.map(x=>`POSITION_MANAGEMENT_UNBOUNDED:${upper(x.symbol)||x.id}`),evidence,
    ['RETRY_POSITION_MANAGEMENT','VERIFY_CURRENT_POSITION_PROTECTION']);

  if(requireNativeProtection){
    const dbBySymbol=new Map(positions.map(p=>[upper(p.symbol),p]));
    const unprotected=portfolioRows.filter(x=>!manual.has(symbol(x))).filter(x=>{
      const p=dbBySymbol.get(symbol(x));if(!p)return !issues.some(i=>upper(i.symbol)===symbol(x));
      return !(p.metadata?.exitProtection?.orders??[]).some(o=>o.terminal!==true&&matched.has(String(o.clientId??o.spec?.params?.clientAlgoId??'')));
    });
    if(unprotected.length)return decision(CONTROL_SCOPE.ACCOUNT_RISK_BLOCK,
      unprotected.map(x=>`LIVE_POSITION_PROTECTION_UNPROVEN:${symbol(x)}`),evidence,
      ['VERIFY_CURRENT_POSITION_PROTECTION']);
  }

  return decision(CONTROL_SCOPE.NORMAL,[],evidence,[],{
    risk:{liveExposureSlots:seen.size,freeSlots:maxSlots-seen.size,totalInitialMargin:Number(portfolio.total_initial_margin_quote),
      availableQuote:Number(portfolio.available_quote),reservedUnknownOrderMargin:0,
      quarantinedSymbols:[...new Set(activeQuarantines.map(x=>upper(x.symbol)).filter(Boolean))],
      accountingPendingSymbols:[...new Set(accounting.map(x=>upper(x.symbol)).filter(Boolean))]},
    discoveredQuarantines:unmatched.filter(x=>x.scope===CONTROL_SCOPE.SYMBOL_QUARANTINE)
      .map(x=>({kind:'IDENTITY_OR_SIDE_MISMATCH',symbol:x.symbol,orderId:x.id,
        exposureState:portfolioRows.some(p=>symbol(p)===x.symbol)?EXPOSURE_STATE.HELD:EXPOSURE_STATE.FLAT,
        accountingState:ACCOUNTING_STATE.ATTRIBUTION_INVESTIGATING,orderSource:ORDER_SOURCE.UNKNOWN,
        recheck:['PROVE_OR_CANCEL_SYMBOL_CONDITIONAL_ORDER']}))});
}

export function symbolRecoveryEvidence({incident,classification,portfolio,openOrders,positions=[],orders=[],now=Date.now()}={}) {
  const s=upper(incident?.symbol),expected=expectedStops(positions),liveForSymbol=(openOrders?.orders??[]).filter(x=>symbol(x)===s),
    algos=(openOrders?.algos??[]).filter(x=>symbol(x)===s),portfolioRow=(portfolio?.positions??[]).find(x=>symbol(x)===s);
  const algoClean=algos.every(a=>{const e=expected.get(String(a?.clientAlgoId??a?.clientOrderId??''));return e&&exactProtectiveAlgo(a,e,portfolioRow?quantity(portfolioRow):0);});
  const clean=!!s&&freshAccountEvidence(portfolio,now)&&freshOpenOrderEvidence(openOrders,now)&&
    !(classification?.issues??[]).some(x=>upper(x.symbol)===s)&&!(classification?.accounting??[]).some(x=>upper(x.symbol)===s)&&
    !orders.some(o=>upper(o.symbol)===s&&pending(o))&&liveForSymbol.length===0&&algoClean;
  return {clean,version:ENTRY_CONTROL_VERSION,symbol:s,incidentId:incident?.id,generation:incident?.generation,
    observation:portfolio?.observation??null,ordersObservedAt:openOrders?.observed_at_ms??null,
    positions:positions.map(p=>({id:p.id,updated_at:p.updated_at,quantity:p.remaining_quantity})),
    recheck:clean?[]:['CURRENT_SYMBOL_EXPOSURE_ORDER_OR_ACCOUNTING_EVIDENCE']};
}
