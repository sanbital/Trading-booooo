-- Track counterfactual outcomes for futures signals that passed the scanner
-- but were rejected later by admission, liquidity, or execution checks.
-- This is observational only: it does not change entry/exit thresholds or orders.

create table if not exists public.entry_rejection_shadow_outcomes (
  decision_id uuid not null,
  candidate_id uuid not null,
  horizon_seconds integer not null check (horizon_seconds > 0),
  scan_id uuid not null,
  exchange text not null,
  market text not null,
  observed_at timestamptz not null,
  evaluated_at timestamptz not null,
  entry_price numeric not null check (entry_price > 0),
  terminal_price numeric not null check (terminal_price > 0),
  max_price numeric not null check (max_price > 0),
  min_price numeric not null check (min_price > 0),
  terminal_return_pct numeric not null,
  mfe_pct numeric not null,
  mae_pct numeric not null,
  decision_outcome text not null,
  rejection_reason text,
  engine_revision text,
  source text not null default 'ENTRY_REJECTION_REPLAY',
  created_at timestamptz not null default now(),
  primary key (decision_id, horizon_seconds)
);

create index if not exists entry_rejection_shadow_outcomes_observed_idx
  on public.entry_rejection_shadow_outcomes (exchange, observed_at desc);

create index if not exists entry_rejection_shadow_outcomes_reason_idx
  on public.entry_rejection_shadow_outcomes (exchange, rejection_reason, horizon_seconds, observed_at desc);

create or replace function public.refresh_entry_rejection_shadow_outcomes(p_limit integer default 1000)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  inserted_count integer := 0;
begin
  with targets as materialized (
    select
      d.id as decision_id,
      c.id as candidate_id,
      c.scan_id,
      c.exchange,
      c.market,
      c.created_at as observed_at,
      c.entry_low::numeric as entry_price,
      d.outcome as decision_outcome,
      d.reason as rejection_reason,
      coalesce(d.audit ->> 'execution_engine_version', sr.engine_version) as engine_revision,
      h.horizon_seconds,
      terminal.terminal_price,
      terminal.terminal_observed_at
    from public.trading_decisions d
    join public.scanner_candidates c
      on c.exchange = d.exchange
     and c.market = d.market
     and c.scan_id::text = d.scan_id
    join public.scanner_scan_runs sr on sr.id = c.scan_id
    cross join (values (180), (600)) as h(horizon_seconds)
    join lateral (
      select
        c2.entry_low::numeric as terminal_price,
        c2.created_at as terminal_observed_at
      from public.scanner_candidates c2
      where c2.exchange = c.exchange
        and c2.market = c.market
        and c2.created_at >= c.created_at + make_interval(secs => h.horizon_seconds)
        and c2.created_at <= c.created_at + make_interval(secs => h.horizon_seconds + 180)
        and c2.entry_low > 0
      order by c2.created_at
      limit 1
    ) terminal on true
    where d.exchange = 'binance_futures'
      and coalesce(d.outcome, '') <> 'ENTERED'
      and coalesce(c.decision, '') in ('BUY', 'ENTER')
      and coalesce(c.failed_gate_count, 0) = 0
      and c.entry_low > 0
      and c.created_at >= now() - interval '48 hours'
      and c.created_at <= now() - make_interval(secs => h.horizon_seconds)
      and not exists (
        select 1
        from public.entry_rejection_shadow_outcomes o
        where o.decision_id = d.id
          and o.horizon_seconds = h.horizon_seconds
      )
    order by c.created_at
    limit greatest(1, least(p_limit, 5000))
  ), priced as (
    select
      t.*,
      max(c3.entry_low)::numeric as max_price,
      min(c3.entry_low)::numeric as min_price
    from targets t
    join public.scanner_candidates c3
      on c3.exchange = t.exchange
     and c3.market = t.market
     and c3.created_at > t.observed_at
     and c3.created_at <= t.terminal_observed_at
     and c3.entry_low > 0
    group by
      t.decision_id, t.candidate_id, t.horizon_seconds, t.scan_id,
      t.exchange, t.market, t.observed_at, t.entry_price,
      t.decision_outcome, t.rejection_reason, t.engine_revision,
      t.terminal_price, t.terminal_observed_at
  )
  insert into public.entry_rejection_shadow_outcomes (
    decision_id, candidate_id, horizon_seconds, scan_id, exchange, market,
    observed_at, evaluated_at, entry_price, terminal_price, max_price, min_price,
    terminal_return_pct, mfe_pct, mae_pct, decision_outcome, rejection_reason,
    engine_revision, source
  )
  select
    decision_id, candidate_id, horizon_seconds, scan_id, exchange, market,
    observed_at, terminal_observed_at, entry_price, terminal_price, max_price, min_price,
    ((terminal_price / entry_price) - 1) * 100,
    ((max_price / entry_price) - 1) * 100,
    ((min_price / entry_price) - 1) * 100,
    decision_outcome, rejection_reason, engine_revision, 'ENTRY_REJECTION_REPLAY'
  from priced
  on conflict (decision_id, horizon_seconds) do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$function$;

-- Use a separate cron job so the existing scanner-blocked replay keeps its
-- original semantics and return value.
do $block$
begin
  if exists (select 1 from cron.job where jobname = 'entry-rejection-shadow-refresh') then
    perform cron.unschedule('entry-rejection-shadow-refresh');
  end if;

  perform cron.schedule(
    'entry-rejection-shadow-refresh',
    '* * * * *',
    'select public.refresh_entry_rejection_shadow_outcomes(1000);'
  );
end;
$block$;

comment on table public.entry_rejection_shadow_outcomes is
  'Counterfactual 180s/600s outcomes for Binance Futures signals accepted by scanner but rejected before entry.';
