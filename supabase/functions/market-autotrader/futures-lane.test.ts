import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { baseAsset, entryQuantityForNotional, isBinanceFutures, quoteCurrency } from "./core.ts";
import { validateSpotMarket } from "../_shared/spot-market.ts";
import { dustQuoteFor } from "../_shared/position-value.ts";
import {
  DEFAULT_FUTURES_LEVERAGE,
  FUTURES_EXIT_APPROVED_REASONS,
  FUTURES_MIN_ENTRY_MARGIN_USDT,
} from "./futures-exit-policy.ts";

const ROOT = new URL("../../../", import.meta.url);
const ENGINE = await Deno.readTextFile(
  new URL("supabase/functions/market-autotrader/index.ts", ROOT),
);
const GATEWAY = await Deno.readTextFile(new URL("gateway/server.mjs", ROOT));
const DASHBOARD = await Deno.readTextFile(new URL("docs/app.js", ROOT));
const DASHBOARD_HTML = await Deno.readTextFile(new URL("docs/index.html", ROOT));
const MIGRATION = await Deno.readTextFile(
  new URL("supabase/migrations/20260810010000_binance_futures_lane_v760.sql", ROOT),
);
const PROTECTED_MIGRATION = await Deno.readTextFile(
  new URL("supabase/migrations/20260810133000_protected_trailing_exit_v761.sql", ROOT),
);
const RECOVERY_MIGRATION = await Deno.readTextFile(
  new URL("supabase/migrations/20260811090700_first_tranche_recovery_exit_v765.sql", ROOT),
);
const STATE_MACHINE_MIGRATION = await Deno.readTextFile(
  new URL("supabase/migrations/20260818083500_futures_recovery_3m_state_machine.sql", ROOT),
);

Deno.test("binance_futures routes like a USDT venue", () => {
  assert(isBinanceFutures("binance_futures"));
  assert(!isBinanceFutures("binance"));
  assertEquals(quoteCurrency("binance_futures"), "USDT");
  assertEquals(baseAsset("binance_futures", "BTCUSDT"), "BTC");
  assertEquals(dustQuoteFor("binance_futures"), 1);

  const route = validateSpotMarket("binance_futures", "BTCUSDT");
  assertEquals(route.ok, true);
  assertEquals(validateSpotMarket("binance_futures", "KRW-BTC").ok, false);
});

Deno.test("every per-exchange loop walks all three venues", () => {
  assertEquals(ENGINE.match(/\["upbit", "binance"\] as Exchange\[\]/g), null);
  assert(
    ENGINE.includes(
      'const ALL_EXCHANGES: readonly Exchange[] = ["upbit", "binance", "binance_futures"]',
    ),
  );
});

Deno.test("the futures lane ships disabled", () => {
  assert(ENGINE.includes("binance_futures_enabled: false"));
  assert(ENGINE.includes(`binance_futures_leverage: DEFAULT_FUTURES_LEVERAGE`));
  assertEquals(DEFAULT_FUTURES_LEVERAGE, 3);
  assert(
    MIGRATION.includes(
      "add column if not exists binance_futures_enabled boolean not null default false",
    ),
  );
});

Deno.test("entry sizing commits margin and the exchange sees margin x leverage", () => {
  assert(
    ENGINE.includes("const notionalQuote = floorToStep(marginQuote * leverage, limits.quoteStep)"),
  );
  assert(ENGINE.includes('leverage: exchange === "binance_futures" ? leverage : undefined'));
  assert(ENGINE.includes('requestedCapital: exchange === "binance_futures"'));
  assert(ENGINE.includes("notionalPerCapital: leverage"));
  assertEquals(entryQuantityForNotional("binance_futures", 150, 0.02442, 0.1), 6142.6);
  assertEquals(entryQuantityForNotional("binance", 150, 0.02442, 0.1), 6142.5);
});

Deno.test("futures entry minimum is an isolated 50 USDT margin floor", () => {
  assertEquals(FUTURES_MIN_ENTRY_MARGIN_USDT, 50);
  assert(ENGINE.includes("minOrder: FUTURES_MIN_ENTRY_MARGIN_USDT"));
  assert(ENGINE.includes("futuresEntryMinimums(leverage, rules.min_notional)"));
  assert(ENGINE.includes('const entryTimeInForce = exchange === "upbit" ? "IOC" : "FOK"'));
  assert(ENGINE.includes('if (exchange === "binance_futures") return false;'));
  assert(
    ENGINE.includes(
      'const marginReturnMultiplier = exchange === "binance_futures" ? leverage : 1',
    ),
  );
  assert(
    ENGINE.includes(
      'const executableMinimumCapitalQuote = exchange === "binance_futures"',
    ),
  );
  assert(GATEWAY.includes("const FUTURES_MIN_ENTRY_MARGIN_USDT = 50"));
  assert(GATEWAY.includes("FUTURES_MIN_ENTRY_MARGIN_USDT * entryLeverage"));
  assert(MIGRATION.includes("FUTURES_ENTRY_MARGIN_BELOW_50_USDT"));
  assert(MIGRATION.includes("binance_futures_allocation_usdt >= 50"));
  assert(DASHBOARD.includes("futuresFixed < 50"));
  assert(DASHBOARD_HTML.includes("신규 진입 증거금은 최소 50 USDT"));
});

Deno.test("spot minimum settings cannot change the futures margin floor", () => {
  const futuresLimitsStart = ENGINE.indexOf(
    'if (exchange === "binance_futures") {',
    ENGINE.indexOf("function exchangeLimits"),
  );
  const spotLimitsStart = ENGINE.indexOf('return exchange === "upbit"', futuresLimitsStart);
  const futuresLimits = ENGINE.slice(futuresLimitsStart, spotLimitsStart);
  assert(futuresLimits.includes("FUTURES_MIN_ENTRY_MARGIN_USDT"));
  assert(!futuresLimits.includes("binanceMinOrderUsdt"));
});

Deno.test("the exit thresholds are stated on the position's own leverage", () => {
  assert(ENGINE.includes("const positionLeverageValue = positionLeverage(position)"));
  assert(ENGINE.includes("leverage: positionLeverageValue"));
  assert(ENGINE.includes("futuresSplitExitDecision({"));
  assert(ENGINE.includes("peakGrossReturnPct,"));
  assert(!ENGINE.includes("futuresRecoveryLatched({"));
  assert(ENGINE.includes("futuresRecoveryState({"));
  assert(ENGINE.includes("if ((lobMode || futuresLane) && !settings.emergency_liquidation)"));
  assert(ENGINE.includes('source: "FUTURES_EXIT_POLICY_NOT_APPLICABLE"'));
});

Deno.test("physical spot residual inventory is unreachable from the futures lane", () => {
  assert(ENGINE.includes('if (exchange === "binance_futures") return [];'));
  assert(
    MIGRATION.includes("c.conrelid <> 'public.trading_residual_inventory'::regclass"),
  );
  assert(MIGRATION.includes("FUTURES_WAS_ADDED_TO_SPOT_RESIDUAL_INVENTORY"));
  assert(MIGRATION.includes("if lower(coalesce(new.exchange, '')) = 'binance_futures' then"));
});

Deno.test("orders cannot cross a spot/futures position boundary", () => {
  assert(MIGRATION.includes("ORDER_POSITION_VENUE_MISMATCH"));
  assert(MIGRATION.includes("guard_order_position_venue_v760"));
});

Deno.test("legacy spot policy triggers are unreachable from the futures lane", () => {
  assert(MIGRATION.includes("drop trigger if exists zz_trading_positions_exit_policy_v714"));
  assert(MIGRATION.includes("drop trigger if exists zz_trading_orders_lob_exit_guard_v714"));
  assertEquals(
    MIGRATION.match(/when \(lower\(coalesce\(new\.exchange, ''\)\) <> 'binance_futures'\)/g)
      ?.length,
    2,
  );
  assert(MIGRATION.includes("SPOT_POLICY_TRIGGERS_NOT_ISOLATED_FROM_FUTURES"));
});

Deno.test("margin accounting keeps each open position's stamped leverage", () => {
  assert(ENGINE.includes("select=market,state,leverage,remaining_quantity"));
  assert(
    ENGINE.includes(
      'const leverageDivisor = exchange === "binance_futures" ? positionLeverage(row) : 1',
    ),
  );
  assert(ENGINE.includes('const capitalBaseQuote = exchange === "binance_futures"'));
});

Deno.test("futures residual state is T1-derived and uses peak-aware protected trailing", () => {
  assert(ENGINE.includes('decision.reason === "FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT"'));
  assert(ENGINE.includes("peakGrossReturnPct,"));
  assert(ENGINE.includes("futuresRecoveryState({"));
  assert(ENGINE.includes("alreadyLatched: recoveryMode"));
  assert(ENGINE.includes("recoveryMode = recoveryState.enabled"));
  assert(!ENGINE.includes("recoveryMode = false"));
  assert(STATE_MACHINE_MIGRATION.includes("coalesce(new.t1_completed, false)"));
  assert(!STATE_MACHINE_MIGRATION.includes("new.t1_completed := v_residual_stage"));
});

Deno.test("futures 3m recovery state survives DB position enforcement", () => {
  assert(ENGINE.includes('trigger_reason: "FUTURES_3M_NET_NONPOSITIVE"'));
  assert(ENGINE.includes('exit_rule: "FULL_POSITION_EXECUTABLE_NET_PNL_GT_0"'));
  assert(STATE_MACHINE_MIGRATION.includes("recovery_latch_after_seconds"));
  assert(STATE_MACHINE_MIGRATION.includes("FUTURES_RECOVERY_NET_POSITIVE_EXIT"));
  assert(STATE_MACHINE_MIGRATION.includes("FUTURES_RECOVERY_TOO_EARLY"));
  assert(STATE_MACHINE_MIGRATION.includes("FUTURES_RECOVERY_NOT_LATCHED"));
  assert(STATE_MACHINE_MIGRATION.includes("FUTURES_RECOVERY_REQUIRES_POSITIVE_NET"));
  assert(!STATE_MACHINE_MIGRATION.includes("- 'recovery_exit'"));
});

Deno.test("generic LOB/scalp exits cannot preempt the futures state machine", () => {
  assert(
    ENGINE.includes(
      "lobMode && !futuresLane && !settings.emergency_liquidation && heldSeconds >= 180",
    ),
  );
  assert(ENGINE.includes('lobMode && !futuresLane && decision.action === "NONE"'));
  assert(ENGINE.includes('scalpMode && !futuresLane && decision.action === "NONE"'));
  assert(
    ENGINE.includes("if (lobMode && !futuresLane && heldSeconds >= absoluteMaxHoldingSeconds)"),
  );
});

Deno.test("every futures exit reason is authorized end to end", () => {
  for (const reason of FUTURES_EXIT_APPROVED_REASONS) {
    assert(
      ENGINE.includes(`decision.reason === "${reason}"`) ||
        ENGINE.includes(`decisionReason === "${reason}"`),
      `${reason} is not on an engine allow list`,
    );
  }
  assert(PROTECTED_MIGRATION.includes("FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT"));
  assert(PROTECTED_MIGRATION.includes("FUTURES_PROTECTED_TRAIL_NOT_REACHED"));
  assert(PROTECTED_MIGRATION.includes("v_protect_roe_pct := greatest(9, v_peak_roe_pct - 4.5)"));
  assert(PROTECTED_MIGRATION.includes("FUTURES_FIRST_TRANCHE_THRESHOLD_NOT_REACHED"));
  assert(STATE_MACHINE_MIGRATION.includes("FUTURES_RECOVERY_NET_POSITIVE_EXIT"));
  assert(STATE_MACHINE_MIGRATION.includes("FUTURES_STALE_GIVEBACK_EXIT_180M"));
  assert(STATE_MACHINE_MIGRATION.includes("FUTURES_RECOVERY_REQUIRES_POSITIVE_NET"));
  assert(STATE_MACHINE_MIGRATION.includes("pending_exit_reason"));
  assert(STATE_MACHINE_MIGRATION.includes("executable_net_allowed"));
});

Deno.test("the spot lane keeps its existing protected trailing and stale recovery", () => {
  assert(ENGINE.includes("spotSplitExitDecision({"));
  assert(ENGINE.includes('decision.reason === "RESIDUAL_PROTECTED_TRAIL_EXIT"'));
  assert(PROTECTED_MIGRATION.includes("v_protect_pct := greatest(3, v_peak_return_pct - 1.5)"));
  assert(PROTECTED_MIGRATION.includes("SPOT_PROTECTED_TRAIL_NOT_REACHED"));
  assert(PROTECTED_MIGRATION.includes("v_gross_return_pct <= -3.999"));
  assert(RECOVERY_MIGRATION.includes("STALE_RECOVERY_NET_POSITIVE_EXIT_180M"));
  assert(RECOVERY_MIGRATION.includes("v_held_seconds < 10800"));
});

Deno.test("the gateway can close a futures long and can never open a short", () => {
  assert(GATEWAY.includes('if (dualPositionSide) order.positionSide = "LONG";'));
  assert(GATEWAY.includes('else if (side === "SELL") order.reduceOnly = "true";'));
  assert(
    GATEWAY.includes('throw new Error("Binance futures market orders are restricted to sells")'),
  );
  assert(!GATEWAY.includes("/sapi/v1/futures/transfer"));
  assert(!GATEWAY.includes("/sapi/v1/capital/withdraw"));
});

Deno.test("futures positions are quoted and monitored on the perpetual venue", () => {
  assert(GATEWAY.includes('publicBinanceFutures("/fapi/v1/depth"'));
  assert(GATEWAY.includes('publicBinanceFutures("/fapi/v1/ticker/bookTicker"'));
  const minuteMarket = Deno.readTextFileSync(
    new URL("supabase/functions/_shared/lob/minute-entry-market.ts", ROOT),
  );
  assert(minuteMarket.includes("BINANCE_FUTURES}/fapi/v1/klines"));
});

Deno.test("engine full-liquidation reasons release the protected half", () => {
  assert(ENGINE.includes('decisionReason === "HALF_HOLD_STOP_LOSS_4"'));
  assert(ENGINE.includes('decisionReason === "FUTURES_HALF_STOP_LOSS_ROE_12"'));
  assert(ENGINE.includes('decisionReason === "RESIDUAL_PROTECTED_TRAIL_EXIT"'));
  assert(ENGINE.includes('decisionReason === "FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT"'));
  assert(ENGINE.includes('decisionReason === "FUTURES_RECOVERY_NET_POSITIVE_EXIT"'));
  assert(ENGINE.includes('decisionReason === "FUTURES_STALE_GIVEBACK_EXIT_180M"'));
  assert(ENGINE.includes('action === "EMERGENCY"'));
  assert(ENGINE.includes("const protectedHoldQuantity = fullLiquidationExit"));
  assert(STATE_MACHINE_MIGRATION.includes("upper(coalesce(new.purpose, '')) = 'EMERGENCY'"));
});
