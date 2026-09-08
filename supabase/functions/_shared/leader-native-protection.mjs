/** Durable, dependency-injected native stop lifecycle.
 * No process startup, credentials, network calls or timers occur on import.
 * The host serializes operations using its existing execution lease and persists
 * position accounting + receipts in the SAME compare-and-swap transaction.
 */
import {exitAttemptId,protectiveStopSpec} from './leader-exit-review.mjs';
const FINAL=new Set(['CANCELED','CANCELLED','EXPIRED','REJECTED','FINISHED']);
const copy=x=>structuredClone(x);
const finite=(x,name)=>{if(!Number.isFinite(x))throw Error(name);return x;};
const eq=(a,b)=>Math.abs(a-b)<=Math.max(1e-10,Math.abs(b)*1e-8);

export function createNativeProtection({store,exchange,clock=Date.now}) {
  async function save(previous,next) {
    next.version=previous.version+1;
    if(!await store.compareAndSwap(previous.position.id,previous.version,next))
      throw Error('PROTECTION_CONCURRENT_UPDATE');
    return next;
  }
  function owned(state) {
    const p=state.position;
    if(p.strategy!=='LEADER_MOMENTUM_V17'||p.side!=='LONG'||p.manual===true)
      throw Error('NOT_OWNED_V17_LONG');
    if(!Number.isFinite(p.remainingQuantity)||p.remainingQuantity<0)
      throw Error('INVALID_OWNED_QUANTITY');
  }
  function validAck(order,ack) {
    const requested=order.spec.params;
    if(String(ack.clientAlgoId)!==requested.clientAlgoId||ack.symbol!==requested.symbol||
       ack.side!=='SELL'||ack.positionSide!=='BOTH'||String(ack.reduceOnly)!=='true'||
       (ack.orderType??ack.type)!=='STOP_MARKET'||
       !eq(Number(ack.quantity),requested.quantity)||!eq(Number(ack.triggerPrice),requested.triggerPrice))
      throw Error('NATIVE_STOP_ACK_MISMATCH');
    if(!ack.algoId||!ack.algoStatus)throw Error('NATIVE_STOP_ACK_INCOMPLETE');
  }
  async function refresh(id) {
    let state=await store.load(id);owned(state);
    for(const remembered of [...state.protection.orders]) {
      if(remembered.terminal)continue;
      let ack;
      try{ack=await exchange.queryStop(remembered.spec.params.clientAlgoId,remembered.spec.params.symbol);}
      catch(error){
        const next=copy(state),item=next.protection.orders.find(x=>x.clientId===remembered.clientId);
        item.lastQueryError=String(error?.message??error);item.lastQueryAt=clock();
        // A lookup failure is NOT evidence that an uncertain submission was absent.
        next.protection.health='RECONCILIATION_PENDING';state=await save(state,next);continue;
      }
      validAck(remembered,ack);
      let next=copy(state),item=next.protection.orders.find(x=>x.clientId===remembered.clientId);
      item.algoId=String(ack.algoId);item.status=String(ack.algoStatus);item.lastQueryAt=clock();item.lastQueryError=null;
      const actual=String(ack.actualOrderId??'');
      if(actual && actual!=='0') {
        const fill=await exchange.getFill(actual,next.position.symbol);
        if(!fill||fill.exact!==true) {
          next.protection.health='FILL_ACCOUNTING_PENDING';state=await save(state,next);continue;
        }
        const q=finite(Number(fill.quantity),'INVALID_FILL_QTY'),funds=finite(Number(fill.funds),'INVALID_FILL_FUNDS'),fee=finite(Number(fill.fee),'INVALID_FILL_FEE');
        if(q<0||funds<0||q>item.spec.params.quantity+1e-8)throw Error('INVALID_NATIVE_FILL');
        const dq=q-(item.appliedQuantity??0),df=funds-(item.appliedFunds??0),dc=fee-(item.appliedFee??0);
        if(dq< -1e-10||df< -1e-10||dq>next.position.remainingQuantity+1e-8)
          throw Error('NATIVE_FILL_QUANTITY_MISMATCH');
        if(dq>0||df!==0||dc!==0) {
          next.position.remainingQuantity=Math.max(0,next.position.remainingQuantity-dq);
          next.position.realizedPnl+=df-next.position.entryPrice*dq-dc;
          next.position.exitPrice=q>0?funds/q:next.position.exitPrice;
          next.position.lastFillAt=Number(fill.lastFillAt);
          next.position.state=next.position.remainingQuantity<=1e-10?'CLOSED':'OPEN';
          if(next.position.state==='CLOSED')next.position.closedAt=Number(fill.lastFillAt);
          item.appliedQuantity=q;item.appliedFunds=funds;item.appliedFee=fee;
        }
        item.actualOrderId=actual;item.fillStatus=fill.status;
        // An algo being triggered is not the same as the market order being filled.
        item.terminal=FINAL.has(item.status)&&['FILLED','EXPIRED','CANCELED','CANCELLED','REJECTED'].includes(fill.status);
      } else item.terminal=FINAL.has(item.status)&&item.status!=='FINISHED';
      if(item.status==='NEW')item.status='ACTIVE';
      state=await save(state,next);
    }
    return state;
  }
  async function cancelRemembered(state,clientId) {
    const order=state.protection.orders.find(x=>x.clientId===clientId);
    if(!order||order.terminal)return state;
    const next=copy(state),item=next.protection.orders.find(x=>x.clientId===clientId);
    item.cancelRequestedAt=clock();item.status='CANCEL_PENDING';state=await save(state,next);
    try{await exchange.cancelStop(order.clientId,order.spec.params.symbol);}
    catch(error){
      const after=copy(state);after.protection.orders.find(x=>x.clientId===clientId).cancelError=String(error?.message??error);
      state=await save(state,after);
    }
    // Always query again, including after a cancel ACK: the order might have filled.
    return refresh(state.position.id);
  }
  async function ensure(id,request) {
    let state=await refresh(id);owned(state);
    if((request.manualSymbols??[]).map(x=>String(x).toUpperCase()).includes(state.position.symbol))
      throw Error('MANUAL_SYMBOL_CONFLICT');
    if(state.position.remainingQuantity<=1e-10) {
      for(const order of [...state.protection.orders].filter(x=>!x.terminal))
        state=await cancelRemembered(state,order.clientId);
      return {status:'CLOSED',state};
    }
    const p=state.position;
    // Validate ownership even when an existing order already covers the stop.
    protectiveStopSpec({...request,symbol:p.symbol,positionId:id,
      ownedQuantity:p.remainingQuantity,clientAlgoId:'tb-check'});
    const outstanding=state.protection.orders.filter(x=>!x.terminal);
    // Reconcile every ambiguous attempt before a distinct attempt is created.
    if(outstanding.some(x=>!['ACTIVE','NEW'].includes(x.status)||x.lastQueryError))
      return {status:'RECONCILIATION_PENDING',state,softwareMonitorRequired:true};
    const current=outstanding.filter(x=>eq(x.spec.params.quantity,p.remainingQuantity))
      .sort((a,b)=>b.spec.params.triggerPrice-a.spec.params.triggerPrice)[0];
    if(current&&current.spec.params.triggerPrice>=request.stopPrice) {
      for(const other of outstanding.filter(x=>x.clientId!==current.clientId))
        state=await cancelRemembered(state,other.clientId);
      return finishReplacement(state,current.clientId,request);
    }
    const generation=(state.protection.generation??0)+1;
    const clientId=await exitAttemptId(id,String(generation),'v17s');
    const spec=protectiveStopSpec({...request,stopPrice:Math.max(request.stopPrice,...outstanding.map(x=>x.spec.params.triggerPrice)),symbol:p.symbol,positionId:id,
      ownedQuantity:p.remainingQuantity,clientAlgoId:clientId});
    if(request.lastPrice!=null&&spec.params.triggerPrice>=request.lastPrice)
      return {status:'STOP_ALREADY_CROSSED',state,softwareMonitorRequired:true};
    const next=copy(state);next.protection.generation=generation;
    next.protection.orders.push({clientId,spec,status:'SUBMITTING',submittedAt:clock(),terminal:false});
    // Persist before sending. A crash after this point only queries this same id.
    state=await save(state,next);
    let ack;
    try{ack=await exchange.createStop(spec.params);validAck(state.protection.orders.at(-1),ack);}
    catch(error){
      const after=copy(state),item=after.protection.orders.find(x=>x.clientId===clientId);
      item.submitError=String(error?.message??error);after.protection.health='RECONCILIATION_PENDING';
      state=await save(state,after);
      return {status:'RECONCILIATION_PENDING',state,softwareMonitorRequired:true};
    }
    const accepted=copy(state),record=accepted.protection.orders.find(x=>x.clientId===clientId);
    record.algoId=String(ack.algoId);record.status=ack.algoStatus==='NEW'?'ACTIVE':String(ack.algoStatus);
    record.ackAt=clock();accepted.protection.health='PROTECTED';state=await save(state,accepted);
    if(record.status!=='ACTIVE')return {status:'RECONCILIATION_PENDING',state,softwareMonitorRequired:true};
    // Never cancel the old stop before the replacement is acknowledged.
    for(const old of outstanding)state=await cancelRemembered(state,old.clientId);
    return finishReplacement(state,clientId,request);
  }
  async function finishReplacement(state,clientId,request) {
    // The old order can fill while its cancellation is in flight.
    if(state.position.remainingQuantity<=1e-10) {
      for(const order of [...state.protection.orders].filter(x=>!x.terminal))
        state=await cancelRemembered(state,order.clientId);
      return {status:'CLOSED',state};
    }
    const current=state.protection.orders.find(x=>x.clientId===clientId);
    if(!current||current.terminal||current.status!=='ACTIVE'||current.lastQueryError||
       !eq(current.spec.params.quantity,state.position.remainingQuantity))
      return {status:'RECONCILIATION_PENDING',state,softwareMonitorRequired:true};
    return {status:'PROTECTED',state,clientId};
  }
  return {refresh,ensure};
}

/** Small host loop. It starts only when start() is explicitly called by the host. */
export function createProtectionLoop({run,report=()=>{},intervalMs=2000,timers=globalThis}) {
  if(!Number.isFinite(intervalMs)||intervalMs<1000)throw Error('INVALID_POLL_INTERVAL');
  let stopped=true,timer=null,running=false;
  async function tick(){
    if(stopped||running)return;
    running=true;const started=Date.now();
    try{await run();report({ok:true,started,finished:Date.now()});}
    catch(error){report({ok:false,started,error:String(error?.message??error)});}
    finally{running=false;if(!stopped)timer=timers.setTimeout(tick,intervalMs);}
  }
  return {start(){if(!stopped)return;stopped=false;timer=timers.setTimeout(tick,0);},
    stop(){stopped=true;if(timer!==null)timers.clearTimeout(timer);},tick};
}
