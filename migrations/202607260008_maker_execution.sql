-- Trading-booooo v5.5 — maker execution.
--
-- WHY
-- ---
-- Every version through v5.4 was a taker on both legs: the entry was a LIMIT IOC priced at
-- the ask, and the exit was a MARKET order. A taker PAYS the spread twice per round trip,
-- so the true cost was `fees + spread`, not `fees`.
--
-- On Upbit that is about 0.17% against a 0.10% fee schedule. The nine live trades of
-- 2026-07-26 had a median absolute price move of 0.109% — smaller than the cost they were
-- paying. Two of them moved in the right direction (+0.036%, +0.220%) and still finished
-- at -0.19% and +0.01%. They could not have won.
--
-- Posting both legs inverts the sign of the spread term: cost becomes `fees - spread`.
-- Upbit and Binance price makers and takers identically, so that swing is the entire
-- improvement — and it is larger than anything available from tuning the signal.
--
--   Upbit round trip:    taker 0.170%  ->  maker 0.070%   (2.4x)
--   Binance (BNB):       taker 0.220%  ->  maker 0.120%   (1.8x)
--
-- It also raises the REALIZED win rate, not merely the threshold. Entering one spread
-- lower puts the target one spread closer and the stop one spread further, measured from
-- where the market actually trades. At a 0.05% spread on a 0.6%/0.3% barrier pair the
-- neutral win rate moves 33.3% -> 38.9% on the entry leg, and the resting take-profit
-- repeats the effect on the exit leg.

-- Columns that only ever existed as code-level settings.
--
-- scalp_resting_tp was introduced in v5.3 as an env/default setting and a matching column
-- was never created, so statement 5 below ("set scalp_resting_tp = true") failed with
-- SQLSTATE 42703 and took the whole deploy with it. scalp_minimum_edge and
-- scalp_maker_slippage_allowance have the same gap: the code reads them and silently falls
-- back to a default, so they were invisible until something referenced them in SQL — and
-- they cannot be changed from the dashboard at all.
alter table public.trading_settings
  add column if not exists scalp_resting_tp boolean not null default true,
  add column if not exists scalp_minimum_edge numeric not null default 0.001,
  add column if not exists scalp_maker_slippage_allowance numeric not null default 0.0003;

alter table public.trading_settings
  -- Post the entry on the bid instead of taking the ask.
  add column if not exists scalp_maker_entry boolean not null default true,
  -- How long a resting entry waits before being abandoned. An unfilled maker quote costs
  -- nothing, so this is a patience setting rather than a risk setting.
  add column if not exists scalp_maker_entry_ttl_seconds integer not null default 90,
  -- Cancel early once the book has walked this many ticks above our resting bid.
  add column if not exists scalp_maker_entry_drift_ticks integer not null default 3,
  -- Spread assumed earned per round trip when sizing barriers. Live spread is measured per
  -- symbol at order time; this is only the sizing input.
  add column if not exists scalp_spread_capture numeric not null default 0.0005;

-- Idempotent: a migration that failed partway must be safe to re-push.
alter table public.trading_settings drop constraint if exists trading_settings_maker_entry_ttl_ck;
alter table public.trading_settings drop constraint if exists trading_settings_maker_drift_ticks_ck;
alter table public.trading_settings drop constraint if exists trading_settings_spread_capture_ck;
alter table public.trading_settings
  add constraint trading_settings_maker_entry_ttl_ck
    check (scalp_maker_entry_ttl_seconds between 5 and 900) not valid,
  add constraint trading_settings_maker_drift_ticks_ck
    check (scalp_maker_entry_drift_ticks between 1 and 50) not valid,
  add constraint trading_settings_spread_capture_ck
    check (scalp_spread_capture >= 0 and scalp_spread_capture <= 0.005) not valid;

alter table public.trading_settings validate constraint trading_settings_maker_entry_ttl_ck;
alter table public.trading_settings validate constraint trading_settings_maker_drift_ticks_ck;
alter table public.trading_settings validate constraint trading_settings_spread_capture_ck;

-- The resting take-profit is the maker EXIT leg. It was shipped in v5.3 defaulted off for
-- a cautious trial; under maker execution it is no longer optional, because a MARKET exit
-- hands back exactly the spread the maker entry just earned.
update public.trading_settings
   set scalp_resting_tp = true
 where id = 1
   and coalesce(scalp_resting_tp, false) = false;

-- Barriers no longer need the width that taker costs forced. With the spread earned rather
-- than paid, the required excess win rate at 0.6%/0.3% falls from 32.2pp to about 13.3pp,
-- so the original scalping geometry becomes viable again and holding times come back down.
update public.trading_settings
   set scalp_max_holding_minutes = least(coalesce(scalp_max_holding_minutes, 120), 60),
       updated_at = now()
 where id = 1
   and strategy = 'SCALP';

update public.trading_settings set updated_at = now() where id = 1;
