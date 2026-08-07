create or replace function trading_internal.trigger_exchange_trade_sync()
returns bigint
language plpgsql
security definer
set search_path = public, trading_internal, extensions, vault, net, pg_temp
as $$
declare
  v_token text;
  v_request_id bigint;
begin
  select decrypted_secret into v_token
  from vault.decrypted_secrets
  where name = 'exchange_trade_sync_token'
  limit 1;

  if coalesce(v_token, '') = '' then
    raise exception 'exchange_trade_sync_token missing';
  end if;

  select net.http_post(
    url := 'https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/exchange-trade-sync',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-sync-token', v_token
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function trading_internal.trigger_exchange_trade_sync() from public, anon, authenticated;
