-- Trading-booooo v6.10.0 r7 — VERIFIED PAYOFF GOVERNOR
--
-- Adds bounded economic-entry controls only. Operator loss rails, exchange permissions,
-- spot-only rules, withdrawal/transfer bans and emergency exits are untouched.

alter table public.trading_settings
  add column if not exists lob_min_target_net_profit_bps numeric not null default 2,
  add column if not exists lob_min_verified_ev_cushion_bps numeric not null default 0.5,
  add column if not exists lob_max_stop_to_target_ratio numeric not null default 1.35,
  add column if not exists lob_min_net_reward_risk_ratio numeric not null default 0.80;

alter table public.trading_settings
  drop constraint if exists trading_settings_lob_min_target_net_profit_bps_ck,
  drop constraint if exists trading_settings_lob_min_verified_ev_cushion_bps_ck,
  drop constraint if exists trading_settings_lob_max_stop_to_target_ratio_ck,
  drop constraint if exists trading_settings_lob_min_net_reward_risk_ratio_ck;

alter table public.trading_settings
  add constraint trading_settings_lob_min_target_net_profit_bps_ck
    check (lob_min_target_net_profit_bps between 0 and 20) not valid,
  add constraint trading_settings_lob_min_verified_ev_cushion_bps_ck
    check (lob_min_verified_ev_cushion_bps between 0 and 20) not valid,
  add constraint trading_settings_lob_max_stop_to_target_ratio_ck
    check (lob_max_stop_to_target_ratio between 0.75 and 5) not valid,
  add constraint trading_settings_lob_min_net_reward_risk_ratio_ck
    check (lob_min_net_reward_risk_ratio between 0.10 and 5) not valid;

alter table public.trading_settings
  validate constraint trading_settings_lob_min_target_net_profit_bps_ck;
alter table public.trading_settings
  validate constraint trading_settings_lob_min_verified_ev_cushion_bps_ck;
alter table public.trading_settings
  validate constraint trading_settings_lob_max_stop_to_target_ratio_ck;
alter table public.trading_settings
  validate constraint trading_settings_lob_min_net_reward_risk_ratio_ck;

comment on column public.trading_settings.lob_min_target_net_profit_bps is
  'Minimum target profit remaining after round-trip fees, slippage and latency. Runtime also applies a bounded fee-proportional floor.';
comment on column public.trading_settings.lob_min_verified_ev_cushion_bps is
  'Minimum fill-conditional EV lower-bound cushion. Runtime also applies a bounded fee-proportional floor.';
comment on column public.trading_settings.lob_max_stop_to_target_ratio is
  'Maximum noise-aware gross stop distance divided by target distance. The stop is never narrowed to satisfy this; the trade is skipped.';
comment on column public.trading_settings.lob_min_net_reward_risk_ratio is
  'Minimum fee-adjusted target reward divided by fee-adjusted stop loss.';

-- Preserve user settings. The migration must never alter allocation, loss rails, enabled
-- exchanges, emergency controls or configured slot count.
