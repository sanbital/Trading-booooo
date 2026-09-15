-- Trading-booooo v6.4.0
--
-- Three changes, all of them consequences of the 2026-07-26/27 incidents:
--
--   1. A balance difference worth less than ~10 USD is accounting noise. It gets a
--      notional tolerance instead of a quantity-only one, so fee dust and step-size
--      rounding stop being read as a human trading behind the bot.
--
--   2. A detected mismatch pauses NEW ENTRIES on the affected asset only. Existing
--      holdings continue to be managed and exited on market data. Previously the
--      position was skipped entirely by the monitor loop, which is how an Upbit ETH
--      position stayed open for 8h39m until it was sold by hand.
--
--   3. Self-correction applies itself. scalp_auto_tune_edge_budget has been measuring
--      and reporting since v5.9 with the write-back switched off, so the measurement
--      never reached the parameters it was measuring.

alter table public.trading_settings
  add column if not exists reconcile_dust_tolerance_krw  numeric not null default 14000,
  add column if not exists reconcile_dust_tolerance_usdt numeric not null default 10;

comment on column public.trading_settings.reconcile_dust_tolerance_krw is
  'Upbit: balance differences below this KRW value never pause an asset (~10 USD).';
comment on column public.trading_settings.reconcile_dust_tolerance_usdt is
  'Binance: balance differences below this USDT value never pause an asset.';

-- Keep the tolerance meaningful: it must sit above the exchange minimum order size
-- (a difference too small to trade back cannot be a manual trade) and below a size
-- that could hide a real position.
alter table public.trading_settings
  drop constraint if exists trading_settings_reconcile_dust_krw_check;
alter table public.trading_settings
  add constraint trading_settings_reconcile_dust_krw_check
  check (reconcile_dust_tolerance_krw between 0 and 100000);

alter table public.trading_settings
  drop constraint if exists trading_settings_reconcile_dust_usdt_check;
alter table public.trading_settings
  add constraint trading_settings_reconcile_dust_usdt_check
  check (reconcile_dust_tolerance_usdt between 0 and 100);

update public.trading_settings
   set reconcile_dust_tolerance_krw  = 14000,
       reconcile_dust_tolerance_usdt = 10
 where id = 1;

-- ---------------------------------------------------------------------------
-- Self-correction writes back now.
--
-- The guardrails were already built in v5.9 and are unchanged: the proposal uses the
-- lower bound of the confidence interval rather than the point estimate, shrinks toward
-- the prior by n/(n+400), and is clamped. What changes is that the result is applied
-- instead of only reported.
-- ---------------------------------------------------------------------------
update public.trading_settings
   set scalp_auto_tune_edge_budget = true
 where id = 1;

alter table public.trading_settings
  alter column scalp_auto_tune_edge_budget set default true;

-- ---------------------------------------------------------------------------
-- Clear the asset locks raised by the false positives this release fixes.
--
-- Operator pauses and withdrawal mode are deliberately left alone.
-- ---------------------------------------------------------------------------
update public.trading_settings
   set manual_asset_locks = '[]'::jsonb,
       manual_intervention_required = false,
       manual_event_reason = null
 where id = 1
   and coalesce(manual_event_reason, '') like 'SAFETY_POSITION_MISMATCH:%';

-- Stale per-position mismatch counters would re-escalate on the first cycle after
-- deploy even though the comparison they came from has been corrected.
update public.trading_positions
   set metadata = metadata
       - 'account_mismatch_count'
       - 'last_account_mismatch_at'
       - 'quote_miss_count'
 where state = 'OPEN'
   and metadata ? 'account_mismatch_count';
