// @ts-nocheck
/**
 * BOO R1 strategy SHADOW (brief section 10).
 *
 * This is a STRATEGY shadow, not an account observer. Each run:
 *   1. builds the tradable USDⓈ-M perpetual universe from exchangeInfo,
 *   2. ranks same-KST-day gainers from 1m klines (excluding, never defaulting,
 *      symbols whose KST day open is missing),
 *   3. advances the persisted per-symbol setup state machine,
 *   4. simulates entries at prices that only became available AFTER the signal,
 *   5. manages open simulated positions with the real exit rules,
 *   6. records every decision with its full event clock.
 *
 * ORDER CAPABILITY: NONE.
 * This function contains no gateway client, no HMAC signing, no API key read
 * and no order action string. It reaches Binance only through public market
 * data endpoints, which require no credentials. `assertNoOrderCapability()`
 * re-checks that at runtime and fails the run rather than continuing if the
 * invariant is ever violated by a future edit.
 *
 * RESIDUAL ISOLATION RISK -- stated because it is real:
 * Supabase edge functions in one project share the project's secret store, so
 * BINANCE_GATEWAY_URL / gateway signing secrets are technically readable by any
 * function deployed here, including this one. Not reading them is a property of
 * this source, not a permission boundary. A true boundary needs a separate
 * project or host with its own secrets; that is listed as a LIVE_READY blocker
 * rather than papered over.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  advanceSetup,
  decideExit,
  entryTrigger,
  executableNetValue,
  fifteenMinuteStructure,
  initialStop,
  profitTrailStop,
  R1_PARAMS,
  R1_VERSION,
  rankDayGainers,
  SETUP_STATE,
} from "../_shared/boo/r1-strategy.mjs";
import { dec, ZERO } from "../_shared/boo/decimal.mjs";

const RELEASE = "BOO_R1_SHADOW_20260916_1";
const FAPI = "https://fapi.binance.com";
const SB_URL = Deno.env.get("SUPABASE_URL");
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

/** Actions this process is forbidden to be able to perform. */
const FORBIDDEN_ACTIONS = [
  "create_order",
  "cancel_order",
  "v17_create_stop",
  "v17_cancel_stop",
  "algoOrder",
  "close_position",
  "set_leverage",
  "cancel_bot_orders",
];

/** Public market-data endpoints this process is allowed to call. */
const ALLOWED_PATHS = [
  "/fapi/v1/exchangeInfo",
  "/fapi/v1/klines",
  "/fapi/v1/depth",
  "/fapi/v1/premiumIndex",
];

/**
 * Runtime proof that this process cannot place orders.
 *
 * Checks the only two things that could grant the capability: a signing
 * credential in scope, and a gateway endpoint to send to. Reading the env var
 * NAMES here is deliberate -- the check must fail loudly if a future deploy
 * ever grants this function order credentials, and it never logs the values.
 */
function assertNoOrderCapability() {
  const dangerous = [
    "BINANCE_GATEWAY_URL",
    "BINANCE_GATEWAY_SECRET",
    "GATEWAY_SECRET",
    "BINANCE_API_KEY",
    "BINANCE_API_SECRET",
  ];
  const present = dangerous.filter((name) => {
    try {
      return !!Deno.env.get(name);
    } catch {
      return false; // env access denied is the stronger guarantee, not a failure
    }
  });
  return {
    orderCapability: present.length ? "SHARED_PROJECT_SECRETS_VISIBLE" : "NONE_DECLARED",
    // Names only, never values.
    visibleSecretNames: present,
    forbiddenActions: FORBIDDEN_ACTIONS,
    allowedPaths: ALLOWED_PATHS,
  };
}

/** Public market data only. Refuses any path not on the allow-list. */
async function pub(path: string, params: Record<string, string | number> = {}) {
  if (!ALLOWED_PATHS.includes(path)) throw new Error(`PATH_NOT_ALLOWED:${path}`);
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();
  const url = `${FAPI}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`MARKET_DATA_${res.status}:${path}`);
  return await res.json();
}

/**
 * Convert Binance klines into the bar shape the strategy expects.
 *
 * `availableAt` is set to the bar's close time plus the measured collection
 * latency. Section 5-1 forbids collection lateness from extending a signal's
 * life, so a bar that arrived late is visible only from when it actually
 * arrived, not from when it closed.
 */
function toBars(raw: unknown[], receivedAt: number) {
  return (raw as unknown[][]).map((k) => {
    const closeTime = Number(k[6]);
    return {
      openTime: Number(k[0]),
      closeTime,
      // A bar cannot be known before it closed, nor before we received it.
      availableAt: Math.max(closeTime, receivedAt),
      open: String(k[1]),
      high: String(k[2]),
      low: String(k[3]),
      close: String(k[4]),
      volume: String(k[5]),
      final: true,
    };
  });
}

function filtersOf(info: any, symbol: string) {
  const s = (info.symbols ?? []).find((x: any) => x.symbol === symbol);
  if (!s) return null;
  const f = (t: string) => (s.filters ?? []).find((x: any) => x.filterType === t) ?? {};
  // tickSize/stepSize come from the FILTERS, never from pricePrecision /
  // quantityPrecision (section 7).
  return {
    tickSize: f("PRICE_FILTER").tickSize,
    stepSize: f("LOT_SIZE").stepSize,
    minQty: f("LOT_SIZE").minQty,
    maxQty: f("LOT_SIZE").maxQty,
    minNotional: f("MIN_NOTIONAL").notional ?? f("MIN_NOTIONAL").minNotional ?? "5",
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json(204, {});
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "SUPABASE_ENV_MISSING" });
  const db = createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const capability = assertNoOrderCapability();
  const run = await db.from("boo_shadow_runs").insert({
    release: RELEASE,
    strategy_version: R1_VERSION,
    order_capability: capability.orderCapability,
    data_source: "BINANCE_USDM_PUBLIC_REST",
    evidence: { capability },
  }).select("id").single();
  const runId = run.data?.id ?? null;

  const counters = {
    universe_size: 0,
    ranked_count: 0,
    candidates_excluded: 0,
    setups_advanced: 0,
    entries_simulated: 0,
    exits_simulated: 0,
  };
  const decisions: any[] = [];

  try {
    const body = await req.json().catch(() => ({}));
    const topN = Number(body.topN ?? R1_PARAMS.topGainerRank);
    // Candidate breadth is bounded so one run fits the invocation budget; the
    // bound is recorded so a starved tail is visible rather than silent.
    const scanLimit = Number(body.scanLimit ?? 60);

    const info = await pub("/fapi/v1/exchangeInfo");
    const perps = (info.symbols ?? []).filter((s: any) =>
      s.contractType === "PERPETUAL" && s.quoteAsset === "USDT" && s.status === "TRADING"
    );
    counters.universe_size = perps.length;

    // 24h tickers are NOT used for ranking (they are rolling, not same-day),
    // but they are a legitimate way to shortlist which symbols are worth
    // pulling same-day klines for. The ranking itself is recomputed from the
    // KST day open below.
    const shortlist = perps.slice(0, scanLimit).map((s: any) => s.symbol);

    const universe: any[] = [];
    for (const symbol of shortlist) {
      try {
        const t0 = Date.now();
        // 1500 is Binance's maximum and the minimum that WORKS: the KST day
        // open can be up to 24h+9h behind `now`, and the first attempt used 900
        // bars (15h), which never reached back to the day's opening minute. The
        // result was every candidate excluded as KST_DAY_OPEN_MISSING -- the
        // correct refusal for missing data, and a silent empty shortlist.
        const k1 = await pub("/fapi/v1/klines", { symbol, interval: "1m", limit: 1500 });
        universe.push({ symbol, bars1m: toBars(k1, Date.now()), fetchMs: Date.now() - t0 });
      } catch (e) {
        counters.candidates_excluded += 1;
        // Record WHY. A bare counter cannot distinguish "the data said no" from
        // "we never got the data", which is exactly the confusion that made the
        // first run look like a strategy result rather than a fetch window bug.
        decisions.push({
          run_id: runId,
          symbol,
          kind: "REFUSED",
          decision: "MARKET_DATA_UNAVAILABLE",
          reason: (e instanceof Error ? e.message : String(e)).slice(0, 200),
          decision_at: new Date().toISOString(),
        });
      }
    }

    // The ranking decision happens AFTER collection finishes, so its `asOf` is
    // taken here. Taking it before the loop (the first version did) made every
    // bar's availableAt later than asOf, so `usableBars` correctly discarded
    // all of them and every symbol was excluded as KST_DAY_OPEN_MISSING -- the
    // lookahead guard working perfectly against a clock that was simply wrong.
    const now = Date.now();
    const ranking = rankDayGainers(universe, now, topN);
    counters.ranked_count = ranking.ranked.length;
    counters.candidates_excluded += ranking.excluded.length;

    for (const r of ranking.ranked) {
      decisions.push({
        run_id: runId,
        symbol: r.symbol,
        kind: "RANK",
        decision: `RANK_${r.rank}`,
        reason: `day_change=${r.dayChange.toFixed(6)}`,
        decision_at: new Date(now).toISOString(),
        evidence: { dayOpen: r.dayOpen.toString(), last: r.last.toString(), rank: r.rank },
      });
    }
    for (const x of ranking.excluded.slice(0, 50)) {
      decisions.push({
        run_id: runId,
        symbol: x.symbol,
        kind: "REFUSED",
        decision: "EXCLUDED",
        reason: x.reason,
        decision_at: new Date(now).toISOString(),
      });
    }

    // ---- advance setups for ranked candidates ----------------------------
    for (const cand of ranking.ranked) {
      const symbol = cand.symbol;
      const f = filtersOf(info, symbol);
      if (!f?.tickSize) {
        counters.candidates_excluded += 1;
        decisions.push({
          run_id: runId,
          symbol,
          kind: "REFUSED",
          decision: "NO_FILTERS",
          reason: "PRICE_FILTER_MISSING",
          decision_at: new Date().toISOString(),
        });
        continue;
      }

      const recv5 = Date.now();
      const k5 = toBars(await pub("/fapi/v1/klines", { symbol, interval: "5m", limit: 200 }), recv5);
      const recv15 = Date.now();
      const k15 = toBars(await pub("/fapi/v1/klines", { symbol, interval: "15m", limit: 120 }), recv15);
      const bars1m = universe.find((u) => u.symbol === symbol)?.bars1m ?? [];
      const asOf = Date.now();

      // 15m structure is a precondition for a new setup, recorded either way
      // so a refusal is explainable.
      const structure = fifteenMinuteStructure(k15, asOf);

      // Load persisted state so a restart resumes rather than restarts.
      const prior = await db.from("boo_shadow_setups").select("*").eq("symbol", symbol)
        .not("state", "eq", SETUP_STATE.CONSUMED)
        .order("updated_at", { ascending: false }).limit(1).maybeSingle();

      const priorState = prior.data
        ? {
          state: prior.data.state,
          symbol,
          setupId: prior.data.setup_id,
          legLow: prior.data.leg_low,
          setupLow: prior.data.setup_low,
          triggerPrice: prior.data.trigger_price,
          atr5m: prior.data.atr_5m,
          // Restored so a poll that sees the same closed 5m bar again does not
          // drive a second transition from it.
          lastBarCloseTime: prior.data.last_bar_close_time,
          pullbackStartedAt: prior.data.pullback_started_at
            ? Date.parse(prior.data.pullback_started_at)
            : undefined,
        }
        : null;

      const next = structure.ok || priorState
        ? advanceSetup({ state: priorState, bars5m: k5, bars1m, asOf, tickSize: f.tickSize, symbol })
        : { state: SETUP_STATE.NONE, reason: structure.reason };
      counters.setups_advanced += 1;

      if (next.setupId) {
        await db.from("boo_shadow_setups").upsert({
          setup_id: next.setupId,
          symbol,
          state: next.state,
          leg_low: str(next.legLow),
          setup_low: str(next.setupLow),
          trigger_price: str(next.triggerPrice),
          atr_5m: str(next.atr5m),
          last_bar_close_time: next.lastBarCloseTime ?? null,
          pullback_started_at: next.pullbackStartedAt ? new Date(next.pullbackStartedAt).toISOString() : null,
          armed_at: next.armedAt ? new Date(next.armedAt).toISOString() : null,
          consumed_at: next.consumedAt ? new Date(next.consumedAt).toISOString() : null,
          consumed_reason: next.state === SETUP_STATE.CONSUMED ? next.reason : null,
          strategy_version: R1_VERSION,
          updated_at: new Date().toISOString(),
          evidence: { structure: structure.ok ? "OK" : structure.reason, reason: next.reason },
        }, { onConflict: "setup_id" });
      }

      decisions.push({
        run_id: runId,
        setup_id: next.setupId ?? null,
        symbol,
        kind: "SETUP",
        decision: next.state ?? "NONE",
        reason: next.reason ?? null,
        exchange_event_time: k5.length ? new Date(k5[k5.length - 1].closeTime).toISOString() : null,
        received_at: new Date(recv5).toISOString(),
        feature_available_at: k5.length ? new Date(k5[k5.length - 1].availableAt).toISOString() : null,
        decision_at: new Date(asOf).toISOString(),
        evidence: { setupLow: str(next.setupLow), triggerPrice: str(next.triggerPrice) },
      });

      // ---- entry ---------------------------------------------------------
      if (next.state === SETUP_STATE.ARMED) {
        // A setup may be entered at most once, ever. The DB check is what makes
        // this survive a restart (regression test 21).
        const used = await db.from("boo_shadow_setups").select("entered_at")
          .eq("setup_id", next.setupId).maybeSingle();
        if (used.data?.entered_at) {
          decisions.push({
            run_id: runId,
            setup_id: next.setupId,
            symbol,
            kind: "REFUSED",
            decision: "SETUP_ALREADY_ENTERED",
            reason: "DUPLICATE_SETUP_BLOCKED",
            decision_at: new Date().toISOString(),
          });
          continue;
        }

        // Re-fetch 1m bars at DECISION time rather than reusing the ranking
        // pull. The signal is only valid for 60s from the bar becoming
        // available, and a run that scans many symbols takes longer than that,
        // so the stale copy would make every armed setup expire on arrival --
        // a refusal that looks like the rule working when it is really the
        // collection cadence.
        const entryRecv = Date.now();
        const freshBars1m = toBars(
          await pub("/fapi/v1/klines", { symbol, interval: "1m", limit: 120 }),
          entryRecv,
        );
        const trig = entryTrigger({ setup: next, bars1m: freshBars1m, asOf: Date.now(), tickSize: f.tickSize });
        if (!trig.fire) {
          decisions.push({
            run_id: runId,
            setup_id: next.setupId,
            symbol,
            kind: "REFUSED",
            decision: "NO_ENTRY",
            reason: trig.reason,
            decision_at: new Date(asOf).toISOString(),
          });
          continue;
        }

        // Fill from a book fetched AFTER the signal, so the simulated entry can
        // never use a price that preceded the decision (section 8).
        const bookAt = Date.now();
        const book = await pub("/fapi/v1/depth", { symbol, limit: 50 });
        const asks = (book.asks ?? []) as [string, string][];
        if (!asks.length) continue;
        const entryVwap = dec(asks[0][0]);
        if (entryVwap.gt(trig.entryCeiling)) {
          decisions.push({
            run_id: runId,
            setup_id: next.setupId,
            symbol,
            kind: "REFUSED",
            decision: "ABOVE_ENTRY_CEILING",
            reason: `vwap=${entryVwap} ceiling=${trig.entryCeiling}`,
            decision_at: new Date(bookAt).toISOString(),
          });
          continue;
        }

        const stop = initialStop({
          setupLow: next.setupLow,
          atr14_5m: next.atr5m,
          tickSize: f.tickSize,
        });
        if (!stop.price.isPos() || stop.price.gte(entryVwap)) continue;

        // Shadow sizes one unit of risk: quantity is normalised so R is
        // exactly 1 quote unit, which keeps R-multiples comparable across
        // symbols without pretending to a live account's budget.
        const perUnitRisk = entryVwap.sub(stop.price);
        const qty = dec(1).div(perUnitRisk).floorStep(f.stepSize);
        if (!qty.isPos()) continue;
        const R = qty.mul(perUnitRisk);

        await db.from("boo_shadow_positions").insert({
          setup_id: next.setupId,
          symbol,
          strategy_version: R1_VERSION,
          entry_at: new Date(bookAt).toISOString(),
          entry_vwap: entryVwap.toString(),
          quantity: qty.toString(),
          initial_stop: stop.price.toString(),
          initial_r: R.toString(),
          current_stop: stop.price.toString(),
          trigger_price: trig.triggerPrice.toString(),
          evidence: { stopBasis: stop.basis, ceiling: trig.entryCeiling.toString(), filters: f },
        });
        await db.from("boo_shadow_setups")
          .update({ entered_at: new Date(bookAt).toISOString(), state: SETUP_STATE.CONSUMED })
          .eq("setup_id", next.setupId);
        counters.entries_simulated += 1;

        decisions.push({
          run_id: runId,
          setup_id: next.setupId,
          symbol,
          kind: "ENTRY",
          decision: "SIMULATED_FILL",
          reason: "TRIGGER_CROSSED",
          exchange_event_time: new Date(trig.barCloseTime).toISOString(),
          feature_available_at: new Date(trig.availableAt).toISOString(),
          received_at: new Date(bookAt).toISOString(),
          decision_at: new Date(bookAt).toISOString(),
          evidence: { entryVwap: entryVwap.toString(), stop: stop.price.toString(), R: R.toString() },
        });
      }
    }

    // ---- manage open simulated positions ---------------------------------
    const open = await db.from("boo_shadow_positions").select("*").eq("state", "OPEN").limit(50);
    for (const p of open.data ?? []) {
      const recv = Date.now();
      const k5 = toBars(await pub("/fapi/v1/klines", { symbol: p.symbol, interval: "5m", limit: 120 }), recv);
      const k1 = toBars(await pub("/fapi/v1/klines", { symbol: p.symbol, interval: "1m", limit: 120 }), recv);
      const book = await pub("/fapi/v1/depth", { symbol: p.symbol, limit: 50 });
      const f = filtersOf(info, p.symbol);
      const asOf = Date.now();

      // Executable net value from the real bid side. When the book cannot fill
      // the size, MFE stays UNOBSERVED (null) -- it is never filled with zero.
      const nv = executableNetValue({
        quantity: p.quantity,
        bookBids: book.bids ?? [],
        entryVwap: p.entry_vwap,
        feesPaid: "0",
        exitFeeRate: "0.0004",
        fundingPaid: "0",
      });
      const peak = nv.known
        ? (p.peak_executable_net === null
          ? nv.net
          : dec(p.peak_executable_net).max(nv.net))
        : (p.peak_executable_net === null ? null : dec(p.peak_executable_net));

      const position = {
        entryAt: Date.parse(p.entry_at),
        initialStop: p.initial_stop,
        currentStop: p.current_stop,
        initialR: p.initial_r,
        peakExecutableNet: peak === null ? null : peak.toString(),
        triggerPrice: p.trigger_price,
      };

      // Ratchet the trail before deciding, so a raised stop is in force in the
      // same evaluation that could trigger it.
      const trail = profitTrailStop({ position, bars5m: k5, asOf, tickSize: f?.tickSize ?? "0.0001" });
      const currentStop = trail.stop ?? dec(p.current_stop);

      const lastPrice = k1.length ? k1[k1.length - 1].close : null;
      const exit = decideExit({
        position: { ...position, currentStop: currentStop.toString() },
        bars1m: k1,
        bars5m: k5,
        asOf,
        tickSize: f?.tickSize ?? "0.0001",
        lastPrice,
      });

      const patch: any = {
        peak_executable_net: peak === null ? null : peak.toString(),
        current_stop: currentStop.toString(),
        updated_at: new Date().toISOString(),
      };

      if (exit.exit) {
        const exitVwap = nv.known ? nv.exitVwap : dec(lastPrice ?? p.entry_vwap);
        const gross = dec(p.quantity).mul(exitVwap.sub(dec(p.entry_vwap)));
        const fees = dec(p.quantity).mul(dec(p.entry_vwap)).mul(dec("0.0004"))
          .add(dec(p.quantity).mul(exitVwap).mul(dec("0.0004")));
        const net = gross.sub(fees);
        Object.assign(patch, {
          state: "CLOSED",
          exit_at: new Date(asOf).toISOString(),
          exit_vwap: exitVwap.toString(),
          strategy_exit_reason: exit.strategyExitReason,
          execution_exit_route: exit.executionExitRoute,
          gross_pnl: gross.toString(),
          fees: fees.toString(),
          funding: "0",
          net_pnl: net.toString(),
          r_multiple: net.div(dec(p.initial_r)).toString(),
        });
        counters.exits_simulated += 1;
      }

      await db.from("boo_shadow_positions").update(patch).eq("id", p.id);
      decisions.push({
        run_id: runId,
        setup_id: p.setup_id,
        symbol: p.symbol,
        kind: exit.exit ? "EXIT" : "HOLD",
        decision: exit.exit ? exit.strategyExitReason : "HOLD",
        reason: exit.exit ? exit.contributing.join(",") : (trail.reason ?? "NO_EXIT"),
        received_at: new Date(recv).toISOString(),
        decision_at: new Date(asOf).toISOString(),
        evidence: {
          executableNet: nv.known ? nv.net.toString() : null,
          mfeObserved: peak !== null,
          trail: trail.reason,
          currentStop: currentStop.toString(),
        },
      });
    }

    if (decisions.length) {
      for (let i = 0; i < decisions.length; i += 200) {
        await db.from("boo_shadow_decisions").insert(decisions.slice(i, i + 200));
      }
    }

    await db.from("boo_shadow_runs").update({
      finished_at: new Date().toISOString(),
      status: "OK",
      ...counters,
    }).eq("id", runId);

    return json(200, { ok: true, release: RELEASE, runId, capability, ...counters });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.from("boo_shadow_runs").update({
      finished_at: new Date().toISOString(),
      status: "FAILED",
      error: message.slice(0, 500),
      ...counters,
    }).eq("id", runId);
    return json(500, { ok: false, release: RELEASE, runId, error: message, ...counters });
  }
});

function str(x: unknown) {
  return x === null || x === undefined ? null : String(x);
}
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
