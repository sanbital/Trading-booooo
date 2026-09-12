-- Trading-booooo v5.4.1 — base-asset commission repair.
--
-- ROOT CAUSE
-- ----------
-- Binance spot deducts the BUY commission from the coin you receive whenever fee payment
-- in BNB is disabled. `executedQty` is the GROSS matched quantity, so the account actually
-- receives `executedQty - commission`. applyEntryAccounting() booked the gross figure into
-- initial_quantity / remaining_quantity, so every Binance position's ledger permanently
-- expected about 0.1% more coin than existed.
--
-- The account reconciliation compared that expectation against the real balance with a
-- 0.0001% tolerance, decided the coin had been sold, and after three checks (45 seconds)
-- set manual_intervention_required — which stops new entries on EVERY market and BOTH
-- exchanges. No user action was involved at any point.
--
-- Observed on 2026-07-26: binance:AVAXUSDT, reported shortfall 0.2528 USDT against a
-- computed commission of 0.2526 USDT.
--
-- Upbit charges its fee in KRW on both sides, so its base quantities were never affected.

-- 1) Repair open positions booked before the fix, using the commissions actually recorded
--    in trading_fills. Only fills whose fee asset IS the position's base asset are
--    subtracted; quote-denominated fees never touched the base quantity.
with base_fees as (
  select
    o.position_id,
    sum(greatest(0, coalesce(f.fee_amount, 0))) as base_fee
  from public.trading_fills f
  join public.trading_orders o on o.id = f.order_id
  join public.trading_positions p on p.id = o.position_id
  where o.purpose = 'ENTRY'
    and o.side = 'BUY'
    and upper(coalesce(f.fee_asset, '')) = upper(p.base_asset)
  group by o.position_id
)
update public.trading_positions p
   set initial_quantity   = greatest(0, p.initial_quantity - b.base_fee),
       remaining_quantity = greatest(0, p.remaining_quantity - b.base_fee),
       metadata = coalesce(p.metadata, '{}'::jsonb) || jsonb_build_object(
         'base_fee_repaired', b.base_fee,
         'base_fee_repaired_at', now()
       )
  from base_fees b
 where p.id = b.position_id
   and b.base_fee > 0
   and p.state in ('OPEN', 'EXITING')
   -- Never repair twice.
   and coalesce(p.metadata->>'base_fee_repaired', '') = '';

-- 2) Clear the halt this bug raised. `SAFETY_POSITION_MISMATCH` flags produced by the
--    gross-quantity comparison are not evidence of anything.
update public.trading_settings
   set manual_intervention_required = false,
       manual_event_reason = null,
       pause_new_entries = false,
       manual_asset_locks = '[]'::jsonb,
       updated_at = now()
 where id = 1
   and coalesce(manual_event_reason, '') like 'SAFETY_POSITION_MISMATCH:%';

-- 3) Reset the per-position mismatch counters so a stale count cannot immediately
--    re-trigger the three-strike rule on the next monitor cycle.
update public.trading_positions
   set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
         'account_mismatch_count', 0,
         'last_account_mismatch_at', null
       )
 where state in ('OPEN', 'EXITING')
   and coalesce((metadata->>'account_mismatch_count')::numeric, 0) > 0;

-- 4) Positions closed as MANUAL_POSITION_REDUCTION by this bug are not real user trades
--    and must not train the calibration model.
update public.trading_positions
   set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
         'exclude_from_learning', true,
         'exclusion_reason', 'FALSE_MANUAL_REDUCTION_BASE_FEE'
       )
 where close_reason = 'MANUAL_RECONCILE'
   and closed_at > now() - interval '7 days'
   and coalesce(metadata->>'exclude_from_learning', 'false') <> 'true';
