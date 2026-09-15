-- Keep explicit pause locks protected from scheduler/automatic recovery while allowing
-- the dashboard's intentional operator resume path after successful reconciliation.
-- This changes control-plane pause handling only; trading strategy/risk logic is untouched.

create or replace function public.protect_operator_pause_lock()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  if old.pause_new_entries is true
     and old.pause_lock_reason is not null
     and new.pause_new_entries is false then

    -- A controlled caller may explicitly consume the lock in the same update.
    if new.pause_lock_reason is null then
      return new;
    end if;

    -- The explicit dashboard resume path runs reconciliation first, then bumps the
    -- settings version and stamps last_resume_at. Scheduler/automatic recovery does
    -- not bump version, so it cannot bypass an operator lock.
    if coalesce(new.version, 0) > coalesce(old.version, 0)
       and new.last_resume_at is distinct from old.last_resume_at
       and new.manual_event_reason is null
       and coalesce(new.emergency_liquidation, false) is false
       and coalesce(new.withdrawal_mode, false) is false
       and coalesce(new.manual_intervention_required, false) is false then
      new.pause_lock_reason := null;
      return new;
    end if;

    raise exception 'operator pause is locked: %', old.pause_lock_reason
      using errcode = '55000';
  end if;

  return new;
end;
$function$;
