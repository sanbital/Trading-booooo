-- The V30 live front (2026-09-24) sends branch V30_SCORE to v11_cec0040_decide; the
-- function accepted it (20260924015005) but both tables' CHECK constraints did not, so
-- every V30-only candidate failed CEC0040 with a constraint violation (fail-closed, no entry).
alter table public.v11_cec0040_decisions drop constraint v11_cec0040_decisions_branch_check;
alter table public.v11_cec0040_decisions add constraint v11_cec0040_decisions_branch_check
  check (branch = any (array['R62','BUYER_SHARE_RESCUE','BOTH','V30_SCORE']));
alter table public.v11_cec0040_targets drop constraint v11_cec0040_targets_branch_check;
alter table public.v11_cec0040_targets add constraint v11_cec0040_targets_branch_check
  check (branch = any (array['R62','BUYER_SHARE_RESCUE','BOTH','V30_SCORE']));
