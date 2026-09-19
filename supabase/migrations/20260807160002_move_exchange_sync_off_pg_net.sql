create or replace function trading_internal.trigger_exchange_trade_sync()
returns bigint
language plpgsql
security definer
set search_path = public, trading_internal, extensions, vault, pg_temp
as $$
declare
  v_token text;
  v_status integer;
  v_content text;
begin
  select decrypted_secret into v_token
  from vault.decrypted_secrets
  where name = 'exchange_trade_sync_token'
  limit 1;

  if coalesce(v_token, '') = '' then
    raise exception 'exchange_trade_sync_token missing';
  end if;

  -- Keep long exchange synchronization requests out of pg_net. pg_net is reserved
  -- for short event-driven work such as realtime trade notifications.
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '120000');

  with request_result as (
    select extensions.http((
      'POST',
      'https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/exchange-trade-sync',
      array[
        row('x-sync-token', v_token)::extensions.http_header,
        row('accept', 'application/json')::extensions.http_header
      ],
      'application/json',
      '{}'::text
    )::extensions.http_request) as r
  )
  select (r).status, (r).content
    into v_status, v_content
  from request_result;

  if coalesce(v_status, 0) not between 200 and 299 then
    raise warning 'exchange-trade-sync HTTP %: %', coalesce(v_status, 0), left(coalesce(v_content, ''), 500);
  end if;

  return coalesce(v_status, 0)::bigint;
end;
$$;

revoke all on function trading_internal.trigger_exchange_trade_sync() from public, anon, authenticated;
