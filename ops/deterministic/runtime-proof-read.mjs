import {normalizeEntryBook} from '../../supabase/functions/_shared/deterministic/book.mjs';
import {sameQuantity} from '../../supabase/functions/_shared/leader-ops-isolation.mjs';
export function quoteIntegrity(quote,now=Date.now()){
 const book=normalizeEntryBook(quote,1500,now),mid=(Number(quote.best_bid)+Number(quote.best_ask))/2;
 return {health:book.health,bid_levels:book.bids.length,ask_levels:book.asks.length,
  bid_25bp_covered:book.bids.length>0&&Number(book.bids.at(-1)[0])<=mid*.9975,
  ask_25bp_covered:book.asks.length>0&&Number(book.asks.at(-1)[0])>=mid*1.0025};
}
export function settledBalanceProof(snapshot,portfolio,at){
 if(!snapshot||snapshot.positions_complete!==true||!Number.isFinite(Date.parse(snapshot.captured_at))||at-Date.parse(snapshot.captured_at)>120000||Date.parse(snapshot.captured_at)>at)return {matched:false,scope:'STALE_OR_INCOMPLETE'};
 const usdt=(snapshot.balances??[]).filter(x=>x.currency==='USDT');
 if(usdt.length!==1||![Number(usdt[0].balance),Number(usdt[0].locked),Number(portfolio.settled_quote)].every(x=>Number.isFinite(x)&&x>=0))return {matched:false,scope:'WALLET_UNPROVEN'};
 return {matched:Math.abs(Number(usdt[0].balance)+Number(usdt[0].locked)-Number(portfolio.settled_quote))<=.01,scope:'SETTLED_WALLET',snapshot_age_ms:at-Date.parse(snapshot.captured_at)};
}
export function executionIdentity(state){
 return JSON.stringify({postmaster:state.postmaster,positions:state.positions.map(p=>({id:p.id,state:p.state,symbol:p.symbol,side:p.side,quantity:p.remaining_quantity,
  protections:(p.metadata?.exitProtection?.orders??[]).map(o=>({id:o.clientId,terminal:o.terminal,status:o.status,spec:o.spec,algoId:o.algoId}))})),orders:state.orders.map(o=>({id:o.id,state:o.state}))});
}
export function nativeAckMatches(p,o,ack){
 const s=o.spec?.params;
 return !!s&&ack.clientAlgoId===o.clientId&&String(ack.algoId)===String(o.algoId)&&ack.symbol===p.symbol&&ack.side==='SELL'&&ack.positionSide==='BOTH'&&String(ack.reduceOnly)==='true'&&
  (ack.orderType??ack.type)==='STOP_MARKET'&&['NEW','ACTIVE','CANCELED','CANCELLED','FINISHED','EXPIRED'].includes(ack.algoStatus)&&
  sameQuantity(Number(ack.quantity),Number(s.quantity))&&sameQuantity(Number(ack.triggerPrice),Number(s.triggerPrice))&&Number(ack.triggerPrice)>=Number(p.entry_price)*.975-Number(p.entry_price)*1e-10;
}
