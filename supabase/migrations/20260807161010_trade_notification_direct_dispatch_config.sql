create or replace function public.get_trade_notification_dispatch_config()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, vault
as $$
  select jsonb_build_object(
    'ready',
      count(*) filter (where name = 'trade_notification_mailer_url' and nullif(decrypted_secret, '') is not null) = 1
      and count(*) filter (where name = 'trade_notification_dispatch_token' and nullif(decrypted_secret, '') is not null) = 1
      and count(*) filter (where name = 'trade_notification_gmail_user' and nullif(decrypted_secret, '') is not null) = 1
      and count(*) filter (where name = 'trade_notification_gmail_app_password' and nullif(decrypted_secret, '') is not null) = 1
      and count(*) filter (where name = 'trade_notification_email_to' and nullif(decrypted_secret, '') is not null) = 1,
    'url', max(decrypted_secret) filter (where name = 'trade_notification_mailer_url'),
    'token', max(decrypted_secret) filter (where name = 'trade_notification_dispatch_token')
  )
  from vault.decrypted_secrets
  where name in (
    'trade_notification_mailer_url',
    'trade_notification_dispatch_token',
    'trade_notification_gmail_user',
    'trade_notification_gmail_app_password',
    'trade_notification_email_to'
  );
$$;

revoke all on function public.get_trade_notification_dispatch_config() from public, anon, authenticated;
grant execute on function public.get_trade_notification_dispatch_config() to service_role;
