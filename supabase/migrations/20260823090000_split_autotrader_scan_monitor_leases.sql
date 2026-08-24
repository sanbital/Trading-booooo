-- Split the autotrader scan/monitor execution leases.
--
-- 202608190001 folded `autotrader-scan` and `autotrader-monitor` onto a single
-- `autotrader-engine` row to serialise the two cycles. Runtime shows that the folding is
-- pure cross-contention: over a 12h window on P10-LIVE-1.0.0, 252/252 SCAN skips overlapped
-- a MONITOR success and 5117/5182 MONITOR skips started inside a SCAN success, while *zero*
-- skips of either kind overlapped another run of their own kind. Scan and monitor never
-- block themselves -- they only block each other.
--
-- The folding is redundant for the hazard it was added alongside. Cross-lifecycle futures
-- fill attribution is enforced by trg_enforce_futures_fill_order_attribution, which matches
-- on an exact exchange_order_id and refuses to infer a lifecycle from symbol/time. That
-- trigger holds regardless of which cycles run concurrently. The remaining entry critical
-- section is likewise constraint-protected and lease-independent:
--
--   * claim_p10_signal            -- insert .. on conflict do nothing on
--                                    p10_signal_claims(venue, market, signal_time, side)
--   * trading_one_active_exchange_market_position
--                                 -- partial unique (exchange, market) over the active states
--                                    ENTRY_PENDING/OPEN/EXITING/RECONCILING/
--                                    RECONCILIATION_FAILED/MANUAL_INTERVENTION_REQUIRED
--   * trading_orders_identifier_key and trading_orders_exchange_exchange_order_id_key
--   * trading_fills_order_id_trade_id_key
--
-- Entry also writes the DB row before it touches the exchange (ENTRY_PENDING carries a 180s
-- reservation_expires_at, against an ~11s scan), so a concurrent monitor reconciliation
-- always sees a known position rather than an unattributed exchange fill.
--
-- Each cycle keeps its own lease row, so scan stays serialised against scan and monitor
-- against monitor. Only the cross-blocking is removed. The monitor-priority gate below is
-- carried over from the deployed definition unchanged.

begin;

create or replace function public.acquire_trading_lease(
  p_name text,
  p_owner uuid,
  p_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last_scan timestamptz;
  v_scan_interval integer := 12;
  v_monitor_priority boolean := false;
  v_has_settings boolean := false;
begin
  if p_name = 'autotrader-monitor' then
    select
      s.last_full_scan_at,
      greatest(12, coalesce(s.full_scan_interval_seconds, 12)),
      coalesce(s.emergency_liquidation, false)
        or coalesce(s.manual_intervention_required, false)
        or coalesce(s.withdrawal_mode, false)
    into
      v_last_scan,
      v_scan_interval,
      v_monitor_priority
    from public.trading_settings s
    where s.id = 1;

    v_has_settings := found;

    if v_has_settings and not v_monitor_priority then
      v_monitor_priority := exists (
        select 1
        from public.trading_positions p
        where p.is_paper = false
          and coalesce(p.state, '') not in ('CLOSED', 'CANCELLED')
      );
    end if;

    if v_has_settings
       and not v_monitor_priority
       and (
         v_last_scan is null
         or v_last_scan < now() - make_interval(secs => greatest(30, v_scan_interval * 2))
       )
    then
      return false;
    end if;
  end if;

  insert into public.trading_leases(name, owner, acquired_at, expires_at)
  values (
    p_name,
    p_owner,
    now(),
    now() + make_interval(secs => greatest(10, p_seconds))
  )
  on conflict (name) do update
    set owner = excluded.owner,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at
    where public.trading_leases.expires_at < now()
       or public.trading_leases.owner = excluded.owner;

  return exists (
    select 1
    from public.trading_leases
    where name = p_name and owner = p_owner
  );
end;
$$;

create or replace function public.release_trading_lease(
  p_name text,
  p_owner uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.trading_leases
  where name = p_name and owner = p_owner;
  return found;
end;
$$;

revoke all on function public.acquire_trading_lease(text, uuid, int) from public, anon, authenticated;
revoke all on function public.release_trading_lease(text, uuid) from public, anon, authenticated;
grant execute on function public.acquire_trading_lease(text, uuid, int) to service_role;
grant execute on function public.release_trading_lease(text, uuid) to service_role;

-- Cycles in flight at deploy time still hold the folded row and will release under their own
-- name, so drop the orphan. Nothing acquires this name after this migration; any row a
-- still-running cycle re-inserts expires on its own TTL.
delete from public.trading_leases where name = 'autotrader-engine';

commit;
