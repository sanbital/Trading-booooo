-- V17 exit R5 — reproducible replay harness.
--
-- Run against the production project (etaajwpernzrcdrifdnw). Everything it creates is
-- prefixed zz_ and is dropped by the last section. It only READS trading tables; it never
-- writes to any v11_*, v17_*, trading_* or exchange_* table.
--
-- It needs the `http` extension, because Binance is reachable from Postgres but not from
-- the analysis container. Binance bans an IP for ~5 minutes at a few thousand request
-- weight per minute, so the loaders below are deliberately batched — do not widen them.
--
-- Sections:
--   1. loaders
--   2. in-sample replay of the real closed V17 positions
--   3. out-of-sample: reconstruct V17 entries from the scanner logic, then replay
--   4. teardown

-- ---------------------------------------------------------------- 1. loaders

create table if not exists zz_research_v17_k1m (
  symbol text not null, open_time bigint not null,
  o numeric, h numeric, l numeric, c numeric, v numeric, qv numeric,
  primary key (symbol, open_time));

create or replace function zz_load_k1m(p_symbol text, p_interval text, p_start bigint, p_limit int)
returns int language plpgsql as $$
declare rec jsonb; n int := 0; body text;
begin
  select content into body from http_get(
    'https://fapi.binance.com/fapi/v1/klines?symbol='||p_symbol||'&interval='||p_interval||
    '&startTime='||p_start||'&limit='||p_limit);
  if body is null or left(body,1) <> '[' then return -1; end if;   -- 418/429 ban, or an error object
  for rec in select * from jsonb_array_elements(body::jsonb) loop
    insert into zz_research_v17_k1m(symbol,open_time,o,h,l,c,v,qv)
    values (p_symbol,(rec->>0)::bigint,(rec->>1)::numeric,(rec->>2)::numeric,(rec->>3)::numeric,
            (rec->>4)::numeric,(rec->>5)::numeric,(rec->>7)::numeric)
    on conflict (symbol,open_time) do nothing;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Load every symbol V17 actually traded over the live window.
--   with syms as (select distinct symbol from v11_long_regime_positions
--                 where entry_at >= '2026-09-07T15:00:00Z')
--   select sum(zz_load_k1m(symbol,'1m',1788825600000,1500)) from syms;

-- ------------------------------------------- 2. in-sample replay of real V17 positions
--
-- Walks 1m bars from each real entry and applies a configurable stop ladder. Two peak
-- series are tracked, because the two roles need different data:
--   * pk_cl (bar closes) approximates what the one-minute monitor actually polls;
--   * pk_hi (bar highs) is the true excursion, used only to answer "would a
--     better-informed monitor help?" — it is NOT what production observes.
-- Ladder step types: abs = entry*(1+v); cap = entry+(peak-entry)*v; trail = peak*(1-v).
-- Each step takes "src": "close" (default for cap/trail) or "high" (default for abs).
--
-- Intrabar path model: up bar O->L->H->C, down bar O->H->L->C. On a down bar the high is
-- therefore allowed to ratchet the stop before the low tests it.
--
-- Fills: a stop fills at min(bar open, stop)*(1-slip_stop), so a bar that gaps through the
-- level fills at the gap, not at the level. Time exits fill at the close.

create or replace function zz_sim3(p jsonb, p_from timestamptz, p_to timestamptz)
returns table(pos_id uuid, symbol text, entry_at timestamptz, exit_at timestamptz,
              reason text, mfe_hi numeric, mfe_cl numeric, mae_pct numeric, ret_pct numeric,
              net_pnl numeric, hold_min numeric, data_edge boolean)
language plpgsql as $$
#variable_conflict use_variable
declare
  r record; b record; lad jsonb := p->'ladder'; step jsonb;
  base_stop numeric := (p->>'base_stop')::numeric;
  stale_min int := (p->>'stale_min')::int;
  max_hold_min int := (p->>'max_hold_min')::int;
  slip_stop numeric := coalesce((p->>'slip_stop')::numeric, 0.0008);
  slip_mkt numeric := coalesce((p->>'slip_mkt')::numeric, 0.0005);
  fee numeric := coalesce((p->>'fee_rate')::numeric, 0.0005);
  fail_after int := coalesce((p->>'fail_after_min')::int, 999999);
  fail_stop numeric := coalesce((p->>'fail_stop')::numeric, base_stop);
  fail_arm numeric := coalesce((p->>'fail_arm')::numeric, 0);
  fail_src text := coalesce(p->>'fail_src','high');
  pk_hi numeric; pk_cl numeric; stop numeric; last_high_ms bigint;
  m_hi numeric; m_cl numeric; trough numeric; src text; sm numeric; spk numeric; fm numeric;
  t0 bigint; fill numeric; rsn text; xat bigint; age numeric; lvl numeric; upbar boolean; lastbar bigint;
begin
  for r in
    select v.id vid, v.symbol vsym, v.entry_price ep, v.entry_at ea,
           v.original_quantity oq, v.entry_fee_usdt ef,
           (extract(epoch from v.entry_at)*1000)::bigint tms
    from v11_long_regime_positions v
    where v.metadata->>'executionMode'='LEADER_MOMENTUM_V17'
      and v.entry_at >= p_from and v.entry_at < p_to and v.state='CLOSED'
    order by v.entry_at
  loop
    t0 := r.tms; pk_hi := r.ep; pk_cl := r.ep; trough := r.ep;
    stop := r.ep*(1-base_stop); last_high_ms := t0; fill := null; rsn := null; xat := null;
    m_hi := 0; m_cl := 0;
    select max(k.open_time) into lastbar from zz_research_v17_k1m k where k.symbol=r.vsym;
    for b in
      select k.open_time ot, k.o,k.h,k.l,k.c from zz_research_v17_k1m k
      where k.symbol = r.vsym and k.open_time >= t0 and k.open_time < t0 + max_hold_min*60000
      order by k.open_time
    loop
      age := (b.ot - t0)/60000.0;
      fm := case when fail_src='high' then m_hi else m_cl end;
      if fm < fail_arm and age >= fail_after then stop := greatest(stop, r.ep*(1-fail_stop)); end if;
      upbar := b.c >= b.o;
      trough := least(trough, b.l);
      if not upbar and b.h > pk_hi then
        pk_hi := b.h; m_hi := pk_hi/r.ep - 1;
        for step in select * from jsonb_array_elements(lad) loop
          if coalesce(step->>'src', case when (step->>'type')='abs' then 'high' else 'close' end)='high'
             and m_hi >= (step->>'mfe')::numeric then
            lvl := case (step->>'type')
                     when 'abs'   then r.ep*(1+(step->>'v')::numeric)
                     when 'cap'   then r.ep + (pk_hi-r.ep)*(step->>'v')::numeric
                     when 'trail' then pk_hi*(1-(step->>'v')::numeric) end;
            stop := greatest(stop, lvl);
          end if;
        end loop;
      end if;
      if b.l <= stop then
        fill := least(b.o, stop) * (1-slip_stop);
        rsn := case when stop > r.ep*(1-base_stop)+r.ep*1e-12 then 'RATCHET_STOP' else 'HARD_STOP' end;
        xat := b.ot; exit;
      end if;
      if b.h > pk_hi then pk_hi := b.h; end if;
      if b.c > pk_cl then pk_cl := b.c; last_high_ms := b.ot; end if;
      m_hi := pk_hi/r.ep - 1; m_cl := pk_cl/r.ep - 1;
      for step in select * from jsonb_array_elements(lad) loop
        src := coalesce(step->>'src', case when (step->>'type')='abs' then 'high' else 'close' end);
        sm  := case when src='high' then m_hi else m_cl end;
        spk := case when src='high' then pk_hi else pk_cl end;
        if sm >= (step->>'mfe')::numeric then
          lvl := case (step->>'type')
                   when 'abs'   then r.ep*(1+(step->>'v')::numeric)
                   when 'cap'   then r.ep + (spk-r.ep)*(step->>'v')::numeric
                   when 'trail' then spk*(1-(step->>'v')::numeric) end;
          stop := greatest(stop, lvl);
        end if;
      end loop;
      if (b.ot - last_high_ms) >= stale_min*60000 then
        fill := b.c*(1-slip_mkt); rsn := 'MOMENTUM_STALE'; xat := b.ot; exit;
      end if;
    end loop;
    if fill is null then
      select k.c, k.open_time into fill, xat from zz_research_v17_k1m k
       where k.symbol=r.vsym and k.open_time < t0 + max_hold_min*60000 and k.open_time >= t0
       order by k.open_time desc limit 1;
      fill := fill*(1-slip_mkt); rsn := 'MAX_HOLD';
    end if;
    pos_id := r.vid; symbol := r.vsym; entry_at := r.ea; exit_at := to_timestamp(xat/1000.0);
    reason := rsn; mfe_hi := 100*m_hi; mfe_cl := 100*m_cl;
    mae_pct := 100*(trough/r.ep-1); ret_pct := 100*(fill/r.ep-1);
    net_pnl := r.oq*(fill-r.ep) - r.ef - fill*r.oq*fee;
    hold_min := (xat-t0)/60000.0;
    -- true when the position never exited inside the loaded data; exclude from aggregates
    data_edge := (rsn='MAX_HOLD' and xat >= lastbar - 60000);
    return next;
  end loop;
end $$;

-- Production ladder vs R5, on the real closed positions:
--
--   select * from zz_sim3(
--     '{"base_stop":0.025,"stale_min":45,"max_hold_min":360,
--       "ladder":[{"mfe":0.01,"type":"abs","v":0.002,"src":"close"},
--                 {"mfe":0.02,"type":"cap","v":0.5},{"mfe":0.03,"type":"trail","v":0.015}]}'::jsonb,
--     '2026-09-07T15:00:00Z','2026-09-10T00:00:00Z');
--
--   select * from zz_sim3(
--     '{"base_stop":0.025,"stale_min":45,"max_hold_min":360,
--       "fail_after_min":10,"fail_arm":0.01,"fail_stop":0.012,"fail_src":"close",
--       "ladder":[{"mfe":0.01,"type":"abs","v":-0.012,"src":"close"},
--                 {"mfe":0.02,"type":"cap","v":0.5},{"mfe":0.03,"type":"trail","v":0.015}]}'::jsonb,
--     '2026-09-07T15:00:00Z','2026-09-10T00:00:00Z');

-- ------------------------------------------------------- 3. out-of-sample entry replay
--
-- Re-implements leader-momentum-v17.mjs feature15/entryReason/confirm5 in SQL so the exit
-- change can be scored on entries V17 never took. Validate the reconstruction against the
-- live scanner before trusting it: at a cutoff present in v17_market_scan_runs, the
-- reconstructed dayret/volratio must match details->'top10' to ~5 decimals. Symbols with
-- CJK names cannot be URL-encoded by this loader and drop out (5 of 526).
--
--   zz_oos_symbols  universe from /fapi/v1/exchangeInfo (TRADING, PERPETUAL, USDT, COIN)
--   zz_oos_k15/k5/k1  klines, loaded by zz_load()
--   zz_oos_feat     feature15() over closed 15m bars, needs >= 110 bars of history
--   zz_oos_rank     rank by KST-day return, then entryReason()
--   zz_oos_entries  confirm5(): last closed 5m bar >= +0.2%, net up over 3 bars, close>=open
--   zz_oos_trades   executor admission proxy — at most one entry per 5m cycle (best rank),
--                   one entry per symbol per 60 min. Policy-independent on purpose, so both
--                   candidates score on an IDENTICAL entry set and only the exit differs.
--
-- The full DDL for these is in the session record; the shape that matters is that
-- zz_oos_trades holds (id, symbol, c5) and zz_sim_oos enters at the 1m open at c5+60s with
-- a fixed 120 USDT notional, then applies the same ladder as zz_sim3.

-- ---------------------------------------------------------------- 4. teardown

-- drop function if exists zz_sim3(jsonb,timestamptz,timestamptz);
-- drop function if exists zz_sim_oos(jsonb);
-- drop function if exists zz_load_k1m(text,text,bigint,int);
-- drop function if exists zz_load(text,text,text,bigint,int);
-- drop table if exists zz_research_v17_k1m, zz_research_v17_k1s,
--   zz_oos_k15, zz_oos_k5, zz_oos_k1, zz_oos_feat, zz_oos_rank,
--   zz_oos_entries, zz_oos_trades, zz_oos_symbols;
