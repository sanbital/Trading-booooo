-- Trading-booooo v6.6.1-JOINT-OBJECTIVE
--
-- v6.6.0 applied 17 same-session pattern observations as a hard EV correction and
-- discarded 17/17 live candidates (mean EV-LCB -4.21bp). That violated the operator's
-- joint objective: win rate and return may not be improved by reducing capital turnover.
--
-- The measured pattern multiplier remains intact for ranking. Runtime code now gives it
-- zero hard-gate weight below 120 samples for that exact pattern. Mature positive evidence
-- may ramp to full influence at 360; adverse evidence remains ranking/rotation-only so it
-- cannot manufacture a higher win rate by deleting turnover. The EV threshold remains
-- strictly positive and no trade-count ceiling or bypass is introduced.

update public.lob_learning_profiles p
set patterns = (
      select jsonb_agg(
        case item ->> 'pattern'
          when 'ABSORPTION_REVERSAL' then item || jsonb_build_object(
            'profitableRate', 5.0 / 29.0,
            'medianHoldSeconds', 65.927
          )
          when 'OFI_CONTINUATION' then item || jsonb_build_object(
            'profitableRate', 5.0 / 24.0,
            'medianHoldSeconds', 145.802
          )
          when 'SWEEP_RECLAIM' then item || jsonb_build_object(
            'profitableRate', 6.0 / 14.0,
            'medianHoldSeconds', 41.3065
          )
          else item
        end
        order by ordinal
      )
      from jsonb_array_elements(p.patterns) with ordinality as rows(item, ordinal)
    ),
    notes = coalesce(p.notes, '[]'::jsonb) ||
      case
        when coalesce(p.notes, '[]'::jsonb) @> '["JOINT_OBJECTIVE_V661"]'::jsonb
          then '[]'::jsonb
        else '["JOINT_OBJECTIVE_V661"]'::jsonb
      end
where p.active;

-- Recover legacy zero-quantity maker bids that old code moved to RECONCILING without an
-- ENTRY phase. Do not cancel or infer a fill in SQL: the next monitor cycle queries the
-- exchange by deterministic identifier, cancels the live order and books any real fill.
with latest_entry as (
  select distinct on (o.position_id)
    o.position_id,
    o.id as order_id,
    o.identifier,
    o.requested_price,
    o.requested_at
  from public.trading_orders o
  where o.purpose = 'ENTRY'
    and o.state = 'EXCHANGE_OPEN'
    and (
      upper(o.order_type) = 'LIMIT_MAKER'
      or o.identifier like 'tb-m-%'
    )
  order by o.position_id, o.created_at desc
)
update public.trading_positions p
set state = 'ENTRY_PENDING',
    updated_at = now(),
    metadata = coalesce(p.metadata, '{}'::jsonb) || jsonb_build_object(
      'reconciliation_phase', 'ENTRY',
      'maker_entry_identifier', e.identifier,
      'maker_entry_order_id', e.order_id,
      'maker_entry_price', coalesce(e.requested_price, p.planned_entry_price),
      'maker_entry_placed_at', e.requested_at,
      'legacy_maker_recovered_at', now()
    )
from latest_entry e
where e.position_id = p.id
  and p.state in ('RECONCILING', 'RECONCILIATION_FAILED')
  and coalesce(p.initial_quantity, 0) = 0
  and coalesce(p.remaining_quantity, 0) = 0
  and coalesce(p.metadata ->> 'reconciliation_phase', '') = '';

update public.trading_settings
set version = coalesce(version, 0) + 1,
    updated_at = now()
where id = 1
  and strategy = 'LOB_SCALP';
