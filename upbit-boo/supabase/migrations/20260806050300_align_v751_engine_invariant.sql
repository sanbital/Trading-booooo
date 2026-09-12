-- Align the canonical engine invariant after the v7.5.1 residual-exit rollout.
-- trading_settings updates are rewritten from this invariant by
-- enforce_trading_settings_ops_invariants().

update public.trading_ops_invariants
set canonical_engine_revision = '7.5.1-RESIDUAL-TP50-SL10',
    updated_at = now()
where id = 1;

update public.trading_settings
set lob_live_admission_revision = '7.5.1-RESIDUAL-TP50-SL10',
    lob_model_revision = '7.5.1-RESIDUAL-TP50-SL10',
    version = version + 1,
    updated_at = now()
where id = 1;
