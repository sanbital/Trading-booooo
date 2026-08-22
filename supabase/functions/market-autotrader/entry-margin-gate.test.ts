import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { p10ExactFuturesTicketCapital } from "../_shared/p10-policy.ts";
import {
  evaluateEntryMarginGate,
  INSUFFICIENT_FUTURES_MARGIN_REASON,
  NO_FREE_SLOT_REASON,
} from "./entry-margin-gate.ts";
import { evaluateCircuit } from "./core.ts";
import type { TradingSettings } from "./core.ts";

const CIRCUIT_SETTINGS = {
  max_open_positions: 10,
  max_open_positions_per_exchange: 10,
  max_daily_entries: Number.MAX_SAFE_INTEGER,
  max_daily_entries_per_exchange: Number.MAX_SAFE_INTEGER,
  max_daily_loss_pct: 30,
  max_weekly_loss_pct: Number.MAX_SAFE_INTEGER,
  max_consecutive_losses: Number.MAX_SAFE_INTEGER,
} as unknown as TradingSettings;

const OPERATOR_MARGIN = 200;

function gate(availableQuote: number, openPositions = 0, maxPositions = 10) {
  return evaluateEntryMarginGate({
    availableQuote,
    requiredQuote: OPERATOR_MARGIN,
    openPositions,
    maxPositions,
  });
}

// The production reading that motivated this: 617.66 USDT of equity but only 105.14 USDT of
// usable margin, and SCAN still reported allowNewEntry=true.
Deno.test("105 USDT of margin cannot fund a 200 USDT slot", () => {
  const result = gate(105.14);
  assertEquals(result.allowed, false);
  assertEquals(result.reason, INSUFFICIENT_FUTURES_MARGIN_REASON);
  assertEquals(Math.round(result.shortfallQuote * 100) / 100, 94.86);
  // The order engine reaches the same verdict from the same margin figure.
  assertEquals(p10ExactFuturesTicketCapital(105.14, OPERATOR_MARGIN), 0);
});

Deno.test("250 USDT of margin with a free slot opens the gate", () => {
  const result = gate(250);
  assertEquals(result.allowed, true);
  assertEquals(result.reason, null);
  assertEquals(result.shortfallQuote, 0);
  assertEquals(result.freeSlots, 10);
  assertEquals(p10ExactFuturesTicketCapital(250, OPERATOR_MARGIN), OPERATOR_MARGIN);
});

Deno.test("the gate and the sizing helper agree at and around the exact ticket", () => {
  for (const available of [199.99, 200, 200.01, 205, 5_000]) {
    const allowed = gate(available).allowed;
    assertEquals(allowed, p10ExactFuturesTicketCapital(available, OPERATOR_MARGIN) > 0);
  }
});

Deno.test("a configured buffer raises the bar the wallet has to clear", () => {
  const buffered = evaluateEntryMarginGate({
    availableQuote: 205,
    requiredQuote: OPERATOR_MARGIN,
    bufferQuote: 10,
    openPositions: 0,
    maxPositions: 10,
  });
  assertEquals(buffered.requiredAvailableQuote, 210);
  assertEquals(buffered.allowed, false);
  assertEquals(buffered.shortfallQuote, 5);
});

Deno.test("a full book blocks entry however much margin is free", () => {
  const result = gate(10_000, 10, 10);
  assertEquals(result.allowed, false);
  assertEquals(result.reason, NO_FREE_SLOT_REASON);
  assertEquals(result.freeSlots, 0);
});

Deno.test("the circuit reports the margin shortfall in the operator's language", () => {
  const blocked = evaluateCircuit({
    mode: "LIVE_LIMITED",
    configured: true,
    exchangeEnabled: true,
    pauseNewEntries: false,
    pausedByOperator: false,
    withdrawalMode: false,
    manualInterventionRequired: false,
    emergencyLiquidation: false,
    availableQuote: 105.14,
    minOrderQuote: OPERATOR_MARGIN,
    minOrderReason: INSUFFICIENT_FUTURES_MARGIN_REASON,
    openPositionsGlobal: 3,
    openPositionsExchange: 3,
    entriesTodayGlobal: 0,
    entriesTodayExchange: 0,
    dailyBoughtQuote: 0,
    maxDailyBuyQuote: Number.MAX_SAFE_INTEGER,
    dailyPnlPct: 0,
    weeklyPnlPct: 0,
    consecutiveLosses: 0,
    settings: CIRCUIT_SETTINGS,
  });
  assertEquals(blocked.allowNewEntry, false);
  assertEquals(blocked.reasons, [INSUFFICIENT_FUTURES_MARGIN_REASON]);

  const funded = evaluateCircuit({
    mode: "LIVE_LIMITED",
    configured: true,
    exchangeEnabled: true,
    pauseNewEntries: false,
    pausedByOperator: false,
    withdrawalMode: false,
    manualInterventionRequired: false,
    emergencyLiquidation: false,
    availableQuote: 250,
    minOrderQuote: OPERATOR_MARGIN,
    minOrderReason: INSUFFICIENT_FUTURES_MARGIN_REASON,
    openPositionsGlobal: 3,
    openPositionsExchange: 3,
    entriesTodayGlobal: 0,
    entriesTodayExchange: 0,
    dailyBoughtQuote: 0,
    maxDailyBuyQuote: Number.MAX_SAFE_INTEGER,
    dailyPnlPct: 0,
    weeklyPnlPct: 0,
    consecutiveLosses: 0,
    settings: CIRCUIT_SETTINGS,
  });
  assertEquals(funded.allowNewEntry, true);
  assertEquals(funded.reasons, []);

  const fullBook = evaluateCircuit({
    mode: "LIVE_LIMITED",
    configured: true,
    exchangeEnabled: true,
    pauseNewEntries: false,
    pausedByOperator: false,
    withdrawalMode: false,
    manualInterventionRequired: false,
    emergencyLiquidation: false,
    availableQuote: 10_000,
    minOrderQuote: OPERATOR_MARGIN,
    minOrderReason: INSUFFICIENT_FUTURES_MARGIN_REASON,
    openPositionsGlobal: 10,
    openPositionsExchange: 10,
    entriesTodayGlobal: 0,
    entriesTodayExchange: 0,
    dailyBoughtQuote: 0,
    maxDailyBuyQuote: Number.MAX_SAFE_INTEGER,
    dailyPnlPct: 0,
    weeklyPnlPct: 0,
    consecutiveLosses: 0,
    settings: CIRCUIT_SETTINGS,
  });
  assertEquals(fullBook.allowNewEntry, false);
});
