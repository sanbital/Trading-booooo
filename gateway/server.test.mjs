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
  assert.equal(module.rawQueryString({ market: "KRW-BTC", states: ["wait", "watch"] }), "market=KRW-BTC&states[]=wait&states[]=watch");
});
test("Upbit encoded query is safe for transport", () => {
  assert.equal(module.encodedQueryString({ market: "KRW-BTC", states: ["wait", "watch"] }), "market=KRW-BTC&states[]=wait&states[]=watch");
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
test("Upbit JWT has three HS512 segments", () => {
  const token = module.createUpbitJwt({ market: "KRW-BTC" });
  assert.equal(token.split(".").length, 3);
  const header = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
  assert.equal(header.alg, "HS512");
});
test("Binance quantity flooring obeys LOT_SIZE step", () => {
  assert.equal(module.floorStep(1.234567, 0.001), 1.234);
  assert.equal(module.floorStep(0.000019, 0.00001), 0.00001);
});
test("normalized orders use a common state model", () => {
  const upbit = module.normalizeUpbitOrder({ uuid: "u", identifier: "tb-a", state: "done", executed_volume: "2", executed_funds: "20", paid_fee: "0.01", trades: [] });
  assert.equal(upbit.status, "FILLED");
  assert.equal(upbit.average_price, 10);
  const binance = module.normalizeBinanceOrder({ orderId: 1, clientOrderId: "tb-b", status: "FILLED", executedQty: "2", cummulativeQuoteQty: "20", fills: [] });
  assert.equal(binance.status, "FILLED");
  assert.equal(binance.average_price, 10);
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

