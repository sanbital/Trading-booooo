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
