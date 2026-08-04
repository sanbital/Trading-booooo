-- Trading-booooo v7.4.0-STATISTICAL-FEATURE-EVIDENCE
--
-- A 24-hour live review tested the eight variables recorded at entry time against realized
-- return with Spearman rank correlation, permutation p-values and Benjamini-Hochberg
-- correction. None survived correction. The only significant variables were MFE and MAE,
-- both recorded after the fill, so neither can select a trade.
--
-- That review ran outside the system, once, by hand. This migration gives the finding a
-- permanent home so it is re-derived from live data on every calibration cycle:
--
--   lob_feature_evidence  — append-only ledger of significance reports, one row per venue
--                           cohort per run. Never updated in place: a threshold change must
--                           be traceable to the exact report that justified it.
--   trading_settings.lob_feature_admission
--                        — the current authority map the trading path reads. Features are
--                          NONE until measurement promotes them, never the other way round.
--
-- Cohorts are stored separately by exchange on purpose. Binance and Upbit differ in fee
-- schedule, tick geometry and quote unit, so a pooled correlation measures the venue mix.

create table if not exists public.lob_feature_evidence (
  id uuid primary key default gen_random_uuid(),
  generated_at timestamptz not null default now(),
  cohort text not null check (cohort in ('binance', 'upbit', 'unknown')),
  engine_version text,
  window_hours integer not null check (window_hours > 0),
  samples integer not null check (samples >= 0),
  wins integer not null check (wins >= 0),
  observation_hours numeric not null default 0 check (observation_hours >= 0),
  distinct_markets integer not null default 0 check (distinct_markets >= 0),
  alpha numeric not null default 0.05 check (alpha > 0 and alpha < 1),
  min_samples integer not null default 30 check (min_samples > 0),
  -- Full per-feature report: rho, raw permutation p, BH q, leave-one-out range, verdict.
  features jsonb not null default '[]'::jsonb,
  -- Group contrasts such as re-entry versus first entry.
  groups jsonb not null default '[]'::jsonb,
  -- Derived authority map for this cohort.
  admission jsonb not null default '{}'::jsonb,
  notes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint lob_feature_evidence_wins_ck check (wins <= samples)
);

create index if not exists lob_feature_evidence_cohort_idx
  on public.lob_feature_evidence(cohort, generated_at desc);

alter table public.lob_feature_evidence enable row level security;

drop policy if exists lob_feature_evidence_service_all on public.lob_feature_evidence;
create policy lob_feature_evidence_service_all
  on public.lob_feature_evidence for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists lob_feature_evidence_read on public.lob_feature_evidence;
create policy lob_feature_evidence_read
  on public.lob_feature_evidence for select
  using (auth.role() in ('anon', 'authenticated', 'service_role'));

comment on table public.lob_feature_evidence is
  'v7.4.0: append-only significance ledger. Spearman rho + permutation p + Benjamini-Hochberg '
  'q per venue cohort. Post-entry path variables (MFE, MAE, hold time) are recorded and '
  'explicitly denied admission authority.';

-- The authority map the runtime reads. Default is an empty array, which means every feature
-- sits at NONE: entry thresholds stay exactly where the operator set them until live
-- measurement earns a feature the right to move one.
alter table public.trading_settings
  add column if not exists lob_feature_admission jsonb not null default '[]'::jsonb,
  add column if not exists lob_feature_admission_measured_at timestamptz,
  add column if not exists lob_feature_admission_samples integer not null default 0;

alter table public.trading_settings
  drop constraint if exists trading_settings_lob_feature_admission_ck;
alter table public.trading_settings
  add constraint trading_settings_lob_feature_admission_ck
  check (jsonb_typeof(lob_feature_admission) = 'array');

alter table public.trading_settings
  drop constraint if exists trading_settings_lob_feature_admission_samples_ck;
alter table public.trading_settings
  add constraint trading_settings_lob_feature_admission_samples_ck
  check (lob_feature_admission_samples >= 0);

comment on column public.trading_settings.lob_feature_admission is
  'v7.4.0: per-cohort feature authority. NONE = informational, TIE_BREAK = may order equal '
  'candidates only, GATE = may move a threshold. Written by lob-calibration from measured '
  'evidence; an empty array is the correct state until a feature clears q < alpha.';

/**
 * Reject any admission map that hands authority to a post-entry variable.
 *
 * MFE, MAE and hold time correlate with realized return by construction, so a future
 * refactor that quietly forwarded them into the authority map would look like a strong
 * signal while actually being lookahead. The database refuses it rather than trusting that
 * every caller remembers.
 */
create or replace function public.guard_lob_feature_admission()
returns trigger
language plpgsql
as $$
declare
  v_cohort jsonb;
  v_entry jsonb;
  v_key text;
  v_authority text;
begin
  if new.lob_feature_admission is null then
    return new;
  end if;

  for v_cohort in select jsonb_array_elements(new.lob_feature_admission) loop
    for v_entry in select jsonb_array_elements(coalesce(v_cohort->'admissions', '[]'::jsonb)) loop
      v_key := coalesce(v_entry->>'key', '');
      v_authority := coalesce(v_entry->>'authority', 'NONE');

      if v_authority not in ('NONE', 'TIE_BREAK', 'GATE') then
        raise exception using errcode = '23514', message = format(
          'V740_UNKNOWN_FEATURE_AUTHORITY key=%s authority=%s', v_key, v_authority
        );
      end if;

      if v_key in ('mfe_bps', 'mae_bps', 'held_seconds') and v_authority <> 'NONE' then
        raise exception using errcode = '23514', message = format(
          'V740_POST_ENTRY_FEATURE_CANNOT_HOLD_AUTHORITY key=%s authority=%s', v_key, v_authority
        );
      end if;
    end loop;
  end loop;

  return new;
end;
$$;

drop trigger if exists trading_settings_feature_admission_guard on public.trading_settings;
create trigger trading_settings_feature_admission_guard
  before insert or update of lob_feature_admission on public.trading_settings
  for each row execute function public.guard_lob_feature_admission();

comment on function public.guard_lob_feature_admission() is
  'v7.4.0: refuses an admission map that grants ordering or gating authority to a variable '
  'only knowable after the fill.';
