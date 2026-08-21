-- P10 accounting RPCs are private service-role entry points. Supabase role-specific
-- default grants can survive a revoke from PUBLIC, so revoke every API-facing role
-- explicitly and then restore only the service role.

revoke all on function public.claim_p10_signal(
  text, text, timestamptz, text, jsonb
) from public, anon, authenticated;
revoke all on function public.apply_p10_entry_order(
  uuid, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric
) from public, anon, authenticated;
revoke all on function public.apply_p10_exit_order(
  uuid, text, numeric, numeric, numeric, numeric, numeric
) from public, anon, authenticated;

grant execute on function public.claim_p10_signal(
  text, text, timestamptz, text, jsonb
) to service_role;
grant execute on function public.apply_p10_entry_order(
  uuid, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric
) to service_role;
grant execute on function public.apply_p10_exit_order(
  uuid, text, numeric, numeric, numeric, numeric, numeric
) to service_role;
