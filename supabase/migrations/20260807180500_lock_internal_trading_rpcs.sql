-- SECURITY DEFINER trading maintenance RPCs are internal-only.
-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default, which would let
-- browser roles bypass table RLS through these definer functions.

revoke execute on function public.link_exchange_fills_to_orders(text, text) from public, anon, authenticated;
revoke execute on function public.rebuild_exchange_trade_accounting(text, text, text) from public, anon, authenticated;
revoke execute on function public.reconcile_positions_from_exchange_fills(text, text, numeric) from public, anon, authenticated;
revoke execute on function public.verify_exchange_trade_sync_token(text) from public, anon, authenticated;
revoke execute on function public.refresh_real_trade_scorecards(text, interval) from public, anon, authenticated;

grant execute on function public.link_exchange_fills_to_orders(text, text) to service_role;
grant execute on function public.rebuild_exchange_trade_accounting(text, text, text) to service_role;
grant execute on function public.reconcile_positions_from_exchange_fills(text, text, numeric) to service_role;
grant execute on function public.verify_exchange_trade_sync_token(text) to service_role;
grant execute on function public.refresh_real_trade_scorecards(text, interval) to service_role;
