-- Trading-booooo v5.4 — live-edge holding, asset-scoped pauses, operator-set limits.
--
-- Three changes, each removing something that was decided in code rather than by the
-- operator, or that mistook the bot's own activity for a user's.

alter table public.trading_settings
  -- 1) The 30-minute forced exit is gone. It was a safety timeout from the original fixed
  --    +0.60%/-0.30% barrier, not a profit rule. Absolute time now only guards against a
  --    stuck ledger, at a horizon the operator sets.
  add column if not exists scalp_safety_ttl_minutes integer not null default 360,
  -- Half-life of the entry signal's contribution to the holding probability. Time is a
  -- confidence decay, not a trigger.
  add column if not exists scalp_hold_alpha_half_life_minutes integer not null default 12,
  -- Edge required to keep occupying a slot once past the expected resolution time.
  add column if not exists scalp_hold_min_edge_after_expected numeric not null default 0.0005,
  -- Live top-of-book imbalance at or below this counts as an orderbook reversal.
  add column if not exists scalp_hold_reversal_imbalance numeric not null default -0.25,
  add column if not exists scalp_hold_reversal_confirmations integer not null default 2,
  -- 2) Assets paused by reconciliation. A confirmed mismatch on ONE coin no longer halts
  --    every market on both exchanges; it pauses that coin.
  add column if not exists manual_asset_locks jsonb not null default '[]'::jsonb,
  -- 3) Use the account's real commission rate instead of the hardcoded list price.
  add column if not exists scalp_use_live_fees boolean not null default true;

alter table public.trading_settings
  add constraint trading_settings_scalp_safety_ttl_ck
    check (scalp_safety_ttl_minutes between 10 and 10080) not valid,
  add constraint trading_settings_scalp_hold_half_life_ck
    check (scalp_hold_alpha_half_life_minutes between 1 and 240) not valid,
  add constraint trading_settings_scalp_hold_reversal_ck
    check (scalp_hold_reversal_confirmations between 1 and 10) not valid;

alter table public.trading_settings validate constraint trading_settings_scalp_safety_ttl_ck;
alter table public.trading_settings validate constraint trading_settings_scalp_hold_half_life_ck;
alter table public.trading_settings validate constraint trading_settings_scalp_hold_reversal_ck;

-- Operator-facing limits. These already existed as columns but were effectively decided by
-- code defaults; the constraints make the allowed dashboard range explicit.
alter table public.trading_settings
  add constraint trading_settings_max_new_entries_per_scan_ck
    check (max_new_entries_per_scan between 1 and 4) not valid;
alter table public.trading_settings validate constraint trading_settings_max_new_entries_per_scan_ck;

-- Clear any halt that the pre-v5.4 reconciliation raised against the bot's own resting
-- orders. That bug set manual_intervention_required from a locked-but-present balance,
-- which stopped new entries system-wide; those flags are not evidence of anything.
update public.trading_settings
   set manual_intervention_required = false,
       manual_event_reason = null,
       pause_new_entries = case
         when manual_event_reason like 'SAFETY_POSITION_MISMATCH:%' then false
         else pause_new_entries
       end,
       updated_at = now()
 where id = 1
   and manual_intervention_required
   and manual_event_reason like 'SAFETY_POSITION_MISMATCH:%';

-- Positions carrying a stale 30-minute max_holding_at would be force-sold on the next
-- monitor tick under the old meaning of that column. Re-base open positions onto the
-- operator's safety TTL so the new semantics apply immediately.
update public.trading_positions p
   set max_holding_at = greatest(
         coalesce(p.opened_at, p.created_at) + make_interval(mins => s.scalp_safety_ttl_minutes),
         now() + interval '10 minutes'
       )
  from public.trading_settings s
 where s.id = 1
   and p.state = 'OPEN'
   and s.strategy = 'SCALP'
   and p.max_holding_at < now() + make_interval(mins => s.scalp_safety_ttl_minutes / 2);

update public.trading_settings set updated_at = now() where id = 1;
