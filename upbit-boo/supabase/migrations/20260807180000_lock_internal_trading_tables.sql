-- Internal trading-control tables must never be reachable with browser roles.
-- Edge Functions use service_role and are unaffected by these restrictions.

alter table public.trading_ops_invariants enable row level security;
alter table public.scanner_entry_overlay_policies enable row level security;
alter table public.scanner_candidate_overlays enable row level security;
alter table public.trading_parameter_changes enable row level security;

revoke all on table public.trading_ops_invariants from anon, authenticated;
revoke all on table public.scanner_entry_overlay_policies from anon, authenticated;
revoke all on table public.scanner_candidate_overlays from anon, authenticated;
revoke all on table public.trading_parameter_changes from anon, authenticated;

grant all on table public.trading_ops_invariants to service_role;
grant all on table public.scanner_entry_overlay_policies to service_role;
grant all on table public.scanner_candidate_overlays to service_role;
grant all on table public.trading_parameter_changes to service_role;

comment on table public.trading_ops_invariants is 'Internal trading operations invariants. service_role only; browser roles are denied.';
comment on table public.scanner_entry_overlay_policies is 'Internal scanner entry overlay policies. service_role only; browser roles are denied.';
comment on table public.scanner_candidate_overlays is 'Internal scanner candidate overlays. service_role only; browser roles are denied.';
comment on table public.trading_parameter_changes is 'Internal trading parameter audit log. service_role only; browser roles are denied.';
