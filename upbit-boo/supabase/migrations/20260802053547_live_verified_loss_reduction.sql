-- Live-verified loss-reduction policy, 2026-08-02.
-- Derived only from the latest 100 hours of real fills and scanner observations.
-- This migration intentionally does not resume new entries.

begin;

update public.trading_settings
set
  lob_max_spread_bps = 10,
  lob_exploration_max_spread_bps = least(coalesce(lob_exploration_max_spread_bps, 10), 10),
  lob_revalidation_max_spread_bps = least(coalesce(lob_revalidation_max_spread_bps, 10), 10),
  lob_max_gainer_rank = 1,
  lob_post180_max_hold_seconds = 420,
  lob_min_net_ev_bps = greatest(coalesce(lob_min_net_ev_bps, 0), 0.50),
  lob_min_verified_ev_cushion_bps = greatest(coalesce(lob_min_verified_ev_cushion_bps, 0), 0.50),
  updated_at = now()
where id = 1;

commit;

-- Expected invariant after deployment:
-- pause_new_entries remains unchanged.
-- Operators must explicitly resume only after deployment verification.
