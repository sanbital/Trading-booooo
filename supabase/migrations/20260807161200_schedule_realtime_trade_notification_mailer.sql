drop trigger if exists trg_trade_notification_outbox_realtime_dispatch
  on public.trade_notification_outbox;

create or replace function trading_internal.flush_trade_notification_outbox(p_limit integer default 3)
returns jsonb
language plpgsql
security definer
set search_path = public, trading_internal, extensions, vault, pg_temp
as $$
declare
  v_ready boolean := false;
  v_url text;
  v_token text;
  v_row record;
  v_status integer;
  v_content text;
  v_processed integer := 0;
  v_success integer := 0;
  v_failed integer := 0;
begin
  select
    count(*) filter (where name = 'trade_notification_mailer_url' and nullif(decrypted_secret, '') is not null) = 1
      and count(*) filter (where name = 'trade_notification_dispatch_token' and nullif(decrypted_secret, '') is not null) = 1
      and count(*) filter (where name = 'trade_notification_gmail_user' and nullif(decrypted_secret, '') is not null) = 1
      and count(*) filter (where name = 'trade_notification_gmail_app_password' and nullif(decrypted_secret, '') is not null) = 1
      and count(*) filter (where name = 'trade_notification_email_to' and nullif(decrypted_secret, '') is not null) = 1,
    max(decrypted_secret) filter (where name = 'trade_notification_mailer_url'),
    max(decrypted_secret) filter (where name = 'trade_notification_dispatch_token')
  into v_ready, v_url, v_token
  from vault.decrypted_secrets
  where name in (
    'trade_notification_mailer_url',
    'trade_notification_dispatch_token',
    'trade_notification_gmail_user',
    'trade_notification_gmail_app_password',
    'trade_notification_email_to'
  );

  if not coalesce(v_ready, false) then
    return jsonb_build_object('ready', false, 'processed', 0, 'sent', 0, 'failed', 0);
  end if;

  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '8000');

  for v_row in
    select id
    from public.trade_notification_outbox
    where sent_at is null
    order by created_at, id
    limit greatest(1, least(coalesce(p_limit, 3), 10))
  loop
    v_processed := v_processed + 1;
    begin
      with request_result as (
        select extensions.http((
          'POST',
          v_url,
          array[
            row('x-trade-notification-token', v_token)::extensions.http_header,
            row('accept', 'application/json')::extensions.http_header
          ],
          'application/json',
          jsonb_build_object('outbox_id', v_row.id)::text
        )::extensions.http_request) as r
      )
      select (r).status, (r).content
        into v_status, v_content
      from request_result;

      if coalesce(v_status, 0) between 200 and 299 then
        v_success := v_success + 1;
      else
        v_failed := v_failed + 1;
        update public.trade_notification_outbox
        set last_error = left('REALTIME_DISPATCH_HTTP_' || coalesce(v_status, 0)::text || ':' || coalesce(v_content, ''), 500),
            updated_at = now()
        where id = v_row.id and sent_at is null;
      end if;
    exception when others then
      v_failed := v_failed + 1;
      update public.trade_notification_outbox
      set last_error = left('REALTIME_DISPATCH:' || sqlerrm, 500),
          updated_at = now()
      where id = v_row.id and sent_at is null;
    end;
  end loop;

  return jsonb_build_object(
    'ready', true,
    'processed', v_processed,
    'sent', v_success,
    'failed', v_failed
  );
end;
$$;

revoke all on function trading_internal.flush_trade_notification_outbox(integer) from public, anon, authenticated;

select cron.schedule(
  'trade-notification-realtime-mailer',
  '5 seconds',
  'select trading_internal.flush_trade_notification_outbox(3);'
);
