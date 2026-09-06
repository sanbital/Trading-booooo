alter table public.v16_momentum_shadow_positions
  add column if not exists last_evaluated_bar_at timestamptz not null default '1970-01-01 00:00:00+00';