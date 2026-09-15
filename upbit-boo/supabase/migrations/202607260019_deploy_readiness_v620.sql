-- Trading-booooo v6.2.0-HEAT — deploy-time trading readiness.
--
-- THE PROBLEM THIS FIXES
-- ----------------------
-- Every release since v6.0 has ended its migration with `set mode = 'PAPER'`. The stated
-- reason was that the operator should re-enable live mode deliberately. The effect was that
-- each deploy silently disarmed the bot: the scanner kept ranking, the gateway kept
-- heartbeating, the dashboard looked healthy, and no order was placed until somebody
-- noticed and flipped the mode back. For a strategy whose entire premise is capital
-- turnover, a disarmed hour is not a safe default — it is the failure mode.
--
-- What replaces it: the deploy preserves whatever mode was already configured. Arming the
-- bot remains an explicit act, but it is an act performed once, not re-performed after
-- every deploy.
--
-- The kill switch, the daily loss ceiling and the consecutive-loss halt are untouched. This
-- migration changes only whether a *deploy* is allowed to stop trading by itself.

-- Preserve the operating mode across deploys. A first-ever install still lands on PAPER
-- because that is the column default from the original schema.
update public.trading_settings
   set updated_at = now()
 where id is not null;

-- Clear infrastructure pauses that no longer describe anything real. v5.9.1 made gateway
-- faults self-resume, but a pause written by a *previous build* survives the deploy that
-- fixed it, and then blocks entries forever with no event to say why.
--
-- Deliberately NOT cleared: account-reconciliation halts and operator halts. Those describe
-- a disagreement about real balances or an explicit human decision, and a deploy is not
-- evidence that either has been resolved.
update public.trading_settings
   set pause_new_entries = false,
       manual_event_reason = null,
       gateway_error_count = 0,
       gateway_recovery_cycles = 0,
       last_resume_at = now(),
       updated_at = now()
 where id = 1
   and pause_new_entries
   and coalesce(manual_event_reason, '') in ('SAFETY_GATEWAY_UNAVAILABLE', 'ENGINE_ERROR', '')
   and not manual_intervention_required
   and not withdrawal_mode
   and coalesce(jsonb_array_length(manual_asset_locks), 0) = 0;

-- Cold-start behaviour is a setting rather than a constant so it can be dialled without a
-- redeploy: how long after boot the first scan runs.
alter table public.trading_settings
  add column if not exists lob_cold_start_scan_seconds integer not null default 3;

alter table public.trading_settings drop constraint if exists trading_settings_lob_cold_start_ck;
alter table public.trading_settings
  add constraint trading_settings_lob_cold_start_ck
    check (lob_cold_start_scan_seconds between 1 and 120) not valid;
alter table public.trading_settings validate constraint trading_settings_lob_cold_start_ck;
