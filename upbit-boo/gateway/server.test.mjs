import test from "node:test";
import assert from "node:assert/strict";

process.env.UPBIT_ACCESS_KEY = "access";
process.env.UPBIT_SECRET_KEY = "secret";
process.env.BINANCE_API_KEY = "binance-access";
process.env.BINANCE_SECRET_KEY = "binance-secret";
process.env.GATEWAY_SHARED_SECRET = "x".repeat(32);
process.env.SCHEDULER_ENABLED = "false";
const module = await import(`./server.mjs?test=${Date.now()}`);

test("Upbit raw query preserves unhashed array convention", () => {
  assert.equal(
    module.rawQueryString({ market: "KRW-BTC", states: ["wait", "watch"] }),
    "market=KRW-BTC&states[]=wait&states[]=watch",
  );
});
test("Upbit encoded query is safe for transport", () => {
  assert.equal(
    module.encodedQueryString({ market: "KRW-BTC", states: ["wait", "watch"] }),
    "market=KRW-BTC&states[]=wait&states[]=watch",
  );
});
test("Binance query and signature are deterministic", () => {
  const query = module.binanceQueryString({ symbol: "BTCUSDT", side: "BUY", timestamp: 123 });
  assert.equal(query, "symbol=BTCUSDT&side=BUY&timestamp=123");
  assert.equal(module.createBinanceSignature(query).length, 64);
});
test("gateway restricts identifiers and spot markets", () => {
  assert.equal(module.validateUpbitMarket("krw-btc"), "KRW-BTC");
  assert.throws(() => module.validateUpbitMarket("BTCUSDT"));
  assert.equal(module.validateBinanceSymbol("btcusdt"), "BTCUSDT");
  assert.throws(() => module.validateBinanceSymbol("BTCUSDC"));
  assert.equal(module.validateIdentifier("tb-e-abc"), "tb-e-abc");
  assert.throws(() => module.validateIdentifier("manual-order"));
});

test("gateway blocks orders from a missing or different engine revision", () => {
  assert.throws(
    () => module.assertOrderEngineVersion({}),
    (error) => error.code === "ENGINE_VERSION_MISMATCH" && error.status === 409,
  );
  assert.throws(
    () => module.assertOrderEngineVersion({ engine_version: "7.2.2-LOB-ENTRY-RISK-GATES" }),
    (error) => error.code === "ENGINE_VERSION_MISMATCH",
  );
  // Read the accepted revision off the module rather than pinning it here: the assertion
  // under test is "command revision must equal gateway revision", which is what should be
  // verified on every release, not the spelling of whichever revision is current.
  assert.equal(
    module.assertOrderEngineVersion({ engine_version: module.VERSION }),
    true,
  );
});
test("Upbit JWT has three HS512 segments", () => {
  const token = module.createUpbitJwt({ market: "KRW-BTC" });
  assert.equal(token.split(".").length, 3);
  const header = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
  assert.equal(header.alg, "HS512");
});

test("Binance myTrades rows are converted into commission-bearing fills", () => {
  const fills = module.binanceTradesToFills([{
    id: 77,
    orderId: 11,
    price: "100",
    qty: "0.5",
    commission: "0.00005",
    commissionAsset: "BNB",
    time: 123456,
  }]);
  assert.deepEqual(fills, [{
    tradeId: "77",
    price: "100",
    qty: "0.5",
    commission: "0.00005",
    commissionAsset: "BNB",
    time: 123456,
  }]);
});

test("Binance quantity flooring obeys LOT_SIZE step", () => {
  assert.equal(module.floorStep(1.234567, 0.001), 1.234);
  assert.equal(module.floorStep(0.000019, 0.00001), 0.00001);
});
test("Binance quantity formatting never leaks floating-point precision", () => {
  assert.equal(module.formatStep(2.0600000000000005, 0.01), "2.06");
  assert.equal(module.formatStep(1.23456789, 0.001), "1.234");
  assert.equal(module.formatStep(0.000019, 0.00001), "0.00001");
  assert.equal(module.stepPrecision(1e-8), 8);
});
test("normalized orders use a common state model", () => {
  const upbit = module.normalizeUpbitOrder({
    uuid: "u",
    identifier: "tb-a",
    state: "done",
    executed_volume: "2",
    executed_funds: "20",
    paid_fee: "0.01",
    trades: [],
  });
  assert.equal(upbit.status, "FILLED");
  assert.equal(upbit.average_price, 10);
  const binance = module.normalizeBinanceOrder({
    orderId: 1,
    clientOrderId: "tb-b",
    status: "FILLED",
    executedQty: "2",
    cummulativeQuoteQty: "20",
    fills: [],
  });
  assert.equal(binance.status, "FILLED");
  assert.equal(binance.average_price, 10);
});

test("Upbit zero-string cumulative fields cannot hide trade-level partial fills", () => {
  const order = module.normalizeUpbitOrder({
    uuid: "partial",
    identifier: "tb-m-partial",
    state: "cancel",
    volume: "9.47051225",
    remaining_volume: "3.76874777",
    executed_volume: "5.70176448",
    executed_funds: "0",
    paid_fee: "6.62259944352",
    trades: [{
      uuid: "fill-1",
      price: "2323",
      volume: "5.70176448",
      funds: "13245.19888704",
    }],
  });
  assert.equal(order.status, "PARTIALLY_FILLED_CANCELED");
  assert.equal(order.executed_funds, 13245.19888704);
  assert.equal(order.average_price, 2323);
});

test("Upbit local rate guards follow API groups with headroom", () => {
  assert.equal(module.upbitRateGroup("GET", "/v1/ticker", true), "ticker");
  assert.equal(module.upbitRateGroup("GET", "/v1/orderbook", true), "orderbook");
  assert.equal(module.upbitRateGroup("POST", "/v1/orders", false), "order");
  assert.equal(module.upbitRateGroup("POST", "/v1/orders/test", false), "order-test");
  assert.equal(module.upbitRateGroup("GET", "/v1/accounts", false), "exchange-default");
  assert.equal(module.localRateLimit("upbit", "ticker"), 9);
  assert.equal(module.localRateLimit("upbit", "order"), 7);
  assert.equal(module.localRateLimit("upbit", "exchange-default"), 25);
});

test("Upbit portfolio ignores unpriced or delisted balances without failing the account", () => {
  const portfolio = module.buildUpbitPortfolio([
    { currency: "KRW", balance: "100000", locked: "5000" },
    { currency: "BTC", balance: "0.01", locked: "0" },
    { currency: "DUST", balance: "12", locked: "1" },
  ], [
    { market: "KRW-BTC", trade_price: 100000000 },
  ]);
  assert.equal(portfolio.available_quote, 100000);
  assert.equal(portfolio.locked_quote, 5000);
  assert.equal(portfolio.total_equity_quote, 1105000);
  assert.deepEqual(portfolio.unpriced_assets, [
    { currency: "DUST", balance: 12, locked: 1, reason: "NO_ACTIVE_KRW_TICKER" },
  ]);
});

test("Upbit contextual errors identify the failing endpoint", () => {
  const source = Object.assign(new Error("Code not found"), { status: 404, code: "not_found" });
  const wrapped = module.contextualizeError(source, "Upbit public GET /v1/ticker/all");
  assert.equal(wrapped.message, "Upbit public GET /v1/ticker/all: Code not found");
  assert.equal(wrapped.status, 404);
  assert.equal(wrapped.code, "not_found");
});

const FUTURES_INFO = {
  symbol: "BTCUSDT",
  base_asset: "BTC",
  quote_asset: "USDT",
  price_tick: 0.1,
  quantity_step: 0.001,
  min_quantity: 0.001,
  max_quantity: 1000,
  market_max_quantity: 120,
  min_notional: 5,
  max_notional: 0,
  max_leverage: 20,
};

test("binance_futures is an accepted venue", () => {
  assert.equal(module.validateExchange("binance_futures"), "binance_futures");
  assert.equal(module.validateExchange("BINANCE_FUTURES"), "binance_futures");
  assert.throws(() => module.validateExchange("binance_coinm"));
});

test("futures leverage is bounded to the gateway ceiling", () => {
  assert.equal(module.validateFuturesLeverage(3), 3);
  assert.equal(module.validateFuturesLeverage("5"), 5);
  assert.throws(() => module.validateFuturesLeverage(0));
  assert.throws(() => module.validateFuturesLeverage(50));
});

test("futures entries independently enforce 50 USDT of posted margin", () => {
  assert.equal(module.FUTURES_MIN_ENTRY_MARGIN_USDT, 50);
  assert.throws(
    () =>
      module.conformFuturesOrder(
        {
          market: "BTCUSDT",
          side: "BUY",
          type: "LIMIT",
          price: 100,
          quantity: 1.499,
          identifier: "tb-margin-1",
        },
        FUTURES_INFO,
        false,
        3,
      ),
    /50 USDT margin \(150 USDT notional at 3x\)/,
  );
  const atThreeX = module.conformFuturesOrder(
    {
      market: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      price: 100,
      quantity: 1.5,
      identifier: "tb-margin-2",
    },
    FUTURES_INFO,
    false,
    3,
  );
  assert.equal(atThreeX.notional, 150);

  assert.throws(
    () =>
      module.conformFuturesOrder(
        {
          market: "BTCUSDT",
          side: "BUY",
          type: "LIMIT",
          price: 100,
          quantity: 2.499,
          identifier: "tb-margin-3",
        },
        FUTURES_INFO,
        false,
        5,
      ),
    /250 USDT notional at 5x/,
  );
});

test("the 50 USDT margin floor applies only to entries, never reduce-only exits", () => {
  const { order } = module.conformFuturesOrder(
    {
      market: "BTCUSDT",
      side: "SELL",
      type: "LIMIT",
      price: 100,
      quantity: 0.1,
      identifier: "tb-margin-exit",
    },
    FUTURES_INFO,
    false,
    20,
  );
  assert.equal(order.reduceOnly, "true");
  assert.equal(Number(order.price) * Number(order.quantity), 10);
});

test("a futures sell is always reduce-only in one-way mode", () => {
  const { order } = module.conformFuturesOrder(
    { market: "BTCUSDT", side: "SELL", type: "MARKET", quantity: 0.0125, identifier: "tb-x-1" },
    FUTURES_INFO,
    false,
  );
  assert.equal(order.reduceOnly, "true");
  assert.equal(order.positionSide, undefined);
  assert.equal(order.quantity, "0.012");
  assert.equal(order.type, "MARKET");
});

test("hedge-mode orders carry the LONG position side instead of reduceOnly", () => {
  const { order } = module.conformFuturesOrder(
    { market: "BTCUSDT", side: "SELL", type: "MARKET", quantity: 0.01, identifier: "tb-x-2" },
    FUTURES_INFO,
    true,
  );
  assert.equal(order.positionSide, "LONG");
  assert.equal(order.reduceOnly, undefined);
});

test("futures maker entries are post-only GTX limits", () => {
  const { order } = module.conformFuturesOrder(
    {
      market: "BTCUSDT",
      side: "BUY",
      type: "LIMIT_MAKER",
      price: 60000.07,
      quantity: 0.01,
      identifier: "tb-x-3",
    },
    FUTURES_INFO,
    false,
  );
  assert.equal(order.type, "LIMIT");
  assert.equal(order.timeInForce, "GTX");
  assert.equal(order.price, "60000.0");
  assert.equal(order.reduceOnly, undefined);
});

test("futures market buys stay blocked and sub-minimum notionals are rejected", () => {
  assert.throws(
    () =>
      module.conformFuturesOrder(
        { market: "BTCUSDT", side: "BUY", type: "MARKET", quantity: 0.01, identifier: "tb-x-4" },
        FUTURES_INFO,
        false,
      ),
    /restricted to sells/,
  );
  assert.throws(
    () =>
      module.conformFuturesOrder(
        {
          market: "BTCUSDT",
          side: "BUY",
          type: "LIMIT",
          price: 100,
          quantity: 0.001,
          identifier: "tb-x-5",
        },
        FUTURES_INFO,
        false,
      ),
    /below 5/,
  );
});

test("a market exit respects MARKET_LOT_SIZE rather than LOT_SIZE", () => {
  const { order } = module.conformFuturesOrder(
    { market: "BTCUSDT", side: "SELL", type: "MARKET", quantity: 900, identifier: "tb-x-6" },
    FUTURES_INFO,
    false,
  );
  assert.equal(Number(order.quantity), 120);
});

test("futures order normalization reads cumQuote and realized pnl", () => {
  const normalized = module.normalizeFuturesOrder({
    orderId: 77,
    clientOrderId: "tb-x-7",
    symbol: "BTCUSDT",
    status: "FILLED",
    side: "SELL",
    origQty: "0.010",
    executedQty: "0.010",
    cumQuote: "630.00",
    avgPrice: "63000.0",
    reduceOnly: true,
    fills: [
      { tradeId: "5", price: "63000.0", qty: "0.010", commission: "0.252", commissionAsset: "USDT", realizedPnl: "12.5", time: 1700000000000 },
    ],
  });
  assert.equal(normalized.exchange, "binance_futures");
  assert.equal(normalized.status, "FILLED");
  assert.equal(normalized.executed_funds, 630);
  assert.equal(normalized.average_price, 63000);
  assert.equal(normalized.paid_fee, 0.252);
  assert.equal(normalized.realized_pnl_quote, 12.5);
  assert.equal(normalized.reduce_only, true);
  assert.equal(normalized.remaining_volume, 0);
});

test("futures portfolio exposes longs as deliverable balances and shorts as nothing", () => {
  const portfolio = module.buildFuturesPortfolio({
    availableBalance: "800.0",
    totalMarginBalance: "1010.0",
    totalUnrealizedProfit: "10.0",
    totalInitialMargin: "200.0",
    maxWithdrawAmount: "800.0",
    assets: [{ asset: "USDT", walletBalance: "1000.0", availableBalance: "800.0" }],
    positions: [
      { symbol: "BTCUSDT", positionAmt: "0.010", entryPrice: "60000", leverage: "3", unrealizedProfit: "10.0", initialMargin: "200.0", liquidationPrice: "41000" },
      { symbol: "ETHUSDT", positionAmt: "-1.5", entryPrice: "3000", leverage: "3", unrealizedProfit: "0", initialMargin: "0" },
      { symbol: "SOLUSDT", positionAmt: "0", entryPrice: "0", leverage: "3" },
    ],
  }, { BTCUSDT: 61000 });

  assert.equal(portfolio.exchange, "binance_futures");
  assert.equal(portfolio.available_quote, 800);
  assert.equal(portfolio.locked_quote, 200);
  assert.equal(portfolio.settled_quote, 1000);
  // Margin balance, not the 610 USDT of notional the 3x long controls.
  assert.equal(portfolio.total_equity_quote, 1010);
  assert.deepEqual(
    portfolio.accounts.map((row) => [row.currency, row.balance]),
    [["USDT", 800], ["BTC", 0.01]],
  );
  assert.equal(portfolio.positions.length, 2);
  assert.equal(portfolio.positions.find((row) => row.market === "ETHUSDT").side, "SHORT");
});
