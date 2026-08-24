begin;

-- `balances` is intentionally spot-shaped.  For Binance Futures it contains the USDT
-- margin row and compatibility inventory rows for LONG contracts only; a SHORT is never
-- an owned base asset.  Persist the gateway's signed, direction-aware position list as a
-- separate authenticated snapshot channel.  NULL/false is deliberate: an older Edge
-- Function that does not send these fields must fail closed (no SHORT reconciliation),
-- rather than treating its omitted data as an authoritative empty position set.
alter table public.trading_account_snapshots
  add column if not exists positions jsonb,
  add column if not exists positions_complete boolean not null default false,
  add column if not exists positions_revision text;

alter table public.trading_account_snapshots
  drop constraint if exists trading_account_snapshots_positions_shape_ck;
alter table public.trading_account_snapshots
  add constraint trading_account_snapshots_positions_shape_ck
  check (
    (
      positions_complete = false
      and (positions is null or jsonb_typeof(positions) = 'array')
    )
    or (
      positions_complete = true
      and positions is not null
      and jsonb_typeof(positions) = 'array'
      and positions_revision = '1-DIRECTIONAL-FUTURES-POSITIONS'
    )
  ) not valid;
alter table public.trading_account_snapshots
  validate constraint trading_account_snapshots_positions_shape_ck;

comment on column public.trading_account_snapshots.positions is
  'Authenticated gateway futures positions (market, side, quantity); separate from spot-shaped balances.';
comment on column public.trading_account_snapshots.positions_complete is
  'True only when positions is a complete gateway response; false prevents absence-based futures reconciliation.';
comment on column public.trading_account_snapshots.positions_revision is
  'Schema attestation for a complete direction-aware futures position snapshot.';

create or replace function public.reconcile_futures_zero_positions_from_snapshots()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  r record;
  v_recent_count integer;
  v_usable_count integer;
  v_zero_count integer;
  v_min_snapshot timestamptz;
begin
  if lower(coalesce(new.exchange, '')) <> 'binance_futures' then
    return new;
  end if;

  for r in
    select
      p.id,
      p.market,
      p.base_asset,
      p.opened_at,
      case
        when upper(coalesce(p.position_side, '')) = 'SHORT' then 'SHORT'
        else 'LONG'
      end as position_side,
      case
        when upper(coalesce(p.position_side, '')) = 'SHORT' then 'BUY'
        else 'SELL'
      end as exit_side
    from public.trading_positions p
    where lower(coalesce(p.exchange, '')) = 'binance_futures'
      and p.state in ('OPEN', 'EXITING')
      and coalesce(p.remaining_quantity, 0) > 0
      and not exists (
        select 1
        from public.trading_orders o
        where o.position_id = p.id
          and upper(coalesce(o.side, '')) = case
            when upper(coalesce(p.position_side, '')) = 'SHORT' then 'BUY'
            else 'SELL'
          end
          and upper(coalesce(o.purpose, '')) <> 'ENTRY'
          and (
            o.position_effect is null
            or upper(coalesce(o.position_effect, '')) = 'CLOSE'
          )
          and o.state not in ('APPLIED', 'CANCELLED', 'REJECTED', 'ERROR')
      )
  loop
    -- A legacy writer omits direction-aware positions.  It remains sufficient for the
    -- historic LONG balance reconciliation, but can never prove that a SHORT is zero.
    if r.position_side = 'SHORT'
       and (
         coalesce(new.positions_complete, false) = false
         or new.positions is null
         or jsonb_typeof(new.positions) <> 'array'
         or coalesce(new.positions_revision, '') <>
            '1-DIRECTIONAL-FUTURES-POSITIONS'
       ) then
      continue;
    end if;

    with recent as (
      select
        s.captured_at,
        coalesce(s.balances, '[]'::jsonb) as balances,
        s.positions,
        coalesce(s.positions_complete, false) as positions_complete,
        s.positions_revision
      from public.trading_account_snapshots s
      where lower(coalesce(s.exchange, '')) = 'binance_futures'
        and s.captured_at > r.opened_at
        and s.captured_at <= new.captured_at
      order by s.captured_at desc, s.id desc
      limit 3
    ), evaluated as (
      select
        recent.captured_at,
        case
          when r.position_side = 'SHORT' then
            recent.positions_complete
            and recent.positions is not null
            and jsonb_typeof(recent.positions) = 'array'
            and recent.positions_revision = '1-DIRECTIONAL-FUTURES-POSITIONS'
          else
            jsonb_typeof(recent.balances) = 'array'
            or (
              recent.positions_complete
              and recent.positions is not null
              and jsonb_typeof(recent.positions) = 'array'
              and recent.positions_revision = '1-DIRECTIONAL-FUTURES-POSITIONS'
            )
        end as usable,
        (
          -- Any live contract on the same market blocks zero reconciliation.  An
          -- opposite-side row is a ledger-direction mismatch to investigate, never proof
          -- that this position is zero; this fails safe in hedge mode and after imports.
          (
            recent.positions_complete
            and recent.positions is not null
            and jsonb_typeof(recent.positions) = 'array'
            and recent.positions_revision = '1-DIRECTIONAL-FUTURES-POSITIONS'
            and exists (
              select 1
              from jsonb_array_elements(recent.positions) position_row
              where upper(coalesce(position_row->>'market', position_row->>'symbol', '')) =
                    upper(r.market)
                and case
                  when jsonb_typeof(position_row->'quantity') = 'number'
                    then (position_row->>'quantity')::numeric
                  when coalesce(position_row->>'quantity', '') ~
                       '^[+]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
                    then (position_row->>'quantity')::numeric
                  else 0
                end > 0
            )
          )
          or (
            -- Preserve the existing LONG-only balance fallback for rolling deploys and
            -- historical snapshots.  It is deliberately unreachable for SHORT.
            r.position_side = 'LONG'
            and jsonb_typeof(recent.balances) = 'array'
            and exists (
              select 1
              from jsonb_array_elements(recent.balances) balance_row
              where upper(coalesce(balance_row->>'currency', balance_row->>'asset', '')) =
                    upper(r.base_asset)
                and (
                  case
                    when coalesce(balance_row->>'balance', '') ~
                         '^[+]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
                      then (balance_row->>'balance')::numeric
                    else 0
                  end
                  + case
                    when coalesce(balance_row->>'locked', '') ~
                         '^[+]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
                      then (balance_row->>'locked')::numeric
                    else 0
                  end
                ) > 0
            )
          )
        ) as exposure_present
      from recent
    )
    select
      count(*),
      count(*) filter (where usable),
      count(*) filter (where usable and not exposure_present),
      min(captured_at)
    into
      v_recent_count,
      v_usable_count,
      v_zero_count,
      v_min_snapshot
    from evaluated;

    if v_recent_count = 3
       and v_usable_count = 3
       and v_zero_count = 3
       and v_min_snapshot > r.opened_at then
      update public.trading_positions
      set state = 'CLOSED',
          remaining_quantity = 0,
          reserved_quote = 0,
          reserved_quantity = 0,
          reservation_expires_at = null,
          closed_at = coalesce(closed_at, new.captured_at),
          close_reason = coalesce(
            close_reason,
            'EXCHANGE_FUTURES_POSITION_ZERO_RECONCILED'
          ),
          marked_pnl_quote = null,
          metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
            'exclude_from_learning', true,
            'display_data_status', 'EXCHANGE_FUTURES_POSITION_ZERO_RECONCILED',
            'futures_position_reconciliation', jsonb_build_object(
              'revision', '8.0.1-DIRECTION-AWARE-FUTURES-ZERO-SNAPSHOT-RECONCILE',
              'position_side', r.position_side,
              'exit_side', r.exit_side,
              'confirmed_snapshot_count', 3,
              'observed_quantity', 0,
              'latest_snapshot_at', new.captured_at,
              'reconciled_at', now(),
              'reason', 'AUTHENTICATED_DIRECTIONAL_FUTURES_POSITION_ZERO'
            )
          ),
          updated_at = now()
      where id = r.id
        and state in ('OPEN', 'EXITING');
    end if;
  end loop;

  return new;
end;
$function$;

comment on function public.reconcile_futures_zero_positions_from_snapshots() is
  'Direction-aware futures zero reconciliation: authenticated positions for SHORT; positions or legacy balances for LONG; service role trigger only.';

revoke all on function public.reconcile_futures_zero_positions_from_snapshots()
  from public, anon, authenticated;
grant execute on function public.reconcile_futures_zero_positions_from_snapshots()
  to service_role;

drop trigger if exists trading_account_snapshots_futures_zero_reconcile
  on public.trading_account_snapshots;
create trigger trading_account_snapshots_futures_zero_reconcile
after insert on public.trading_account_snapshots
for each row
when (lower(coalesce(new.exchange, '')) = 'binance_futures')
execute function public.reconcile_futures_zero_positions_from_snapshots();

commit;
