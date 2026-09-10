-- V17 native-stop exits: link the SELL fills the attribution trigger could not classify.
--
-- WHY THIS IS NOT IN supabase/migrations
-- --------------------------------------
-- Same reason as the other files in this directory: main.deploy-supabase.yml fires on any
-- push to main touching supabase/migrations/**, so landing this as a migration would apply
-- it -- and redeploy unrelated functions -- as a side effect of merging code. Run it
-- deliberately from the SQL editor instead.
--
-- THE DEFECT
-- ----------
-- A native stop closes through /fapi/v1/algoOrder. Binance executes it as a separate market
-- order whose id is the algo's actualOrderId, and that order has NO row in
-- v11_long_regime_orders. 20260909001000_v17_native_stop_fill_attribution.sql therefore
-- taught enforce_futures_fill_order_attribution() to resolve such a fill by finding a
-- position whose metadata->'exitProtection'->'orders' already contains that id as
-- 'actualOrderId'. That journal is the only link back.
--
-- But the journal is written by the executor's protection.refresh() on its next one-minute
-- tick, while the fill row is written by exchange-trade-sync as soon as it sees the trade.
-- When sync wins the race the trigger finds no actualOrderId, falls through every branch and
-- stamps the row UNMATCHED_INVENTORY / source UNCLASSIFIED. The trigger only classifies a
-- row as it is written, so repairing the journal afterwards does not relabel it.
--
-- Measured on production 2026-09-10:
--   EDGEUSDT order 900418698 -- fill executed 00:32:11.044Z, journal recorded actualOrderId
--     at 00:33:02.976Z. 52 seconds late. The exit itself was completely healthy: position
--     69b72bbc-a2ab-4e5d-8627-8d8f81dac4c2 is CLOSED, remaining 0, exit_reason
--     V17_NATIVE_STOP, realized_pnl_usdt -0.75419745 booked from the gateway's own fill.
--     Only the ledger label is wrong.
--   CKBUSDT order 4191734774 -- the 2026-09-10 halt. The journal has no actualOrderId AT ALL
--     yet, because POSITION_MISMATCH opened the circuit before refresh() could record it.
--
-- So this is a recurring race, not a one-off, and V18-OPS-RACE-2 does not close it: that
-- patch ends the trading halt and lets the journal be completed, but a future native-stop
-- exit whose sync beats the tick will orphan its SELL fills again. See "REMAINING DEFECT"
-- at the bottom.
--
-- ORDER OF OPERATIONS
-- -------------------
-- EDGEUSDT can be repaired now -- its evidence already exists.
-- CKBUSDT is repaired only AFTER V18-OPS-RACE-2 is deployed and the reconciliation-only
-- path has recorded actualOrderId from the real exchange fill. Until then step 1 simply
-- does not list CKB and step 2 leaves it alone. This script never invents a link: it only
-- propagates one the exchange has already proved.
--
-- WHAT THIS DOES NOT DO
-- ---------------------
--   * does not set remaining_quantity, state, closed_at or exit_reason on any position
--   * does not add or change realized PnL anywhere. realized_pnl_usdt is booked on the
--     position by the protection reconciler from the gateway's own fill (funds/fee); the
--     ledger's realized_pnl_quote is a separate average-cost inventory ledger. Relabelling
--     attribution does not feed either, so there is no double accounting.
--   * does not delete, edit or move any fill's quantity, price, fee or timestamps
--   * does not touch the circuit breaker, and repairs nothing that lacks a FILLED receipt
--   * does NOT touch MAGMAUSDT (orders 1444776244 BUY / 1472439514 SELL, 1029 each way).
--     Those are not native-stop exits -- no position journal names either order -- so they
--     are outside this evidence rule and still need separate human classification.
--
-- IDEMPOTENCE
-- -----------
-- The UPDATE requires all four attribution columns to still be null, so re-running it
-- cannot double-link, cannot relabel an already-attributed row, and cannot move a row a
-- human has since classified by hand. The second run reports UPDATE 0.

-- ---------------------------------------------------------------------------
-- STEP 1 -- PRE-CHECK. Exactly what would change, and the receipt authorising
-- each row. Run alone and read it. Anything you do not recognise, stop.
--
-- Expected before the V18 deploy: 1 row  (EDGEUSDT / 900418698 / 93).
-- Expected after  the V18 deploy: 4 rows (adds CKBUSDT / 4191734774 x3, 101139).
-- ---------------------------------------------------------------------------
select f.market,
       f.exchange_order_id,
       f.exchange_trade_id,
       f.side,
       f.quantity,
       f.price,
       f.fee_quote_amount,
       f.executed_at,
       f.accounting_status as status_now,
       f.source           as source_now,
       p.id               as will_link_to_position,
       p.state            as position_state,
       p.exit_reason      as position_exit_reason,
       o->>'fillStatus'      as receipt_fill_status,
       o->>'appliedQuantity' as receipt_quantity,
       o->>'appliedFunds'    as receipt_funds,
       o->>'appliedFee'      as receipt_fee
from public.exchange_trade_fills f
join public.v11_long_regime_positions p
  on p.symbol = f.market
join lateral jsonb_array_elements(
  coalesce(p.metadata->'exitProtection'->'orders','[]'::jsonb)) o
  on o->>'actualOrderId' = f.exchange_order_id
where f.exchange = 'binance_futures'
  and f.v17_position_id is null
  and f.v17_order_id    is null
  and f.bot_order_id    is null
  and f.position_id     is null
  and o->>'fillStatus' = 'FILLED'
order by f.executed_at, f.exchange_trade_id;

-- ---------------------------------------------------------------------------
-- STEP 2 -- THE CORRECTION. Gated on the position's own exitProtection journal
-- naming that exact exchange order with a FILLED receipt. This is the same rule
-- the deployed trigger applies to new rows and the same rule the 20260909001000
-- backfill used; it is restated here so it can be re-run deliberately.
--
-- Run inside an explicit transaction. Confirm the row count matches step 1
-- before COMMIT; ROLLBACK on anything else.
-- ---------------------------------------------------------------------------
-- begin;

update public.exchange_trade_fills f
set v17_position_id   = p.id,
    v17_order_id      = null,   -- a native stop has no v11_long_regime_orders row
    bot_order_id      = null,
    position_id       = null,
    source            = 'AUTOMATED',
    accounting_status = 'PENDING',
    updated_at        = now()
from public.v11_long_regime_positions p
where f.exchange = 'binance_futures'
  -- idempotence: only ever touches a row that is still completely unattributed
  and f.v17_position_id is null
  and f.v17_order_id    is null
  and f.bot_order_id    is null
  and f.position_id     is null
  and p.symbol = f.market
  -- evidence gate: the exchange fill must already be journaled on the position,
  -- with a FILLED receipt, before its ledger row may be attributed to it
  and exists (
    select 1
    from jsonb_array_elements(
      coalesce(p.metadata->'exitProtection'->'orders','[]'::jsonb)) o
    where o->>'actualOrderId' = f.exchange_order_id
      and o->>'fillStatus'    = 'FILLED');

-- commit;

-- ---------------------------------------------------------------------------
-- STEP 3 -- POST-CHECK. Per position, both sides of the ledger. For a fully
-- closed V17 position the BUY and SELL quantities must match and net to zero.
--   EDGEUSDT 69b72bbc: BUY 93 / SELL 93
--   CKBUSDT  ecf3660c: BUY 101139 / SELL 101139  (after the V18 deploy)
-- ---------------------------------------------------------------------------
select p.symbol,
       f.v17_position_id,
       p.state,
       p.remaining_quantity,
       p.exit_reason,
       sum(case when upper(f.side)='BUY'  then f.quantity else 0 end) as buy_quantity,
       sum(case when upper(f.side)='SELL' then f.quantity else 0 end) as sell_quantity,
       sum(case when upper(f.side)='BUY'  then f.quantity else -f.quantity end) as net_quantity,
       sum(f.fee_quote_amount) as total_fee_quote,
       array_agg(distinct f.accounting_status) as statuses
from public.exchange_trade_fills f
join public.v11_long_regime_positions p on p.id = f.v17_position_id
where f.exchange = 'binance_futures'
  and f.v17_position_id in ('69b72bbc-a2ab-4e5d-8627-8d8f81dac4c2',
                            'ecf3660c-74c4-499b-992c-85496abaf81b')
group by p.symbol, f.v17_position_id, p.state, p.remaining_quantity, p.exit_reason
order by p.symbol;

-- ---------------------------------------------------------------------------
-- STEP 4 -- LEAK CHECK. Everything still unattributed on this account. Report
-- only; changes nothing. After step 2 the native-stop rows should be gone and
-- only MAGMAUSDT (which this rule deliberately does not cover) should remain.
-- ---------------------------------------------------------------------------
select market, side, count(*) as fills, sum(quantity) as quantity,
       min(executed_at) as first_at,
       array_agg(distinct exchange_order_id) as orders,
       array_agg(distinct source) as sources
from public.exchange_trade_fills
where exchange = 'binance_futures'
  and accounting_status = 'UNMATCHED_INVENTORY'
  and v17_position_id is null
  and v17_order_id    is null
  and bot_order_id    is null
  and position_id     is null
group by market, side
order by first_at;

-- ---------------------------------------------------------------------------
-- REMAINING DEFECT -- NOT FIXED BY THIS SCRIPT OR BY V18-OPS-RACE-2
-- ---------------------------------------------------------------------------
-- The race that produced these rows is still open. Whenever exchange-trade-sync inserts a
-- native stop's SELL fill before the executor's next tick records actualOrderId, that fill
-- is orphaned again and this script has to be re-run.
--
-- Closing it properly means making attribution retroactive rather than insert-only, e.g. a
-- scheduled re-attribution pass over recently unattributed futures fills using exactly the
-- evidence rule in step 2. That belongs in a DB function, which lands in supabase/migrations
-- and is therefore applied by main.deploy-supabase.yml on push -- a production mutation the
-- operator should schedule deliberately, not inherit from this recovery. It is written up
-- but deliberately NOT included here.
--
-- Until then: re-run steps 1-4 after any V17_NATIVE_STOP exit.
