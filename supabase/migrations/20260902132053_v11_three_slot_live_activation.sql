-- V11 three-slot live activation.
--
-- Replaces the single-open-position safety index with a three-slot cap that
-- matches MAX_SLOTS in v11-micro-executor / v10-lane-executor.
--
-- Why this matters: v11_long_regime_one_open_position rejected the second
-- concurrent position AFTER its IOC entry had already filled on Binance, which
-- left an untracked live position (FILUSDT, 2026-09-02 12:01) outside stop-loss
-- and time-exit management for 95 minutes. The cap below is still enforced in
-- the database, but at the same slot count the executors use, so a filled entry
-- can always be recorded.

drop index if exists public.v11_long_regime_one_open_position;

-- One open position per symbol. The executors already refuse duplicate symbols
-- in code; this keeps the invariant enforced in the database.
create unique index if not exists v11_long_regime_one_open_position_per_symbol
  on public.v11_long_regime_positions (symbol)
  where state = 'OPEN';

create or replace function public.v11_long_regime_enforce_slot_cap()
returns trigger
language plpgsql
as $$
declare
  slot_cap constant int := 3;
  open_count int;
begin
  if new.state is distinct from 'OPEN' then
    return new;
  end if;

  -- Serialise concurrent entries so the count below cannot be raced.
  perform pg_advisory_xact_lock(hashtext('v11_long_regime_slot_cap'));

  select count(*)
    into open_count
    from public.v11_long_regime_positions
   where state = 'OPEN'
     and id is distinct from new.id;

  if open_count >= slot_cap then
    raise exception
      'V11_SLOT_CAP_EXCEEDED: % open positions already, cap is %',
      open_count, slot_cap
      using errcode = '23505';
  end if;

  return new;
end;
$$;

drop trigger if exists v11_long_regime_slot_cap_trg on public.v11_long_regime_positions;

create trigger v11_long_regime_slot_cap_trg
  before insert or update of state on public.v11_long_regime_positions
  for each row
  execute function public.v11_long_regime_enforce_slot_cap();
