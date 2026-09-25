// Shared fixtures for the LE-SHADOW-1 tests: a PGlite database with minimal stand-ins for the
// production tables the shadow reads, the real shadow_le migration applied on top, and a fake
// Binance/OpenAI world that records every request. Not a test file itself.
import {readFileSync,readdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {klines} from '../development/gpt-final-decision/tests/fixtures.mjs';
import {makeStore} from '../supabase/functions/leader-emerging-shadow/store.mjs';

export const MIN=60_000;
const MIG_DIR=new URL('../supabase/migrations/',import.meta.url);
export function migration(kind){
  const f=readdirSync(MIG_DIR).filter(n=>n.endsWith('_leader_emerging_shadow_'+kind+'.sql')).sort();
  if(f.length!==1)throw Error('migration not found: '+kind+' '+JSON.stringify(f));
  return readFileSync(new URL(f[0],MIG_DIR),'utf8');
}

export const PRODUCTION_STUBS=`
create role anon; create role authenticated; create role service_role;
create schema extensions;
create function extensions.gen_random_bytes(n int) returns bytea language sql as $$ select decode(repeat(md5(random()::text), 2), 'hex') $$;
create table public.market_regime_observations(id uuid primary key default gen_random_uuid(), observation_bucket timestamptz unique, observed_at timestamptz,
  model_revision text, predicted_regime text, bull_score double precision, confidence double precision, sample_size int, features jsonb,
  benchmark_prices jsonb, liquid_prices jsonb, trading_influence boolean, created_at timestamptz default now());
create table public.v17_market_scan_runs(id bigint generated always as identity primary key, captured_at timestamptz, strategy text, signal_close_at timestamptz, details jsonb);
create table public.v11_cec0040_state(singleton boolean primary key, ewma_usdt numeric, training_count int, reject_run int, updated_at timestamptz);
insert into public.v11_cec0040_state values (true, -4.07, 126, 0, now());
create table public.v11_long_regime_signals(id uuid primary key default gen_random_uuid(), symbol text, status text, reject_reason text, features jsonb, created_at timestamptz default now(), updated_at timestamptz default now());
create table public.v11_long_regime_orders(id uuid primary key default gen_random_uuid(), symbol text, intent text, state text, created_at timestamptz default now());
create table public.v11_long_regime_positions(id uuid primary key default gen_random_uuid(), symbol text, state text, entry_price numeric, entry_at timestamptz, realized_pnl_usdt numeric);
create table public.gpt_final_entry_reviews(job_key text primary key, purpose text, symbol text, decision text, valid boolean, error text, attempted boolean, record jsonb, created_at timestamptz default now());
create table public.gpt_final_review_daily_budget(utc_day date primary key, calls int, reserved_usd numeric, settled_usd numeric);
create table public.trading_settings(id smallint primary key, binance_futures_allocation_usdt numeric);
insert into public.trading_settings values (1, 200);
create function public.v11_cec0040_decide() returns int language sql as $$ select 1 $$;
do $$ declare t text; begin foreach t in array array['market_regime_observations','v17_market_scan_runs','v11_cec0040_state','v11_long_regime_signals',
  'v11_long_regime_orders','v11_long_regime_positions','gpt_final_entry_reviews','gpt_final_review_daily_budget','trading_settings'] loop
  execute format('alter table public.%I enable row level security', t); end loop; end $$;
`;

export async function pglite(){
  const dep=process.env.PGLITE_MODULE;
  if(!dep)throw Error('Set PGLITE_MODULE to the installed @electric-sql/pglite/dist/index.js');
  const {PGlite}=await import(pathToFileURL(dep).href);
  return PGlite;
}

/** Fresh DB: stubs + schema migration. Returns {pg, store (as shadow_le_writer), admin}. */
export async function setupDb(){
  const PGlite=await pglite(),pg=new PGlite();
  await pg.exec(PRODUCTION_STUBS);
  await pg.exec('begin;'+migration('schema')+'commit;');
  await pg.exec('begin;'+migration('compare_index')+'commit;');
  // every store statement runs AS the writer role, exactly like production
  const asWriter={query:async(text,params)=>{
    await pg.exec('set role shadow_le_writer');
    try{return (await pg.query(text,params)).rows;}finally{await pg.exec('reset role');}
  }};
  const admin={query:async(text,params)=>(await pg.query(text,params)).rows};
  return {pg,store:makeStore(asWriter),writer:asWriter,admin};
}

export const OBS_REV='MARKET-REGIME-OBSERVER-v2-C01-HYSTERESIS-v1-FULLMARKET';
export async function addObserver(admin,at,prices){
  await admin.query(`insert into public.market_regime_observations(observation_bucket, observed_at, model_revision, liquid_prices) values ($1,$2,$3,$4)`,
    [new Date(Math.floor(at/300000)*300000+2000).toISOString(),new Date(at).toISOString(),OBS_REV,JSON.stringify(Object.fromEntries(Object.entries(prices).map(([s,p])=>['BF:'+s,p])))]);
}

export function symbols(n){return Array.from({length:n},(_,i)=>'C'+String(i).padStart(3,'0')+'USDT');}

/** Fake Binance + OpenAI. Every request is recorded; `opts` tweak depth/weight/status. */
export function world({usedWeight=50,status=200,depth=null,openai=null,exchangeSymbols=null}={}){
  const calls=[];
  const book=depth??{bids:[[1.199,5000],[1.198,5000]],asks:[[1.2,5000],[1.201,5000],[1.202,5000]]};
  const fetchFn=async(url,init={})=>{
    const u=new URL(url);calls.push({host:u.hostname,path:u.pathname,q:Object.fromEntries(u.searchParams),method:init.method??'GET'});
    if(u.hostname==='api.openai.com'){if(!openai)return new Response('{}',{status:500});return openai(JSON.parse(init.body));}
    const h={'x-mbx-used-weight-1m':String(typeof usedWeight==='function'?usedWeight(calls.length):usedWeight)};
    if(status!==200)return new Response('{}',{status,headers:h});
    const p=u.pathname,lim=Number(u.searchParams.get('limit')),iv=u.searchParams.get('interval');
    const end=u.searchParams.has('endTime')?Number(u.searchParams.get('endTime'))+1:Date.now();
    const J=x=>new Response(JSON.stringify(x),{status:200,headers:h});
    if(p==='/fapi/v1/exchangeInfo')return J({symbols:(exchangeSymbols??[]).map(s=>({symbol:s,status:'TRADING',contractType:'PERPETUAL',quoteAsset:'USDT',underlyingType:'COIN',onboardDate:0}))});
    if(p==='/fapi/v1/klines'){
      const step={'1m':MIN,'5m':5*MIN,'15m':15*MIN}[iv];
      if(u.searchParams.has('startTime')&&!u.searchParams.has('endTime')){const s=Number(u.searchParams.get('startTime'));return J(klines(lim,step,s+lim*step));}
      return J(klines(lim,step,end,{step:u.searchParams.get('symbol')==='BTCUSDT'?.0001:.001}));
    }
    if(p==='/futures/data/openInterestHist')return J(Array.from({length:13},(_,i)=>({timestamp:Math.floor(Date.now()/300000)*300000-(12-i)*300000,sumOpenInterest:1000+i,sumOpenInterestValue:5e6})));
    if(p==='/fapi/v1/premiumIndexKlines')return J([[Math.floor(end/MIN)*MIN-MIN,'0','0','0','0.0002','0',Math.floor(end/MIN)*MIN-1]]);
    if(p==='/fapi/v1/premiumIndex')return J({lastFundingRate:'0.0001'});
    if(p==='/fapi/v1/depth')return J(book);
    if(p==='/fapi/v1/ticker/price')return J((exchangeSymbols??[]).map((s,i)=>({symbol:s,price:String(1+i/1000)})));
    return new Response('no',{status:404});
  };
  return {fetchFn,calls};
}
