-- v6.11.2: cohort-aware EV-bias governance.
--
-- The global realized-vs-forecast penalty must not be learned entirely from low-evidence
-- exploration and then applied to every future market. When no mature CORE cohort exists,
-- the global penalty is shrunk to a small cap; adverse market/pattern learning and the
-- controlled-exploration budget continue to price the observed risk locally.

alter table public.trading_settings
  add column if not exists lob_ev_bias_min_core_samples integer not null default 40,
  add column if not exists lob_ev_bias_fallback_cap_bps numeric not null default 4,
  add column if not exists lob_ev_bias_core_cap_bps numeric not null default 12,
  add column if not exists lob_ev_bias_raw_penalty_bps numeric not null default 0,
  add column if not exists lob_ev_bias_approved_penalty_bps numeric not null default 0,
  add column if not exists lob_ev_bias_core_samples integer not null default 0,
  add column if not exists lob_ev_bias_low_evidence_samples integer not null default 0,
  add column if not exists lob_ev_bias_core_mean_residual_bps numeric,
  add column if not exists lob_ev_bias_core_upper_bound_bps numeric,
  add column if not exists lob_ev_bias_governance_revision text not null
    default '6.11.2-COHORT-AWARE';

alter table public.trading_settings
  drop constraint if exists trading_settings_lob_ev_bias_governance_v6112;
alter table public.trading_settings
  add constraint trading_settings_lob_ev_bias_governance_v6112 check (
    lob_ev_bias_min_core_samples between 20 and 500
    and lob_ev_bias_fallback_cap_bps between 0 and 10
    and lob_ev_bias_core_cap_bps between lob_ev_bias_fallback_cap_bps and 30
    and lob_ev_bias_raw_penalty_bps >= 0
    and lob_ev_bias_approved_penalty_bps >= 0
    and lob_ev_bias_core_samples >= 0
    and lob_ev_bias_low_evidence_samples >= 0
  ) not valid;
alter table public.trading_settings
  validate constraint trading_settings_lob_ev_bias_governance_v6112;

create or replace function public.govern_lob_ev_bias_setting_v6112()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_core_n integer := 0;
  v_low_n integer := 0;
  v_core_mean numeric;
  v_core_se numeric := 0;
  v_core_upper numeric;
  v_raw numeric := greatest(0, coalesce(new.scalp_ev_bias_penalty_bps, 0));
  v_approved numeric := 0;
  v_weight numeric := 0;
begin
  with verified as (
    select
      public.safe_numeric_v6112(o.net_bps::text) -
        public.safe_numeric_v6112(
          coalesce(
            o.entry_snapshot ->> 'conditional_ev_lower_bound_bps',
            o.entry_snapshot ->> 'conditional_ev_net_bps'
          )
        ) as residual_bps,
      lower(coalesce(o.entry_snapshot #>> '{evidence_sizing,lowEvidence}', 'false')) = 'true'
        or upper(coalesce(
          o.entry_snapshot #>> '{features,dynamicStatus}',
          o.entry_snapshot #>> '{scanned_lob,features,dynamicStatus}',
          'UNKNOWN'
        )) in ('INSUFFICIENT', 'UNKNOWN') as low_evidence
    from public.lob_online_outcomes o
    where o.accounting_quality in ('NO_RESIDUAL', 'RESIDUAL_MARKED_TO_EXIT')
      and o.fee_accounting_quality in (
        'EXACT', 'AGGREGATE_EXACT', 'THIRD_ASSET_MARKED', 'BASE_ASSET_ACCOUNTED'
      )
      and o.prediction_basis = 'FILL_CONDITIONAL'
      and o.engine_version in (
        '6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE',
        '6.11.0-CONTINUOUS-ADAPTIVE-EXECUTION'
      )
  ),
  clean as (
    select residual_bps, low_evidence
    from verified
    where residual_bps is not null and abs(residual_bps) <= 5000
  ),
  core_ranked as (
    select residual_bps,
           row_number() over (order by residual_bps) as rn,
           count(*) over () as n
    from clean
    where not low_evidence
  ),
  core_trimmed as (
    select residual_bps
    from core_ranked
    where rn > floor(n * 0.05)
      and rn <= n - floor(n * 0.05)
  ),
  core_stats as (
    select count(*)::integer as n,
           avg(residual_bps) as mean,
           coalesce(stddev_samp(residual_bps), 0) /
             sqrt(greatest(1, count(*))) as se
    from core_trimmed
  ),
  low_stats as (
    select count(*)::integer as n
    from clean
    where low_evidence
  )
  select c.n, l.n, c.mean, c.se
    into v_core_n, v_low_n, v_core_mean, v_core_se
    from core_stats c cross join low_stats l;

  v_core_upper := case
    when v_core_mean is null then null
    else v_core_mean + 1.281551565545 * coalesce(v_core_se, 0)
  end;

  if v_core_n >= new.lob_ev_bias_min_core_samples
     and v_core_upper is not null
     and v_core_upper < 0
  then
    v_weight := v_core_n::numeric / (v_core_n + 80);
    v_approved := least(new.lob_ev_bias_core_cap_bps, greatest(0, -v_core_mean * v_weight));
    new.scalp_ev_bias_source := 'MEASURED_CORE';
  elsif v_core_n >= new.lob_ev_bias_min_core_samples then
    -- A mature core cohort does not confirm systematic optimism. Retain only a small
    -- operational cushion instead of carrying exploratory losses into the core lane.
    v_approved := least(v_raw, new.lob_ev_bias_fallback_cap_bps / 2);
    new.scalp_ev_bias_source := 'CORE_NOT_ADVERSE';
  else
    -- Low-evidence-only history is informative for local pattern/market penalties and the
    -- exploration budget, but is not representative enough to own a global veto.
    v_approved := least(
      v_raw,
      new.lob_ev_bias_fallback_cap_bps +
        (new.lob_ev_bias_core_cap_bps - new.lob_ev_bias_fallback_cap_bps) *
        least(1, v_core_n::numeric / greatest(1, new.lob_ev_bias_min_core_samples))
    );
    new.scalp_ev_bias_source := 'SHRUNK_LOW_EVIDENCE';
  end if;

  new.lob_ev_bias_raw_penalty_bps := v_raw;
  new.lob_ev_bias_approved_penalty_bps := v_approved;
  new.lob_ev_bias_core_samples := v_core_n;
  new.lob_ev_bias_low_evidence_samples := v_low_n;
  new.lob_ev_bias_core_mean_residual_bps := v_core_mean;
  new.lob_ev_bias_core_upper_bound_bps := v_core_upper;
  new.lob_ev_bias_governance_revision := '6.11.2-COHORT-AWARE';
  new.scalp_ev_bias_penalty_bps := v_approved;
  return new;
end;
$$;

drop trigger if exists trading_settings_lob_ev_bias_governance_v6112
  on public.trading_settings;
create trigger trading_settings_lob_ev_bias_governance_v6112
before update of scalp_ev_bias_penalty_bps on public.trading_settings
for each row
when (new.id = 1)
execute function public.govern_lob_ev_bias_setting_v6112();

revoke all on function public.govern_lob_ev_bias_setting_v6112()
  from public, anon, authenticated;

-- Run the new governance once against the currently measured raw penalty.
update public.trading_settings
   set scalp_ev_bias_penalty_bps = scalp_ev_bias_penalty_bps,
       updated_at = now()
 where id = 1;

comment on function public.govern_lob_ev_bias_setting_v6112() is
  'Prevents low-evidence-only forecast residuals from becoming a global no-trade penalty; mature core residuals may still produce a bounded global correction.';
