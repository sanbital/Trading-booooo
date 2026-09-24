import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href);
const fixture=JSON.parse(readFileSync(new URL('./fixtures/closed-fills-20260924.json',import.meta.url)));
const sql=readFileSync(new URL('../supabase/migrations/20260924143851_fd1_retry_journal_accounting.sql',import.meta.url),'utf8');
const encodingSql=readFileSync(new URL('../supabase/migrations/20260924144625_fd1_journal_symbol_encoding.sql',import.meta.url),'utf8');
const original=readFileSync(new URL('../supabase/migrations/20260924090000_fd1_execution_retry_missed_journal.sql',import.meta.url),'utf8');
async function setup(){
  const pg=new PGlite();
  await pg.exec(`create role anon;create role authenticated;create role service_role;create schema cron;
    create table cron.jobs(name text primary key,schedule text,command text);
    create function cron.schedule(text,text,text) returns integer language plpgsql as $$begin
      insert into cron.jobs values($1,$2,$3) on conflict(name) do update set schedule=excluded.schedule,command=excluded.command;return 1;end $$;
    create function public.missed_opportunity_sync(integer) returns integer language sql as $$select 0$$;
    create function public.http_set_curlopt(text,text) returns void language plpgsql as $$begin return;end$$;
    create table public.v11_long_regime_signals(id uuid primary key);
    create table public.v11_long_regime_runtime(singleton boolean primary key,last_accounting_settlement_at timestamptz);
    insert into public.v11_long_regime_runtime values(true,null);
    create table public.http_calls(url text);
    create function public.http_get(u text) returns table(status integer,content text) language plpgsql as $$
      declare t bigint;begin insert into http_calls values(u);t:=substring(u from 'startTime=([0-9]+)')::bigint;
      return query select 200,(select jsonb_agg(jsonb_build_array(t+i*60000,100,102,98,101,1,t+(i+1)*60000-1) order by i)::text
        from generate_series(0,59) i);end$$;
    create table public.v11_long_regime_positions(id uuid primary key,signal_id uuid,symbol text,side text,state text,
      original_quantity numeric,remaining_quantity numeric,entry_price numeric,entry_fee_usdt numeric,
      realized_pnl_usdt numeric,entry_at timestamptz,closed_at timestamptz,metadata jsonb);
    create table public.v11_long_regime_orders(id uuid primary key,signal_id uuid,position_id uuid,symbol text,
      exchange_order_id text,state text,request_payload jsonb);
  `);
  const fills=fixture.fills[0];const nums=new Set(['exchange_trade_id','price','quantity','quote_amount','fee_amount','fee_quote_amount','realized_pnl_quote',
    'realized_cost_quote','realized_proceeds_quote','inventory_quantity_after','inventory_cost_after']);
  await pg.exec('create table exchange_trade_fills('+Object.keys(fills).map(k=>`${k} ${k==='raw_response'?'jsonb':k==='is_maker'?'boolean':nums.has(k)?'numeric':k.endsWith('_at')?'timestamptz':k==='id'||/^(bot_order_id|position_id|v17_order_id|v17_position_id)$/.test(k)?'uuid':'text'}`).join(',')+')');
  await pg.exec(original.slice(original.indexOf('create table if not exists public.missed_opportunity_journal'),original.indexOf('create or replace function public.missed_opportunity_sync')));
  for(const [name,rows] of [['v11_long_regime_positions',fixture.positions],['v11_long_regime_orders',fixture.orders],['exchange_trade_fills',fixture.fills]]){
    await pg.query(`insert into ${name} select * from jsonb_populate_recordset(null::${name},$1::jsonb)`,[JSON.stringify(rows)]);
  }
  await pg.exec(sql);await pg.exec(sql);await pg.exec(encodingSql);await pg.exec(encodingSql);return pg;
}
test('CASE 19: production 33 PENDING fills reconcile from exact exchange receipts, retaining all losses and fees',async()=>{
  const pg=await setup();try{
    const before=(await pg.query('select jsonb_agg(to_jsonb(p) order by id) v from v11_long_regime_positions p')).rows[0].v;
    const proof=await pg.query('select symbol,v17_closed_fill_accounting_proven(id) ok from v11_long_regime_positions');
    assert.ok(proof.rows.every(x=>x.ok),JSON.stringify(proof.rows));
    assert.equal((await pg.query('select v17_reconcile_closed_fill_accounting(20) n')).rows[0].n,33);
    const settledAt=(await pg.query('select last_accounting_settlement_at from v11_long_regime_runtime')).rows[0].last_accounting_settlement_at;
    assert.ok(settledAt);
    assert.equal((await pg.query('select v17_reconcile_closed_fill_accounting(20) n')).rows[0].n,0);
    assert.deepEqual((await pg.query('select last_accounting_settlement_at from v11_long_regime_runtime')).rows[0].last_accounting_settlement_at,settledAt);
    assert.deepEqual((await pg.query('select jsonb_agg(to_jsonb(p) order by id) v from v11_long_regime_positions p')).rows[0].v,before);
    await pg.exec("update exchange_trade_fills set accounting_status='PENDING'");
    assert.equal((await pg.query("select count(*)::int n from exchange_trade_fills where accounting_status='ACCOUNTED'")).rows[0].n,33);
    await pg.exec("update exchange_trade_fills set fee_quote_amount=fee_quote_amount+1 where side='BUY'");
    assert.ok((await pg.query('select v17_closed_fill_accounting_proven(id) ok from v11_long_regime_positions')).rows.every(x=>!x.ok));
    await pg.exec('set role anon');await assert.rejects(pg.query('select v17_reconcile_closed_fill_accounting(20)'),/permission denied/);
  }finally{await pg.close();}
});
test('CASE 16-18: recent lane bypasses old backlog, horizons complete only when due, repeated calls idempotent',async()=>{
  const pg=await setup();try{
    await pg.exec(`insert into v11_long_regime_signals values ('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222');
      insert into missed_opportunity_journal(signal_id,symbol,candidate_at,reference_price,target_notional_usdt)
      values('11111111-1111-4111-8111-111111111111','OLDUSDT',date_trunc('minute',now())-interval '1 day',100,450),
      ('22222222-2222-4222-8222-222222222222','NEWUSDT',date_trunc('minute',now())-interval '16 minutes',100,450);`);
    assert.equal((await pg.query('select missed_opportunity_track(30) n')).rows[0].n,1);
    let rows=(await pg.query('select symbol,high_5m::float8,high_15m::float8,high_30m,close_60m,outcome_tracked_at from missed_opportunity_journal order by symbol')).rows;
    assert.equal(rows[0].symbol,'NEWUSDT');assert.equal(rows[0].high_5m,102);assert.equal(rows[0].high_15m,102);
    assert.equal(rows[0].high_30m,null);assert.equal(rows[0].outcome_tracked_at,null);assert.equal(rows[1].high_5m,null);
    assert.equal((await pg.query('select missed_opportunity_track(30) n')).rows[0].n,0);
    assert.equal((await pg.query('select missed_opportunity_track_lane(150,false) n')).rows[0].n,1);
    assert.equal((await pg.query("select count(*)::int n from missed_opportunity_journal where outcome_tracked_at is not null")).rows[0].n,1);
    assert.equal((await pg.query('select missed_opportunity_track_lane(150,false) n')).rows[0].n,0);
    await pg.exec("update missed_opportunity_journal set candidate_at=date_trunc('minute',now())-interval '61 minutes',next_track_at=null where symbol='NEWUSDT'");
    assert.equal((await pg.query('select missed_opportunity_track(30) n')).rows[0].n,1);
    const r=(await pg.query("select close_60m::float8,reconstructed_net_usdt::float8 net,outcome_tracked_at is not null done from missed_opportunity_journal where symbol='NEWUSDT'")).rows[0];
    assert.equal(r.close_60m,101);assert.equal(r.net,4.05);assert.equal(r.done,true);
  }finally{await pg.close();}
});

test('subminute horizons exclude pre-candidate extremes and use exact final boundary trades',async()=>{
  const pg=await setup();try{
    await pg.exec(`create or replace function public.http_get(u text) returns table(status integer,content text) language plpgsql as $$
      declare t bigint;begin insert into http_calls values(u);t:=substring(u from 'startTime=([0-9]+)')::bigint;
      if u like '%aggTrades%' then
        return query select 200,jsonb_build_array(jsonb_build_object('a',1,'T',t,'p',case when t%60000=0 then 104 else 103 end),
          jsonb_build_object('a',2,'T',t+1,'p',case when t%60000=0 then 97 else 99 end),
          jsonb_build_object('a',3,'T',t+2,'p',103))::text;
      else return query select 200,(select jsonb_agg(jsonb_build_array(t+i*60000,100,case when i=0 then 1000 else 102 end,
        case when i=0 then 1 else 98 end,101,1,t+(i+1)*60000-1) order by i)::text from generate_series(0,59) i);end if;end$$;
      insert into v11_long_regime_signals values ('33333333-3333-4333-8333-333333333333');
      insert into missed_opportunity_journal(signal_id,symbol,candidate_at,reference_price,target_notional_usdt)
      values('33333333-3333-4333-8333-333333333333','SUBUSDT',date_trunc('minute',now())-interval '61 minutes'+interval '10 seconds',100,450);`);
    assert.equal((await pg.query('select missed_opportunity_track(30) n')).rows[0].n,1);
    const r=(await pg.query('select high_60m::float8 hi,low_60m::float8 lo,close_60m::float8 cl,outcome_tracked_at is not null done from missed_opportunity_journal')).rows[0];
    assert.deepEqual(r,{hi:104,lo:97,cl:103,done:true});
    assert.equal((await pg.query('select count(*)::int n from http_calls')).rows[0].n,6);
  }finally{await pg.close();}
});

test('gapped candles fail closed with bounded backoff instead of completing a horizon',async()=>{
  const pg=await setup();try{
    await pg.exec(`create or replace function public.http_get(u text) returns table(status integer,content text) language sql as $$select 200,'[]'::text$$;
      insert into v11_long_regime_signals values ('44444444-4444-4444-8444-444444444444');
      insert into missed_opportunity_journal(signal_id,symbol,candidate_at,reference_price)
      values('44444444-4444-4444-8444-444444444444','GAPUSDT',date_trunc('minute',now())-interval '61 minutes',100);`);
    assert.equal((await pg.query('select missed_opportunity_track(30) n')).rows[0].n,0);
    const r=(await pg.query('select outcome_tracked_at,tracking_error,next_track_at>now() backoff,track_attempts from missed_opportunity_journal')).rows[0];
    assert.equal(r.outcome_tracked_at,null);assert.match(r.tracking_error,/INCOMPLETE_HORIZON/);
    assert.equal(r.backoff,true);assert.equal(r.track_attempts,1);
    await pg.query('select missed_opportunity_track(30)');
    assert.equal((await pg.query('select track_attempts from missed_opportunity_journal')).rows[0].track_attempts,1);
  }finally{await pg.close();}
});

test('Unicode Binance symbols are percent-encoded on both kline and boundary URLs',async()=>{
 const pg=await setup();try{
  const symbol='我踏马来了USDT';
  const r=(await pg.query('select missed_opportunity_url_symbol($1) encoded',[symbol])).rows[0];
  assert.equal(decodeURIComponent(r.encoded),symbol);assert.match(r.encoded,/^%e6%88%91/i);
  await pg.exec(`create or replace function public.http_get(u text) returns table(status integer,content text) language plpgsql as $$
    begin insert into http_calls values(u);return query select 200,'[]'::text;end$$;`);
  await pg.query('select missed_opportunity_boundary($1,10000,59999)',[symbol]);
  const url=(await pg.query('select url from http_calls')).rows[0].url;
  assert.ok(!url.includes(symbol));assert.equal(new URL(url).searchParams.get('symbol'),symbol);
  assert.match((await pg.query("select pg_get_functiondef('missed_opportunity_track_lane(integer,boolean)'::regprocedure) definition")).rows[0].definition,/missed_opportunity_url_symbol\(r.symbol\)/);
 }finally{await pg.close();}
});
