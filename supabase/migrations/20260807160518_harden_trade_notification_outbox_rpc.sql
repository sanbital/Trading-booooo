revoke all on table public.trade_notification_outbox from public, anon, authenticated;
grant all on table public.trade_notification_outbox to service_role;

revoke all on function public.enqueue_trade_notification_outbox() from public, anon, authenticated;
revoke all on function public.dispatch_trade_notification_realtime() from public, anon, authenticated;
revoke all on function public.request_trade_notification_dispatch(bigint) from public, anon, authenticated;
revoke all on function public.verify_trade_notification_dispatch_token(text) from public, anon, authenticated;
revoke all on function public.get_trade_notification_mail_config() from public, anon, authenticated;
revoke all on function public.get_trade_notification_email_payload(bigint) from public, anon, authenticated;
revoke all on function public.mark_trade_notification_sent(bigint) from public, anon, authenticated;
revoke all on function public.mark_trade_notification_failed(bigint, text) from public, anon, authenticated;

grant execute on function public.request_trade_notification_dispatch(bigint) to service_role;
grant execute on function public.verify_trade_notification_dispatch_token(text) to service_role;
grant execute on function public.get_trade_notification_mail_config() to service_role;
grant execute on function public.get_trade_notification_email_payload(bigint) to service_role;
grant execute on function public.mark_trade_notification_sent(bigint) to service_role;
grant execute on function public.mark_trade_notification_failed(bigint, text) to service_role;
