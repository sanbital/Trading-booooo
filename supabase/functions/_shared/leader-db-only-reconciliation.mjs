/**
 * Read-only proof builder for a V17 DB-only position.
 *
 * This module never creates an order or mutates accounting.  It produces the narrow,
 * canonical evidence accepted by the lease-fenced settlement RPC.  A matching symbol
 * and a flat account are deliberately insufficient: the complete entry lifecycle,
 * exact exit order, every exchange trade, the local fill ledger and (for native stops)
 * the exact algo identity must all agree.
 */
import {freshPortfolio,sameQuantity} from './leader-ops-isolation.mjs';

export const DB_ONLY_EVIDENCE_VERSION='V18-DB-ONLY-EVIDENCE-1';
export const AUTO_RECOVERABLE_EXIT_CLASSES=new Set([
  'VERIFIED_BOT_EXIT',
  'VERIFIED_NATIVE_STOP',
  'VERIFIED_STALE_NATIVE_STOP'
]);

const upper=x=>String(x??'').trim().toUpperCase();
const text=x=>x==null?'':String(x);
const number=x=>Number(x);
const finite=x=>Number.isFinite(number(x));
const at=x=>Number.isFinite(number(x))?number(x):Date.parse(String(x??''));
const close=(a,b)=>sameQuantity(number(a),number(b));
const qty=x=>number(x?.qty??x?.quantity);
const price=x=>number(x?.price);
const quote=x=>finite(x?.quoteQty)?number(x.quoteQty):finite(x?.quote_amount)?number(x.quote_amount):qty(x)*price(x);
const fee=x=>number(x?.commission??x?.fee_quote_amount??0);
const tradeId=x=>text(x?.id??x?.exchange_trade_id);
const orderId=x=>text(x?.orderId??x?.exchange_order_id);
const tradeTime=x=>at(x?.time??x?.executed_at);
const tradeSide=x=>x?.isBuyer===true?'BUY':x?.isBuyer===false?'SELL':upper(x?.side);
const unresolved=(reason,stage='EVIDENCE')=>({
  outcome:'UNRESOLVED',inspectionPerformed:true,evidenceSecured:false,
  quantityResolved:false,attributionComplete:false,accountingComplete:false,
  settlementPermitted:false,recoveryEligible:false,reason,stage
});
function uniqueTrades(rows){
  const out=new Map();
  for(const x of rows){
    const key=tradeId(x),fingerprint=[orderId(x),tradeSide(x),qty(x),price(x),quote(x),fee(x),tradeTime(x)].join('|');
    if(out.has(key)&&out.get(key).fingerprint!==fingerprint)return null;
    out.set(key,{row:x,fingerprint});
  }
  return [...out.values()].map(x=>x.row);
}

function exactOrder(rows,id){
  const hits=(Array.isArray(rows)?rows:[]).filter(x=>orderId(x)===id);
  return hits.length===1?hits[0]:null;
}
function protectionOwners(positions,clientOrderId){
  const out=[];
  for(const position of Array.isArray(positions)?positions:[]){
    for(const order of position?.metadata?.exitProtection?.orders??[]){
      const client=text(order?.clientId??order?.spec?.params?.clientAlgoId);
      if(client===clientOrderId)out.push({position,order});
    }
  }
  return out;
}
function safeOrder(order,position,quantity){
  return upper(order?.symbol)===upper(position.symbol)&&upper(order?.side)==='SELL'&&
    upper(order?.positionSide)==='BOTH'&&String(order?.reduceOnly)==='true'&&
    upper(order?.status)==='FILLED'&&upper(order?.type??order?.origType)==='MARKET'&&
    close(order?.origQty,quantity)&&close(order?.executedQty,quantity)&&
    finite(order?.avgPrice)&&number(order.avgPrice)>0&&finite(order?.cumQuote)&&number(order.cumQuote)>0;
}
function safeAlgo(algo,owner,exitOrder,quantity){
  if(!algo||!owner)return false;
  const params=owner.order?.spec?.params??{};
  const actual=algo.actualOrderId??algo.actual_order_id;
  const client=algo.clientAlgoId??algo.client_algo_id;
  const actualQty=algo.actualQty??algo.actual_quantity??algo.executedQty;
  return text(actual)===orderId(exitOrder)&&text(client)===text(owner.order?.clientId??params.clientAlgoId)&&
    !!owner.order?.algoId&&text(algo.algoId??algo.algo_id)===text(owner.order.algoId)&&
    upper(algo.symbol??params.symbol)===upper(exitOrder.symbol)&&upper(algo.side??params.side)==='SELL'&&
    upper(algo.positionSide??params.positionSide)==='BOTH'&&String(algo.reduceOnly??params.reduceOnly)==='true'&&
    ['FINISHED','TRIGGERED'].includes(upper(algo.algoStatus??algo.status))&&
    finite(params.quantity)&&number(params.quantity)+Math.max(1e-10,quantity*1e-8)>=quantity&&
    (!finite(actualQty)||close(actualQty,quantity));
}
function safeLaneExit(order,position,exitOrder){
  const request=order?.request_payload?.order??{};
  return order?.position_id===position.id&&['CLOSE_LONG','PARTIAL_CLOSE'].includes(order?.intent)&&
    text(order?.client_order_id)===text(exitOrder?.clientOrderId)&&
    (!order?.exchange_order_id||text(order.exchange_order_id)===orderId(exitOrder))&&
    upper(request.side)==='SELL'&&upper(request.position_side)==='LONG'&&upper(request.position_effect)==='CLOSE';
}

export function analyzeDbOnlyExit({
  position,lifecyclePositions=[],laneOrders=[],ledgerFills=[],accountTrades=[],orderHistory=[],algo=null,
  portfolio,openOrders,tradeHistoryComplete=false,orderHistoryComplete=false,now=Date.now()
}={}){
  if(!position||position.state!=='OPEN'||position.side!=='LONG'||!(number(position.remaining_quantity)>0))
    return unresolved('TARGET_NOT_OPEN');
  if(position.metadata?.executionMode!=='LEADER_MOMENTUM_V17'||position.metadata?.v17ManualPosition===true)
    return unresolved('TARGET_OWNERSHIP_UNPROVEN');
  if(!freshPortfolio(portfolio,now)||portfolio.positions.some(x=>upper(x?.market??x?.symbol)===upper(position.symbol)&&Math.abs(number(x?.quantity??x?.positionAmt??x?.position_amount))>1e-12))
    return unresolved('FRESH_FLAT_UNPROVEN','PORTFOLIO');
  if(openOrders?.complete!==true||!Array.isArray(openOrders.orders)||!Array.isArray(openOrders.algos)||
    !finite(openOrders.observed_at_ms)||now-number(openOrders.observed_at_ms)>5000||number(openOrders.observed_at_ms)>now+1000||
    [...openOrders.orders,...openOrders.algos].some(x=>upper(x?.symbol??x?.market)===upper(position.symbol)))
    return unresolved('OPEN_ORDER_RISK','OPEN_ORDERS');
  if(!tradeHistoryComplete||!orderHistoryComplete)return unresolved('HISTORY_INCOMPLETE','HISTORY');

  const symbol=upper(position.symbol),entryOrderId=text(position.metadata?.entryOrderId);
  const entryRows=(Array.isArray(laneOrders)?laneOrders:[]).filter(o=>o?.position_id===position.id&&
    o?.signal_id===position.signal_id&&upper(o?.symbol)===symbol&&o?.intent==='OPEN_LONG'&&
    ['FILLED','RECONCILIATION_PENDING'].includes(o?.state)&&text(o?.exchange_order_id)===entryOrderId&&
    upper(o?.request_payload?.order?.side)==='BUY'&&upper(o?.request_payload?.order?.position_side)==='LONG'&&
    upper(o?.request_payload?.order?.position_effect)==='OPEN');
  if(entryRows.length!==1)return unresolved('ENTRY_DB_OWNERSHIP_UNPROVEN','LIFECYCLE');
  const filteredTrades=(Array.isArray(accountTrades)?accountTrades:[]).filter(x=>upper(x?.symbol)===symbol&&tradeId(x)&&orderId(x)&&
    finite(qty(x))&&qty(x)>0&&finite(price(x))&&price(x)>0&&Number.isFinite(tradeTime(x)));
  const trades=uniqueTrades(filteredTrades);
  if(!trades)return unresolved('CONFLICTING_DUPLICATE_TRADE','HISTORY');
  const entries=trades.filter(x=>orderId(x)===entryOrderId&&tradeSide(x)==='BUY');
  if(!entryOrderId||!entries.length||!close(entries.reduce((s,x)=>s+qty(x),0),number(position.original_quantity)))
    return unresolved('ENTRY_LIFECYCLE_UNPROVEN','LIFECYCLE');
  const entryLast=Math.max(...entries.map(tradeTime)),declaredEntry=at(position.entry_at);
  if(!Number.isFinite(declaredEntry)||Math.abs(entryLast-declaredEntry)>5*60*1000)
    return unresolved('ENTRY_TIME_MISMATCH','LIFECYCLE');

  const after=trades.filter(x=>tradeTime(x)>entryLast);
  if(after.some(x=>tradeSide(x)==='BUY'))return unresolved('INTERVENING_BUY_LIFECYCLE','LIFECYCLE');
  const sells=after.filter(x=>tradeSide(x)==='SELL');
  const sellOrderIds=[...new Set(sells.map(orderId))];
  if(sellOrderIds.length!==1)return unresolved(sellOrderIds.length?'MULTIPLE_EXIT_ORDERS':'EXIT_TRADES_MISSING','LIFECYCLE');
  const exitOrderId=sellOrderIds[0],quantity=sells.reduce((s,x)=>s+qty(x),0);
  if(!close(quantity,number(position.remaining_quantity)))
    return unresolved(quantity<number(position.remaining_quantity)?'PARTIAL_EXIT_ONLY':'EXIT_QUANTITY_MISMATCH','QUANTITY');
  const order=exactOrder(orderHistory,exitOrderId);
  if(!order||!safeOrder(order,position,quantity))return unresolved('EXACT_EXIT_ORDER_UNPROVEN','ORDER');

  const ledger=uniqueTrades((Array.isArray(ledgerFills)?ledgerFills:[]).filter(x=>upper(x?.market)===symbol&&orderId(x)===exitOrderId));
  if(!ledger)return unresolved('CONFLICTING_DUPLICATE_LEDGER_FILL','LEDGER');
  if(ledger.length!==sells.length)return unresolved('LEDGER_FILL_COUNT_MISMATCH','LEDGER');
  const ledgerByTrade=new Map(ledger.map(x=>[tradeId(x),x]));
  for(const trade of sells){
    const row=ledgerByTrade.get(tradeId(trade));
    if(!row||upper(row.side)!=='SELL'||!close(row.quantity,qty(trade))||!close(row.price,price(trade))||
      !close(row.quote_amount,quote(trade))||!close(row.fee_quote_amount,fee(trade))||
      !close(row.realized_pnl_quote,number(trade.realizedPnl??row.realized_pnl_quote))||
      Math.abs(at(row.executed_at)-tradeTime(trade))>1000)return unresolved('LEDGER_FILL_MISMATCH','LEDGER');
  }
  const funds=sells.reduce((s,x)=>s+quote(x),0),exitFee=ledger.reduce((s,x)=>s+number(x.fee_quote_amount),0);
  const grossPnl=ledger.reduce((s,x)=>s+number(x.realized_pnl_quote),0),closedAt=Math.max(...sells.map(tradeTime));
  if(!close(order.cumQuote,funds)||!close(number(order.avgPrice)*quantity,funds)||
    !close(grossPnl,funds-number(position.entry_price)*quantity))return unresolved('EXIT_ACCOUNTING_MISMATCH','ACCOUNTING');

  const clientOrderId=text(order.clientOrderId),laneMatches=(Array.isArray(laneOrders)?laneOrders:[])
    .filter(x=>safeLaneExit(x,position,order));
  const owners=protectionOwners(lifecyclePositions,clientOrderId);
  let classification,sourcePositionId=null,sourceOrder=null,laneOrderId=null,recoveryEligible=false;
  if(laneMatches.length===1){
    classification='VERIFIED_BOT_EXIT';laneOrderId=laneMatches[0].id;recoveryEligible=true;
  }else if(laneMatches.length>1){return unresolved('AMBIGUOUS_LANE_EXIT','ATTRIBUTION');
  }else if(owners.length===1&&safeAlgo(algo,owners[0],order,quantity)){
    const owner=owners[0];sourcePositionId=owner.position.id;sourceOrder=owner.order;
    if(owner.position.id===position.id){classification='VERIFIED_NATIVE_STOP';recoveryEligible=true;
    }else if(owner.position.state==='CLOSED'&&number(owner.position.remaining_quantity)===0&&
      Number.isFinite(at(owner.position.closed_at))&&at(owner.position.closed_at)<declaredEntry){
      classification='VERIFIED_STALE_NATIVE_STOP';recoveryEligible=true;
    }else return unresolved('NATIVE_STOP_LIFECYCLE_MISMATCH','ATTRIBUTION');
  }else if(owners.length){return unresolved('NATIVE_ALGO_IDENTITY_UNPROVEN','ATTRIBUTION');
  }else if(/^tb-/i.test(clientOrderId)){return unresolved('UNKNOWN_BOT_ORDER_IDENTITY','ATTRIBUTION');
  }else classification='VERIFIED_EXTERNAL_OR_UNATTRIBUTED_CLOSE';

  const evidence={
    version:DB_ONLY_EVIDENCE_VERSION,classification,exchange:'binance_futures',accountScope:'futures',
    targetPositionId:position.id,targetSignalId:position.signal_id,targetUpdatedAt:position.updated_at,
    targetRemainingQuantity:number(position.remaining_quantity),symbol,entryOrderId,
    sourcePositionId,laneOrderId,exchangeOrderId:exitOrderId,clientOrderId,
    algoId:algo?text(algo.algoId??algo.algo_id):null,
    tradeIds:sells.map(tradeId).sort((a,b)=>a.length-b.length||a.localeCompare(b)),
    quantity,funds,exitPrice:funds/quantity,grossPnl,exitFee,closedAt:new Date(closedAt).toISOString(),
    order:{symbol:upper(order.symbol),orderId:exitOrderId,clientOrderId,side:upper(order.side),
      positionSide:upper(order.positionSide),reduceOnly:String(order.reduceOnly),type:upper(order.type??order.origType),
      status:upper(order.status),origQty:number(order.origQty),executedQty:number(order.executedQty),
      avgPrice:number(order.avgPrice),cumQuote:number(order.cumQuote),time:number(order.time),updateTime:number(order.updateTime)},
    algo:algo?{clientAlgoId:text(algo.clientAlgoId??algo.client_algo_id),algoId:text(algo.algoId??algo.algo_id),
      actualOrderId:text(algo.actualOrderId??algo.actual_order_id),status:upper(algo.algoStatus??algo.status)}:null,
    portfolioObservation:portfolio.observation,ordersObservedAt:number(openOrders.observed_at_ms),
    strategyExit:classification!=='VERIFIED_EXTERNAL_OR_UNATTRIBUTED_CLOSE'
  };
  return {outcome:'VERIFIED',inspectionPerformed:true,evidenceSecured:true,quantityResolved:true,
    attributionComplete:true,accountingComplete:false,settlementPermitted:true,recoveryEligible,
    classification,evidence,sourceOrder};
}
