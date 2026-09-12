create extension if not exists pg_net;

alter table public.trade_notification_outbox
  add column if not exists dispatch_requested_at timestamptz,
  add column if not exists dispatch_request_id bigint;

comment on column public.trade_notification_outbox.dispatch_requested_at is
  'When pg_net queued the realtime mailer request; null means realtime dispatch was not configured.';
comment on column public.trade_notification_outbox.dispatch_request_id is
  'pg_net request id for the realtime mailer invocation.';

do $$
begin
  if not exists (
    select 1 from vault.secrets where name = 'trade_notification_dispatch_token'
  ) then
    perform vault.create_secret(
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      'trade_notification_dispatch_token',
      'Internal token used only for DB -> trade-notification-mailer dispatch authentication'
    );
  end if;
end
$$;

create or replace function public.verify_trade_notification_dispatch_token(p_token text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, vault
as $$
  select coalesce(
    exists (
      select 1
      from vault.decrypted_secrets
      where name = 'trade_notification_dispatch_token'
        and decrypted_secret = p_token
        and p_token is not null
        and length(p_token) >= 32
    ),
    false
  );
$$;

revoke all on function public.verify_trade_notification_dispatch_token(text) from public, anon, authenticated;
grant execute on function public.verify_trade_notification_dispatch_token(text) to service_role;

create or replace function public.get_trade_notification_mail_config()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, vault
as $$
  select jsonb_build_object(
    'gmail_user', max(decrypted_secret) filter (where name = 'trade_notification_gmail_user'),
    'gmail_app_password', max(decrypted_secret) filter (where name = 'trade_notification_gmail_app_password'),
    'email_to', max(decrypted_secret) filter (where name = 'trade_notification_email_to')
  )
  from vault.decrypted_secrets
  where name in (
    'trade_notification_gmail_user',
    'trade_notification_gmail_app_password',
    'trade_notification_email_to'
  );
$$;

revoke all on function public.get_trade_notification_mail_config() from public, anon, authenticated;
grant execute on function public.get_trade_notification_mail_config() to service_role;

create or replace function public.get_trade_notification_email_payload(p_outbox_id bigint)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select jsonb_build_object(
    'outbox', jsonb_build_object(
      'id', n.id,
      'bot_order_id', n.bot_order_id,
      'position_id', n.position_id,
      'exchange', n.exchange,
      'market', n.market,
      'side', n.side,
      'event_type', n.event_type,
      'first_fill_at', n.first_fill_at,
      'last_fill_at', n.last_fill_at,
      'sent_at', n.sent_at
    ),
    'fill', jsonb_build_object(
      'count', a.fill_count,
      'quantity', a.quantity,
      'quote_amount', a.quote_amount,
      'fee_quote_amount', a.fee_quote_amount,
      'average_price', a.average_price,
      'quote_asset', a.quote_asset,
      'base_asset', a.base_asset,
      'realized_pnl_quote', a.realized_pnl_quote,
      'realized_cost_quote', a.realized_cost_quote,
      'inventory_quantity_after', a.inventory_quantity_after,
      'first_executed_at', a.first_executed_at,
      'last_executed_at', a.last_executed_at
    ),
    'order', jsonb_build_object(
      'purpose', o.purpose,
      'decision_id', o.decision_id
    ),
    'position', jsonb_build_object(
      'realized_pnl_quote', p.realized_pnl_quote,
      'realized_return_pct', p.realized_return_pct,
      'close_reason', p.close_reason
    ),
    'decision', jsonb_build_object(
      'pattern', d.audit ->> 'pattern',
      'gainer_rank', d.audit #> '{features,gainerRank}',
      'm1_pre_breakout', d.audit #> '{features,m1PreBreakout}',
      'm1_core_passed', d.audit #> '{features,m1CorePassed}',
      'trade_pressure_fast', d.audit #> '{features,tradePressureFast}',
      'data_quality', d.audit #> '{features,dataQuality}',
      'spread_bps', d.audit #> '{features,spreadBps}'
    )
  )
  from public.trade_notification_outbox n
  join public.trading_orders o on o.id = n.bot_order_id
  left join public.trading_positions p on p.id = n.position_id
  left join public.trading_decisions d on d.id = o.decision_id
  left join lateral (
    select
      count(*) as fill_count,
      coalesce(sum(f.quantity), 0) as quantity,
      coalesce(sum(f.quote_amount), 0) as quote_amount,
      coalesce(sum(coalesce(f.fee_quote_amount, 0)), 0) as fee_quote_amount,
      case
        when coalesce(sum(f.quantity), 0) = 0 then null
        else sum(f.quote_amount) / sum(f.quantity)
      end as average_price,
      min(f.quote_asset) as quote_asset,
      min(f.base_asset) as base_asset,
      coalesce(sum(coalesce(f.realized_pnl_quote, 0)), 0) as realized_pnl_quote,
      coalesce(sum(coalesce(f.realized_cost_quote, 0)), 0) as realized_cost_quote,
      (
        array_agg(f.inventory_quantity_after order by f.executed_at desc, f.exchange_trade_id desc)
        filter (where f.inventory_quantity_after is not null)
      )[1] as inventory_quantity_after,
      min(f.executed_at) as first_executed_at,
      max(f.executed_at) as last_executed_at
    from public.exchange_trade_fills f
    where f.bot_order_id = n.bot_order_id
      and f.source = 'AUTOMATED'
      and f.accounting_status = 'ACCOUNTED'
  ) a on true
  where n.id = p_outbox_id;
$$;

revoke all on function public.get_trade_notification_email_payload(bigint) from public, anon, authenticated;
grant execute on function public.get_trade_notification_email_payload(bigint) to service_role;

create or replace function public.mark_trade_notification_sent(p_outbox_id bigint)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  update public.trade_notification_outbox
  set
    sent_at = now(),
    send_attempts = send_attempts + 1,
    last_error = null,
    updated_at = now()
  where id = p_outbox_id
    and sent_at is null;
end;
$$;

revoke all on function public.mark_trade_notification_sent(bigint) from public, anon, authenticated;
grant execute on function public.mark_trade_notification_sent(bigint) to service_role;

create or replace function public.mark_trade_notification_failed(p_outbox_id bigint, p_error text)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  update public.trade_notification_outbox
  set
    send_attempts = send_attempts + 1,
    last_error = left(coalesce(p_error, 'UNKNOWN_SEND_ERROR'), 500),
    updated_at = now()
  where id = p_outbox_id
    and sent_at is null;
end;
$$;

revoke all on function public.mark_trade_notification_failed(bigint, text) from public, anon, authenticated;
grant execute on function public.mark_trade_notification_failed(bigint, text) to service_role;

create or replace function public.request_trade_notification_dispatch(p_outbox_id bigint)
returns bigint
language plpgsql
security definer
set search_path = public, pg_catalog, vault, net
as $$
declare
  v_url text;
  v_token text;
  v_request_id bigint;
begin
  if not exists (
    select 1
    from public.trade_notification_outbox
    where id = p_outbox_id and sent_at is null
  ) then
    return null;
  end if;

  if not exists (select 1 from vault.secrets where name = 'trade_notification_gmail_user')
     or not exists (select 1 from vault.secrets where name = 'trade_notification_gmail_app_password')
     or not exists (select 1 from vault.secrets where name = 'trade_notification_email_to')
     or not exists (select 1 from vault.secrets where name = 'trade_notification_mailer_url') then
    return null;
  end if;

  select decrypted_secret into v_url
  from vault.decrypted_secrets
  where name = 'trade_notification_mailer_url';

  select decrypted_secret into v_token
  from vault.decrypted_secrets
  where name = 'trade_notification_dispatch_token';

  if nullif(v_url, '') is null or nullif(v_token, '') is null then
    return null;
  end if;

  select net.http_post(
    url := v_url,
    body := jsonb_build_object('outbox_id', p_outbox_id),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-trade-notification-token', v_token
    ),
    timeout_milliseconds := 15000
  ) into v_request_id;

  update public.trade_notification_outbox
  set
    dispatch_requested_at = now(),
    dispatch_request_id = v_request_id,
    updated_at = now()
  where id = p_outbox_id
    and sent_at is null;

  return v_request_id;
end;
$$;

revoke all on function public.request_trade_notification_dispatch(bigint) from public, anon, authenticated;
grant execute on function public.request_trade_notification_dispatch(bigint) to service_role;

create or replace function public.dispatch_trade_notification_realtime()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  perform public.request_trade_notification_dispatch(new.id);
  return new;
end;
$$;

revoke all on function public.dispatch_trade_notification_realtime() from public, anon, authenticated;

drop trigger if exists trg_trade_notification_outbox_realtime_dispatch
  on public.trade_notification_outbox;

create trigger trg_trade_notification_outbox_realtime_dispatch
after insert on public.trade_notification_outbox
for each row
execute function public.dispatch_trade_notification_realtime();
