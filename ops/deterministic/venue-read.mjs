// Signed exchange observation independent of database availability. No controls or orders.
import {freshPortfolio} from '../../supabase/functions/_shared/leader-ops-isolation.mjs';
import {supportedFuturesMode} from '../../supabase/functions/v10-lane-executor/entry-evidence.mjs';

export async function observeVenue({read,now=Date.now}) {
 const [portfolio,openOrders,mode]=await Promise.all(
  ['p10_portfolio','v18_open_orders','futures_position_mode'].map(action=>read({action})));
 const at=now();
 if(!freshPortfolio(portfolio,at)||openOrders?.complete!==true||
   !Array.isArray(openOrders.orders)||!Array.isArray(openOrders.algos)||
   !Number.isSafeInteger(openOrders.observed_at_ms)||at-openOrders.observed_at_ms>5000||
   openOrders.observed_at_ms>at+1000)throw Error('VENUE_OBSERVATION_INCOMPLETE_OR_STALE');
 const positions=portfolio.positions.map(p=>({symbol:p.market,side:p.side,quantity:Number(p.quantity)}));
 if(positions.some(p=>typeof p.symbol!=='string'||!/^[\p{L}\p{N}]+USDT$/u.test(p.symbol)||
   !['LONG','SHORT'].includes(p.side)||!Number.isFinite(p.quantity)||p.quantity<=0))throw Error('VENUE_POSITION_IDENTITY_UNPROVEN');
 const modeVerified=supportedFuturesMode(mode,at);
 const flat=positions.length===0&&openOrders.orders.length===0&&openOrders.algos.length===0&&modeVerified;
 return {raw:{portfolio,openOrders,mode},summary:{utc:new Date(at).toISOString(),
  status:flat?'VENUE_FLAT_VERIFIED_DB_UNAVAILABLE':'VENUE_OBSERVED_DB_RECONCILIATION_REQUIRED',
  exchange_positions:positions.length,positions,ordinary_orders:openOrders.orders.length,
  protective_orders:openOrders.algos.length,position_mode:mode?.position_mode??null,position_mode_verified:modeVerified,
  account_age_ms:at-portfolio.observation.requested_at_ms,orders_age_ms:at-openOrders.observed_at_ms,
  db_reconciliation:'UNAVAILABLE',new_entry_permission_granted:false,order_commands:0}};
}
