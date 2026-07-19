import { baseAsset, combineCandidates } from "./combined.ts";
import type { FinalCandidate } from "./engine.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function candidate(
  market: string,
  decision: FinalCandidate["decision"],
  score: number,
  dynamicStatus = "NEUTRAL",
  watchAvailable = decision === "WAIT",
): FinalCandidate {
  return {
    market,
    korean_name: market,
    english_name: market,
    current_price: 100,
    change_24h_pct: 1,
    turnover_24h_krw: 10_000_000_000,
    turnover_24h_quote: 10_000_000_000,
    quote_currency: market.startsWith("KRW-") ? "KRW" : "USDT",
    score,
    confidence: 60,
    decision,
    decision_label: decision,
    trade_plan: {
      entry_low: 99,
      entry_high: 100,
      entry_execution_estimate: 100,
      short_target: 103,
      short_target_execution_estimate: 102.9,
      expected_exit_price: 102.9,
      expected_exit_net_return_pct: 2.7,
      medium_target: 106,
      stop_price: 98,
      stop_execution_estimate: 97.9,
      short_net_return_pct: 2.7,
      medium_net_return_pct: 5.5,
      net_stop_pct: 2.2,
      net_rr: 1.6,
      recommended_investment_krw: 100_000,
      recommended_investment_quote: 100_000,
      risk_budget_krw: 5_000,
      estimated_loss_krw: 2_200,
      tick_size: 0.1,
      actionable: decision === "BUY",
    },
    watch_entry_plan: {
      available: watchAvailable,
      status: watchAvailable ? "CONDITIONAL" : "UNAVAILABLE",
      zone_low: watchAvailable ? 97 : null,
      zone_high: watchAvailable ? 98 : null,
      max_price: watchAvailable ? 98 : null,
      invalidation_price: watchAvailable ? 95 : null,
      reference_target: watchAvailable ? 103 : null,
      expected_exit_price: watchAvailable ? 102.9 : null,
      expected_net_return_pct: watchAvailable ? 4 : null,
      stop_price: watchAvailable ? 95 : null,
      estimated_net_rr: watchAvailable ? 1.6 : null,
      discount_from_current_pct: watchAvailable ? 2 : null,
      label: watchAvailable ? "조건부" : "미제시",
      entry_trigger: "15분봉 회복",
      exit_trigger: "목표 도달",
      scenario: [],
      conditions: [],
      note: "test",
    },
    horizon: {
      code: "SHORT",
      label: "단기",
      expected_window: "1~3일",
      persistence_score: 60,
      estimate: "test",
      invalidation: [],
    },
    gates: [],
    failed_gates: [],
    positives: [],
    negatives: [],
    warnings: [],
    timeframes: {} as FinalCandidate["timeframes"],
    microstructure: {
      dynamic: {
        status: dynamicStatus,
        label: dynamicStatus,
      },
    } as FinalCandidate["microstructure"],
  };
}

Deno.test("base asset normalizes Upbit, Binance, and 1000-unit symbols", () => {
  assert(baseAsset("KRW-ETH", "upbit") === "ETH");
  assert(baseAsset("ETHUSDT", "binance") === "ETH");
  assert(baseAsset("1000SHIBUSDT", "binance") === "SHIB");
});

Deno.test("same asset on both exchanges occupies one Top 4 slot", () => {
  const rows = combineCandidates(
    [candidate("KRW-ETH", "BUY", 75)],
    [candidate("ETHUSDT", "BUY", 74)],
  );
  assert(rows.length === 1);
  assert(rows[0].base_asset === "ETH");
  assert(rows[0].cross_exchange.both_buy);
  assert(rows[0].cross_exchange.venues.length === 2);
});

Deno.test("higher score cannot replace a safer decision from the same venue", () => {
  const rows = combineCandidates(
    [
      candidate("KRW-ETH", "BUY", 73),
      candidate("KRW-ETH", "AVOID", 92),
    ],
    [],
  );
  assert(rows.length === 1);
  assert(rows[0].decision === "BUY");
  assert(rows[0].score === 73);
});

Deno.test("two-venue BUY confirmation outranks a slightly higher single-venue BUY", () => {
  const rows = combineCandidates(
    [candidate("KRW-ETH", "BUY", 74), candidate("KRW-XRP", "BUY", 75)],
    [candidate("ETHUSDT", "BUY", 73)],
  );
  assert(
    rows[0].base_asset === "ETH",
    rows.map((row) => row.base_asset).join(","),
  );
});

Deno.test("counter-venue dynamic risk downgrades BUY to WAIT", () => {
  const rows = combineCandidates(
    [candidate("KRW-ETH", "BUY", 78)],
    [candidate("ETHUSDT", "AVOID", 65, "ASK_ABSORPTION_RISK")],
  );
  assert(rows.length === 1);
  assert(rows[0].decision === "WAIT");
  assert(!rows[0].trade_plan.actionable);
  assert(rows[0].cross_exchange.conflict);
  assert(rows[0].failed_gates.includes("cross_exchange"));
});

Deno.test("unsafe AVOID assets are not used to pad Top 4", () => {
  const rows = combineCandidates(
    [candidate("KRW-BAD", "AVOID", 80)],
    [],
    4,
  );
  assert(rows.length === 0);
});
