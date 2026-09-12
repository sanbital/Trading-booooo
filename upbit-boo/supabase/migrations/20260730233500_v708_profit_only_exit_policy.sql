-- Trading-booooo v7.0.8: profit-only ordinary exits.
--
-- User policy:
--   * never realize an ordinary loss before -5%;
--   * remove time-based loss liquidation;
--   * hold a negative position after 180 seconds;
--   * close as soon as the estimated result is net positive.
--
-- The Edge Function uses target_2 before every other ordinary exit. We therefore pin both
-- targets to a conservative fee-aware breakeven level and pin the only loss stop to -5%.
-- max_holding_at is infinity so the legacy base TIME_EXIT route cannot bypass the LOB policy.

create or replace function public.enforce_v708_profit_only_exit_policy()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  entry_price numeric;
  positive_exit_multiplier numeric;
begin
  if new.state = 'OPEN' then
    entry_price := coalesce(
      nullif(new.average_entry_price, 0),
      nullif(new.planned_entry_price, 0)
    );

    if entry_price is not null and entry_price > 0 then
      -- Upbit: 5 bps per side + 5 bps execution buffer = 15 bps.
      -- Binance: 10 bps per side + 5 bps execution buffer = 25 bps.
      positive_exit_multiplier := case
        when new.exchange = 'upbit' then 1.0015
        else 1.0025
      end;

      new.stop_price := entry_price * 0.95;
      new.target_1 := entry_price * positive_exit_multiplier;
      new.target_2 := entry_price * positive_exit_multiplier;
      new.max_holding_at := 'infinity'::timestamptz;

      -- A trailing floor is allowed only after it already guarantees a positive net exit.
      if coalesce(new.trailing_stop, 0) < new.target_1 then
        new.trailing_stop := null;
      end if;

      new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
        'exit_policy_revision', '7.0.8-PROFIT-ONLY-EXIT',
        'hard_stop_return_pct', -5,
        'positive_exit_multiplier', positive_exit_multiplier,
        'timeout_loss_exit_enabled', false,
        'profit_only_exit_enforced_at', now()
      );
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_v708_profit_only_exit_policy() from public;
revoke all on function public.enforce_v708_profit_only_exit_policy() from anon;
revoke all on function public.enforce_v708_profit_only_exit_policy() from authenticated;

drop trigger if exists trading_positions_v708_profit_only_exit on public.trading_positions;
create trigger trading_positions_v708_profit_only_exit
before insert or update on public.trading_positions
for each row
execute function public.enforce_v708_profit_only_exit_policy();

-- Disable capital rotation because the legacy rotation route can request a loss-making exit.
update public.trading_settings
set lob_rotation_enabled = false,
    updated_at = now(),
    version = version + 1
where id = 1;

-- Re-run the trigger for any position that happened to open during deployment.
update public.trading_positions
set updated_at = now()
where state = 'OPEN';
