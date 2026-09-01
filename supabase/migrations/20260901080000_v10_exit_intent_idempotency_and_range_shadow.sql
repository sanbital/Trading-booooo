-- V10 runtime repair: exit idempotency is decision-scoped, not signal-scoped.
-- Also activates only the independently validated RANGE entry lane in shadow.
-- BULL remains on the existing P10 production path; failed V10 BULL/BEAR candidates stay disabled.

begin;

alter table public.v10_lane_order_intents
  add column if not exists exit_decision_id bigint;

alter table public.v10_lane_order_intents
  drop constraint if exists v10_lane_order_intents_signal_id_intent_key;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.v10_lane_order_intents'::regclass
      and conname = 'v10_lane_order_intents_exit_decision_id_fkey'
  ) then
    alter table public.v10_lane_order_intents
      add constraint v10_lane_order_intents_exit_decision_id_fkey
      foreign key (exit_decision_id)
      references public.v10_lane_exit_decisions(id)
      on delete set null;
  end if;
end
$$;

alter table public.v10_lane_order_intents
  drop constraint if exists v10_lane_order_intents_decision_scope_ck;

alter table public.v10_lane_order_intents
  add constraint v10_lane_order_intents_decision_scope_ck
  check (
    (intent = 'OPEN_LONG' and exit_decision_id is null)
    or
    (intent = 'CLOSE_LONG' and exit_decision_id is not null)
  );

create unique index if not exists v10_lane_order_intents_one_open_per_signal_uidx
  on public.v10_lane_order_intents(signal_id)
  where intent = 'OPEN_LONG';

create unique index if not exists v10_lane_order_intents_one_close_per_decision_uidx
  on public.v10_lane_order_intents(exit_decision_id)
  where intent = 'CLOSE_LONG';

comment on column public.v10_lane_order_intents.exit_decision_id is
  'Required for CLOSE_LONG. Allows multiple partial/full exits for one entry signal while preserving decision-level idempotency.';

insert into public.v10_lane_strategy_versions(
  fingerprint,
  lane,
  revision,
  params,
  research_evidence
)
values (
  'RANGE_V10_LANES_3_0_0',
  'RANGE',
  'V10-LANES-3.0.0',
  jsonb_build_object(
    'bar','15m',
    'side','LONG',
    'entry','next_open',
    'btc72_min',-0.05,
    'btc72_max',0.04,
    'atr_ratio_min',1.65,
    'bb_pos_max',-1.05,
    'quote_volume_24h_min_usdt',50000000,
    'hold_hours',6,
    'cooldown_hours',6,
    'leverage',3,
    'margin_usdt',40
  ),
  jsonb_build_object(
    'source_lock','research/v10_continuation/v10-lanes-3-2021-holdout-lock.json',
    'source_spec_sha256','9a41b270a1f11a6649bb5ca9510b0b53a48998979e8c4def5aed274262c6a27f',
    'untouched_2022_trades',72,
    'untouched_2022_mean_net_bps',25.9,
    'untouched_2022_profit_factor',1.2,
    'untouched_2022_loo_positive_fraction',1.0,
    'range_revalidation_required',false,
    'activation_scope','SHADOW_ONLY'
  )
)
on conflict (fingerprint) do nothing;

update public.v10_lane_flags
set validated = true,
    shadow_enabled = true,
    live_enabled = false,
    max_concurrent = 2,
    notional_usdt = 40,
    max_aggregate_notional_usdt = 80,
    leverage = 3,
    engine_revision = 'V10-LANES-3.0.0',
    spec_sha256 = '9a41b270a1f11a6649bb5ca9510b0b53a48998979e8c4def5aed274262c6a27f',
    updated_at = now()
where lane = 'RANGE';

update public.v10_lane_flags
set validated = false,
    shadow_enabled = false,
    live_enabled = false,
    updated_at = now()
where lane in ('BULL','BEAR');

do $$
declare
  v_job_id bigint;
begin
  select jobid
  into v_job_id
  from cron.job
  where jobname = 'v10-lane-signal-generator-v3';

  if v_job_id is null then
    raise exception 'v10-lane-signal-generator-v3 cron job not found';
  end if;

  perform cron.alter_job(
    job_id := v_job_id,
    schedule := '0,15,30,45 * * * *'
  );
end
$$;

insert into public.v10_lane_deployment_audit(
  stage,
  engine_revision,
  spec_sha256,
  edge_function_slug,
  passed,
  details
)
values (
  'RANGE_SHADOW_ACTIVATED',
  'V10-LANES-3.0.0',
  '9a41b270a1f11a6649bb5ca9510b0b53a48998979e8c4def5aed274262c6a27f',
  'v10-lane-signal-generator',
  true,
  jsonb_build_object(
    'lane','RANGE',
    'live_enabled',false,
    'shadow_enabled',true,
    'margin_usdt',40,
    'leverage',3,
    'bull_runtime','EXISTING_P10',
    'bear_runtime','CASH_FAILED_HOLDOUT'
  )
);

commit;
