begin;

-- Align identity only. Trading thresholds, sizing, entry gates and emergency exits are unchanged.
update public.trading_ops_invariants
set canonical_engine_revision = '7.5.3-RECOVERY-NET-POSITIVE',
    updated_at = now()
where id = 1;

update public.trading_settings
set lob_live_admission_revision = '7.5.3-RECOVERY-NET-POSITIVE',
    lob_model_revision = '7.5.3-RECOVERY-NET-POSITIVE',
    version = version + 1,
    updated_at = now()
where id = 1;

-- market-autotrader's final executable re-quote uses the legacy positive-net label.
-- In recovery mode normalize only that label back to the recovery contract before
-- the existing zzzzz residual guard runs. The guard's projected TOTAL net PnL > 0
-- check remains authoritative and unchanged.
create or replace function public.normalize_recovery_exit_reason_v753()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_metadata jsonb;
  v_recovery_mode boolean;
  v_approved_reason text;
  v_pending_reason text;
begin
  if upper(coalesce(new.side, '')) <> 'SELL' or new.position_id is null then
    return new;
  end if;

  select coalesce(metadata, '{}'::jsonb)
    into v_metadata
  from public.trading_positions
  where id = new.position_id;

  if not found then
    return new;
  end if;

  v_recovery_mode := lower(coalesce(v_metadata#>>'{recovery_exit,enabled}', 'false')) = 'true';
  v_approved_reason := coalesce(v_metadata#>>'{exit_policy_quote,approved_reason}', '');
  v_pending_reason := coalesce(v_metadata->>'pending_exit_reason', '');

  if v_recovery_mode
     and v_approved_reason = 'POSITIVE_NET_AFTER_180S'
     and v_pending_reason = 'RECOVERY_NET_POSITIVE_EXIT' then
    update public.trading_positions
    set metadata = jsonb_set(
          coalesce(metadata, '{}'::jsonb),
          '{exit_policy_quote,approved_reason}',
          to_jsonb('RECOVERY_NET_POSITIVE_EXIT'::text),
          true
        ),
        updated_at = now()
    where id = new.position_id;
  end if;

  return new;
end;
$function$;

drop trigger if exists zzzz0_trading_orders_normalize_recovery_reason_v753
  on public.trading_orders;
create trigger zzzz0_trading_orders_normalize_recovery_reason_v753
before insert on public.trading_orders
for each row
execute function public.normalize_recovery_exit_reason_v753();

-- Keep status/UI metadata on the same revision as the authoritative exit policy.
create or replace function public.sync_active_exit_revision_v753()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_revision text;
begin
  if new.state not in ('OPEN','EXITING') then
    return new;
  end if;

  v_revision := nullif(coalesce(new.metadata, '{}'::jsonb)->>'exit_policy_revision', '');
  if v_revision = '7.5.3-RECOVERY-NET-POSITIVE' then
    new.metadata := jsonb_set(
      coalesce(new.metadata, '{}'::jsonb),
      '{active_exit_revision}',
      to_jsonb(v_revision),
      true
    );
  end if;
  return new;
end;
$function$;

drop trigger if exists zzzzzz_trading_positions_sync_exit_revision_v753
  on public.trading_positions;
create trigger zzzzzz_trading_positions_sync_exit_revision_v753
before insert or update on public.trading_positions
for each row
execute function public.sync_active_exit_revision_v753();

do $verify$
declare
  v_canonical text;
  v_normalizer_name text;
  v_guard_name text;
begin
  select canonical_engine_revision into v_canonical
  from public.trading_ops_invariants where id = 1;
  if v_canonical is distinct from '7.5.3-RECOVERY-NET-POSITIVE' then
    raise exception 'canonical engine revision mismatch: %', v_canonical;
  end if;

  select min(tgname) filter (where tgname like '%normalize_recovery_reason_v753%'),
         min(tgname) filter (where tgname = 'zzzzz_trading_orders_residual_exit_v751')
    into v_normalizer_name, v_guard_name
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'trading_orders' and not t.tgisinternal;

  if v_normalizer_name is null or v_guard_name is null or v_normalizer_name >= v_guard_name then
    raise exception 'recovery reason normalizer trigger ordering invalid: normalizer=%, guard=%',
      v_normalizer_name, v_guard_name;
  end if;
end;
$verify$;

commit;
