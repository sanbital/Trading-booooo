const STRATEGY='LEADER_MOMENTUM_V17';
const owned=p=>p?.metadata?.executionMode===STRATEGY&&p.side==='LONG'&&p.metadata?.v17ManualPosition!==true;
const symbol=p=>String(p?.market??p?.symbol??'').toUpperCase();
const amount=p=>Math.abs(Number(p?.quantity??p?.positionAmt??p?.position_amount??NaN));
const equal=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=Math.max(1e-10,b*1e-8);
const problem=r=>{if(r.error)throw Error('V18_DATABASE_READ_OR_WRITE');return r.data;};

/** An order is accounting-only pending only after its quantity was booked. */
export function executionPending(order){
 const o=order.response_payload?.order??order.response_payload;
 const status=String(o?.raw_status??o?.status??'').toUpperCase();
 return order.state!=='RECONCILIATION_PENDING'||!['FILLED','EXPIRED','CANCELED','CANCELLED','PARTIALLY_FILLED_CANCELED'].includes(status);
}
export async function recentLeaderExit(db,symbol){
 const rows=problem(await db.from('v11_long_regime_positions').select('closed_at,exit_reason,realized_pnl_usdt')
  .eq('metadata->>executionMode',STRATEGY).eq('symbol',symbol).eq('state','CLOSED').order('closed_at',{ascending:false}).limit(1));
 const p=rows?.[0];if(!p)return null;
 const net=p.realized_pnl_usdt===null?null:Number(p.realized_pnl_usdt);
 return {closedAt:p.closed_at,reason:p.exit_reason,netUsdt:Number.isFinite(net)?net:null,loss:Number.isFinite(net)?net<0:null};
}

/** Never let a cleanup-only metadata write replace execution provenance. */
export async function updateLastExit(db) {
 const rows=problem(await db.from('v11_long_regime_positions').select('closed_at')
  .eq('metadata->>executionMode',STRATEGY).eq('state','CLOSED').order('closed_at',{ascending:false}).limit(1));
 const at=rows?.[0]?.closed_at;if(!at||!Number.isFinite(Date.parse(at)))return null;
 // Conditional UPDATE is atomic; an old pass cannot move the clock backwards.
 problem(await db.from('v11_long_regime_runtime').update({last_exit_at:at})
  .eq('singleton',true).or(`last_exit_at.is.null,last_exit_at.lt.${at}`));
 return at;
}

/** Persist a protection failure without changing the FILLED order or signal state. */
export async function rememberEntryProtection(db,id,result) {
 for(let attempt=0;attempt<3;attempt++){
  const p=problem(await db.from('v11_long_regime_positions').select('*').eq('id',id).single());
  const metadata={...p.metadata,entryProtection:result};
  const r=await db.from('v11_long_regime_positions').update({metadata,updated_at:new Date(Math.max(Date.now(),Date.parse(p.updated_at)+1)).toISOString()})
   .eq('id',id).eq('updated_at',p.updated_at).select('id').maybeSingle();
  if(problem(r))return;
 }
 throw Error('V18_ENTRY_PROTECTION_JOURNAL_CONFLICT');
}

/** Read the native receipt immediately before a software close. The exchange may
 * have filled since the cycle portfolio snapshot (the 2026-09-10 CKB incident). */
export async function reconcileBeforeClose({db,position,protection}) {
 if(!owned(position))throw Error('V18_CLOSE_NOT_OWNED');
 if((position.metadata?.exitProtection?.orders??[]).some(o=>!o.terminal))await protection.refresh(position.id);
 const latest=problem(await db.from('v11_long_regime_positions').select('*').eq('id',position.id).single());
 if(!owned(latest))throw Error('V18_CLOSE_OWNERSHIP_CHANGED');
 return latest;
}

/** A leased, management-only pass. It never reads entry signals or sends BUYs.
 * Every restart reloads durable position and stop receipts. Circuit state gates
 * entries, but cannot prevent reconciliation of the event that opened the circuit. */
export async function managementPass({db,gateway,protection,manualAllowances,manage,
 portfolioMatches,nativeEnabled,clock=Date.now}) {
 const startedAt=clock();
 const runtime=problem(await db.from('v11_long_regime_runtime').select('*').eq('singleton',true).single());
 if(runtime?.live_enabled!==true)return {ok:true,skipped:'RUNTIME_DISABLED'};
 const all=problem(await db.from('v11_long_regime_positions').select('*').eq('state','OPEN').order('entry_at',{ascending:true}).limit(11))??[];
 if(all.length>10)throw Error('V18_POSITION_LIMIT');
 const errors=[],manual=await manualAllowances();
 // Query every remembered stop, even while a circuit is open. No new stop here.
 if(nativeEnabled)for(const p of all.filter(owned)) {
  if(!(p.metadata?.exitProtection?.orders??[]).some(o=>!o.terminal))continue;
  try{await protection.refresh(p.id);}catch{errors.push({id:p.id,symbol:p.symbol,error:'NATIVE_RECONCILIATION_PENDING'});}
 }
 const open=problem(await db.from('v11_long_regime_positions').select('*').eq('state','OPEN').order('entry_at',{ascending:true}).limit(11))??[];
 // Closed positions can still own a replacement order after a cancel/fill race.
 if(nativeEnabled){
  const closed=problem(await db.from('v11_long_regime_positions').select('*').eq('state','CLOSED')
   .order('closed_at',{ascending:false}).limit(50))??[];
  const closedIds=closed.filter(owned).map(p=>p.id);
  if(closedIds.length)problem(await db.from('v11_long_regime_signals').update({status:'CLOSED',updated_at:new Date(clock()).toISOString()})
   .in('position_id',closedIds).in('status',['FILLED','ORDERED','CLAIMED']));
  for(const p of closed.filter(owned)){
   if(manual.some(x=>x.symbol===p.symbol)||!(p.metadata?.exitProtection?.orders??[]).some(o=>!o.terminal))continue;
   try{await protection.ensure(p.id,{manualSymbols:manual.map(x=>x.symbol),exchangeQuantity:0});}
   catch{errors.push({id:p.id,symbol:p.symbol,error:'CLOSED_PROTECTION_CLEANUP_PENDING'});}
  }
 }
 const pf=await gateway({action:'p10_portfolio'},5000);
 if(!Array.isArray(pf?.positions)||pf.positions_complete===false)throw Error('V18_INCOMPLETE_PORTFOLIO');
 const pending=problem(await db.from('v11_long_regime_orders').select('id,symbol,position_id,state,response_payload')
  .in('state',['PLANNED','RECONCILIATION_FAILED','RECONCILIATION_PENDING']).limit(100))??[];
 const uncertain=new Set(pending.filter(executionPending).map(o=>o.symbol));
 const pm=portfolioMatches(open,pf,manual);
 const mine=open.filter(owned),quotes=mine.length?await gateway({action:'p10_quotes',markets:mine.map(p=>p.symbol)},4000):[];
 const context={manualSymbols:manual.map(x=>x.symbol),exchangeQuantity:new Map(),quotes:new Map((Array.isArray(quotes)?quotes:[]).map(q=>[q.market,q])),
  fast:true,quoteRetryBudget:{remaining:0},nativeMinIntervalMs:5000,nativeMinImprovementBps:5};
 const actions=[];
 for(const p of mine){
  const rows=pf.positions.filter(x=>symbol(x)===p.symbol&&amount(x)>0);
  if(manual.some(x=>x.symbol===p.symbol)||uncertain.has(p.symbol)||rows.length!==1||
     !portfolioMatches([p],{positions:rows},[]).ok||!equal(amount(rows[0]),Number(p.remaining_quantity))){
   actions.push({id:p.id,symbol:p.symbol,error:'OWNERSHIP_OR_EXECUTION_UNCERTAIN'});continue;
  }
  context.exchangeQuantity.set(p.symbol,amount(rows[0]));
  try{actions.push({id:p.id,symbol:p.symbol,action:await manage(p,context)});}
  catch{actions.push({id:p.id,symbol:p.symbol,error:'MANAGEMENT_FAILED'});}
 }
 const lastExitAt=await updateLastExit(db);
 // Only auto-clear the operational faults this pass can prove resolved. Operator
 // pauses, kill switches and entry_enabled are not written anywhere in this module.
 const recoverable=/^(V17_POSITION_MANAGEMENT_FAILED|BULL_EXCHANGE_MISMATCH|BULL_EXIT_AMBIGUOUS|BULL_ENTRY_AMBIGUOUS):/.test(runtime.circuit_reason??'');
 const good=pm.ok&&pending.length===0&&errors.length===0&&actions.every(x=>!x.error&&
  (x.action?.result?.closed===true||!nativeEnabled||x.action?.nativeStop?.status==='PROTECTED'));
 if(runtime.circuit_open&&recoverable&&good)problem(await db.from('v11_long_regime_runtime')
  .update({circuit_open:false,circuit_reason:null,last_error:null,updated_at:new Date(clock()).toISOString()})
  .eq('singleton',true).eq('circuit_reason',runtime.circuit_reason));
 return {ok:good,mode:'protect',startedAt,finishedAt:clock(),actions,errors,lastExitAt,
  circuitRecovered:!!(runtime.circuit_open&&recoverable&&good),entryAttempted:false};
}
