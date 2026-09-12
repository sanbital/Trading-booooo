-- v6.11.2: admission policy rejections are expected control decisions, not engine faults.
--
-- The autotrader wrapper records any thrown database error as ERROR/ENTRY_ERROR. The
-- admission trigger deliberately throws before an order exists, so normalize only the
-- explicit LOB_ADMISSION_REJECT prefix. Real database, gateway and reconciliation failures
-- remain untouched and critical.

create or replace function public.normalize_lob_admission_decision_v6112()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.outcome = 'ERROR'
     and coalesce(new.reason, '') like '%LOB_ADMISSION_REJECT%'
  then
    new.outcome := 'REJECTED';
    new.audit := coalesce(new.audit, '{}'::jsonb) || jsonb_build_object(
      'admission_rejected', true,
      'admission_revision', '6.11.2-ADAPTIVE-OPPORTUNITY'
    );
  end if;
  return new;
end;
$$;

create or replace function public.normalize_lob_admission_event_v6112()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.code = 'ENTRY_ERROR'
     and (
       coalesce(new.message, '') like '%LOB_ADMISSION_REJECT%'
       or coalesce(new.details::text, '') like '%LOB_ADMISSION_REJECT%'
     )
  then
    new.level := 'INFO';
    new.code := 'LOB_ADMISSION_REJECT';
    new.details := coalesce(new.details, '{}'::jsonb) || jsonb_build_object(
      'expected_policy_rejection', true,
      'admission_revision', '6.11.2-ADAPTIVE-OPPORTUNITY'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trading_decisions_normalize_lob_admission_v6112
  on public.trading_decisions;
create trigger trading_decisions_normalize_lob_admission_v6112
before insert or update of outcome, reason on public.trading_decisions
for each row
execute function public.normalize_lob_admission_decision_v6112();

drop trigger if exists trading_events_normalize_lob_admission_v6112
  on public.trading_events;
create trigger trading_events_normalize_lob_admission_v6112
before insert or update of level, code, message, details on public.trading_events
for each row
execute function public.normalize_lob_admission_event_v6112();

update public.trading_decisions
   set outcome = 'REJECTED',
       audit = coalesce(audit, '{}'::jsonb) || jsonb_build_object(
         'admission_rejected', true,
         'admission_revision', '6.11.2-ADAPTIVE-OPPORTUNITY'
       )
 where outcome = 'ERROR'
   and coalesce(reason, '') like '%LOB_ADMISSION_REJECT%';

update public.trading_events
   set level = 'INFO',
       code = 'LOB_ADMISSION_REJECT',
       details = coalesce(details, '{}'::jsonb) || jsonb_build_object(
         'expected_policy_rejection', true,
         'admission_revision', '6.11.2-ADAPTIVE-OPPORTUNITY'
       )
 where code = 'ENTRY_ERROR'
   and (
     coalesce(message, '') like '%LOB_ADMISSION_REJECT%'
     or coalesce(details::text, '') like '%LOB_ADMISSION_REJECT%'
   );

revoke all on function public.normalize_lob_admission_decision_v6112()
  from public, anon, authenticated;
revoke all on function public.normalize_lob_admission_event_v6112()
  from public, anon, authenticated;

comment on function public.normalize_lob_admission_decision_v6112() is
  'Classifies explicit pre-order admission vetoes as REJECTED while preserving genuine errors.';
