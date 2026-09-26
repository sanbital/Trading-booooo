-- Align the canonical engine invariant after the v7.5.2 residual-exit rollout.
--
-- v7.5.1 shipped 20260806050300_align_v751_engine_invariant.sql alongside the policy
-- migration. v7.5.2 shipped the policy migration and the autotrader runtime bump but
-- never shipped the companion invariant alignment, so the database kept declaring
-- 7.5.1 as canonical while the runtime signed everything 7.5.2. That gap is what
-- enforce_lob_live_admission_v711() reports as V740_ENGINE_REVISION_MISMATCH: the
-- ENTRY_PENDING row carries metadata.engine_version = '7.5.2-RESIDUAL-TP10-SL4' and
-- the canonical revision it is compared against is still '7.5.1-RESIDUAL-TP50-SL10'.
--
-- This migration moves only the version identity. No exit policy, no threshold, no
-- sizing rule and no gate parameter is touched here.
--
-- trading_settings updates are rewritten from this invariant by
-- enforce_trading_settings_ops_invariants(), so the invariant must move first.

update public.trading_ops_invariants
set canonical_engine_revision = '7.5.2-RESIDUAL-TP10-SL4',
    updated_at = now()
where id = 1;

update public.trading_settings
set lob_live_admission_revision = '7.5.2-RESIDUAL-TP10-SL4',
    lob_model_revision = '7.5.2-RESIDUAL-TP10-SL4',
    version = version + 1,
    updated_at = now()
where id = 1;

do $$
declare
  v_canonical text;
  v_admission text;
  v_model text;
begin
  select canonical_engine_revision into v_canonical
  from public.trading_ops_invariants where id = 1;
  select lob_live_admission_revision, lob_model_revision into v_admission, v_model
  from public.trading_settings where id = 1;

  if v_canonical is distinct from '7.5.2-RESIDUAL-TP10-SL4' then
    raise exception 'canonical engine revision did not move to v7.5.2 (got %)', v_canonical;
  end if;
  if v_admission is distinct from '7.5.2-RESIDUAL-TP10-SL4'
     or v_model is distinct from '7.5.2-RESIDUAL-TP10-SL4' then
    raise exception
      'trading_settings revisions did not follow the invariant (admission=%, model=%)',
      v_admission, v_model;
  end if;
end
$$;
