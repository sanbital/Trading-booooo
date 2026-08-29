import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  dedupeP10LinkedFills,
  p10DurableFillScopeError,
  summarizeP10LinkedFills,
} from "./p10-entry-reconciliation.ts";
import {
  p10DurableExitQuantityComplete,
  settleP10ExitBeforeOrderLookup,
} from "./p10-exit-reconciliation.ts";

const scope = {
  exchange: "binance_futures",
  market: "ETHUSDT",
  positionId: "position-1",
  orderId: "order-1",
  exchangeOrderId: "9001",
  clientOrderId: "tb-p10x-position-1",
};

const sellFill = {
  id: "fill-1",
  exchange: scope.exchange,
  market: scope.market,
  position_id: scope.positionId,
  bot_order_id: scope.orderId,
  exchange_order_id: scope.exchangeOrderId,
  client_order_id: scope.clientOrderId,
  exchange_trade_id: "trade-1",
  side: "SELL",
  price: 2500,
  quantity: 0.02,
  quote_amount: 50,
  fee_quote_amount: 0.025,
  fee_amount: 0.025,
  fee_asset: "USDT",
  executed_at: "2026-08-29T12:00:00.000Z",
};

Deno.test("durable LONG exit accepts SELL and dedupes the same exchange trade identity", () => {
  const duplicate = { ...sellFill, id: "fill-duplicate-row" };
  const deduped = dedupeP10LinkedFills([sellFill, duplicate]);
  assertEquals(deduped.valid, true);
  assertEquals(deduped.rows.length, 1);

  const summary = summarizeP10LinkedFills(deduped.rows, "SELL", "exit");
  assertEquals(summary.valid, true);
  assertEquals(summary.count, 1);
  assertEquals(summary.executedVolume, 0.02);
  assertEquals(summary.executedFunds, 50);
  assertEquals(summary.paidFeeQuote, 0.025);
});

Deno.test("durable SHORT exit accepts BUY and rejects the opposite direction", () => {
  const buyFill = { ...sellFill, side: "BUY" };
  assertEquals(summarizeP10LinkedFills([buyFill], "BUY", "exit").valid, true);
  const wrongDirection = summarizeP10LinkedFills([sellFill], "BUY", "exit");
  assertEquals(wrongDirection.valid, false);
  assertEquals(wrongDirection.reason, "linked fill has invalid exit direction or economics");
});

Deno.test("durable exit rejects non-positive economics and conflicting duplicate trades", () => {
  const invalidEconomics = summarizeP10LinkedFills(
    [
      { ...sellFill, quantity: 0 },
    ],
    "SELL",
    "exit",
  );
  assertEquals(invalidEconomics.valid, false);

  const conflict = dedupeP10LinkedFills([
    sellFill,
    { ...sellFill, id: "fill-2", quantity: 0.03, quote_amount: 75 },
  ]);
  assertEquals(conflict.valid, false);
  assertEquals(conflict.reason, "duplicate durable trade identity has conflicting economics");
});

Deno.test("durable fill scope and order lineage mismatches fail closed", () => {
  assertEquals(p10DurableFillScopeError(sellFill, scope), null);
  assertEquals(
    p10DurableFillScopeError({ ...sellFill, market: "BTCUSDT" }, scope),
    "durable fill escaped its exchange/market scope",
  );
  assertEquals(
    p10DurableFillScopeError({ ...sellFill, position_id: "position-2" }, scope),
    "durable fill is linked to another position",
  );
  assertEquals(
    p10DurableFillScopeError({ ...sellFill, bot_order_id: "order-2" }, scope),
    "durable fill has a conflicting bot order identity",
  );
});

Deno.test("durable exit settles before an injected order-does-not-exist lookup", async () => {
  let applyCalls = 0;
  let lookupCalls = 0;
  const summary = summarizeP10LinkedFills([sellFill], "SELL", "exit");
  const result = await settleP10ExitBeforeOrderLookup({
    loadDurableFills: () => Promise.resolve({ rows: [sellFill], summary }),
    applyDurableFills: () => {
      applyCalls += 1;
      return Promise.resolve({ closed: true });
    },
    lookupOrder: () => {
      lookupCalls += 1;
      return Promise.reject(new Error("Order does not exist."));
    },
  });

  assertEquals(result.source, "DURABLE_FILLS");
  assertEquals(applyCalls, 1);
  assertEquals(lookupCalls, 0);
});

Deno.test("partial or fee-incomplete durable evidence keeps the gateway fallback", async () => {
  assertEquals(
    p10DurableExitQuantityComplete({
      durableExecutedVolume: 1,
      requestedVolume: 2,
      persistedExecutedVolume: 0,
      orderState: "UNKNOWN",
      quantityStep: 0.01,
    }),
    false,
  );
  assertEquals(
    p10DurableExitQuantityComplete({
      durableExecutedVolume: 1,
      requestedVolume: 2,
      persistedExecutedVolume: 1,
      orderState: "EXCHANGE_PARTIAL_CANCELLED",
      quantityStep: 0.01,
    }),
    true,
  );

  let lookupCalls = 0;
  const result = await settleP10ExitBeforeOrderLookup({
    loadDurableFills: () =>
      Promise.resolve({
        rows: [sellFill],
        summary: {
          ...summarizeP10LinkedFills([sellFill], "SELL", "exit"),
          feeQuoteComplete: false,
        },
      }),
    canApplyDurableFills: (durable) => durable.summary.feeQuoteComplete,
    applyDurableFills: () => Promise.resolve({}),
    lookupOrder: () => {
      lookupCalls += 1;
      return Promise.resolve({ status: "FILLED" });
    },
  });
  assertEquals(result.source, "ORDER_LOOKUP");
  assertEquals(lookupCalls, 1);
});

Deno.test("invalid durable exit evidence never falls through to gateway lookup", async () => {
  let lookupCalls = 0;
  let error = "";
  try {
    await settleP10ExitBeforeOrderLookup({
      loadDurableFills: () =>
        Promise.resolve({
          rows: [{ ...sellFill, side: "BUY" }],
          summary: summarizeP10LinkedFills([{ ...sellFill, side: "BUY" }], "SELL", "exit"),
        }),
      applyDurableFills: () => Promise.resolve({}),
      lookupOrder: () => {
        lookupCalls += 1;
        return Promise.resolve({});
      },
    });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  assertEquals(error, "linked fill has invalid exit direction or economics");
  assertEquals(lookupCalls, 0);
});

Deno.test("P10 EXIT source loads all durable identities before get_order fallback", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const start = source.indexOf("async function reconcileP10Order(");
  const end = source.indexOf("function p10ExchangeQuantity(", start);
  assert(start >= 0 && end > start);
  const reconciliation = source.slice(start, end);
  const durableFirst = reconciliation.indexOf(
    "const exitEvidence = await settleP10ExitBeforeOrderLookup",
  );
  const durableLoad = reconciliation.indexOf("loadP10LinkedExitFills", durableFirst);
  const durableApply = reconciliation.indexOf("applyP10ExitAccounting", durableLoad);
  const lookup = reconciliation.indexOf('action: "get_order"', durableApply);
  const durableReturn = reconciliation.indexOf('source: "EXCHANGE_FILLS"', lookup);
  const gatewayUpdate = reconciliation.indexOf("updateOrderFromGateway", durableReturn);
  assert(
    durableFirst >= 0 && durableFirst < durableLoad && durableLoad < durableApply &&
      durableApply < lookup && lookup < durableReturn && durableReturn < gatewayUpdate,
  );

  const loaderStart = source.indexOf("async function loadP10LinkedFills(");
  const loaderEnd = source.indexOf("async function p10EntryExposureProof(", loaderStart);
  const loader = source.slice(loaderStart, loaderEnd);
  assert(loader.includes("&bot_order_id=eq."));
  assert(loader.includes("&exchange_order_id=eq."));
  assert(loader.includes("&client_order_id=eq."));
  assert(loader.includes("p10DurableFillScopeError"));
  assert(loader.includes("dedupeP10LinkedFills"));
  assert(loader.includes("const exitSide = p10ExitSide"));
});

Deno.test("database exit application remains order-idempotent", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20260824013500_p10_market_risk_overlay.sql", import.meta.url),
  );
  const start = sql.indexOf("create or replace function public.apply_p10_exit_order(");
  const end = sql.indexOf("revoke all on function public.apply_p10_exit_order(", start);
  assert(start >= 0 && end > start);
  const apply = sql.slice(start, end);
  const appliedGuard = apply.indexOf("if v_order.state = 'APPLIED' then");
  const positiveGuard = apply.indexOf("if coalesce(p_fill_quantity, 0) <= 0", appliedGuard);
  const positionUpdate = apply.indexOf("update public.trading_positions set", positiveGuard);
  assert(appliedGuard >= 0 && appliedGuard < positiveGuard && positiveGuard < positionUpdate);
  assert(apply.includes("v_order.side <> v_expected_side"));
});
