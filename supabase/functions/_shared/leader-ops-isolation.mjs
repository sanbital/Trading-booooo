/** Operational isolation only. No strategy parameters, startup or exchange side effects. */
export const OPS_PATCH = 'V18-OPS-ISOLATION-3';
export const SCOPE = Object.freeze({exchange:'binance_futures',account_scope:'futures'});
export const RECOVERABLE = new Set(['KNOWN_EXIT_PENDING_RECONCILIATION','KNOWN_ORDER_PENDING_RECONCILIATION','INCOMPLETE_OR_STALE_SNAPSHOT','TRANSIENT_DEPENDENCY','ACCOUNTING_DETAILS_PENDING','DB_CAS_CONFLICT']);
export const sameQuantity = (a,b) => Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=Math.max(1e-10,Math.abs(b)*1e-8);
const symbol = p => String(p?.symbol??p?.market??'').toUpperCase();
const amount = p => Math.abs(Number(p?.quantity??p?.positionAmt??p?.position_amount));
const side = p => {
  const s=String(p?.position_side??p?.positionSide??p?.side??'').toUpperCase();
  if(['LONG','SHORT'].includes(s))return s;
  const n=Number(p?.positionAmt??p?.position_amount);
  return Number.isFinite(n)&&n!==0?(n>0?'LONG':'SHORT'):'';
};
export function freshPortfolio(pf,now=Date.now(),maxAge=3000) {
  const t=pf?.observation;
  return pf?.exchange===SCOPE.exchange&&pf?.account_scope===SCOPE.account_scope&&
    pf?.positions_complete===true&&Array.isArray(pf.positions)&&!!t?.id&&
    t.source==='BINANCE_ACCOUNT_REST'&&Number.isFinite(t.requested_at_ms)&&
    Number.isFinite(t.received_at_ms)&&t.requested_at_ms<=t.received_at_ms&&
    now-t.requested_at_ms<=maxAge&&now-t.received_at_ms>=-1000;
}
export function ownedEntry(p,orders) {
  if(p.state!=='OPEN'||p.side!=='LONG'||p.active_lane!=='BULL'||
    p.metadata?.executionMode!=='LEADER_MOMENTUM_V17'||p.metadata?.v17ManualPosition===true)return false;
  return orders.some(o=>o.position_id===p.id&&o.signal_id===p.signal_id&&o.symbol===p.symbol&&
    o.intent==='OPEN_LONG'&&(o.state==='FILLED'||o.response_payload?.v18ExposureFinal===true)&&o.exchange_order_id&&
    String(o.exchange_order_id)===String(p.metadata?.entryOrderId)&&
    o.request_payload?.order?.position_effect==='OPEN'&&o.request_payload?.order?.side==='BUY'&&
    o.request_payload?.order?.position_side==='LONG');
}
export function riskOrders(orders) {
  return orders.filter(o=>['PLANNED','DISPATCHED','RECONCILIATION_FAILED','RECONCILIATION_PENDING'].includes(o.state)&&
    o.response_payload?.v18ExposureFinal!==true);
}
export function classifyPortfolio(positions,pf,{manual=[],orders=[],now=Date.now()}={}) {
  const issues=[],safe=[];
  const add=(kind,p,x,extra={})=>issues.push({kind,symbol:symbol(p??x),positionId:p?.id??null,
    side:p?.side??side(x),dbQuantity:p?Number(p.remaining_quantity):null,exchangeQuantity:x?amount(x):null,
    exchange:SCOPE.exchange,accountScope:SCOPE.account_scope,...extra});
  if(!freshPortfolio(pf,now)) {
    add('INCOMPLETE_OR_STALE_SNAPSHOT',null,null,{observation:pf?.observation??null});
    return {ok:false,issues,safe,external:[],snapshot:pf?.observation??null};
  }
  const exchange=pf.positions.filter(p=>amount(p)!==0);
  for(const x of exchange)if(!Number.isFinite(amount(x))||!symbol(x)||!side(x))add('IDENTITY_OR_SIDE_MISMATCH',null,x);
  for(const p of positions) {
    const matches=exchange.filter(x=>symbol(x)===symbol(p)),lock=manual.find(x=>x.symbol===symbol(p));
    if(lock||positions.filter(x=>symbol(x)===symbol(p)).length!==1||!ownedEntry(p,orders)) {
      add('IDENTITY_OR_SIDE_MISMATCH',p,matches[0],{reason:lock?'MANUAL_SYMBOL_CONFLICT':'OWNERSHIP_UNPROVEN'});continue;
    }
    if(matches.length===0){
      const known=(p.metadata?.exitProtection?.orders??[]).some(o=>!o.terminal)||
        orders.some(o=>o.position_id===p.id&&o.intent!=='OPEN_LONG'&&riskOrders([o]).length);
      add(known?'KNOWN_EXIT_PENDING_RECONCILIATION':'DB_ONLY_POSITION',p,null);continue;
    }
    const x=matches[0];
    if(matches.length!==1||side(x)!==p.side){add('IDENTITY_OR_SIDE_MISMATCH',p,x);continue;}
    if(!sameQuantity(amount(x),Number(p.remaining_quantity))){
      // A smaller quantity can be explained only by a persisted exit identity. The
      // symbol remains quarantined until its actual cumulative execution is proved.
      const exit=(p.metadata?.exitProtection?.orders??[]).find(o=>!o.terminal)||
        riskOrders(orders).find(o=>o.position_id===p.id&&o.intent!=='OPEN_LONG');
      add('QUANTITY_MISMATCH',p,x,{knownExitPending:!!exit&&amount(x)<Number(p.remaining_quantity)});continue;
    }
    const unknown=riskOrders(orders).find(o=>o.symbol===p.symbol);
    if(unknown){add('UNKNOWN_ORDER_OUTCOME',p,x,{orderId:unknown.id,clientOrderId:unknown.client_order_id});continue;}
    safe.push(p);
  }
  for(const x of exchange.filter(x=>!positions.some(p=>symbol(p)===symbol(x)))) {
    const allowed=manual.find(a=>a.symbol===symbol(x));
    if(allowed&&side(x)===allowed.side&&amount(x)>0&&amount(x)<=allowed.maxQuantity)continue;
    const pending=riskOrders(orders).find(o=>o.symbol===symbol(x)&&o.intent==='OPEN_LONG');
    add(allowed?'IDENTITY_OR_SIDE_MISMATCH':pending?'UNKNOWN_ORDER_OUTCOME':'EXCHANGE_ONLY_POSITION',null,x,pending?{orderId:pending.id,clientOrderId:pending.client_order_id}:{});
  }
  for(const o of riskOrders(orders))if(!issues.some(i=>i.kind==='UNKNOWN_ORDER_OUTCOME'&&i.symbol===o.symbol))
    add('UNKNOWN_ORDER_OUTCOME',null,{symbol:o.symbol},{orderId:o.id,clientOrderId:o.client_order_id});
  return {ok:issues.length===0,issues,safe,external:exchange,snapshot:pf.observation};
}
export function classifyFailure(error) {
  const message=String(error?.message??error);
  if(/LEASE|EXECUTION_FENCED/.test(message))return {kind:'LEASE_LOST',fatal:true,recoverable:false,message};
  if(/401|403|AUTH|SIGNATURE|API.?KEY/.test(message))return {kind:'AUTHENTICATION_FAILURE',recoverable:false,message};
  if(/CONCURRENT|CAS|EXIT_STATE_WRITE/.test(message))return {kind:'DB_CAS_CONFLICT',recoverable:true,message};
  if(/QUOTE|timeout|aborted|BUDGET|429|RATE_LIMIT|SNAPSHOT|PORTFOLIO/.test(message))return {kind:'TRANSIENT_DEPENDENCY',recoverable:true,message};
  return {kind:'UNKNOWN_ORDER_OUTCOME',recoverable:false,message};
}
export function operatorAllowsRecovery(rt,control,settings) {
  return rt?.live_enabled===true&&control?.entry_enabled===true&&control?.legacy_entries_retired===true&&
    settings?.mode==='LIVE_LIMITED'&&!['pause_new_entries','withdrawal_mode','manual_intervention_required',
      'scalp_kill_switch','emergency_liquidation'].some(k=>settings[k]!==false)&&settings.pause_lock_reason==null;
}
export function recoveryEvidence({runtime,classification,orders,control,settings,protectedIds,now=Date.now()}) {
  const eligible=runtime.circuit_open===true&&RECOVERABLE.has(runtime.incident_kind)&&runtime.incident_id&&
    classification.ok&&operatorAllowsRecovery(runtime,control,settings)&&riskOrders(orders).length===0&&
    classification.safe.every(p=>protectedIds.has(p.id));
  return {eligible:!!eligible,incidentId:runtime.incident_id,generation:runtime.incident_generation,
    observation:classification.snapshot,checkedAt:now,
    positions:classification.safe.map(p=>({id:p.id,updated_at:p.updated_at,quantity:p.remaining_quantity}))};
}
export function confirmedLiveProtection(live,positions,now=Date.now()) {
  if(live?.complete!==true||!Array.isArray(live.orders)||live.orders.length||!Array.isArray(live.algos)||
    !Number.isFinite(live.observed_at_ms)||now-live.observed_at_ms>5000||live.observed_at_ms>now+1000)return false;
  const expected=positions.flatMap(p=>(p.metadata?.exitProtection?.orders??[])
    .filter(o=>!o.terminal&&o.status==='ACTIVE').map(o=>({p,o})));
  if(live.algos.length!==expected.length)return false;
  const ids=new Set();
  for(const ack of live.algos){
    const e=expected.find(x=>x.o.clientId===ack.clientAlgoId),s=e?.o.spec?.params;
    if(!e||ids.has(ack.clientAlgoId)||ack.symbol!==e.p.symbol||ack.side!=='SELL'||ack.positionSide!=='BOTH'||
      String(ack.reduceOnly)!=='true'||(ack.orderType??ack.type)!=='STOP_MARKET'||
      !['NEW','ACTIVE'].includes(ack.algoStatus)||String(ack.algoId)!==String(e.o.algoId)||
      !sameQuantity(Number(ack.quantity),Number(e.p.remaining_quantity))||
      !sameQuantity(Number(ack.quantity),Number(s.quantity))||!sameQuantity(Number(ack.triggerPrice),Number(s.triggerPrice)))return false;
    ids.add(ack.clientAlgoId);
  }
  return positions.every(p=>expected.some(e=>e.p.id===p.id));
}
export function createBudget({clock=Date.now,ms=8000,calls=18}={}) {
  const deadline=clock()+ms;let left=calls;
  return {remaining:()=>Math.max(0,deadline-clock()),get callsLeft(){return left;},
    take(cost=1){if(left<cost||clock()>=deadline)throw Error('V18_API_BUDGET_EXHAUSTED');left-=cost;return deadline-clock();}};
}
export async function boundedMap(items,concurrency,work) {
  let index=0;const results=new Array(items.length);
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{
    while(index<items.length){const i=index++;try{results[i]={value:await work(items[i],i)};}catch(error){results[i]={error};}}
  }));return results;
}
