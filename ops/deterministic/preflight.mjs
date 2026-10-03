// Read-only signed venue and DB evidence. Never invoke executor cycles, circuit
// recovery, machine exec, key-reveal APIs, migrations or any order command here.
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createCipheriv,publicEncrypt,randomBytes} from 'node:crypto';
import {readVenue,reconcileHoldings,reconcileTrades} from './preflight-read.mjs';
import {expectedGatewayCommit} from './gateway-source.mjs';
const project='etaajwpernzrcdrifdnw';
if(process.env.GITHUB_REPOSITORY!=='sanbital/Trading-booooo'||process.env.EXPECTED_COMMIT!==process.env.GITHUB_SHA||!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA??''))throw Error('PREFLIGHT_EXACT_COMMIT_REQUIRED');
const ev={version:'DETERMINISTIC_READ_ONLY_PREFLIGHT_1',source_commit:process.env.GITHUB_SHA,started_at:new Date().toISOString(),mutations:0,timing:{}};
function seal(){mkdirSync('infra-evidence',{recursive:true});const key=randomBytes(32),iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([c.update(JSON.stringify(ev)),c.final()]);
 writeFileSync('infra-evidence/deterministic-preflight.encrypted.json',JSON.stringify({version:1,key:publicEncrypt({key:readFileSync('ops/execution-infra/evidence-public.pem'),oaepHash:'sha256'},key).toString('base64'),iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),data:data.toString('base64')}));}
const query=`select jsonb_build_object('utc',now(),'postmaster',pg_postmaster_start_time(),
 'runtime',(select to_jsonb(r) from public.v11_long_regime_runtime r where singleton),
 'positions',(select coalesce(jsonb_agg(to_jsonb(p)),'[]') from public.v11_long_regime_positions p where state='OPEN' or remaining_quantity>0),
 'orders',(select coalesce(jsonb_agg(to_jsonb(o)-'request_payload'-'response_payload'),'[]') from public.v11_long_regime_orders o where state in ('PLANNED','DISPATCHED','SUBMITTING','PARTIALLY_FILLED','UNKNOWN','RECONCILIATION_PENDING','RECONCILIATION_FAILED')),
 'fills',(select coalesce(jsonb_agg(to_jsonb(f)-'raw_response'),'[]') from public.exchange_trade_fills f where exchange='binance_futures' and account_scope='futures' and executed_at>=now()-interval '24 hours'),
 'history_symbols',(select coalesce(jsonb_agg(symbol),'[]') from (select distinct market symbol from public.exchange_trade_fills where exchange='binance_futures' and account_scope='futures' and executed_at>=now()-interval '24 hours' union select distinct symbol from public.v11_long_regime_positions where state='OPEN' or closed_at>=now()-interval '24 hours')s),
 'account_snapshot',(select jsonb_build_object('captured_at',captured_at,'equity',total_equity_quote,'available',available_quote) from public.trading_account_snapshots where exchange='binance_futures' order by captured_at desc limit 1),
 'leader20',(select to_jsonb(c) from public.leader20_control c where singleton),
 'capture',(select to_jsonb(c)-'lease_owner' from doa_capture.control c where id=1),
 'capture_symbols',(select coalesce(jsonb_agg(symbol),'[]') from (select distinct symbol from doa_capture.live_micro where kind='micro' and at>=now()-interval '155 seconds')s),
 'top20_symbols',(select coalesce(jsonb_agg(m.symbol order by m.rank),'[]') from public.leader20_members m join public.leader20_control c on c.epoch_id=m.epoch_id where c.singleton and m.rank<=20),
 'executor_schedule',(select to_jsonb(j) from public.trading_scheduler_jobs j where scheduler_key='trading-production' and job_key='v11-long-regime-executor'),
 'deterministic_installed',to_regclass('public.deterministic_control') is not null) evidence`;
async function db(){const started=Date.now();const r=await fetch(`https://api.supabase.com/v1/projects/${project}/database/query`,{method:'POST',headers:{authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN,'content-type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error('PREFLIGHT_DB_HTTP_'+r.status);const rows=await r.json();ev.timing.db_roundtrip_ms=Date.now()-started;
 if(!Array.isArray(rows)||rows.length!==1||!rows[0].evidence)throw Error('PREFLIGHT_DB_INCOMPLETE');return rows[0].evidence;}
try{
 ev.before=await db();seal();
 const app=process.env.FLY_BINANCE_APP_NAME;
 if(!['trading-booooo','trading-booooo-sanbital-gateway'].includes(app))throw Error('PREFLIGHT_APP_CONFIG');
 const health=await fetch(`https://${app}.fly.dev/health`,{signal:AbortSignal.timeout(5000)});
 if(!health.ok)throw Error('PREFLIGHT_VENUE_HEALTH_UNAVAILABLE');ev.health=await health.json();
 const request=JSON.parse(readFileSync('ops/deterministic/release-request.json','utf8'));
 const config={app,token:process.env.LEARNING_ACCESS_TOKEN,commit:expectedGatewayCommit(request,app)};
 const started=Date.now();
 const [portfolio,openOrders,mode]=await Promise.all(['p10_portfolio','v18_open_orders','futures_position_mode'].map(action=>readVenue({...config,command:{action}})));
 ev.timing.signed_account_orders_mode_roundtrip_ms=Date.now()-started;ev.venue={portfolio,openOrders,mode};
 ev.holdings=reconcileHoldings({db:ev.before,portfolio,openOrders,mode});seal();
 console.log(JSON.stringify({stage:'SIGNED_HOLDINGS_READ',...ev.holdings}));
 const symbols=[...new Set([...ev.before.history_symbols,...portfolio.positions.map(p=>p.market)])].sort();
 if(symbols.length>30)throw Error('PREFLIGHT_HISTORY_SCOPE_TOO_LARGE');
 ev.history={};for(const market of symbols)ev.history[market]=await readVenue({...config,command:{action:'trade_history',market,limit:1000}});
 ev.trades=reconcileTrades(ev.before.fills,ev.history,Date.parse(ev.before.utc)-86400000);seal();
 ev.after=await db();
 const failures=[...ev.holdings.failures,...ev.trades.failures];
 if(ev.before.postmaster!==ev.after.postmaster||JSON.stringify(ev.before.positions)!==JSON.stringify(ev.after.positions)||JSON.stringify(ev.before.orders)!==JSON.stringify(ev.after.orders))failures.push('DB_TRUTH_CHANGED_DURING_READ');
 if(ev.after.runtime.circuit_open||ev.after.runtime.incident_resolved_at==null&&ev.after.runtime.incident_id)failures.push('OPEN_ACCOUNT_INCIDENT');
 if(ev.after.executor_schedule?.enabled!==true||ev.after.executor_schedule?.last_result==='HTTP_401')failures.push('PERIODIC_EXECUTOR_UNAVAILABLE');
 const missing=ev.after.top20_symbols.filter(s=>!ev.after.capture_symbols.includes(s));
 if(ev.after.top20_symbols.length!==20||missing.length)failures.push('TOP20_CAPTURE_INCOMPLETE');
 const snapshot=ev.before.account_snapshot;
 const balanceCompared=ev.holdings.exchange_positions===0&&ev.holdings.failures.length===0&&snapshot&&Date.parse(ev.before.utc)-Date.parse(snapshot.captured_at)<=120000;
 const balanceMatched=!!balanceCompared&&Math.abs(Number(snapshot.equity)-Number(portfolio.total_equity_quote))<=0.01&&Math.abs(Number(snapshot.available)-Number(portfolio.available_quote))<=0.01;
 if(!balanceMatched)failures.push('BALANCE_RECONCILIATION_UNPROVEN');
 ev.summary={utc:new Date().toISOString(),source_commit:ev.source_commit,production_gateway_commit:ev.health.deployment_commit,
  status:failures.length?'BLOCKED':'ACCOUNT_PREFLIGHT_PASSED',mutations:0,
  failures:[...new Set(failures)],holdings:ev.holdings,trades:ev.trades,balance_reconciled:balanceMatched,
  circuit_open:ev.after.runtime.circuit_open,incident_kind:ev.after.runtime.incident_kind,incident_generation:ev.after.runtime.incident_generation,
  active_strategy:ev.after.leader20.active_strategy,watch_limit:ev.after.leader20.watch_limit,top20_capture_missing:missing.length,
  deterministic_installed:ev.after.deterministic_installed,periodic_executor_enabled:ev.after.executor_schedule?.enabled,
  timing:ev.timing};seal();
 console.log(JSON.stringify(ev.summary));writeFileSync('infra-evidence/deterministic-preflight-summary.json',JSON.stringify(ev.summary,null,2));
 if(failures.length)process.exitCode=2;
}catch(e){ev.error=/^[A-Z0-9_]+$/.test(e.message)?e.message:'PREFLIGHT_READ_FAILED';seal();console.error(JSON.stringify({error:ev.error,mutations:0,holdings:ev.holdings??null}));process.exitCode=1;}
