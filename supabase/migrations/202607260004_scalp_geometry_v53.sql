-- Trading-booooo v5.3 — scalp barrier geometry, position slots, breakeven exit.
--
-- Background: v5.2.5 traded a fixed +0.60% / -0.30% barrier pair on every symbol and
-- sized every entry at the full available allocation. With Upbit round-trip cost around
-- 0.19% and Binance around 0.29%, that geometry required a win rate of 65.6% / 76.7%
-- against a neutral (no-alpha) rate of 33.3% — unreachable — while the sizing meant only
-- one position could ever be open. This migration adds the settings that fix both.

alter table public.trading_settings
  -- Capital is divided into this many concurrent positions. 1 reproduces v5.2.5.
  add column if not exists scalp_position_slots integer not null default 6,
  -- Excess win rate (over neutral) the signal is assumed to deliver. Lower => wider
  -- barriers => lower required win rate. This is the primary tuning knob.
  add column if not exists scalp_edge_budget numeric not null default 0.10,
  -- Target : stop ratio.
  add column if not exists scalp_reward_risk numeric not null default 2.0,
  -- Both-side stressed slippage assumed when SIZING barriers. Precise slippage is still
  -- simulated against the live book at order time.
  add column if not exists scalp_slippage_allowance numeric not null default 0.0009,
  -- Half-life for decaying scan-time alpha when the signal is re-priced at order time.
  add column if not exists scalp_alpha_half_life_ms integer not null default 20000,
  -- Move the effective stop to entry + round-trip fee once the first target is taken.
  add column if not exists scalp_breakeven_after_t1 boolean not null default true;

alter table public.trading_settings
  add constraint trading_settings_scalp_position_slots_ck
    check (scalp_position_slots between 1 and 20) not valid,
  add constraint trading_settings_scalp_edge_budget_ck
    check (scalp_edge_budget > 0 and scalp_edge_budget <= 0.30) not valid,
  add constraint trading_settings_scalp_reward_risk_ck
    check (scalp_reward_risk >= 1 and scalp_reward_risk <= 4) not valid;

alter table public.trading_settings validate constraint trading_settings_scalp_position_slots_ck;
alter table public.trading_settings validate constraint trading_settings_scalp_edge_budget_ck;
alter table public.trading_settings validate constraint trading_settings_scalp_reward_risk_ck;

-- The 30-minute ceiling was inherited from the fixed 0.60% target. Barrier widths are now
-- volatility-scaled and need proportionally more time; geometry.ts still sizes each
-- symbol's own horizon and this value is only the upper bound.
update public.trading_settings
   set scalp_max_holding_minutes = 120
 where id = 1
   and coalesce(scalp_max_holding_minutes, 0) <= 30;

update public.trading_settings set updated_at = now() where id = 1;
