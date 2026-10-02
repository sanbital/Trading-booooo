import {createHash,createHmac,randomUUID} from 'node:crypto';
import {freshPortfolio,confirmedLiveProtection,sameQuantity} from '../../supabase/functions/_shared/leader-ops-isolation.mjs';
import {supportedFuturesMode} from '../../supabase/functions/v10-lane-executor/entry-evidence.mjs';

const READS=new Set(['p10_portfolio','v18_open_orders','futures_position_mode','trade_history']);
export async function readVenue({app,token,commit,command,fetchImpl=fetch,now=Date.now}){
 if(!['trading-booooo','trading-booooo-sanbital-gateway'].includes(app)||typeof token!=='string'||token.length<32||!/^[a-f0-9]{40}$/.test(commit))throw Error('PREFLIGHT_READ_CONFIG');
 if(!READS.has(command?.action)||Object.keys(command).some(k=>!['action','market','limit'].includes(k))||
   (command.action==='trade_history'&&(!/^[\p{L}\p{N}]+USDT$/u.test(command.market)||command.limit!==1000)))throw Error('PREFLIGHT_READ_ALLOWLIST');
 const base=`https://${app}.fly.dev`,health=await fetchImpl(base+'/health',{signal:AbortSignal.timeout(5000)});
 if(!health.ok)throw Error('PREFLIGHT_HEALTH_UNAVAILABLE');const h=await health.json();
 if(h.deployment_commit!==commit||h.order_writer?.required!==true||h.keys_configured?.binance_futures!==true)throw Error('PREFLIGHT_VENUE_BUILD_OR_IDENTITY');
 const body=JSON.stringify({exchange:'binance_futures',...command}),ts=String(now()),nonce=randomUUID();
 const secret=createHash('sha256').update('gateway:'+token).digest('hex');
 const signature=createHmac('sha256',secret).update(ts+'\n'+nonce+'\n'+body).digest('hex');
 const r=await fetchImpl(base+'/v1/command',{method:'POST',headers:{'content-type':'application/json','x-gateway-ts':ts,'x-gateway-nonce':nonce,'x-gateway-signature':signature},body,signal:AbortSignal.timeout(5000)});
 if(!r.ok)throw Error('PREFLIGHT_SIGNED_READ_HTTP_'+r.status);const d=await r.json();
 if(d.ok!==true||d.result==null)throw Error('PREFLIGHT_SIGNED_READ_INCOMPLETE');return d.result;
}
export function reconcileHoldings({db,portfolio,openOrders,mode,now=Date.now()}){
 const failures=[],positions=db.positions??[],venue=portfolio?.positions??[];
 if(!freshPortfolio(portfolio,now))failures.push('ACCOUNT_TRUTH_STALE_OR_INCOMPLETE');
 const same=positions.length===venue.length&&positions.every(p=>{
  const matches=venue.filter(x=>x.market===p.symbol&&x.side===p.side);
  return matches.length===1&&sameQuantity(Number(p.remaining_quantity),Number(matches[0].quantity));
 });
 if(!same)failures.push('EXCHANGE_DB_POSITION_MISMATCH');
 if(!confirmedLiveProtection(openOrders,positions,now))failures.push('EXCHANGE_PROTECTION_OR_OPEN_ORDER_MISMATCH');
 if((db.orders??[]).length)failures.push('UNRESOLVED_DB_ORDER');
 if(!supportedFuturesMode(mode,now))failures.push('POSITION_MODE_UNPROVEN');
 return {failures,exchange_positions:venue.length,db_positions:positions.length,ordinary_orders:Array.isArray(openOrders?.orders)?openOrders.orders.length:null,
  protective_orders:Array.isArray(openOrders?.algos)?openOrders.algos.length:null,position_mode:mode?.position_mode??null,
  observation_id:portfolio?.observation?.id??null,account_age_ms:now-portfolio?.observation?.requested_at_ms,orders_age_ms:now-openOrders?.observed_at_ms};
}
export function reconcileTrades(fills,history,since){
 const failures=[],trades=Object.entries(history).flatMap(([symbol,rows])=>{
  if(!Array.isArray(rows)||rows.length>=1000){failures.push('TRADE_HISTORY_INCOMPLETE');return [];}
  return rows.filter(t=>Number(t.time)>=since).map(t=>({...t,symbol}));
 });
 const matches=(f,t)=>f.market===t.symbol&&String(f.exchange_trade_id)===String(t.id);
 for(const f of fills){const found=trades.filter(t=>matches(f,t));
  if(found.length!==1){failures.push('DB_FILL_EXCHANGE_PROOF_MISSING');continue;}const t=found[0];
  if(String(f.exchange_order_id)!==String(t.orderId)||f.side!==(t.isBuyer?'BUY':'SELL')||
     !sameQuantity(Number(f.quantity),Number(t.qty))||!sameQuantity(Number(f.price),Number(t.price))||
     !sameQuantity(Number(f.fee_amount),Number(t.commission))||f.fee_asset!==t.commissionAsset)failures.push('EXCHANGE_DB_FILL_OR_FEE_MISMATCH');
  if(f.source==='AUTOMATED'&&(f.v17_position_id==null||(f.side==='BUY'&&f.v17_order_id==null)))failures.push('FILL_ATTRIBUTION_MISSING');
  if(f.accounting_status!=='ACCOUNTED')failures.push('FILL_ACCOUNTING_UNSETTLED');
 }
 if(trades.some(t=>!fills.some(f=>matches(f,t))))failures.push('EXCHANGE_FILL_MISSING_IN_DB');
 return {failures:[...new Set(failures)],canonical_fills:fills.length,exchange_fills:trades.length,
  scope:'Last 24 hours; symbols from the last seven days of DB positions/fills plus current venue holdings. Other-symbol manual history is not proven.'};
}
