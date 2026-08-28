-- P10 entry Full-Market Regime Overlay — SHADOW ONLY
--
-- Purpose:
--   Record what the proposed entry regime gate would have decided at the exact
--   P10 signal-claim time, without changing claim success, order submission, sizing,
--   or any existing live entry/exit behavior.
--
-- Causality:
--   The evaluator uses only the latest qualifying Full-Market observation at or
--   before p_at and no older than 12 minutes. Historical replay therefore has no
--   lookahead/data leakage.
--
-- Live enforcement is intentionally impossible in this revision. The trigger is
-- AFTER INSERT and its exception handler always returns NEW, so telemetry failure
-- cannot block a live claim.

create table if not exists public.p10_entry_regime_shadow (
  id bigint generated always as identity primary key,
  claim_id uuid not null unique references public.p10_signal_claims(id) on delete cascade,
  position_id uuid null,
  venue text not null,
  market text not null,
  side text not null,
  signal_time timestamptz not null,
  claimed_at timestamptz not null,
  observation_id uuid null,
  observed_at timestamptz null,
  model_revision text not null default 'MARKET-REGIME-OBSERVER-v2-C01-FULLMARKET',
  policy_revision text not null default 'P10-ENTRY-REGIME-SHADOW-v1',
  regime text null,
  phase text null,
  bull_score double precision null,
  confidence double precision null,
  sample_size integer null,
  observation_trading_influence boolean null,
  live_gate_candidate boolean not null default false,
  recommendation text not null check (recommendation in ('ALLOW','BLOCK','CAUTION','UNKNOWN')),
  reason text not null,
  shadow_only boolean not null default true check (shadow_only = true),
  audit jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists p10_entry_regime_shadow_claimed_at_idx
  on public.p10_entry_regime_shadow (claimed_at desc);
create index if not exists p10_entry_regime_shadow_side_recommendation_idx
  on public.p10_entry_regime_shadow (side, recommendation, claimed_at desc);
create index if not exists p10_entry_regime_shadow_regime_phase_idx
  on public.p10_entry_regime_shadow (regime, phase, claimed_at desc);

alter table public.p10_entry_regime_shadow enable row level security;

comment on table public.p10_entry_regime_shadow is
  'Shadow-only P10 entry regime decisions. Never authoritative for live order admission.';

create or replace function public.evaluate_p10_entry_regime_shadow(
  p_side text,
  p_at timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_obs public.market_regime_observations%rowtype;
  v_side text := upper(coalesce(p_side, ''));
  v_phase text;
  v_recommendation text := 'UNKNOWN';
  v_reason text := 'REGIME_UNAVAILABLE_OR_STALE';
  v_live_gate_candidate boolean := false;
begin
  select o.*
  into v_obs
  from public.market_regime_observations o
  where o.model_revision = 'MARKET-REGIME-OBSERVER-v2-C01-FULLMARKET'
    and o.observed_at <= p_at
    and o.observed_at >= p_at - interval '12 minutes'
    and o.confidence >= 0.60
    and o.sample_size >= 240
    and o.features->>'source' = 'BINANCE_SPOT_FUTURES_UPBIT_FULL_ACTIVE_UNIVERSE'
    and coalesce((o.features->'breadth_30m'->'binance_spot'->>'sample_size')::integer, 0) >= 80
    and coalesce((o.features->'breadth_30m'->'binance_futures'->>'sample_size')::integer, 0) >= 80
    and coalesce((o.features->'breadth_30m'->'upbit_spot'->>'sample_size')::integer, 0) >= 40
    and o.predicted_regime in ('RISK_OFF','NEUTRAL','BULL','STRONG_BULL')
  order by o.observed_at desc
  limit 1;

  if not found then
    return jsonb_build_object(
      'policy_revision', 'P10-ENTRY-REGIME-SHADOW-v1',
      'model_revision', 'MARKET-REGIME-OBSERVER-v2-C01-FULLMARKET',
      'evaluated_at', p_at,
      'side', v_side,
      'recommendation', 'UNKNOWN',
      'reason', 'REGIME_UNAVAILABLE_OR_STALE',
      'live_gate_candidate', false,
      'shadow_only', true
    );
  end if;

  v_phase := coalesce(v_obs.features->'momentum_phase'->>'phase', 'UNKNOWN');
  -- The current exit overlay requires trading_influence=true before it can affect
  -- orders. Shadow evaluation still records observations from the same model when the
  -- influence switch was off, which permits causal historical replay. This flag tells
  -- promotion logic which rows would be eligible to become live evidence.
  v_live_gate_candidate := coalesce(v_obs.trading_influence, false);

  if v_side = 'LONG' then
    if v_obs.predicted_regime in ('BULL','STRONG_BULL') then
      v_recommendation := 'ALLOW';
      v_reason := 'LONG_STRUCTURAL_BULL';
    elsif v_obs.predicted_regime in ('NEUTRAL','RISK_OFF') then
      v_recommendation := 'BLOCK';
      v_reason := 'LONG_NON_BULL_REGIME';
    end if;
  elsif v_side = 'SHORT' then
    if v_phase = 'CAPITULATION_REBOUND' then
      v_recommendation := 'BLOCK';
      v_reason := 'SHORT_CAPITULATION_REBOUND';
    elsif v_obs.predicted_regime in ('BULL','STRONG_BULL') then
      v_recommendation := 'BLOCK';
      v_reason := 'SHORT_BULL_ADVERSE';
    elsif v_obs.predicted_regime = 'RISK_OFF' and v_obs.bull_score <= 42 then
      v_recommendation := 'ALLOW';
      v_reason := 'SHORT_CONFIRMED_RISK_OFF';
    else
      v_recommendation := 'CAUTION';
      v_reason := 'SHORT_AMBIGUOUS_REGIME';
    end if;
  else
    v_recommendation := 'UNKNOWN';
    v_reason := 'UNSUPPORTED_POSITION_SIDE';
  end if;

  return jsonb_build_object(
    'policy_revision', 'P10-ENTRY-REGIME-SHADOW-v1',
    'model_revision', v_obs.model_revision,
    'evaluated_at', p_at,
    'side', v_side,
    'observation_id', v_obs.id,
    'observed_at', v_obs.observed_at,
    'regime', v_obs.predicted_regime,
    'phase', v_phase,
    'bull_score', v_obs.bull_score,
    'confidence', v_obs.confidence,
    'sample_size', v_obs.sample_size,
    'observation_trading_influence', v_obs.trading_influence,
    'live_gate_candidate', v_live_gate_candidate,
    'recommendation', v_recommendation,
    'reason', v_reason,
    'shadow_only', true,
    'observation_age_seconds', extract(epoch from (p_at - v_obs.observed_at))
  );
end;
$$;

revoke all on function public.evaluate_p10_entry_regime_shadow(text, timestamptz) from public;
grant execute on function public.evaluate_p10_entry_regime_shadow(text, timestamptz) to service_role;

create or replace function public.record_p10_entry_regime_shadow()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_audit jsonb;
begin
  v_audit := public.evaluate_p10_entry_regime_shadow(new.side, new.claimed_at);

  insert into public.p10_entry_regime_shadow (
    claim_id,
    position_id,
    venue,
    market,
    side,
    signal_time,
    claimed_at,
    observation_id,
    observed_at,
    model_revision,
    policy_revision,
    regime,
    phase,
    bull_score,
    confidence,
    sample_size,
    observation_trading_influence,
    live_gate_candidate,
    recommendation,
    reason,
    shadow_only,
    audit
  ) values (
    new.id,
    new.position_id,
    new.venue,
    new.market,
    upper(new.side),
    new.signal_time,
    new.claimed_at,
    nullif(v_audit->>'observation_id','')::uuid,
    nullif(v_audit->>'observed_at','')::timestamptz,
    coalesce(v_audit->>'model_revision','MARKET-REGIME-OBSERVER-v2-C01-FULLMARKET'),
    coalesce(v_audit->>'policy_revision','P10-ENTRY-REGIME-SHADOW-v1'),
    nullif(v_audit->>'regime',''),
    nullif(v_audit->>'phase',''),
    nullif(v_audit->>'bull_score','')::double precision,
    nullif(v_audit->>'confidence','')::double precision,
    nullif(v_audit->>'sample_size','')::integer,
    nullif(v_audit->>'observation_trading_influence','')::boolean,
    coalesce((v_audit->>'live_gate_candidate')::boolean, false),
    coalesce(v_audit->>'recommendation','UNKNOWN'),
    coalesce(v_audit->>'reason','REGIME_EVALUATION_FAILED'),
    true,
    v_audit
  )
  on conflict (claim_id) do nothing;

  return new;
exception when others then
  -- Shadow telemetry can never change claim success or order admission.
  raise warning 'P10 entry regime shadow write failed for claim %: %', new.id, sqlerrm;
  return new;
end;
$$;

revoke all on function public.record_p10_entry_regime_shadow() from public;

drop trigger if exists trg_p10_entry_regime_shadow on public.p10_signal_claims;
create trigger trg_p10_entry_regime_shadow
after insert on public.p10_signal_claims
for each row execute function public.record_p10_entry_regime_shadow();

-- Causal backfill for existing recent claims. This is telemetry only and uses the same
-- evaluator with each historical claim timestamp, never a later observation.
insert into public.p10_entry_regime_shadow (
  claim_id,
  position_id,
  venue,
  market,
  side,
  signal_time,
  claimed_at,
  observation_id,
  observed_at,
  model_revision,
  policy_revision,
  regime,
  phase,
  bull_score,
  confidence,
  sample_size,
  observation_trading_influence,
  live_gate_candidate,
  recommendation,
  reason,
  shadow_only,
  audit
)
select
  c.id,
  c.position_id,
  c.venue,
  c.market,
  upper(c.side),
  c.signal_time,
  c.claimed_at,
  nullif(a.audit->>'observation_id','')::uuid,
  nullif(a.audit->>'observed_at','')::timestamptz,
  coalesce(a.audit->>'model_revision','MARKET-REGIME-OBSERVER-v2-C01-FULLMARKET'),
  coalesce(a.audit->>'policy_revision','P10-ENTRY-REGIME-SHADOW-v1'),
  nullif(a.audit->>'regime',''),
  nullif(a.audit->>'phase',''),
  nullif(a.audit->>'bull_score','')::double precision,
  nullif(a.audit->>'confidence','')::double precision,
  nullif(a.audit->>'sample_size','')::integer,
  nullif(a.audit->>'observation_trading_influence','')::boolean,
  coalesce((a.audit->>'live_gate_candidate')::boolean, false),
  coalesce(a.audit->>'recommendation','UNKNOWN'),
  coalesce(a.audit->>'reason','REGIME_EVALUATION_FAILED'),
  true,
  a.audit
from public.p10_signal_claims c
cross join lateral (
  select public.evaluate_p10_entry_regime_shadow(c.side, c.claimed_at) as audit
) a
where c.claimed_at >= now() - interval '14 days'
on conflict (claim_id) do nothing;
