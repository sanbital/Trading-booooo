-- Repair V17 closed-fill accounting false negatives without changing strategy,
-- order execution, risk, sizing, or exchange fill truth.
--
-- Fixes:
-- 1. Treat terminal IOC PARTIALLY_FILLED_CANCELED orders with verified non-zero
--    exchange execution as valid fill ownership.
-- 2. Allow a bounded +/-2s position/fill timestamp handoff window.
-- 3. Reconcile PnL differences that are fully explained by stored entry-price rounding.
-- 4. Prevent the latest unprovable rows from starving older provable PENDING fills.

create or replace function public.v17_closed_fill_accounting_proven(p_id uuid)
returns boolean
language plpgsql
stable
set search_path to 'pg_catalog','public'
as $function$
declare
  p public.v11_long_regime_positions%rowtype;
  a record;
  v_fill_entry_price numeric;
  v_price_tolerance numeric;
begin
  select * into p
  from public.v11_long_regime_positions
  where id = p_id;

  if not found
    or p.state <> 'CLOSED'
    or p.side <> 'LONG'
    or p.remaining_quantity <> 0
    or p.original_quantity <= 0
    or p.metadata->>'executionMode' is distinct from 'LEADER_MOMENTUM_V17'
    or p.metadata->>'exitAccountingPending' is distinct from 'false'
    or p.metadata->>'v18EntryAccountingPending' is distinct from 'false'
  then
    return false;
  end if;

  select
    count(*) n,
    sum(quantity) filter (where side='BUY') bought,
    sum(quantity) filter (where side='SELL') sold,
    sum(quote_amount) filter (where side='BUY') entry_quote,
    sum(fee_quote_amount) filter (where side='BUY') entry_fee,
    sum(realized_pnl_quote-fee_quote_amount) net,
    bool_and(coalesce(
      f.exchange='binance_futures'
      and f.account_scope='futures'
      and f.market=p.symbol
      and f.position_id is null
      and f.bot_order_id is null
      and f.quantity>0
      and f.price>0
      and f.side in ('BUY','SELL')
      and f.executed_at between (p.entry_at - interval '2 seconds') and (p.closed_at + interval '2 seconds')
      and f.fee_asset='USDT'
      and f.fee_amount=f.fee_quote_amount
      and f.fee_amount>=0
      and f.raw_response->>'symbol'=f.market
      and f.raw_response->>'id'=f.exchange_trade_id::text
      and f.raw_response->>'orderId'=f.exchange_order_id
      and (f.raw_response->>'qty')::numeric=f.quantity
      and (f.raw_response->>'price')::numeric=f.price
      and (f.raw_response->>'quoteQty')::numeric=f.quote_amount
      and abs(f.price*f.quantity-f.quote_amount)<0.000001
      and f.raw_response->>'commissionAsset'='USDT'
      and (f.raw_response->>'commission')::numeric=f.fee_quote_amount
      and (f.raw_response->>'realizedPnl')::numeric=f.realized_pnl_quote
      and (f.raw_response->>'isBuyer')::boolean=(f.side='BUY')
      and abs(extract(epoch from f.executed_at)*1000-(f.raw_response->>'time')::numeric)<1
      and (
        exists (
          select 1
          from public.v11_long_regime_orders o
          where o.id=f.v17_order_id
            and o.position_id=p.id
            and o.signal_id=p.signal_id
            and o.symbol=f.market
            and o.exchange_order_id=f.exchange_order_id
            and (
              o.state='FILLED'
              or (
                o.state='PARTIALLY_FILLED_CANCELED'
                and o.response_payload->>'status'='PARTIALLY_FILLED_CANCELED'
                and o.response_payload->>'raw_status'='EXPIRED'
                and nullif(o.response_payload->>'executed_volume','')::numeric > 0
                and nullif(o.response_payload->>'requested_volume','')::numeric = o.requested_quantity
                and nullif(o.response_payload->>'remaining_volume','')::numeric >= 0
              )
            )
            and o.request_payload#>>'{order,side}'=f.side
            and o.request_payload#>>'{order,position_effect}'=
              case when f.side='BUY' then 'OPEN' else 'CLOSE' end
        )
        or (
          f.side='SELL'
          and f.v17_order_id is null
          and exists (
            select 1
            from jsonb_array_elements(coalesce(p.metadata#>'{exitProtection,orders}','[]')) o
            where o->>'actualOrderId'=f.exchange_order_id
              and o->>'terminal'='true'
              and o->>'accountingPending'='false'
              and o#>>'{spec,params,symbol}'=f.market
              and o#>>'{spec,params,side}'='SELL'
              and o#>>'{spec,params,reduceOnly}'='true'
              and o->'tradeIds' ? f.exchange_trade_id::text
          )
        )
      ),
      false
    )) verified
  into a
  from public.exchange_trade_fills f
  where f.v17_position_id=p.id;

  if coalesce(a.bought,0) <= 0 then
    return false;
  end if;

  v_fill_entry_price := a.entry_quote / a.bought;
  v_price_tolerance := case
    when scale(p.entry_price)=7 then 0.00000005::numeric
    else 0.00000001::numeric
  end;

  return coalesce(
    a.n>1
    and a.verified
    and abs(a.bought-p.original_quantity)<0.00000001
    and abs(a.sold-p.original_quantity)<0.00000001
    and abs(a.entry_fee-p.entry_fee_usdt)<0.000001
    and abs(v_fill_entry_price-p.entry_price)<=v_price_tolerance
    and abs(
      (a.net-p.realized_pnl_usdt)
      + ((v_fill_entry_price-p.entry_price)*a.bought)
    )<0.000001,
    false
  );
exception when others then
  return false;
end
$function$;

create or replace function public.v17_reconcile_closed_fill_accounting(p_limit integer default 20)
returns integer
language plpgsql
set search_path to 'pg_catalog','public'
set lock_timeout to '2s'
as $function$
declare
  p record;
  n integer := 0;
  changed integer;
  settled_positions integer := 0;
  target_positions integer := greatest(1,least(p_limit,50));
begin
  if not pg_try_advisory_xact_lock(714024,33) then
    return 0;
  end if;

  for p in
    select x.id
    from public.v11_long_regime_positions x
    where x.state='CLOSED'
      and exists (
        select 1
        from public.exchange_trade_fills f
        where f.v17_position_id=x.id
          and f.accounting_status='PENDING'
      )
    order by x.closed_at desc,x.id
    limit 500
    for update skip locked
  loop
    perform 1
    from public.exchange_trade_fills
    where v17_position_id=p.id
    for update;

    if public.v17_closed_fill_accounting_proven(p.id) then
      update public.exchange_trade_fills
      set accounting_status='ACCOUNTED',
          updated_at=clock_timestamp()
      where v17_position_id=p.id
        and accounting_status='PENDING';

      get diagnostics changed=row_count;
      if changed>0 then
        n:=n+changed;
        settled_positions:=settled_positions+1;
      end if;

      exit when settled_positions>=target_positions;
    end if;
  end loop;

  if n>0 then
    update public.v11_long_regime_runtime
    set last_accounting_settlement_at=clock_timestamp()
    where singleton;
  end if;

  return n;
end
$function$;
