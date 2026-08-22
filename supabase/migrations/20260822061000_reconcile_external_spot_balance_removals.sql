create or replace function public.reconcile_external_spot_balance_removals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  p record;
  snapshot_count integer;
  zero_count integer;
  missing_value numeric;
begin
  if new.exchange not in ('binance', 'upbit') then
    return new;
  end if;

  if jsonb_typeof(new.balances) <> 'array' then
    return new;
  end if;

  for p in
    select id, exchange, market, quote_currency, base_asset, state,
           remaining_quantity, average_entry_price, metadata
      from public.trading_positions
     where exchange = new.exchange
       and state in ('OPEN','EXITING','RECONCILING','RECONCILIATION_FAILED','MANUAL_INTERVENTION_REQUIRED')
       and coalesce(remaining_quantity, 0) > 0
       and coalesce(base_asset, '') <> ''
     for update skip locked
  loop
    select count(*),
           count(*) filter (
             where coalesce((
               select sum(
                 coalesce(nullif(b->>'balance','')::numeric, nullif(b->>'free','')::numeric, 0)
                 + coalesce(nullif(b->>'locked','')::numeric, 0)
               )
                 from jsonb_array_elements(s.balances) b
                where upper(coalesce(b->>'currency', b->>'asset', '')) = upper(p.base_asset)
             ), 0) <= 1e-12
           )
      into snapshot_count, zero_count
      from (
        select balances
          from public.trading_account_snapshots
         where exchange = new.exchange
           and captured_at <= new.captured_at
           and captured_at >= new.captured_at - interval '3 minutes'
           and jsonb_typeof(balances) = 'array'
         order by captured_at desc
         limit 3
      ) s;

    if snapshot_count < 3 or zero_count < 3 then
      continue;
    end if;

    -- Do not race an in-flight bot SELL. A just-filled exchange order can reduce the
    -- account balance before its fill has been applied to the position ledger.
    if exists (
      select 1
        from public.trading_orders o
       where o.position_id = p.id
         and upper(coalesce(o.side, '')) in ('SELL','ASK')
         and o.requested_at >= new.captured_at - interval '15 minutes'
         and upper(coalesce(o.state, '')) not in
             ('APPLIED','REJECTED','NOT_FOUND','EXCHANGE_CANCELLED','CANCELLED','FAILED')
    ) then
      continue;
    end if;

    missing_value := coalesce(p.remaining_quantity, 0) * coalesce(p.average_entry_price, 0);

    update public.trading_positions
       set state = 'CLOSED',
           remaining_quantity = 0,
           reserved_quote = 0,
           reserved_quantity = 0,
           reservation_expires_at = null,
           realized_cost_quote = 0,
           realized_proceeds_quote = 0,
           paid_fees_quote = 0,
           realized_pnl_quote = 0,
           close_reason = 'MANUAL_RECONCILE',
           closed_at = new.captured_at,
           metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
             'exclude_from_learning', true,
             'exclude_from_performance', true,
             'pending_exit_action', null,
             'pending_exit_at', null,
             'manual_reconcile', jsonb_build_object(
               'detected_at', new.captured_at,
               'previous_quantity', p.remaining_quantity,
               'actual_quantity', 0,
               'missing_quantity', p.remaining_quantity,
               'estimated_value_quote', missing_value,
               'reason', 'AUTHENTICATED_ACCOUNT_BALANCE_ZERO_3X'
             )
           ),
           updated_at = now()
     where id = p.id
       and state <> 'CLOSED';

    if found then
      insert into public.trading_cash_flows(
        exchange, quote_currency, flow_type, amount_quote, detected_at, details
      ) values (
        p.exchange,
        p.quote_currency,
        'MANUAL_POSITION_REDUCTION',
        missing_value,
        new.captured_at,
        jsonb_build_object(
          'position_id', p.id,
          'market', p.market,
          'base_asset', p.base_asset,
          'previous_quantity', p.remaining_quantity,
          'actual_quantity', 0,
          'estimated_price', p.average_entry_price,
          'reason', 'AUTHENTICATED_ACCOUNT_BALANCE_ZERO_3X',
          'exclude_from_performance', true
        )
      );

      insert into public.trading_events(
        position_id, level, code, message, details, created_at
      ) values (
        p.id,
        'WARNING',
        'EXIT_RECONCILED_EXTERNAL_REDUCTION',
        p.exchange || ':' || p.market || ' closed after three authenticated zero-balance snapshots',
        jsonb_build_object(
          'expected_quantity', p.remaining_quantity,
          'actual_total_quantity', 0,
          'confirmation_snapshots', 3,
          'excluded_from_performance', true,
          'source', 'ACCOUNT_SNAPSHOT_TRIGGER'
        ),
        new.captured_at
      );
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists trg_reconcile_external_spot_balance_removals
  on public.trading_account_snapshots;

create trigger trg_reconcile_external_spot_balance_removals
after insert on public.trading_account_snapshots
for each row
execute function public.reconcile_external_spot_balance_removals();
