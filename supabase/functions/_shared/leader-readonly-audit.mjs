export const AUDIT_VERSION='V18-READONLY-AUDIT-1';
/** Each exchange request is named here; callers cannot supply arbitrary commands. */
export async function auditAccount(db,gateway,body={}) {
 const mode=body.mode??'snapshot';
 if(!['snapshot','fills'].includes(mode))throw Error('INVALID_MODE');
 const observedAt=new Date().toISOString();
 if(mode==='fills') {
  if(!/^[0-9a-f-]{36}$/.test(String(body.positionId)))throw Error('INVALID_POSITION_ID');
  const p=await db.from('v11_long_regime_positions').select('id,symbol,entry_at,metadata').eq('id',body.positionId).single();
  if(p.error||p.data?.metadata?.executionMode!=='LEADER_MOMENTUM_V17')throw Error('POSITION_NOT_OWNED');
  // Account trades, never public aggregate trades. Return original per-fill values.
  const trades=await gateway({action:'trade_history',market:p.data.symbol,limit:1000});
  if(!Array.isArray(trades))throw Error('TRADE_LIST_INVALID');
  return {ok:true,version:AUDIT_VERSION,observedAt,positionId:p.data.id,symbol:p.data.symbol,trades,
   paginationRequired:trades.length===1000,rawFillSource:'SIGNED_ACCOUNT_USER_TRADES',fundingVerified:false};
 }
 const rows=await db.from('v11_long_regime_positions').select('id,symbol,remaining_quantity,entry_price,entry_at,state,metadata,closed_at').gte('entry_at',new Date(Date.now()-7*86400000).toISOString()).order('entry_at',{ascending:false}).limit(500);
 if(rows.error)throw Error('POSITIONS_READ');
 const positions=rows.data??[],portfolio=await gateway({action:'p10_portfolio'});
 const ordinaryOrders=await gateway({action:'open_orders'}),protection=[];
 for(const p of positions)for(const o of p.metadata?.exitProtection?.orders??[]) {
  if(o.terminal===true)continue;
  if(protection.length>=30)throw Error('AUDIT_ORDER_LIMIT');
  try {protection.push({positionId:p.id,symbol:p.symbol,dbState:p.state,order:await gateway({action:'v17_query_stop',symbol:p.symbol,clientAlgoId:o.clientId})});}
  catch {protection.push({positionId:p.id,symbol:p.symbol,dbState:p.state,error:'STOP_QUERY_FAILED'});}
 }
 return {ok:true,version:AUDIT_VERSION,observedAt,finishedAt:new Date().toISOString(),portfolio,ordinaryOrders,protection,
  databaseOpen:positions.filter(p=>p.state==='OPEN').map(({metadata,...p})=>({...p,strategy:metadata?.executionMode})),
  allConditionalOrdersVerified:false,conditionalCoverage:'DB_REMEMBERED_ORDERS_ONLY',fundingVerified:false};
}
