-- Trading-booooo v5.9.1 — infrastructure pauses recover on their own.
--
-- Three consecutive connectivity failures set pause_new_entries with the reason
-- SAFETY_GATEWAY_UNAVAILABLE. When the gateway came back, gateway_error_count reset to
-- zero on the next successful cycle — but the pause it had caused did not. The only path
-- that cleared it was an operator pressing resume, so a transient network blip stopped
-- trading indefinitely, with no event to say it was still stopped.
--
-- What failed decides whether it clears itself:
--   infrastructure (gateway unreachable) -> auto-resumes after N healthy cycles
--   account (balances do not reconcile)  -> still requires human review
--   operator intent (manual pause, withdrawal mode) -> never auto-cleared

alter table public.trading_settings
  add column if not exists gateway_recovery_cycles integer not null default 0,
  add column if not exists gateway_recovery_cycles_required integer not null default 3;

alter table public.trading_settings drop constraint if exists trading_settings_gateway_recovery_ck;
alter table public.trading_settings
  add constraint trading_settings_gateway_recovery_ck
    check (gateway_recovery_cycles_required between 1 and 20) not valid;
alter table public.trading_settings validate constraint trading_settings_gateway_recovery_ck;

-- Clear a pause currently latched by this bug. An account mismatch or an operator pause is
-- left exactly as it is.
update public.trading_settings
   set pause_new_entries = false,
       manual_event_reason = null,
       gateway_error_count = 0,
       gateway_recovery_cycles = 0,
       last_resume_at = now(),
       updated_at = now()
 where id = 1
   and pause_new_entries
   and coalesce(manual_event_reason, '') = 'SAFETY_GATEWAY_UNAVAILABLE'
   and not manual_intervention_required
   and not withdrawal_mode;
