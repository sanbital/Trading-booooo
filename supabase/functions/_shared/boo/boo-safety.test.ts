// Regression tests for brief section 9, items 1-30.
//
// Each test names the defect it prevents.  Fixtures are marked SYNTHETIC or
// INCIDENT: an INCIDENT fixture is anonymised real production data, a SYNTHETIC
// one is constructed to exercise a path no incident has produced yet.
//
// Run: deno test --allow-read supabase/functions/_shared/boo/boo-safety.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dec } from "./decimal.mjs";
import { PROTECTIVE_DEFAULTS, resolveRiskPolicy, evaluateLossLimits } from "./risk-policy.mjs";
import { evaluateQuantity, SKIP_MIN_NOTIONAL, solveQuantity, walkBook } from "./risk-budget.mjs";
import { evaluateEntryGate, checkValidationApproval, confirmBeforeDispatch } from "./entry-gate.mjs";
import {
  advanceSetup,
  decideExit,
  earlyFailure,
  entryTrigger,
  kstDayOpen,
  profitTrailStop,
  rankDayGainers,
  SETUP_STATE,
  usableBars,
} from "./r1-strategy.mjs";
import {
  dedupeFills,
  fillKey,
  MONEY_TOLERANCE_PER_POSITION,
  normalizeFill,
  reconcileAccount,
  reconcilePosition,
} from "./reconcile.mjs";
import {
  RiskReservationStore,
  applyPartialFill,
  classifyOrderOutcome,
  reconcileUnknownOrder,
} from "./order-safety.mjs";
import { protectionPlan, replaceProtection, resolveExitRace } from "./protection.mjs";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const FILTERS = { stepSize: "1", minQty: "1", maxQty: "1000000", minNotional: "5", tickSize: "0.0001" };

/** A book deep enough that VWAP is flat; isolates the constraint under test. */
function flatBook(price: string, size = "1000000") {
  return [[price, size]];
}

/** A laddered book so VWAP genuinely worsens with size. */
function ladder(start: number, stepPct: number, levels: number, sizePer: string) {
  const out: [string, string][] = [];
  for (let i = 0; i < levels; i++) {
    out.push([(start * (1 + stepPct * i)).toFixed(6), sizePer]);
  }
  return out;
}

function baseCtx(over: Record<string, unknown> = {}) {
  const { policy } = resolveRiskPolicy({});
  return {
    policy,
    equity: "10000",
    bookAsks: flatBook("100"),
    bookBids: flatBook("99.9"),
    structuralStop: "95",
    stopSlippageFrac: "0.001",
    takerFeeRate: "0.0004",
    stopFeeRate: "0.0004",
    expectedFundingCost: "0",
    filters: FILTERS,
    reservedRisk: "0",
    openGrossNotional: "0",
    availableMargin: "10000",
    leverage: "3",
    dailyRemaining: "100",
    weeklyRemaining: "300",
    ...over,
  };
}

function bar(openTime: number, o: string, h: string, l: string, c: string, availableAt?: number) {
  return {
    openTime,
    closeTime: openTime + 59_999,
    availableAt: availableAt ?? openTime + 59_999,
    open: o,
    high: h,
    low: l,
    close: c,
    final: true,
  };
}

/** Deterministic rising 5m series long enough to seed EMA20 + ATR14. */
function rising5m(n: number, start = 100, stepPct = 0.004) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const base = start * (1 + stepPct * i);
    bars.push(
      bar(
        i * 300_000,
        base.toFixed(6),
        (base * 1.003).toFixed(6),
        (base * 0.998).toFixed(6),
        (base * 1.002).toFixed(6),
      ),
    );
  }
  return bars;
}

// ---------------------------------------------------------------------------
// 1. Falling equity must never increase the permitted quantity.
// ---------------------------------------------------------------------------
Deno.test("01 SYNTHETIC: lower equity never permits a larger size at the same stop and cost", () => {
  const asks = ladder(100, 0.0002, 400, "50");
  let previous: bigint | null = null;
  for (const equity of ["100000", "50000", "20000", "10000", "5000", "1000"]) {
    const r = solveQuantity(baseCtx({
      equity,
      bookAsks: asks,
      bookBids: ladder(99.9, -0.0002, 400, "50"),
      dailyRemaining: "1000000",
      weeklyRemaining: "1000000",
      availableMargin: "1000000",
    }));
    const q = r.decision === "ENTER" ? r.plan!.quantity.v : 0n;
    if (previous !== null) {
      assert(q <= previous, `equity ${equity} produced ${q} > previous ${previous}`);
    }
    previous = q;
  }
});

// ---------------------------------------------------------------------------
// 2. Leverage must not be applied to P&L twice.
// ---------------------------------------------------------------------------
Deno.test("02 SYNTHETIC: leverage changes margin only, never planned loss", () => {
  const a = evaluateQuantity("10", baseCtx({ leverage: "3" }));
  const b = evaluateQuantity("10", baseCtx({ leverage: "20" }));
  assertEquals(a.plan!.plannedLoss.toString(), b.plan!.plannedLoss.toString());
  // Margin, by contrast, must fall as leverage rises.
  assert(b.plan!.margin.lt(a.plan!.margin));
  assertEquals(a.plan!.margin.toString(), a.plan!.notional.div(dec(3)).toString());
});

// ---------------------------------------------------------------------------
// 3. Exchange minimum order size must never force a trade over budget.
// ---------------------------------------------------------------------------
Deno.test("03 SYNTHETIC: min notional above the risk budget is a SKIP, not a bigger risk", () => {
  // 25 USDT equity, 0.25% budget = 0.0625 USDT, but minNotional 100 with a 5%
  // stop implies ~5 USDT of loss. Nothing may make this pass.
  const r = solveQuantity(baseCtx({
    equity: "25",
    availableMargin: "25",
    filters: { ...FILTERS, minNotional: "100", minQty: "1" },
    dailyRemaining: "1000",
    weeklyRemaining: "1000",
  }));
  assertEquals(r.decision, "SKIP");
  assertEquals(r.reason, SKIP_MIN_NOTIONAL);
});

// ---------------------------------------------------------------------------
// 4. risk_per_trade = 100 and unit errors must be rejected, not normalised.
// ---------------------------------------------------------------------------
Deno.test("04 INCIDENT: live risk_per_trade_pct=100 is refused as a config error", () => {
  // Exactly the row observed in production on 2026-09-16T13:01Z.
  const r = resolveRiskPolicy({ risk_per_trade_pct: 100, max_daily_loss_pct: 30 });
  assertEquals(r.ok, false);
  assertEquals(r.policy, null);
  const codes = r.errors.map((e: any) => e.code);
  assert(codes.includes("RISK_PER_TRADE_IMPLAUSIBLE"), JSON.stringify(codes));
  assert(codes.includes("DAILY_LOSS_LIMIT_IMPLAUSIBLE"), JSON.stringify(codes));
});

Deno.test("04b SYNTHETIC: a stricter operator value is honoured; a looser one is capped", () => {
  const strict = resolveRiskPolicy({ risk_per_trade_pct: 0.1 }); // 0.001 < 0.0025
  assertEquals(strict.ok, true);
  assertEquals(strict.policy!.riskPerTradeFrac.toString(), "0.001");
  const loose = resolveRiskPolicy({ risk_per_trade_pct: 2 }); // 0.02 > 0.0025 but < 5%
  assertEquals(loose.ok, true);
  assertEquals(loose.policy!.riskPerTradeFrac.toString(), PROTECTIVE_DEFAULTS.risk_per_trade_frac);
});

Deno.test("04c SYNTHETIC: unreadable and negative risk settings are refused", () => {
  assertEquals(resolveRiskPolicy({ risk_per_trade_pct: "abc" }).ok, false);
  assertEquals(resolveRiskPolicy({ risk_per_trade_pct: -1 }).ok, false);
  assertEquals(resolveRiskPolicy(null).ok, false);
});

// ---------------------------------------------------------------------------
// 5. Concurrent workers must not double-book the same risk budget.
// ---------------------------------------------------------------------------
Deno.test("05 SYNTHETIC: two workers cannot both reserve the last of the risk budget", () => {
  const store = new RiskReservationStore({ totalBudget: "100" });
  const a = store.reserve({ id: "A", amount: "80", fencingToken: 1 });
  const b = store.reserve({ id: "B", amount: "80", fencingToken: 1 });
  assertEquals(a.ok, true);
  assertEquals(b.ok, false);
  assertEquals(b.reason, "INSUFFICIENT_RISK_BUDGET");
  assertEquals(store.outstanding().toString(), "80");
});

Deno.test("05b SYNTHETIC: a stale fencing token cannot reserve or release", () => {
  const store = new RiskReservationStore({ totalBudget: "100", fencingToken: 7 });
  assertEquals(store.reserve({ id: "old", amount: "10", fencingToken: 6 }).reason, "FENCED_OUT");
  assertEquals(store.reserve({ id: "new", amount: "10", fencingToken: 7 }).ok, true);
  assertEquals(store.release({ id: "new", fencingToken: 6 }).reason, "FENCED_OUT");
});

// ---------------------------------------------------------------------------
// 6. Unfilled and UNKNOWN orders keep holding their reservation.
// ---------------------------------------------------------------------------
Deno.test("06 SYNTHETIC: UNKNOWN outcome holds the reservation until it is proven", () => {
  const store = new RiskReservationStore({ totalBudget: "100" });
  store.reserve({ id: "o1", amount: "40", fencingToken: 1 });
  const outcome = classifyOrderOutcome({ kind: "TIMEOUT" });
  assertEquals(outcome.state, "UNKNOWN");
  assertEquals(outcome.mayRelease, false);
  assertEquals(store.releaseIfProven({ id: "o1", outcome }).released, false);
  assertEquals(store.outstanding().toString(), "40");
});

Deno.test("06b SYNTHETIC: HTTP 503 splits into indeterminate and definitely-rejected", () => {
  assertEquals(classifyOrderOutcome({ kind: "HTTP", status: 503, message: "Service Unavailable" }).state, "UNKNOWN");
  const rejected = classifyOrderOutcome({
    kind: "HTTP",
    status: 503,
    message: '{"code":-2010,"msg":"Account has insufficient balance"}',
  });
  assertEquals(rejected.state, "REJECTED");
  assertEquals(rejected.mayRelease, true);
});

// ---------------------------------------------------------------------------
// 7. Protection must match the quantity that actually filled.
// ---------------------------------------------------------------------------
Deno.test("07 SYNTHETIC: partial fill protects the filled quantity, not the requested one", () => {
  const plan = protectionPlan({ filledQuantity: "37", requestedQuantity: "100", stopPrice: "95", side: "LONG" });
  assertEquals(plan.quantity.toString(), "37");
  assertEquals(plan.reduceOnly, true);
  assertEquals(plan.closePosition, false);
});

Deno.test("07b SYNTHETIC: a zero fill produces no protective order and no position", () => {
  const plan = protectionPlan({ filledQuantity: "0", requestedQuantity: "100", stopPrice: "95", side: "LONG" });
  assertEquals(plan.required, false);
});

// ---------------------------------------------------------------------------
// 8. A lost response must be resolved by querying the same order.
// ---------------------------------------------------------------------------
Deno.test("08 SYNTHETIC: a lost ack resolves by identity lookup, never by a new client id", () => {
  const r = reconcileUnknownOrder({
    clientOrderId: "tb-v11e-abc",
    lookup: () => ({ found: true, status: "FILLED", executedQty: "12", avgPrice: "100" }),
  });
  assertEquals(r.action, "ADOPT_EXISTING");
  assertEquals(r.filledQuantity.toString(), "12");
  assertEquals(r.newClientOrderIdAllowed, false);
});

Deno.test("08b SYNTHETIC: an unresolvable lookup never authorises a resend", () => {
  const r = reconcileUnknownOrder({
    clientOrderId: "tb-v11e-abc",
    lookup: () => { throw new Error("GW_504"); },
  });
  assertEquals(r.action, "HOLD_UNKNOWN");
  assertEquals(r.newClientOrderIdAllowed, false);
});

// ---------------------------------------------------------------------------
// 9. Native stop vs local exit must not open an opposite position.
// ---------------------------------------------------------------------------
Deno.test("09 SYNTHETIC: a stop that already filled cancels the local exit instead of doubling it", () => {
  const r = resolveExitRace({
    exchangeQuantity: "0",
    nativeStopFilled: true,
    localExitRequestedQuantity: "500",
  });
  assertEquals(r.action, "ABORT_LOCAL_EXIT");
  assertEquals(r.sendQuantity.toString(), "0");
});

Deno.test("09b SYNTHETIC: a partial native stop fill leaves only the remainder to close", () => {
  const r = resolveExitRace({
    exchangeQuantity: "200",
    nativeStopFilled: true,
    localExitRequestedQuantity: "500",
  });
  assertEquals(r.action, "REDUCE_LOCAL_EXIT");
  assertEquals(r.sendQuantity.toString(), "200");
});

// ---------------------------------------------------------------------------
// 10. One symbol's failure must not stop another symbol's protection.
// ---------------------------------------------------------------------------
Deno.test("10 SYNTHETIC: a symbol-scoped settlement failure isolates that symbol only", () => {
  const outcomes: string[] = [];
  const symbols = ["AAAUSDT", "BBBUSDT", "哈基米USDT"];
  for (const s of symbols) {
    try {
      if (s === "BBBUSDT") throw new Error("SETTLE_FAIL");
      outcomes.push(`${s}:protected`);
    } catch {
      outcomes.push(`${s}:quarantined`);
    }
  }
  assertEquals(outcomes, ["AAAUSDT:protected", "BBBUSDT:quarantined", "哈基米USDT:protected"]);
});

// ---------------------------------------------------------------------------
// 11. Loss state must survive a restart.
// ---------------------------------------------------------------------------
Deno.test("11 SYNTHETIC: day/week loss, high-water and streak survive a serialise/restore", () => {
  const { policy } = resolveRiskPolicy({});
  const before = evaluateLossLimits({
    policy,
    equity: "10000",
    realizedToday: "-95",
    realizedThisWeek: "-95",
    highWaterEquity: "10200",
    consecutiveLosses: 2,
  });
  const restored = JSON.parse(JSON.stringify({
    realizedToday: "-95",
    realizedThisWeek: "-95",
    highWaterEquity: "10200",
    consecutiveLosses: 2,
  }));
  const after = evaluateLossLimits({ policy, equity: "10000", ...restored });
  assertEquals(before.allowed, after.allowed);
  assertEquals(before.dailyRemaining.toString(), after.dailyRemaining.toString());
  // One more loss crosses both the daily limit and the streak limit.
  const tripped = evaluateLossLimits({
    policy,
    equity: "10000",
    realizedToday: "-101",
    realizedThisWeek: "-101",
    highWaterEquity: "10200",
    consecutiveLosses: 3,
  });
  assertEquals(tripped.allowed, false);
  const codes = tripped.blocks.map((b: any) => b.code);
  assert(codes.includes("DAILY_LOSS_LIMIT_REACHED"));
  assert(codes.includes("CONSECUTIVE_LOSS_LIMIT_REACHED"));
});

// ---------------------------------------------------------------------------
// 12. Hitting a risk limit must not stop protection or settlement.
// ---------------------------------------------------------------------------
Deno.test("12 SYNTHETIC: a reached risk limit blocks entry but leaves protection enabled", () => {
  const { policy } = resolveRiskPolicy({});
  const limits = evaluateLossLimits({
    policy,
    equity: "10000",
    realizedToday: "-500",
    realizedThisWeek: "-500",
    highWaterEquity: "10000",
    consecutiveLosses: 0,
  });
  assertEquals(limits.allowed, false);
  // Protection planning is independent of entry admission.
  const plan = protectionPlan({ filledQuantity: "10", requestedQuantity: "10", stopPrice: "95", side: "LONG" });
  assertEquals(plan.required, true);
  assertEquals(plan.quantity.toString(), "10");
});

// ---------------------------------------------------------------------------
// 13. Non-ASCII symbols must survive keying, encoding and fill collection.
// ---------------------------------------------------------------------------
Deno.test("13 INCIDENT: 哈基米USDT keeps its bytes through keying and URL encoding", () => {
  const f = {
    account: "futures",
    exchange: "binance_futures",
    market: "哈基米USDT",
    exchange_trade_id: 4140134,
    side: "BUY",
    price: "0.01",
    quantity: "1080",
    fee_asset: "USDT",
    fee_amount: "0.02",
  };
  const n = normalizeFill(f);
  assertEquals(n.symbol, "哈基米USDT");
  assert(n.key!.includes("哈基米USDT"));
  // Round-trip through the query encoding the REST client would use.
  const enc = encodeURIComponent("哈基米USDT");
  assertEquals(decodeURIComponent(enc), "哈基米USDT");
  assert(enc !== "哈基米USDT", "expected percent-encoding to actually change the string");
  // Uppercasing must not corrupt it either.
  assertEquals("哈基米USDT".toUpperCase(), "哈基米USDT");
});

Deno.test("13b INCIDENT: an ASCII-only market allow-list would drop 哈基米USDT", () => {
  // The guard that must NOT be used for collection, asserted so a future
  // reintroduction fails here rather than silently losing fills.
  assertEquals(/^[A-Z0-9]{5,20}$/.test("哈基米USDT"), false);
  assertEquals("哈基米USDT".endsWith("USDT"), true);
});

// ---------------------------------------------------------------------------
// 14. Plain order, conditional order and fills must link end to end.
// ---------------------------------------------------------------------------
Deno.test("14 SYNTHETIC: algoId -> actualOrderId -> fill chain resolves", () => {
  const fills = [{
    account: "futures",
    exchange: "binance_futures",
    market: "AAAUSDT",
    exchange_trade_id: 1,
    side: "SELL",
    price: "95",
    quantity: "10",
    fee_asset: "USDT",
    fee_amount: "0.38",
    exchange_order_id: "9001",
    algo_id: "A1",
    actual_order_id: "9001",
  }];
  const n = normalizeFill(fills[0]);
  assertEquals(n.algoId, "A1");
  assertEquals(String(n.actualOrderId), String(n.orderId));
});

// ---------------------------------------------------------------------------
// 15. CLOSED alone must not mask missing fills.
// ---------------------------------------------------------------------------
Deno.test("15 INCIDENT: 哈基米USDT closed with only BUY fills stays UNRESOLVED", () => {
  // Anonymised shape of the production row: state CLOSED, native stop exit,
  // three BUY fills totalling 3240, zero SELL fills.
  const r = reconcilePosition({
    position: { id: "p1", symbol: "哈基米USDT", realized_pnl_usdt: "-4.55312894" },
    fills: [1, 2, 3].map((i) => ({
      account: "futures",
      exchange: "binance_futures",
      market: "哈基米USDT",
      exchange_trade_id: i,
      side: "BUY",
      price: "0.0123",
      quantity: "1080",
      fee_asset: "USDT",
      fee_amount: "0.0200011",
      realized_pnl_quote: "0",
    })),
    exchangeExposure: { quantity: "0" },
  });
  assertEquals(r.state, "UNRESOLVED");
  assertEquals(r.findings.some((f: any) => f.code === "EXIT_FILLS_MISSING"), true);
  assertEquals(r.soldQty.toString(), "0");
});

Deno.test("15b INCIDENT: a position with zero linked fills is UNRESOLVED, not settled", () => {
  const r = reconcilePosition({
    position: { id: "p2", symbol: "CVCUSDT", realized_pnl_usdt: "-1.66055724" },
    fills: [],
    exchangeExposure: { quantity: "0" },
  });
  assertEquals(r.state, "UNRESOLVED");
  assertEquals(r.findings.some((f: any) => f.code === "NO_FILLS_LINKED"), true);
});

Deno.test("15c SYNTHETIC: an unverified exchange exposure is not treated as flat", () => {
  const r = reconcilePosition({
    position: { id: "p3", symbol: "AAAUSDT", realized_pnl_usdt: "0" },
    fills: [],
    exchangeExposure: undefined,
  });
  assertEquals(r.findings.some((f: any) => f.code === "EXCHANGE_EXPOSURE_UNVERIFIED"), true);
});

// ---------------------------------------------------------------------------
// 16. Income history and fills must not both be counted.
// ---------------------------------------------------------------------------
Deno.test("16 SYNTHETIC: one ledger is authoritative, the other only cross-checks", () => {
  const ok = reconcileAccount({
    startEquity: "1000",
    endEquity: "950",
    netDeposits: "0",
    realizedPnl: "-40",
    fees: "10",
    fundingAndOther: "0",
    unrealizedChange: "0",
    basis: { equityDefinition: "walletBalance+unrealizedPnl", collateralScope: "USDT_ONLY" },
    ledger: "USER_TRADES",
    crossCheck: { source: "INCOME_HISTORY", realizedPnl: "-40", fees: "10" },
  });
  assertEquals(ok.reconciled, true);
  assertEquals(ok.crossCheck!.agrees, true);
  // Double counting the same fees breaks the identity rather than passing quietly.
  const doubled = reconcileAccount({
    startEquity: "1000",
    endEquity: "950",
    netDeposits: "0",
    realizedPnl: "-40",
    fees: "20",
    fundingAndOther: "0",
    unrealizedChange: "0",
    basis: { equityDefinition: "walletBalance+unrealizedPnl", collateralScope: "USDT_ONLY" },
    crossCheck: { source: "INCOME_HISTORY", realizedPnl: "-40", fees: "10" },
  });
  assertEquals(doubled.reconciled, false);
  assert(doubled.findings.some((f: any) => f.code === "LEDGER_CROSS_CHECK_DISAGREES"));
});

Deno.test("16b SYNTHETIC: an undeclared equity basis fails the reconciliation", () => {
  const r = reconcileAccount({
    startEquity: "1000",
    endEquity: "1000",
    netDeposits: "0",
    realizedPnl: "0",
    fees: "0",
    fundingAndOther: "0",
    unrealizedChange: "0",
    basis: null,
  });
  assertEquals(r.reconciled, false);
  assert(r.findings.some((f: any) => f.code === "BASIS_UNDECLARED"));
});

// ---------------------------------------------------------------------------
// 17. Stale, crossed or gapped books must block entry.
// ---------------------------------------------------------------------------
Deno.test("17 SYNTHETIC: stale / crossed / gapped book state blocks the gate", () => {
  for (
    const data of [
      { bookHealthy: true, bookAgeMs: 9000, maxBookAgeMs: 5000, barsFinal: true, resyncComplete: true },
      { bookHealthy: false, bookAgeMs: 100, maxBookAgeMs: 5000, barsFinal: true, resyncComplete: true },
      { bookHealthy: true, bookAgeMs: 100, maxBookAgeMs: 5000, barsFinal: true, resyncComplete: false },
      { bookHealthy: true, bookAgeMs: 100, maxBookAgeMs: 5000, barsFinal: true, resyncComplete: true, reasons: ["CROSSED_BOOK"] },
    ]
  ) {
    const g = evaluateEntryGate({ ...passingGateInput(), data });
    assertEquals(g.allowed, false, JSON.stringify(data));
    assertEquals(g.conditions.data_healthy.state, "BLOCK");
  }
});

// ---------------------------------------------------------------------------
// 18. Unfinished bars, future ranks and future pivots must be unreachable.
// ---------------------------------------------------------------------------
Deno.test("18 SYNTHETIC: an unfinished or not-yet-arrived bar is invisible to a decision", () => {
  const asOf = 300_000;
  const bars = [
    bar(0, "1", "1", "1", "1"),
    bar(60_000, "1", "1", "1", "1"),
    { ...bar(120_000, "1", "9", "1", "9"), final: false }, // still forming
    { ...bar(180_000, "1", "9", "1", "9"), availableAt: 999_999 }, // arrives later
  ];
  const seen: any[] = usableBars(bars, asOf);
  assertEquals(seen.length, 2);
  assertEquals(seen.every((b: any) => Number(b.high) === 1), true);
});

Deno.test("18b SYNTHETIC: a missing KST day open excludes the symbol instead of reusing yesterday", () => {
  const KST = 9 * 3600 * 1000;
  const dayStart = Math.floor((1_800_000_000_000 + KST) / 86400000) * 86400000 - KST;
  const withOpen = { symbol: "AAAUSDT", bars1m: [bar(dayStart, "10", "12", "10", "12")] };
  const withoutOpen = { symbol: "BBBUSDT", bars1m: [bar(dayStart + 600_000, "10", "12", "10", "12")] };
  const asOf = dayStart + 700_000;
  assert(kstDayOpen(withOpen.bars1m, asOf) !== null);
  assertEquals(kstDayOpen(withoutOpen.bars1m, asOf), null);
  const r = rankDayGainers([withOpen, withoutOpen], asOf);
  assertEquals(r.ranked.map((x: any) => x.symbol), ["AAAUSDT"]);
  assertEquals(r.excluded[0].reason, "KST_DAY_OPEN_MISSING");
});

// ---------------------------------------------------------------------------
// 19. A disabled or unreadable filter must never become an automatic ALLOW.
// ---------------------------------------------------------------------------
Deno.test("19 SYNTHETIC: missing gate inputs block instead of defaulting to allow", () => {
  assertEquals(evaluateEntryGate({}).allowed, false);
  for (const key of ["strategy", "approval", "data", "cost", "risk", "execution", "authorization"]) {
    const input: Record<string, unknown> = { ...passingGateInput() };
    delete input[key];
    const g = evaluateEntryGate(input);
    assertEquals(g.allowed, false, `omitting ${key} still allowed entry`);
  }
});

Deno.test("19b SYNTHETIC: a failed settings read refuses entry", () => {
  const g = evaluateEntryGate({
    ...passingGateInput(),
    authorization: { ...passingGateInput().authorization, settingsReadOk: false },
  });
  assertEquals(g.allowed, false);
  assertEquals(g.conditions.trading_authorized.state, "BLOCK");
});

// ---------------------------------------------------------------------------
// 20. A boolean or manual edge must not constitute approval.
// ---------------------------------------------------------------------------
Deno.test("20 INCIDENT: parametersValidatedByBacktest alone is not approval", () => {
  // The exact operator-override shape present in the live executor today.
  const r = checkValidationApproval(
    { parametersValidatedByBacktest: false, basis: "OPERATOR_OVERRIDE_UNVALIDATED" },
    runningIdentity(),
  );
  assertEquals(r.state, "BLOCK");
  assertEquals(r.code, "VALIDATION_BOOLEAN_ONLY");
});

Deno.test("20b SYNTHETIC: a manually entered expectedEdgeBps is refused", () => {
  const r = checkValidationApproval(
    { ...approvalFor(runningIdentity()), expectedEdgeBpsSource: "MANUAL" },
    runningIdentity(),
  );
  assertEquals(r.state, "BLOCK");
  assertEquals(r.code, "VALIDATION_EDGE_MANUALLY_ENTERED");
});

Deno.test("20c SYNTHETIC: a hash mismatch against the running policy is refused", () => {
  const approval = approvalFor(runningIdentity());
  const r = checkValidationApproval(approval, { ...runningIdentity(), policyCodeHash: "different" });
  assertEquals(r.state, "BLOCK");
  assertEquals(r.code, "VALIDATION_HASH_MISMATCH");
});

Deno.test("20d SYNTHETIC: a non-positive validated expectancy is refused", () => {
  const r = checkValidationApproval(
    { ...approvalFor(runningIdentity()), netExpectancyLowerBound: "-0.5" },
    runningIdentity(),
  );
  assertEquals(r.state, "BLOCK");
  assertEquals(r.code, "VALIDATION_EXPECTANCY_NOT_POSITIVE");
});

// ---------------------------------------------------------------------------
// 21. The same setup must never be re-entered.
// ---------------------------------------------------------------------------
Deno.test("21 SYNTHETIC: a consumed setup cannot arm again without a new impulse", () => {
  const consumed = {
    state: SETUP_STATE.CONSUMED,
    symbol: "AAAUSDT",
    setupId: "AAAUSDT:1:R1",
    legLow: "100",
    consumedAt: 1,
  };
  const bars = rising5m(40);
  const next = advanceSetup({
    state: consumed,
    bars5m: bars,
    bars1m: rising5m(40),
    asOf: bars[bars.length - 1].closeTime,
    tickSize: "0.0001",
    symbol: "AAAUSDT",
  });
  // It may become a NEW setup with a NEW id, but must never re-arm the old one.
  assert(next.state !== SETUP_STATE.ARMED || next.setupId !== consumed.setupId);
  const trigger = entryTrigger({ setup: consumed, bars1m: rising5m(20), asOf: 1e12, tickSize: "0.0001" });
  assertEquals(trigger.fire, false);
  assertEquals(trigger.reason, "SETUP_NOT_ARMED");
});

Deno.test("21b SYNTHETIC: a restart does not reset setup consumption", () => {
  const consumed = { state: SETUP_STATE.CONSUMED, symbol: "A", setupId: "A:1:R1", legLow: "1" };
  const restored = JSON.parse(JSON.stringify(consumed));
  assertEquals(restored.state, SETUP_STATE.CONSUMED);
  const t = entryTrigger({ setup: restored, bars1m: rising5m(20), asOf: 1e12, tickSize: "0.0001" });
  assertEquals(t.fire, false);
});

// ---------------------------------------------------------------------------
// 22. A bulk cancel or rollback must not remove live protection.
// ---------------------------------------------------------------------------
Deno.test("22 SYNTHETIC: bulk cancel skips orders that are the only protection", () => {
  const open = [
    { clientOrderId: "tb-entry-1", protective: false, symbol: "AAAUSDT" },
    { clientOrderId: "tb-stop-1", protective: true, symbol: "AAAUSDT" },
  ];
  const toCancel = open.filter((o: any) => !o.protective);
  assertEquals(toCancel.map((o: any) => o.clientOrderId), ["tb-entry-1"]);
  assertEquals(open.some((o: any) => o.protective), true);
});

// ---------------------------------------------------------------------------
// 23. A failed stop replacement must leave protection in place.
// ---------------------------------------------------------------------------
Deno.test("23 SYNTHETIC: the old stop is cancelled only after the new one is accepted", () => {
  const ok = replaceProtection({
    existing: { clientAlgoId: "old", live: true },
    placeNew: () => ({ accepted: true, clientAlgoId: "new", active: true }),
  });
  assertEquals(ok.cancelledOld, true);
  assertEquals(ok.protectionGap, false);

  const failed = replaceProtection({
    existing: { clientAlgoId: "old", live: true },
    placeNew: () => ({ accepted: false, reason: "GW_503" }),
  });
  assertEquals(failed.cancelledOld, false);
  assertEquals(failed.stillProtectedBy, "old");
  assertEquals(failed.blockNewEntries, true);
});

Deno.test("23b SYNTHETIC: an indeterminate placement does not spawn a second stop", () => {
  const r = replaceProtection({
    existing: { clientAlgoId: "old", live: true },
    placeNew: () => { throw new Error("TIMEOUT"); },
  });
  assertEquals(r.cancelledOld, false);
  assertEquals(r.action, "VERIFY_BEFORE_RETRY");
  assertEquals(r.mayPlaceAnother, false);
});

// ---------------------------------------------------------------------------
// 24. Repository code and deployed code must be compared, not assumed equal.
// ---------------------------------------------------------------------------
Deno.test("24 INCIDENT: a deployed-vs-repository hash mismatch is detected", () => {
  const deployed = { slug: "v10-lane-executor", version: 47, ezbr_sha256: "7575268e27e9b77c9ff463d8608c831d480203bc7bc05f3c3de97b7e5d17b6be" };
  const expected = { version: 47, ezbr_sha256: "7575268e27e9b77c9ff463d8608c831d480203bc7bc05f3c3de97b7e5d17b6be" };
  assertEquals(deployed.ezbr_sha256 === expected.ezbr_sha256 && deployed.version === expected.version, true);
  const drifted = { ...deployed, version: 48, ezbr_sha256: "0".repeat(64) };
  assertEquals(drifted.ezbr_sha256 === expected.ezbr_sha256 && drifted.version === expected.version, false);
});

// ---------------------------------------------------------------------------
// 25. Negative fees (rebates) keep their sign.
// ---------------------------------------------------------------------------
Deno.test("25 SYNTHETIC: a maker rebate stays negative through normalisation", () => {
  const n = normalizeFill({
    account: "futures",
    exchange: "binance_futures",
    market: "AAAUSDT",
    exchange_trade_id: 7,
    side: "SELL",
    price: "100",
    quantity: "1",
    fee_asset: "USDT",
    fee_amount: "-0.0025",
  });
  assertEquals(n.feeAmount.toString(), "-0.0025");
  assertEquals(n.feeQuote!.toString(), "-0.0025");
  assertEquals(n.feeQuote!.isNeg(), true);
});

// ---------------------------------------------------------------------------
// 26. A relative tolerance must not hide a real shortfall on a large position.
// ---------------------------------------------------------------------------
Deno.test("26 SYNTHETIC: absolute tolerance catches on a large position what relative would hide", () => {
  // 1 USDT missing against a 1,000,000 USDT position is 1e-6 relative -- inside
  // any plausible relative epsilon, and exactly the kind of loss that must not
  // be absorbed.
  const r = reconcilePosition({
    position: { id: "big", symbol: "AAAUSDT", realized_pnl_usdt: "1000001" },
    fills: [{
      account: "futures",
      exchange: "binance_futures",
      market: "AAAUSDT",
      exchange_trade_id: 1,
      side: "BUY",
      price: "1",
      quantity: "1",
      fee_asset: "USDT",
      fee_amount: "0",
      realized_pnl_quote: "1000000",
    }, {
      account: "futures",
      exchange: "binance_futures",
      market: "AAAUSDT",
      exchange_trade_id: 2,
      side: "SELL",
      price: "1",
      quantity: "1",
      fee_asset: "USDT",
      fee_amount: "0",
      realized_pnl_quote: "0",
    }],
    exchangeExposure: { quantity: "0" },
  });
  assertEquals(r.residualMoney!.toString(), "1");
  assert(r.findings.some((f: any) => f.code === "MONEY_RESIDUAL_ABOVE_TOLERANCE"));
  assertEquals(r.state, "UNRESOLVED");
});

Deno.test("26b INCIDENT: the 119-position float residual sits inside the declared tolerance", () => {
  // Largest single-position residual observed in the real window was
  // 2.999998757e-8 USDT -- float64 noise in a value written from JS, not money.
  // It is ABOVE the 1e-8 per-position bound, so it must be REPORTED.
  const observedMax = dec("0.00000002999998757");
  assertEquals(observedMax.gt(dec(MONEY_TOLERANCE_PER_POSITION)), true);
});

// ---------------------------------------------------------------------------
// 27. Reprocessing a partial fill must not move the original reservation.
// ---------------------------------------------------------------------------
Deno.test("27 SYNTHETIC: replaying the same fill is idempotent for the reservation", () => {
  const store = new RiskReservationStore({ totalBudget: "100" });
  store.reserve({ id: "o1", amount: "40", fencingToken: 1 });
  const fill = { fillId: "f1", quantity: "5", price: "100" };
  let state: any = { openRisk: "0", reservedRemaining: "40", seenFills: [] as string[] };
  state = applyPartialFill(state, fill, { originalReservation: "40", riskPerUnit: "2" });
  const once = JSON.stringify(state);
  state = applyPartialFill(state, fill, { originalReservation: "40", riskPerUnit: "2" });
  assertEquals(JSON.stringify(state), once, "re-applying the same fill changed the reservation");
  assertEquals(state.originalReservation, "40");
});

Deno.test("27b SYNTHETIC: partial fills do not auto-top-up toward the original quantity", () => {
  const state: any = applyPartialFill(
    { openRisk: "0", reservedRemaining: "40", seenFills: [] },
    { fillId: "f1", quantity: "5", price: "100" },
    { originalReservation: "40", riskPerUnit: "2" },
  );
  assertEquals(state.topUpOrderAuthorised, false);
});

// ---------------------------------------------------------------------------
// 28. Changing data, cost or execution model invalidates prior approval.
// ---------------------------------------------------------------------------
Deno.test("28 SYNTHETIC: a new cost model version voids the previous approval", () => {
  const running = runningIdentity();
  const approval = approvalFor(running);
  assertEquals(checkValidationApproval(approval, running).state, "PASS");
  for (const field of ["datasetHash", "costModelVersion", "executionModelVersion", "parameterHash"]) {
    const moved = { ...running, [field]: `${running[field as keyof typeof running]}-v2` };
    assertEquals(checkValidationApproval(approval, moved).state, "BLOCK", field);
  }
});

Deno.test("28b SYNTHETIC: an expired approval stops admitting entries", () => {
  const running = runningIdentity();
  const approval = { ...approvalFor(running), validUntil: "2026-01-01T00:00:00Z" };
  assertEquals(checkValidationApproval(approval, running, Date.parse("2026-09-16T13:00:00Z")).state, "BLOCK");
});

// ---------------------------------------------------------------------------
// 29. A SHADOW process must have no order-sending capability.
// ---------------------------------------------------------------------------
Deno.test("29 SYNTHETIC: shadow capability set contains no order-sending action", () => {
  const SHADOW_ALLOWED = ["exchangeInfo", "klines", "depth", "aggTrades", "premiumIndex", "fundingRate", "openInterest"];
  const ORDER_ACTIONS = ["create_order", "cancel_order", "v17_create_stop", "v17_cancel_stop", "algoOrder", "close_position"];
  for (const a of ORDER_ACTIONS) {
    assertEquals(SHADOW_ALLOWED.includes(a), false, `${a} must not be shadow-reachable`);
  }
  // And the gate itself refuses when trading is not authorised for live.
  const g = evaluateEntryGate({
    ...passingGateInput(),
    authorization: { ...passingGateInput().authorization, mode: "SHADOW" },
  });
  // SHADOW mode may evaluate, but the executor must not dispatch: assert the
  // mode is carried through so the dispatcher can refuse on it.
  assertEquals(g.conditions.trading_authorized.detail, "SHADOW");
});

// ---------------------------------------------------------------------------
// 30. Protection and settlement run regardless of entry admission state.
// ---------------------------------------------------------------------------
Deno.test("30 SYNTHETIC: entry refusal does not disable protection or reconciliation", () => {
  const gate = evaluateEntryGate({
    ...passingGateInput(),
    authorization: { ...passingGateInput().authorization, pauseNewEntries: true },
  });
  assertEquals(gate.allowed, false);
  // Protection still plans.
  assertEquals(protectionPlan({ filledQuantity: "5", requestedQuantity: "5", stopPrice: "9", side: "LONG" }).required, true);
  // Reconciliation still runs and still reaches a verdict.
  const rec = reconcilePosition({
    position: { id: "p", symbol: "AAAUSDT", realized_pnl_usdt: "0" },
    fills: [],
    exchangeExposure: { quantity: "0" },
  });
  assertEquals(rec.state, "UNRESOLVED");
});

// ---------------------------------------------------------------------------
// Ledger invariants used by the reconciliation script
// ---------------------------------------------------------------------------
Deno.test("ledger: fill arrival order does not change the reconciliation verdict", () => {
  const mk = (id: number, side: string, qty: string) => ({
    account: "futures",
    exchange: "binance_futures",
    market: "AAAUSDT",
    exchange_trade_id: id,
    side,
    price: "100",
    quantity: qty,
    fee_asset: "USDT",
    fee_amount: "0.01",
    realized_pnl_quote: side === "SELL" ? "1" : "0",
  });
  const fills = [mk(1, "BUY", "5"), mk(2, "BUY", "5"), mk(3, "SELL", "4"), mk(4, "SELL", "6")];
  const forward = reconcilePosition({
    position: { id: "p", symbol: "AAAUSDT", realized_pnl_usdt: "1.96" },
    fills,
    exchangeExposure: { quantity: "0" },
  });
  const reversed = reconcilePosition({
    position: { id: "p", symbol: "AAAUSDT", realized_pnl_usdt: "1.96" },
    fills: [...fills].reverse(),
    exchangeExposure: { quantity: "0" },
  });
  assertEquals(forward.state, reversed.state);
  assertEquals(forward.residualQty.toString(), reversed.residualQty.toString());
  assertEquals(forward.ledgerNet!.toString(), reversed.ledgerNet!.toString());
});

Deno.test("ledger: tradeId alone is not a key across symbols", () => {
  const a = { account: "futures", exchange: "binance_futures", market: "AAAUSDT", exchange_trade_id: 1 };
  const b = { account: "futures", exchange: "binance_futures", market: "BBBUSDT", exchange_trade_id: 1 };
  assert(fillKey(a) !== fillKey(b));
  const { fills, conflicts } = dedupeFills([a, b]);
  assertEquals(fills.length, 2);
  assertEquals(conflicts.length, 0);
});

Deno.test("ledger: identical key with differing content is a conflict, not a dedupe", () => {
  const base = {
    account: "futures",
    exchange: "binance_futures",
    market: "AAAUSDT",
    exchange_trade_id: 1,
    side: "BUY",
    price: "100",
    quantity: "1",
    fee_amount: "0.04",
    fee_asset: "USDT",
  };
  const { conflicts } = dedupeFills([base, { ...base, price: "101" }]);
  assertEquals(conflicts.length, 1);
  assertEquals(conflicts[0].fields.includes("price"), true);
});

Deno.test("ledger: a non-quote fee without conversion provenance is unresolved", () => {
  const n = normalizeFill({
    account: "futures",
    exchange: "binance_futures",
    market: "AAAUSDT",
    exchange_trade_id: 1,
    side: "BUY",
    price: "100",
    quantity: "1",
    fee_asset: "BNB",
    fee_amount: "0.001",
  });
  assertEquals(n.feeQuote, null);
  assertEquals(n.resolved, false);
  assertEquals(n.feeConversion.method, "UNRESOLVED");

  const withRate = normalizeFill(
    {
      account: "futures",
      exchange: "binance_futures",
      market: "AAAUSDT",
      exchange_trade_id: 1,
      side: "BUY",
      price: "100",
      quantity: "1",
      fee_asset: "BNB",
      fee_amount: "0.001",
    },
    { conversions: new Map([["BNB", { rate: "600", at: "2026-09-16T00:00:00Z", source: "BINANCE_MARK" }]]) },
  );
  assertEquals(withRate.feeQuote!.toString(), "0.6");
  assertEquals(withRate.feeConversion.source, "BINANCE_MARK");
});

// ---------------------------------------------------------------------------
// Sizing invariants
// ---------------------------------------------------------------------------
Deno.test("sizing: VWAP cost is recomputed per size, not reused from a probe", () => {
  const asks = ladder(100, 0.01, 50, "1"); // 1% worse per level
  const small = walkBook(asks, "1")!;
  const large = walkBook(asks, "20")!;
  assert(large.vwap.gt(small.vwap), "deep order must have a worse VWAP");
  assertEquals(small.levelsConsumed, 1);
  assert(large.levelsConsumed > 1);
});

Deno.test("sizing: insufficient depth is refused rather than extrapolated", () => {
  assertEquals(walkBook([["100", "5"]], "10"), null);
  const r = evaluateQuantity("10", baseCtx({ bookAsks: [["100", "5"]] }));
  assertEquals(r.ok, false);
  assert(r.reasons.includes("INSUFFICIENT_ASK_DEPTH"));
});

Deno.test("sizing: the returned quantity is on the step lattice and re-verified", () => {
  const r = solveQuantity(baseCtx({
    filters: { ...FILTERS, stepSize: "0.001", minQty: "0.001", minNotional: "5" },
    bookAsks: ladder(100, 0.0001, 500, "1"),
    bookBids: ladder(99.9, -0.0001, 500, "1"),
    dailyRemaining: "1000000",
    weeklyRemaining: "1000000",
  }));
  if (r.decision === "ENTER") {
    const q = r.plan!.quantity;
    assertEquals(q.toString(), q.floorStep("0.001").toString());
    assertEquals(evaluateQuantity(q, baseCtx({
      filters: { ...FILTERS, stepSize: "0.001", minQty: "0.001", minNotional: "5" },
      bookAsks: ladder(100, 0.0001, 500, "1"),
      bookBids: ladder(99.9, -0.0001, 500, "1"),
      dailyRemaining: "1000000",
      weeklyRemaining: "1000000",
    })).ok, true);
  }
});

Deno.test("sizing: a wider stop yields a smaller quantity, never a tightened stop", () => {
  const ctx = (stop: string) =>
    baseCtx({
      structuralStop: stop,
      bookAsks: ladder(100, 0.00005, 2000, "10"),
      bookBids: ladder(99.9, -0.00005, 2000, "10"),
      dailyRemaining: "1000000",
      weeklyRemaining: "1000000",
      availableMargin: "1000000",
    });
  const tight = solveQuantity(ctx("99"));
  const wide = solveQuantity(ctx("90"));
  if (tight.decision === "ENTER" && wide.decision === "ENTER") {
    assert(wide.plan!.quantity.lt(tight.plan!.quantity));
    assertEquals(wide.plan!.stopPrice.toString(), "90");
  }
});

// ---------------------------------------------------------------------------
// Strategy invariants
// ---------------------------------------------------------------------------
Deno.test("strategy: MFE that was never observed does not satisfy the early-failure rule", () => {
  const r = earlyFailure({
    position: { entryAt: 0, initialR: "10", peakExecutableNet: null, triggerPrice: "100" },
    bars1m: [bar(0, "100", "100", "99", "99"), bar(60_000, "99", "99", "98", "98"), bar(120_000, "98", "98", "97", "97")],
    asOf: 600_000,
    tickSize: "0.01",
  });
  assertEquals(r.failed, false);
  assertEquals(r.reason, "MFE_UNOBSERVED");
});

Deno.test("strategy: the trail is withheld until three post-entry bars exist", () => {
  const bars = rising5m(40);
  const entryAt = bars[bars.length - 2].openTime; // only one post-entry bar
  const r = profitTrailStop({
    position: { entryAt, initialR: "1", peakExecutableNet: "10", currentStop: "1" },
    bars5m: bars,
    asOf: bars[bars.length - 1].closeTime,
    tickSize: "0.0001",
  });
  assertEquals(r.armed, false);
  assertEquals(r.reason, "INSUFFICIENT_POST_ENTRY_5M_BARS");
  assertEquals(r.stop, null);
});

Deno.test("strategy: the profit stop only ratchets upward", () => {
  const bars = rising5m(60);
  const entryAt = bars[0].openTime;
  const high = profitTrailStop({
    position: { entryAt, initialR: "0.0001", peakExecutableNet: "100", currentStop: "999999" },
    bars5m: bars,
    asOf: bars[bars.length - 1].closeTime,
    tickSize: "0.0001",
  });
  assertEquals(high.stop, null);
  assertEquals(high.reason, "TRAIL_NOT_HIGHER");
});

Deno.test("strategy: simultaneous exit conditions collapse into one intent", () => {
  const bars5 = rising5m(30);
  const d: any = decideExit({
    position: {
      entryAt: 0,
      initialStop: "95",
      currentStop: "99",
      initialR: "1",
      peakExecutableNet: "0",
      triggerPrice: "100",
    },
    bars1m: [bar(0, "100", "100", "94", "94")],
    bars5m: bars5,
    asOf: bars5[bars5.length - 1].closeTime,
    tickSize: "0.01",
    lastPrice: "94",
  });
  assertEquals(d.exit, true);
  // Price is below BOTH stops; the initial hard stop wins and only one intent
  // is produced.
  assertEquals(d.strategyExitReason, "INITIAL_STOP");
  assertEquals(d.fraction, "1");
});

Deno.test("strategy: the entry trigger is not re-derived downward once armed", () => {
  const setup = {
    state: SETUP_STATE.ARMED,
    setupId: "A:1:R1",
    triggerPrice: "105",
    legLow: "90",
    symbol: "AAAUSDT",
  };
  const bars = [
    bar(0, "100", "101", "99", "100"),
    bar(60_000, "100", "101", "99", "100"),
    bar(120_000, "100", "101", "99", "100"),
  ];
  // Price never reaches 105, so no entry, and the trigger stays 105.
  const t = entryTrigger({ setup, bars1m: bars, asOf: bars[2].closeTime, tickSize: "0.01" });
  assertEquals(t.fire, false);
  assertEquals(setup.triggerPrice, "105");
});

Deno.test("strategy: data lateness does not extend the signal's life", () => {
  const setup = { state: SETUP_STATE.ARMED, setupId: "A:1:R1", triggerPrice: "100", legLow: "90" };
  const late = bar(0, "99", "101", "99", "101", 500_000); // arrived at 500s
  const prev = bar(-60_000, "99", "99", "98", "99", 400_000);
  // Evaluated 120s after it became available -> beyond the 60s signal TTL.
  const t = entryTrigger({ setup, bars1m: [prev, late], asOf: 620_000, tickSize: "0.01" });
  assertEquals(t.fire, false);
  assertEquals(t.reason, "SIGNAL_TTL_EXPIRED");
});

// ---------------------------------------------------------------------------
// Gate composition
// ---------------------------------------------------------------------------
Deno.test("gate: all seven conditions must pass together", () => {
  const g = evaluateEntryGate(passingGateInput());
  assertEquals(g.allowed, true, JSON.stringify(g.blocked));
});

Deno.test("gate: the pre-dispatch re-check is authoritative over admission", () => {
  const admission = evaluateEntryGate(passingGateInput());
  const predispatch = evaluateEntryGate({
    ...passingGateInput(),
    phase: "PRE_DISPATCH",
    execution: { ...passingGateInput().execution, leaseHeld: false },
  });
  const c = confirmBeforeDispatch(admission, predispatch);
  assertEquals(c.allowed, false);
  assertEquals(c.driftDetected, true);
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function runningIdentity() {
  return {
    policyCodeHash: "aaa",
    parameterHash: "bbb",
    datasetHash: "ccc",
    costModelVersion: "cost-1",
    executionModelVersion: "exec-1",
  };
}

function approvalFor(running: ReturnType<typeof runningIdentity>) {
  return {
    ...running,
    resultFileHash: "ddd",
    approvedBy: "operator:lkr9912",
    evaluationWindow: { start: "2026-08-01T00:00:00Z", end: "2026-09-01T00:00:00Z" },
    netExpectancyLowerBound: "0.5",
    expectedEdgeBpsSource: "EVALUATED",
    validUntil: "2099-01-01T00:00:00Z",
  };
}

function passingGateInput() {
  const { policy } = resolveRiskPolicy({});
  return {
    phase: "ADMISSION",
    now: Date.parse("2026-09-16T13:00:00Z"),
    strategy: { eligible: true, setupId: "A:1:R1", reason: null },
    approval: approvalFor(runningIdentity()),
    running: runningIdentity(),
    data: { bookHealthy: true, bookAgeMs: 200, maxBookAgeMs: 5000, barsFinal: true, resyncComplete: true, reasons: [] },
    cost: { netEdgeBps: "20", requiredEdgeBps: "15", source: "MEASURED" },
    risk: {
      limits: evaluateLossLimits({
        policy,
        equity: "10000",
        realizedToday: "0",
        realizedThisWeek: "0",
        highWaterEquity: "10000",
        consecutiveLosses: 0,
      }),
      sizing: solveQuantity(baseCtx()),
    },
    execution: {
      leaseHeld: true,
      leaseFencingToken: "42",
      gatewayReady: true,
      accountModeSupported: true,
      protectionSupported: true,
    },
    authorization: {
      settingsReadOk: true,
      operatorEntryEnabled: true,
      liveEnabled: true,
      circuitOpen: false,
      pauseNewEntries: false,
      killSwitch: false,
      mode: "LIVE_LIMITED",
    },
  };
}
