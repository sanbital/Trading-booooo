-- Keep completed live-trading rows immutable during normal runtime updates.
-- This is an accounting safety guard only; it does not change entry/exit decisions.

create or replace function public.protect_closed_trading_position_ledger()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_override text := current_setting('trading_boooo.allow_closed_rewrite', true);
begin
  if old.state = 'CLOSED' and coalesce(v_override, '') <> 'on' then
    if new.state is distinct from 'CLOSED' then
      raise exception 'CLOSED trading position % is immutable', old.id
        using errcode = '55000';
    end if;

    -- A completed trade is a historical fact. Runtime telemetry may still update
    -- unrelated columns, but settlement economics and audit metadata stay fixed.
    new.closed_at := old.closed_at;
    new.close_reason := old.close_reason;
    new.realized_proceeds_quote := old.realized_proceeds_quote;
    new.realized_cost_quote := old.realized_cost_quote;
    new.paid_fees_quote := old.paid_fees_quote;
    new.realized_pnl_quote := old.realized_pnl_quote;
    new.realized_return_pct := old.realized_return_pct;
    new.residual_quantity := old.residual_quantity;
    new.residual_value_quote := old.residual_value_quote;
    new.residual_fee_base := old.residual_fee_base;
    new.accounting_version := old.accounting_version;
    new.fee_accounting_quality := old.fee_accounting_quality;
    new.fee_accounting_version := old.fee_accounting_version;
    new.metadata := old.metadata;
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_protect_closed_trading_position_ledger on public.trading_positions;
create trigger trg_protect_closed_trading_position_ledger
before update on public.trading_positions
for each row
execute function public.protect_closed_trading_position_ledger();

comment on function public.protect_closed_trading_position_ledger is
  'Prevents normal runtime updates from reopening CLOSED positions or changing settled PnL, close timestamps/reasons, residual accounting, or metadata. A controlled SQL maintenance session may SET LOCAL trading_boooo.allow_closed_rewrite = on before an intentional historical correction.';
