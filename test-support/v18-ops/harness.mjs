import vm from 'node:vm';
import {readFileSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import * as momentum from '../../supabase/functions/_shared/leader-momentum-v17.mjs';
import * as review from '../../supabase/functions/_shared/leader-exit-review.mjs';
import {protectNewLeaderPosition} from '../../supabase/functions/_shared/leader-entry-protection.mjs';
import {createGatewayProtection} from '../../supabase/functions/_shared/leader-protection-adapter.mjs';
import * as ops from '../../supabase/functions/_shared/leader-ops-isolation.mjs';
import * as entrySettlement from '../../supabase/functions/_shared/leader-entry-settlement.mjs';
import * as qv3 from '../../supabase/functions/_shared/leader-qv3-runtime.mjs';
import * as settlement from '../../supabase/functions/_shared/leader-exit-settlement.mjs';
export const BASE='bce9e95210829b5ae561f667dd1b499772977ec1';
const root=new URL('../../',import.meta.url);
const baselineDir=mkdtempSync(join(tmpdir(),'v18-baseline-'));
for(const name of ['leader-momentum-v17.mjs','leader-exit-review.mjs','leader-native-protection.mjs','leader-protection-adapter.mjs'])writeFileSync(join(baselineDir,name),execFileSync('git',['show',BASE+':supabase/functions/_shared/'+name],{cwd:root}));
const baselineAdapter=await import(pathToFileURL(join(baselineDir,'leader-protection-adapter.mjs')).href);
const clone=x=>structuredClone(x);
export function position(symbol='SAGAUSDT',quantity=7067.3,price=.01699){
 const id=symbol,at='2026-09-10T16:10:09.013Z';
 return {id,signal_id:'signal-'+symbol,revision:'V11-LONG-REGIME-1.0.1',symbol,side:'LONG',state:'OPEN',
  active_lane:'BULL',entry_lane:'BULL',original_quantity:quantity,remaining_quantity:quantity,entry_price:price,
  entry_at:at,entry_fee_usdt:.06,entry_atr:price*.01,entry_bb_pos:0,t1_completed:false,
  realized_pnl_usdt:-.06,peak_price:price,hard_stop_price:price*.975,updated_at:at,last_evaluated_at:at,
  metadata:{executionMode:momentum.STRATEGY,entryOrderId:'entry-'+symbol,leaderExitPolicyVersion:review.EXIT_REVIEW_R5.policyVersion,
    leaderExitPolicy:{...momentum.POLICY,...review.EXIT_REVIEW_R5},exitProtection:{version:0,generation:1,health:'PROTECTED',orders:[{
      clientId:'tb-v17s-'+symbol.toLowerCase().padEnd(27,'0').slice(0,27),status:'ACTIVE',terminal:false,
      spec:{params:{clientAlgoId:'tb-v17s-'+symbol.toLowerCase().padEnd(27,'0').slice(0,27),symbol,side:'SELL',positionSide:'BOTH',reduceOnly:'true',
        type:'STOP_MARKET',quantity,triggerPrice:price*.975}}}]}}};
}
export function entryOrder(p){return {id:'order-'+p.id,signal_id:p.signal_id,position_id:p.id,symbol:p.symbol,intent:'OPEN_LONG',state:'FILLED',
 exchange_order_id:p.metadata.entryOrderId,client_order_id:'entry-client-'+p.id,requested_quantity:p.original_quantity,
 request_payload:{order:{side:'BUY',position_side:'LONG',position_effect:'OPEN'}},created_at:p.entry_at,updated_at:p.entry_at};}
export function harness({positions=[],baseline=false,circuit=false,manual=[],settings={},signal=true,now=Date.parse('2026-09-10T16:16:00Z'),hook=()=>{},qv3Cutover=null,qv3Fetch=null}={}) {
 const state={now,portfolioCount:0,lease:true,leaseOwner:null,quotes:{},stopFills:{},software:{},calls:[],writes:[],circuits:[],hook,
  exchange:positions.map(p=>({market:p.symbol,side:p.side,quantity:p.remaining_quantity})),
  tables:{v11_long_regime_positions:clone(positions),v11_long_regime_orders:positions.map(entryOrder),v11_long_regime_decisions:[],
   v11_long_regime_runtime:[{singleton:true,revision:'V11-LONG-REGIME-1.0.1',live_enabled:true,circuit_open:circuit,
    incident_id:circuit?'incident-1':null,incident_generation:circuit?1:0,incident_kind:circuit?'KNOWN_EXIT_PENDING_RECONCILIATION':null}],
   v17_operator_control:[{singleton:true,entry_enabled:true,legacy_entries_retired:true}],
   trading_settings:[{id:1,mode:'LIVE_LIMITED',binance_futures_allocation_usdt:40,pause_new_entries:false,withdrawal_mode:false,manual_intervention_required:false,scalp_kill_switch:false,emergency_liquidation:false,...settings}],
   trading_asset_locks:manual.map(x=>({exchange:'binance_futures',asset:x.symbol.replace(/USDT$/,''),state:'LOCKED',metadata:{v17ManualPosition:true,...x}})),
   v11_long_regime_signals:signal?[{id:'soph-signal',symbol:'SOPHUSDT',side:'LONG',status:'NEW',lane:'BULL',revision:'V11-LONG-REGIME-1.0.1',entry_bar_at:new Date(now-60000).toISOString(),features:{strategy:momentum.STRATEGY,rank:1,signal5Close:now-60000,referenceClose:.004,atr:.0001,exitPolicy:{stopPct:.025,trailArmPct:.05,trailGapPct:.0225,maxHoldMs:momentum.POLICY.maxHoldMs,staleMs:momentum.POLICY.staleMs}}}]:[],
   trading_account_snapshots:[{exchange:'binance_futures',captured_at:new Date(now).toISOString(),positions_complete:true,available_quote:108,positions:[]}],
  },incidents:new Map(),seq:0};
 // Inject the clock at the host/module boundary; no production algorithm is replaced.
 Date.now=()=>state.now;
 class Clock extends Date {constructor(...x){super(...(x.length?x:[state.now]));}static now(){return state.now;}}
 const get=(r,k)=>k.includes('->>')?r[k.split('->>')[0]]?.[k.split('->>')[1]]:r[k];
 const db={from(table){let filters=[],patch=null,insert=null,limit=Infinity,sort=null,single=false;const b={
  select(){return b;},eq(k,v){filters.push(r=>String(get(r,k))===String(v));return b;},in(k,vs){filters.push(r=>vs.includes(get(r,k)));return b;},
  or(expression){if(expression!=="response_payload->>v18ExposureFinal.is.null,response_payload->>v18ExposureFinal.neq.true")throw Error("unsupported test filter");filters.push(r=>r.response_payload?.v18ExposureFinal!==true);return b;},
  gte(k,v){filters.push(r=>get(r,k)>=v);return b;},order(k,o){sort=[k,o?.ascending!==false];return b;},limit(n){limit=n;return b;},
  update(v){patch=clone(v);return b;},insert(v){insert=clone(v);return b;},single(){single=true;return b;},maybeSingle(){single=true;return b;},
  async then(resolve,reject){try{
   await state.hook({type:'db',table,patch,insert,state});
   if((patch||insert)&&!state.lease)throw Error('V18_EXECUTION_FENCED');
   let rows=(state.tables[table]??[]).filter(r=>filters.every(f=>f(r)));
   if(sort)rows.sort((a,b)=>String(get(a,sort[0])).localeCompare(String(get(b,sort[0])))*(sort[1]?1:-1));rows=rows.slice(0,limit);
   if(insert){const row={id:'new-'+(++state.seq),created_at:new Clock().toISOString(),updated_at:new Clock().toISOString(),...insert};(state.tables[table]??=[]).push(row);rows=[row];}
   if(patch){for(const r of rows)Object.assign(r,patch);}
   if(patch||insert){state.writes.push({table,patch,insert,count:rows.length});if(table==='v11_long_regime_runtime'&&patch?.circuit_open===true)state.circuits.push(patch);}
   const out={data:clone(single?rows[0]??null:rows),error:single&&rows.length>1?{message:'MULTIPLE_ROWS'}:null};return resolve(out);
  }catch(e){if(reject)return reject(e);throw e;}}
 };return b;},async rpc(name,args){
  state.calls.push({rpc:name,args:clone(args)});await state.hook({type:'rpc',name,args,state});
  if(name==='v17_verify_execution_lease')return {data:state.lease};
  if(name==='v17_acquire_execution_lease'){if(state.leaseOwner)return{data:false};state.leaseOwner=args.p_owner;return{data:state.lease};}
  if(name==='v17_release_execution_lease'){if(state.leaseOwner===args.p_owner)state.leaseOwner=null;return{data:true};}
  if(!state.lease)throw Error('V18_EXECUTION_FENCED');
  const r=state.tables.v11_long_regime_runtime[0];
  if(name==='v18_record_incident'){
   if(!r.circuit_open||r.circuit_reason!==args.p_reason||r.incident_kind!==args.p_kind){r.incident_generation++;r.incident_id='incident-'+r.incident_generation;}
   Object.assign(r,{circuit_open:true,circuit_reason:args.p_reason,incident_kind:args.p_kind});state.circuits.push(clone(r));return{data:r.incident_id};
  }
  if(name==='v18_recovery_observation'){
   if(r.incident_id!==args.p_incident_id||r.incident_generation!==args.p_generation)return{data:{resolved:false,reason:'INCIDENT_CAS_MISS'}};
   const old=state.incidents.get(r.incident_id),o=args.p_evidence.observation;
   if(old&&(old.id===o.id||o.requested_at_ms-old.time<50000))return{data:{resolved:false}};
   const rec={id:o.id,time:o.requested_at_ms,count:old?old.count+1:1};state.incidents.set(r.incident_id,rec);
   if(rec.count>=3)r.circuit_open=false;return{data:{resolved:rec.count>=3,checks:rec.count}};
  }
  throw Error('UNIMPLEMENTED_RPC:'+name);
 }};
 const gateway=async(cmd)=>{
  state.calls.push(clone(cmd));if(cmd.action==='p10_portfolio')state.portfolioCount++;
  await state.hook({type:'gateway',cmd,state});
  if(['create_order','v17_create_stop','v17_cancel_stop'].includes(cmd.action)&&!state.lease)throw Error('V18_EXECUTION_FENCED');
  if(cmd.action==='p10_portfolio')return {exchange:'binance_futures',account_scope:'futures',positions_complete:true,positions:clone(state.exchange),available_quote:108,
   observation:{id:'snapshot-'+state.portfolioCount,source:'BINANCE_ACCOUNT_REST',requested_at_ms:state.now,received_at_ms:state.now},...state.portfolioOverride};
  if(cmd.action==='v18_open_orders')return{complete:true,orders:[],algos:state.tables.v11_long_regime_positions.flatMap(p=>(p.metadata?.exitProtection?.orders??[]).filter(o=>!o.terminal&&o.status==='ACTIVE').map(o=>({...o.spec.params,algoId:o.algoId,algoStatus:'NEW'}))),observed_at_ms:state.now,...state.openOrdersOverride};
  if(cmd.action==='symbol_info')return{quantity_step:cmd.market==='SAGAUSDT'?.1:1,price_tick:cmd.market==='SAGAUSDT'?.00001:.000001,min_notional:5};
  if(cmd.action==='p10_quotes')return cmd.markets.map(m=>{if(state.quotes[m] instanceof Error)throw state.quotes[m];const p=state.tables.v11_long_regime_positions.find(p=>p.symbol===m);
   return{market:m,best_bid:state.quotes[m]??p.entry_price,best_ask:(state.quotes[m]??p.entry_price)*1.0001,timing:{requested_at_ms:state.now,received_at_ms:state.now}};});
  if(cmd.action==='quote')return state.entryQuote??{best_bid:.004,best_ask:.004001};
  if(cmd.action==='v17_query_stop'){
   const p=state.tables.v11_long_regime_positions.find(p=>p.symbol===cmd.symbol),o=p.metadata.exitProtection.orders.find(o=>o.clientId===cmd.clientAlgoId);
   const f=state.stopFills[cmd.symbol];return{...o.spec.params,algoId:'algo-'+o.clientId,algoStatus:f?'FINISHED':state.cancelled?.has(cmd.clientAlgoId)?'CANCELED':'NEW',actualOrderId:f?.orderId??null};
  }
  if(cmd.action==='v17_stop_fill')return clone(state.stopFills[cmd.symbol]);
  if(cmd.action==='v17_create_stop')return{...cmd.params,algoId:'algo-'+cmd.params.clientAlgoId,algoStatus:'NEW'};
  if(cmd.action==='v17_cancel_stop'){(state.cancelled??=new Set()).add(cmd.clientAlgoId);return{};}
  if(cmd.action==='get_order'){const r=state.software[cmd.identifier];if(r instanceof Error)throw r;if(!r)throw Error('ORDER_READ_PENDING');return clone(r);}
  if(cmd.action==='create_order'){
   if(state.createOrder){return state.createOrder(cmd,state);}
   throw Error('UNEXPECTED_ORDER_DISPATCH:'+cmd.order.side);
  }
  if(cmd.action==='v17_shadow_positions')return {};
  throw Error('UNEXPECTED_GATEWAY:'+cmd.action);
 };
 let source=baseline?execFileSync('git',['show',BASE+':supabase/functions/v10-lane-executor/index.ts'],{cwd:root,encoding:'utf8'}):readFileSync(new URL('supabase/functions/v10-lane-executor/index.ts',root),'utf8');
 source=source.replace(/^import .*;\n/gm,'').replace('const exchangeGateway=gateway;','const exchangeGateway=__gateway;');source=source.slice(0,source.indexOf('Deno.serve'));
 // Only exchange/DB/time boundaries are replaced. run/manage/open/close are actual source.
 source+='\ngateway=__gateway;this.runCycle=()=>runWithLease(__db);this.open=(...args)=>openBull(__db,...args);this.close=(...args)=>closePos(__db,...args);this.manage=(...args)=>manageLeader(__db,...args);this.setLease=()=>leaseOwners.set(__db,"test-owner");';
 const ctx={...momentum,...review,...ops,...settlement,...entrySettlement,...qv3,QV3_LIVE_CUTOVER:qv3Cutover,qv3Candles:(symbol,at,start)=>qv3.qv3Candles(symbol,at,start,qv3Fetch??(()=>{throw Error("NETWORK_FORBIDDEN")})),leaderPortfolioMatches:momentum.portfolioMatches,protectNewLeaderPosition,createGatewayProtection:baseline?baselineAdapter.createGatewayProtection:createGatewayProtection,
  Date:Clock,console,crypto,Map,Set,WeakMap,AbortController,TextEncoder,Response,Headers,fetch:()=>{throw Error('NETWORK_FORBIDDEN')},setTimeout,clearTimeout,
  Deno:{env:{get:k=>k==='V17_NATIVE_STOP'?'true':''}},__gateway:gateway,__db:db};
 vm.createContext(ctx);vm.runInContext(source,ctx);ctx.setLease();
 return{state,db,ctx,gateway,advance(ms=60000){state.now+=ms;state.tables.trading_account_snapshots[0].captured_at=new Clock().toISOString();}};
}
export function nativeFill(p,{exact=true,price=p.entry_price*.988,quantity=p.remaining_quantity}={}){
 const o=p.metadata.exitProtection.orders[0];return{orderId:'exit-'+p.id,exact,quantity,funds:quantity*price,fee:.05,status:'FILLED',lastFillAt:Date.parse('2026-09-10T16:16:02.599Z'),tradeIds:['1','2','3'],
 orderEvidence:{orderId:'exit-'+p.id,clientAlgoId:o.clientId,symbol:p.symbol,side:'SELL',positionSide:'BOTH',reduceOnly:true,requestedQuantity:o.spec.params.quantity,quantity,status:'FILLED',lastAt:Date.parse('2026-09-10T16:16:02.599Z')}};
}
