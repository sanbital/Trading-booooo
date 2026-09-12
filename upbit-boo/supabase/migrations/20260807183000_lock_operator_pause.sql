-- An explicit operator validation pause must not be cleared by scheduler recovery
-- or by a generic dashboard resume request. This guard does not alter any entry,
-- exit, sizing, TP, SL, or candidate-selection logic.

alter table public.trading_settings
  add column if not exists pause_lock_reason text;

create or replace function public.protect_operator_pause_lock()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  if old.pause_new_entries is true
     and old.pause_lock_reason is not null
     and new.pause_new_entries is false
     and new.pause_lock_reason is not null then
    raise exception 'operator pause is locked: %', old.pause_lock_reason
      using errcode = '55000';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_protect_operator_pause_lock on public.trading_settings;
create trigger trg_protect_operator_pause_lock
before update on public.trading_settings
for each row
execute function public.protect_operator_pause_lock();

comment on column public.trading_settings.pause_lock_reason is
  'When non-null while pause_new_entries=true, generic resume/auto-resume updates are rejected. Clear this field in the same controlled update that intentionally resumes trading.';
