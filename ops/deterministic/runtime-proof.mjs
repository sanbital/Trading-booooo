// Signed, read-only observations. No entry/exit/control command or key-reveal API.
import fs from 'node:fs';import {createCipheriv,publicEncrypt,randomBytes} from 'node:crypto';
import {readVenue,validateReadCommand,reconcileHoldings,reconcileTrades} from './preflight-read.mjs';
import {quoteIntegrity,settledBalanceProof,executionIdentity,nativeAckMatches} from './runtime-proof-read.mjs';
import {expectedGatewayCommit} from './gateway-source.mjs';
import {reusableSeed,quoteRevalidationEvidence} from './quote-revalidation-read.mjs';
import {observeVenue} from './venue-read.mjs';
const project='etaajwpernzrcdrifdnw',sha=process.env.GITHUB_SHA,operation=process.env.PROOF_OPERATION,notBefore=Date.parse(process.env.NOT_BEFORE??''),minutes=Number(process.env.OBSERVATION_MINUTES??30);
if(process.env.GITHUB_REPOSITORY!=='sanbital/Trading-booooo'||process.env.GITHUB_REF!=='refs/heads/main'||sha!==process.env.EXPECTED_COMMIT||!/^[a-f0-9]{40}$/.test(sha??'')||!['quote-evidence','revalidation-evidence','venue-evidence','fill-proof'].includes(operation))throw Error('RUNTIME_PROOF_EXACT_MAIN_REQUIRED');
if(operation==='fill-proof'&&(!Number.isFinite(notBefore)||notBefore>Date.now()+60000||Date.now()-notBefore>86400000||!Number.isInteger(minutes)||minutes<1||minutes>60))throw Error('FILL_OBSERVATION_WINDOW_INVALID');
if(operation==='revalidation-evidence'&&(!Number.isInteger(minutes)||minutes<1||minutes>10))throw Error('REVALIDATION_OBSERVATION_WINDOW_INVALID');
const request=JSON.parse(fs.readFileSync('ops/deterministic/release-request.json','utf8')),app=process.env.FLY_BINANCE_APP_NAME,config={app,token:process.env.LEARNING_ACCESS_TOKEN,commit:expectedGatewayCommit(request,app)};
const ev={version:'DETERMINISTIC_SIGNED_RUNTIME_PROOF_1',operation,source_commit:sha,service_source_commit:request.staged_source_commit,not_before:operation==='fill-proof'?new Date(notBefore).toISOString():null,mutations:0,order_commands:0,observations:[]};
function seal(){fs.mkdirSync('infra-evidence',{recursive:true});const key=randomBytes(32),iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([c.update(JSON.stringify(ev)),c.final()]);fs.writeFileSync('infra-evidence/deterministic-runtime-proof.encrypted.json',JSON.stringify({version:1,key:publicEncrypt({key:fs.readFileSync('ops/execution-infra/evidence-public.pem'),oaepHash:'sha256'},key).toString('base64'),iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),data:data.toString('base64')}));}
async function query(query){const r=await fetch(`https://api.supabase.com/v1/projects/${project}/database/query`,{method:'POST',headers:{authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN,'content-type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('PROOF_DB_HTTP_'+r.status);return r.json();}
const cutoff=Number.isFinite(notBefore)?new Date(notBefore).toISOString():'1970-01-01T00:00:00.000Z';
const stateSQL=`select jsonb_build_object('utc',clock_timestamp(),'postmaster',pg_postmaster_start_time(),
 'control',(select to_jsonb(c) from deterministic_control c where singleton),
 'runtime',(select to_jsonb(r) from v11_long_regime_runtime r where singleton),
 'scheduler',(select to_jsonb(c) from trading_scheduler_control c where scheduler_key='trading-production'),
 'positions',(select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]') from v11_long_regime_positions p where state='OPEN' or remaining_quantity>0),
 'orders',(select coalesce(jsonb_agg(to_jsonb(o)-'request_payload'-'response_payload' order by id),'[]') from v11_long_regime_orders o where state in ('PLANNED','DISPATCHED','SUBMITTING','PARTIALLY_FILLED','UNKNOWN','RECONCILIATION_PENDING','RECONCILIATION_FAILED')),
 'fills',(select coalesce(jsonb_agg(to_jsonb(f)-'raw_response'),'[]') from exchange_trade_fills f where exchange='binance_futures' and account_scope='futures' and executed_at>=now()-interval '24 hours'),
 'new_fills',(select coalesce(jsonb_agg(to_jsonb(f)-'raw_response'),'[]') from exchange_trade_fills f join v11_long_regime_orders o on o.id=f.v17_order_id join v11_long_regime_signals s on s.id=o.signal_id where f.exchange='binance_futures' and f.account_scope='futures' and f.side='BUY' and f.source='AUTOMATED' and f.executed_at>='${cutoff}'::timestamptz and s.features#>>'{deterministic,version}'='DETERMINISTIC_DYNAMIC_STATE_1'),
 'new_positions',(select coalesce(jsonb_agg(to_jsonb(p)),'[]') from v11_long_regime_positions p join v11_long_regime_signals s on s.id=p.signal_id where p.entry_at>='${cutoff}'::timestamptz and s.features#>>'{deterministic,version}'='DETERMINISTIC_DYNAMIC_STATE_1'),
 'snapshot',(select jsonb_build_object('captured_at',captured_at,'positions_complete',positions_complete,'balances',balances) from trading_account_snapshots where exchange='binance_futures' order by captured_at desc limit 1),
 'gpt_off',(select mode='OFF' from gpt_final_review_control where singleton),'batch_off',(select not enabled from leader20_batch_control where singleton),
 'provider_calls',(select count(*) from ai_call_ledger where created_at>='2026-10-02T23:58:25Z' and purpose in ('ENTRY','EXIT'))) evidence`;
const state=async()=>(await query(stateSQL))[0].evidence;
function authority(s){if(!s.control.enabled||s.control.generation!==2||s.control.source_commit!==request.staged_source_commit||!s.gpt_off||!s.batch_off||s.provider_calls!==0)throw Error('LIVE_DETERMINISTIC_IDENTITY_CHANGED');}
function note(summary){ev.observations.push(summary);seal();console.log(JSON.stringify(summary));fs.writeFileSync('infra-evidence/deterministic-runtime-proof-summary.json',JSON.stringify(summary,null,2));}
async function quoteEvidence(){const s=await state();authority(s);const symbols=await query("select symbol,max(created_at) latest_buy from v11_long_regime_signals where features#>>'{deterministic,version}'='DETERMINISTIC_DYNAMIC_STATE_1' and created_at>now()-interval '15 minutes' group by symbol order by latest_buy desc limit 6");
 for(const {symbol}of symbols){const quote=await readVenue({...config,command:{action:'quote',market:symbol}});ev['quote_'+symbol]=quote;note({utc:new Date().toISOString(),status:'SIGNED_QUOTE_OBSERVED',symbol,...quoteIntegrity(quote),order_commands:0});}
 if(!symbols.length)note({utc:new Date().toISOString(),status:'NO_RECENT_BUY_SYMBOLS',order_commands:0});
}
async function venueEvidence(){
 const observed=await observeVenue({read:command=>readVenue({...config,command})});
 ev.venue=observed.raw;note(observed.summary);
}
async function revalidationEvidence(){authority(await state());const end=Date.now()+minutes*60000,seen=new Set();let observations=0;
 while(Date.now()<end&&observations<12){
  const seeds=await query("select id,symbol,features->'deterministic' seed from v11_long_regime_signals where created_at>clock_timestamp()-interval '30 seconds' and features#>>'{deterministic,version}'='DETERMINISTIC_DYNAMIC_STATE_1' order by created_at desc limit 3");
  for(const row of seeds){if(seen.has(row.id)||!reusableSeed(row.seed,Date.now()))continue;seen.add(row.id);
   // Exact read schema validates the symbol before the separately escaped SQL literal.
   const command={action:'quote',market:row.symbol};validateReadCommand(command);
   const symbol=row.symbol.replaceAll("'","''"),raw=(await query(`with cutoff as materialized(select clock_timestamp() at) select deterministic_capture_raw('${symbol}',cutoff.at,null,cutoff.at) capture from cutoff`))[0].capture;
   const quote=await readVenue({...config,command});
   // Take the signed book last; all capture/query latency still counts toward data freshness.
   ev['revalidation_'+row.id]={seed:row.seed,raw,quote};observations++;
   note({utc:new Date().toISOString(),symbol:row.symbol,...quoteRevalidationEvidence({seed:row.seed,raw,quote}),quote:quoteIntegrity(quote),order_commands:0});
  }
  if(Date.now()<end&&observations<12)await new Promise(r=>setTimeout(r,10000));
 }
 note({utc:new Date().toISOString(),status:'READ_ONLY_COMPARISON_WINDOW_COMPLETED',observations,order_commands:0});
}
async function fillObservation(){const before=await state();authority(before);
 if(!before.new_fills.length){note({utc:before.utc,status:'WAITING_FOR_REAL_FILL',new_entry_fills:0,unresolved_orders:before.orders.length,open_positions:before.positions.filter(p=>p.state==='OPEN').length,circuit_open:before.runtime.circuit_open,order_commands:0});return false;}
 ev.before=before;const [portfolio,openOrders,mode]=await Promise.all(['p10_portfolio','v18_open_orders','futures_position_mode'].map(action=>readVenue({...config,command:{action}})));
 const holdings=reconcileHoldings({db:before,portfolio,openOrders,mode}),symbols=[...new Set([...before.fills.map(f=>f.market),...portfolio.positions.map(p=>p.market)])];if(symbols.length>30)throw Error('FILL_HISTORY_SCOPE_TOO_LARGE');
 const history={};for(const market of symbols)history[market]=await readVenue({...config,command:{action:'trade_history',market,limit:1000}});
 const trades=reconcileTrades(before.fills,history,Date.parse(before.utc)-86400000),balance=settledBalanceProof(before.snapshot,portfolio,Date.parse(before.utc)),nativeProofs=[];
 for(const p of before.new_positions){const acknowledgements=(p.metadata?.exitProtection?.orders??[]).filter(o=>o.ackAt&&o.algoId);if(!acknowledgements.length){nativeProofs.push(false);continue;}for(const o of acknowledgements){if(nativeProofs.length>=20)throw Error('NATIVE_HISTORY_SCOPE_TOO_LARGE');const ack=await readVenue({...config,command:{action:'v17_query_stop',symbol:p.symbol,clientAlgoId:o.clientId}});nativeProofs.push(nativeAckMatches(p,o,ack));ev['native_'+o.clientId]=ack;}}
 const after=await state();authority(after);const failures=[...holdings.failures,...trades.failures];
 if(executionIdentity(before)!==executionIdentity(after))failures.push('EXECUTION_TRUTH_CHANGED_DURING_READ');
 if(after.runtime.circuit_open||after.runtime.incident_id&&after.runtime.incident_resolved_at==null)failures.push('OPEN_ACCOUNT_INCIDENT');
 if(!after.scheduler.recovery_complete||after.scheduler.recovered_postmaster_at!==after.postmaster)failures.push('POSTMASTER_RECOVERY_UNPROVEN');
 if(!balance.matched)failures.push('SETTLED_WALLET_RECONCILIATION_UNPROVEN');
 if(!before.new_positions.length||!nativeProofs.length||nativeProofs.some(x=>!x))failures.push('NATIVE_HARD_STOP_HISTORY_UNPROVEN');
 ev.account={portfolio,openOrders,mode,history,holdings,trades,balance};ev.after=after;
 const summary={utc:new Date().toISOString(),status:failures.length?'FILL_PROOF_PENDING':'REAL_FILL_VERIFIED',failures:[...new Set(failures)],new_entry_fills:before.new_fills.length,new_positions:before.new_positions.length,holdings,trades,balance,native_acknowledgements_verified:nativeProofs.filter(Boolean).length,provider_calls:after.provider_calls,postmaster:after.postmaster,order_commands:0};note(summary);return failures.length===0;
}
try{seal();if(operation==='venue-evidence')await venueEvidence();else if(operation==='quote-evidence')await quoteEvidence();else if(operation==='revalidation-evidence')await revalidationEvidence();else{const end=Date.now()+minutes*60000;let complete=false;while(Date.now()<end){complete=await fillObservation();if(complete)break;await new Promise(r=>setTimeout(r,30000));}if(!complete){note({utc:new Date().toISOString(),status:'REAL_FILL_NOT_VERIFIED_WITHIN_WINDOW',order_commands:0});process.exitCode=3;}}}
catch(e){const error=/^[A-Z0-9_]+$/.test(e.message)?e.message:'RUNTIME_PROOF_READ_FAILED';note({utc:new Date().toISOString(),status:'BLOCKED',error,order_commands:0});process.exitCode=2;}
