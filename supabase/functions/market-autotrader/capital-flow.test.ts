import { assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { detectEquityCapitalFlow, netCapitalFlowQuote, tradingReturn } from "./capital-flow.ts";

// The reported defect: futures equity went 67 → 619 USDT in a day because capital was
// transferred in, and that showed up as a return.
Deno.test("a deposit is capital movement, not a trading result", () => {
  const detected = detectEquityCapitalFlow({
    previousEquityQuote: 100,
    currentEquityQuote: 600,
    botPnlQuote: 0,
    thresholdQuote: 25,
  });
  assertEquals(detected.detected, true);
  assertEquals(detected.flowType, "EXTERNAL_INCREASE");
  assertEquals(detected.externalDeltaQuote, 500);

  const reported = tradingReturn({
    startEquityQuote: 100,
    currentEquityQuote: 600,
    netCapitalFlowQuote: 500,
  });
  assertEquals(reported.tradingPnlQuote, 0);
  assertEquals(reported.tradingReturnPct, 0);
  // The raw equity metric still exists, and is still +500%; it just is not the return.
  assertEquals(reported.equityChangePct, 500);
});

Deno.test("a withdrawal does not read as a loss", () => {
  const detected = detectEquityCapitalFlow({
    previousEquityQuote: 600,
    currentEquityQuote: 100,
    botPnlQuote: 0,
    thresholdQuote: 25,
  });
  assertEquals(detected.flowType, "EXTERNAL_DECREASE");
  assertEquals(detected.externalDeltaQuote, -500);
  const reported = tradingReturn({
    startEquityQuote: 600,
    currentEquityQuote: 100,
    netCapitalFlowQuote: -500,
  });
  assertEquals(reported.tradingPnlQuote, 0);
  assertEquals(reported.tradingReturnPct, 0);
});

Deno.test("PnL the bot booked is not mistaken for a transfer", () => {
  const detected = detectEquityCapitalFlow({
    previousEquityQuote: 600,
    currentEquityQuote: 640,
    botPnlQuote: 40,
    thresholdQuote: 25,
  });
  assertEquals(detected.detected, false);
  assertEquals(detected.flowType, null);
  assertEquals(detected.externalDeltaQuote, 0);
  assertEquals(detected.equityChangeQuote, 40);
});

Deno.test("mark and fee noise below the threshold is never recorded as a flow", () => {
  const detected = detectEquityCapitalFlow({
    previousEquityQuote: 600,
    currentEquityQuote: 604,
    botPnlQuote: 0,
    thresholdQuote: 25,
  });
  assertEquals(detected.detected, false);
  assertEquals(detected.externalDeltaQuote, 4);
});

Deno.test("trading return with a mid-window deposit credits only real profit", () => {
  const reported = tradingReturn({
    startEquityQuote: 100,
    currentEquityQuote: 630,
    netCapitalFlowQuote: 500,
  });
  assertEquals(reported.tradingPnlQuote, 30);
  assertAlmostEquals(reported.tradingReturnPct!, 5, 1e-12);
});

Deno.test("with no capital movement the trading return equals the equity change", () => {
  const reported = tradingReturn({
    startEquityQuote: 200,
    currentEquityQuote: 220,
    netCapitalFlowQuote: 0,
  });
  assertEquals(reported.tradingPnlQuote, 20);
  assertEquals(reported.tradingReturnPct, 10);
  assertEquals(reported.equityChangePct, 10);
});

Deno.test("recorded cash flow rows net deposits against withdrawals", () => {
  assertEquals(
    netCapitalFlowQuote([
      { flow_type: "EXTERNAL_INCREASE", amount_quote: 500 },
      { flow_type: "EXTERNAL_DECREASE", amount_quote: 120 },
      { flow_type: "external_increase", amount_quote: "20" },
    ]),
    400,
  );
  assertEquals(netCapitalFlowQuote([]), 0);
});
