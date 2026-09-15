// @ts-nocheck
/**
 * V24 REPLAY ENGINE -- research only. Never submits an order, never touches a live
 * trading table. It imports the SAME strategy core the executor would import, so a
 * replayed decision and a live decision cannot drift apart silently.
 *
 * Fidelity, stated up front and stamped on every row it writes:
 *   price / volume / rank ....... FULL      (closed 1m + 15m klines)
 *   aggressive buy share ........ PROXY_1M  (kline takerBuyQuote / quoteVolume)
 *   order book .................. ABSENT    (no historical depth exists to replay)
 *   funding ..................... MODELLED  (realised funding is not in the ledger)
 * Any result produced here is a price/tape-only validation. It is NOT a validation of
 * the book-dependent gates, which can only be tested forward on live-collected depth.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  V24_POLICY, V24_VERSION, MIN, M15, kstDayStart, closedBars, resample, atrWilder,
  emaSeries, rvol1, anchoredVwap, setupA, setupB, chaseGate, trendGate, leaderGate,
  structuralStop, sizePosition, profitLockFloor, trailLevel, netRealisable,
} from "./v24-leader-continuation.mjs";

const env = (n: string) => (Deno.env.get(n) || "").trim();
const res = (s: number, b: unknown) =>
  new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
const N = (v: unknown, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };

/** Cost model calibrated from THIS account's realised fills, not from a rate card:
 *  5.0 bps/side taker on 1417 fills, 0 maker fills, median entry spread 4.22 bps. */
const COST = Object.freeze({
  feeBpsPerSide: 5.0,
  entrySlipBps: 4.5,     // crossing the ask with an IOC limit
  exitSlipBps: 4.5,      // market / stop-market exit
  stopExtraSlipBps: 5.0, // a stop fires into a falling book
});

const ARMS = ["OLD_ENTRY_OLD_EXIT", "OLD_ENTRY_NEW_EXIT", "NEW_ENTRY_OLD_EXIT", "NEW_ENTRY_NEW_EXIT"];

/* -------------------------------------------------------------- old policy -- */
/** Production V17 + R5 as deployed (revision V11-LONG-REGIME-1.0.1, executor v44). */
const OLD = Object.freeze({
  rankLimit: 10, minDayReturn: 0.03, min30mReturn: 0.0075, min60mReturn: 0.015,
  minVolumeRatio: 1.1, minQuoteVolume24h: 5_000_000, min5mReturn: 0.002,
  stopPct: 0.025, trailArmPct: 0.03, trailGapPct: 0.015,
  riskCutArmPct: 0.01, riskCutLevelPct: 0.012, failCutAfterMs: 600_000,
  profitLockArmPct: 0.02, profitLockCapture: 0.50,
  staleMs: 45 * 60_000, maxHoldMs: 6 * 3_600_000,
});

/** V17 entry: top-10 by KST day return, then a closed-5m acceleration confirmation. */
function oldEntry(f: any) {
  if (!f.leader || f.leader.rank > OLD.rankLimit) return { enter: false, reason: "OUTSIDE_TOP10" };
  if (!(f.dayReturn >= OLD.minDayReturn)) return { enter: false, reason: "DAY_RETURN" };
  if (!(f.qv24 >= OLD.minQuoteVolume24h)) return { enter: false, reason: "LIQUIDITY" };
  if (!(f.return15m > 0) || !(f.return30m >= OLD.min30mReturn) || !(f.return60m >= OLD.min60mReturn))
    return { enter: false, reason: "MOMENTUM" };
  if (!(f.volumeRatio >= OLD.minVolumeRatio)) return { enter: false, reason: "VOLUME_ACCELERATION" };
  const b = f.last5m, prev = f.prev5m;
  if (!b || !prev) return { enter: false, reason: "NO_5M" };
  const r5 = b.c / prev.c - 1, r15 = f.r15_5m;
  if (r5 < OLD.min5mReturn || !(r15 > 0) || b.c < b.o) return { enter: false, reason: "NO_5M_ACCELERATION" };
  return { enter: true, reason: "V17_ELIGIBLE", referenceClose: b.c };
}

/** V17 + EXIT_REVIEW_R5 protection ladder, evaluated on a bid proxy. */
function oldExitLevel(pos: any, peak: number, heldMs: number) {
  const E = pos.entryPrice;
  const levels = [{ stage: "BASELINE", price: E * (1 - OLD.stopPct) }];
  const mfe = peak / E - 1;
  if (mfe >= OLD.trailArmPct) levels.push({ stage: "TRAIL", price: peak * (1 - OLD.trailGapPct) });
  if (mfe >= OLD.profitLockArmPct)
    levels.push({ stage: "PROFIT_LOCK", price: E + (peak - E) * OLD.profitLockCapture });
  if (mfe >= OLD.riskCutArmPct || heldMs >= OLD.failCutAfterMs)
    levels.push({ stage: "RISK_CUT", price: E * (1 - OLD.riskCutLevelPct) });
  let best = levels[0];
  for (const l of levels) if (l.price >= best.price) best = l;
  return best;
}

/* ------------------------------------------------------------ feature prep -- */

/** Aggressive-buy share for a closed 1m bar. UNKNOWN when the split is missing. */
function barBuyShare(b: any) {
  if (!(b?.qv > 0) || !Number.isFinite(b?.tbq)) return null;
  const s = b.tbq / b.qv;
  return s >= 0 && s <= 1 ? s : null;
}
/** Tape proxy over the last k closed 1m bars. Labelled PROXY_1M everywhere it is used. */
function tapeProxy(bars: any[], k: number) {
  const xs = bars.slice(-k);
  if (xs.length < k) return { known: false, reason: "PROXY_INSUFFICIENT" };
  let buy = 0, total = 0, n = 0;
  for (const b of xs) {
    const s = barBuyShare(b);
    if (s === null) return { known: false, reason: "PROXY_SPLIT_MISSING" };
    buy += b.qv * s; total += b.qv; n += 1;
  }
  if (!(total > 0)) return { known: false, reason: "PROXY_EMPTY" };
  const share = buy / total;
  return {
    known: true, buyShare: share, buyQuote: buy, sellQuote: total - buy,
    totalQuote: total, delta: 2 * buy - total, aggCount: n,
    sufficient: true, fidelity: "PROXY_1M",
  };
}

/* ----------------------------------------------------------------- replay -- */

async function replaySymbol(db: any, symbol: string, cfg: any) {
  const { data: k1raw } = await db.from("v24_k1").select("t,o,h,l,c,quote_vol,taker_buy_quote,close_ms")
    .eq("symbol", symbol).order("t").limit(60000);
  const { data: k15raw } = await db.from("v24_k15").select("t,o,h,l,c,quote_vol,close_ms")
    .eq("symbol", symbol).order("t").limit(6000);
  const { data: ranks } = await db.from("v24_rank_panel")
    .select("t,rank,day_return,qv24,rvol15,available_at").eq("symbol", symbol).lte("rank", 40).order("t");
  if (!k1raw?.length || !k15raw?.length || !ranks?.length) return { symbol, trades: [], skipped: "NO_DATA" };

  const k1 = k1raw.map((r: any) => ({ t: N(r.t), o: N(r.o), h: N(r.h), l: N(r.l), c: N(r.c),
    qv: N(r.quote_vol), tbq: N(r.taker_buy_quote), closeMs: N(r.close_ms) }));
  const k15 = k15raw.map((r: any) => ({ t: N(r.t), o: N(r.o), h: N(r.h), l: N(r.l), c: N(r.c),
    qv: N(r.quote_vol), closeMs: N(r.close_ms) }));
  const rankAt = new Map<number, any>();
  for (const r of ranks) rankAt.set(N(r.t), r);

  const byT = new Map<number, number>();
  k1.forEach((b, i) => byT.set(b.t, i));
  const out: any[] = [];

  for (const arm of cfg.arms) {
    const newEntry = arm.startsWith("NEW_ENTRY"), newExit = arm.endsWith("NEW_EXIT");
    let cooldownUntil = -Infinity, lastSetupId: string | null = null;

    for (let i = 60; i < k1.length - 2; i++) {
      const bar = k1[i], now = bar.closeMs + 1;          // first instant the bar is usable
      if (now < cfg.panelStart || now > cfg.panelEnd) continue;
      if (now < cooldownUntil) continue;

      // Leader state: the most recent 15m bar CLOSED before `now`.
      const lastT = Math.floor((now - 1) / M15) * M15 - M15;
      const rk = rankAt.get(lastT);
      if (!rk || N(rk.rank) > V24_POLICY.rankLimit) continue;
      if (N(rk.available_at) > now) continue;            // published after the decision: unusable

      const win1 = k1.slice(Math.max(0, i - 400), i + 1);
      const win15 = k15.filter((b) => b.closeMs < now).slice(-120);
      if (win15.length < 100) continue;

      const c1 = closedBars(win1, now, MIN);
      if (c1.length < 30) continue;
      const c3 = resample(c1, 3).filter((b) => b.closeMs < now);
      const c5 = resample(c1, 5).filter((b) => b.closeMs < now);
      if (c5.length < 25 || c3.length < 20) continue;

      const closes5 = c5.map((b) => b.c);
      const e9 = emaSeries(closes5, 9), e21 = emaSeries(closes5, 21);
      const e21_3 = emaSeries(c3.map((b) => b.c), 21);
      const atr3 = atrWilder(c3, 14);
      if (!atr3.known || e21.length < 4 || !e9.length) continue;

      const btc = cfg.btc5.filter((b: any) => b.closeMs < now).slice(-5);
      const r15 = c5.length >= 4 ? c5.at(-1)!.c / c5.at(-4)!.c - 1 : null;
      const btcR15 = btc.length >= 4 ? btc.at(-1).c / btc.at(-4).c - 1 : null;

      const f: any = {
        closed1m: c1, closed3m: c3, closed5m: c5, closed15m: win15,
        last5mClose: c5.at(-1)!.c, ema9_5m: e9.at(-1), ema21_5m: e21.at(-1),
        ema21_5m_prev3: e21.at(-4), ema21_3m_series: e21_3,
        atr14_3m: atr3.value, rvol1: (() => { const v = rvol1(c1); return v.known ? v.value : null; })(),
        rvol15: N(rk.rvol15, NaN), rs15: r15 !== null && btcR15 !== null ? r15 - btcR15 : null,
        return15m: r15,
      };

      let decision: any = null;
      if (newEntry) {
        const L = leaderGate({ dayReturn: N(rk.day_return), rank: N(rk.rank), quoteVolume24h: N(rk.qv24) });
        if (!L.pass) continue;
        const T = trendGate(f);
        if (!T.pass) continue;
        const a = setupA(f);
        // SETUP_B's dwell proof needs sub-minute data that no kline can supply, so on
        // this data it is UNAVAILABLE rather than assumed. Path A only, and the report
        // must say so instead of implying both paths were tested.
        if (!a.pass) continue;
        const price = c1.at(-1)!.c;
        if (!chaseGate(a, price, f.atr14_3m).pass) continue;
        const t60 = tapeProxy(c1, 1), t180 = tapeProxy(c1, 3);
        if (!t60.known || !t180.known) continue;
        if (!(t60.buyShare >= V24_POLICY.minBuyShare60s)) continue;
        if (!(t180.buyShare >= V24_POLICY.minBuyShare180s)) continue;
        const stop = structuralStop(a.setupLow, f.atr14_3m, cfg.tick[symbol] ?? price * 1e-4);
        if (!stop.known || !(stop.value < price)) continue;
        const setupId = `${symbol}:A:${a.triggerBarT}`;
        if (setupId === lastSetupId) continue;
        decision = { setupId, setupType: "A", triggerLevel: a.triggerLevel,
          setupLow: a.setupLow, stop: stop.value, price };
      } else {
        const c15c = win15;
        const o = oldEntry({
          leader: { rank: N(rk.rank) }, dayReturn: N(rk.day_return), qv24: N(rk.qv24),
          return15m: c15c.at(-1)!.c / c15c.at(-2)!.c - 1,
          return30m: c15c.at(-1)!.c / c15c.at(-3)!.c - 1,
          return60m: c15c.at(-1)!.c / c15c.at(-5)!.c - 1,
          volumeRatio: N(rk.rvol15, 0),
          last5m: c5.at(-1), prev5m: c5.at(-2), r15_5m: r15,
        });
        if (!o.enter) continue;
        const price = c1.at(-1)!.c;
        decision = { setupId: `${symbol}:V17:${bar.t}`, setupType: "V17",
          triggerLevel: price, setupLow: null, stop: price * (1 - OLD.stopPct), price };
      }
      if (!decision) continue;

      // ---- fill: the order goes out after the bar closes, so it fills on the NEXT bar's
      // open, paying the measured crossing cost. Never on the signal bar's own close.
      const fillBar = k1[i + 1];
      if (!fillBar) continue;
      const E = fillBar.o * (1 + COST.entrySlipBps / 10_000);
      if (!(E > 0)) continue;

      const notional = cfg.notional;
      let qty = notional / E;
      let stopPrice = decision.stop;
      if (newEntry) {
        const s = sizePosition({
          entryPrice: E, stopPrice, riskBudgetUsdt: cfg.riskBudget, maxNotionalUsdt: notional,
          leverage: cfg.leverage, availableMarginUsdt: notional / cfg.leverage,
          bidDepth25: Infinity, askDepth25: Infinity, qtyStep: 1e-9, minNotionalUsdt: 5,
          entryFeeRate: COST.feeBpsPerSide / 10_000, exitFeeRate: COST.feeBpsPerSide / 10_000,
        });
        if (!s.ok) continue;
        qty = s.quantity;
      }
      const R0 = qty * (E - stopPrice);
      if (!(R0 > 0)) continue;

      const entryFee = qty * E * (COST.feeBpsPerSide / 10_000);
      let peak = E, M = 0, floor = 0, exitPrice: number | null = null,
        exitReason = "", exitAt = 0, ambiguous = false, confirmedHL: number | null = null;
      const entryAt = fillBar.t;
      const maxHold = newExit ? OLD.maxHoldMs : OLD.maxHoldMs;

      for (let j = i + 1; j < k1.length; j++) {
        const b = k1[j], heldMs = b.closeMs + 1 - entryAt;
        // Intrabar stop first: a protective stop cannot wait for the close.
        if (b.l <= stopPrice) {
          // If the same bar also printed a new high, the true order is unknowable at 1m.
          if (b.h > peak * 1.0001) ambiguous = true;
          exitPrice = Math.min(stopPrice, b.o) * (1 - (COST.exitSlipBps + COST.stopExtraSlipBps) / 10_000);
          exitReason = newExit ? "V24_STRUCTURAL_STOP" : "V17_STOP_LADDER";
          exitAt = b.closeMs + 1; break;
        }
        peak = Math.max(peak, b.h);

        if (newExit) {
          const g = netRealisable({ entryPrice: E, remainingQty: qty,
            sellVwap: b.c * (1 - COST.exitSlipBps / 10_000), realisedGross: 0,
            feesPaid: entryFee, fundingCashflow: 0,
            exitFeeRate: COST.feeBpsPerSide / 10_000, latencyReserveBps: 0 });
          const gPeak = netRealisable({ entryPrice: E, remainingQty: qty,
            sellVwap: peak * (1 - COST.exitSlipBps / 10_000), realisedGross: 0,
            feesPaid: entryFee, fundingCashflow: 0,
            exitFeeRate: COST.feeBpsPerSide / 10_000, latencyReserveBps: 0 });
          // M is raised from the peak, but a floor armed by THIS bar's high must not be
          // applied to THIS bar's low -- that is the classic intrabar look-ahead. The
          // floor raised here only binds from the NEXT bar onward.
          const fl = profitLockFloor(M, R0, floor);
          if (g.known && fl.known && fl.value > 0 && g.value <= fl.value) {
            exitPrice = b.c * (1 - COST.exitSlipBps / 10_000);
            exitReason = "V24_PROFIT_LOCK"; exitAt = b.closeMs + 1; break;
          }
          if (gPeak.known) M = Math.max(M, gPeak.value);
          if (fl.known) floor = Math.max(floor, fl.value);

          // structural trail, ratcheting upward only
          const w3 = resample(k1.slice(Math.max(0, j - 60), j + 1), 3).filter((x) => x.closeMs < b.closeMs + 1);
          if (w3.length >= 3) {
            const lows = w3.slice(-3).map((x) => x.l);
            if (lows[1] < lows[2] && lows[0] < lows[1]) confirmedHL = lows[2];
          }
          const atrNow = atrWilder(resample(k1.slice(Math.max(0, j - 80), j + 1), 3)
            .filter((x) => x.closeMs < b.closeMs + 1), 14);
          if (atrNow.known) {
            const tr = trailLevel({ confirmedHigherLow: confirmedHL, peakPrice: peak,
              atr3m: atrNow.value, priorStop: stopPrice, tick: 0 });
            if (tr.known && tr.value > stopPrice && tr.value < b.c) stopPrice = tr.value;
          }
          // early failure / time stop, on the 1m proxy tape
          const cw = closedBars(k1.slice(Math.max(0, j - 30), j + 1), b.closeMs + 1, MIN);
          const t60 = tapeProxy(cw, 1), t180 = tapeProxy(cw, 3);
          if (heldMs <= V24_POLICY.failWindowMs && decision.triggerLevel &&
              b.c < decision.triggerLevel && t60.known && t60.buyShare < V24_POLICY.breakBuyShare60s &&
              t180.known && t180.buyShare < 0.50) {
            exitPrice = b.c * (1 - COST.exitSlipBps / 10_000);
            exitReason = "V24_ENTRY_FAILED_EARLY"; exitAt = b.closeMs + 1; break;
          }
          if (heldMs >= V24_POLICY.timeStopAfterMs && M < V24_POLICY.timeStopMaxR * R0 &&
              decision.triggerLevel && b.c <= decision.triggerLevel &&
              t180.known && t180.buyShare <= V24_POLICY.minBuyShare180s) {
            exitPrice = b.c * (1 - COST.exitSlipBps / 10_000);
            exitReason = "V24_TIME_STOP"; exitAt = b.closeMs + 1; break;
          }
          if (t60.known && t180.known && c3.length &&
              b.c < (confirmedHL ?? decision.setupLow ?? -Infinity) &&
              t60.buyShare < V24_POLICY.breakBuyShare60s) {
            exitPrice = b.c * (1 - COST.exitSlipBps / 10_000);
            exitReason = "V24_MOMENTUM_BREAK"; exitAt = b.closeMs + 1; break;
          }
        } else {
          const lvl = oldExitLevel({ entryPrice: E }, peak, heldMs);
          if (lvl.price > stopPrice) stopPrice = lvl.price;
          if (heldMs >= OLD.staleMs && peak <= E * 1.0001) {
            exitPrice = b.c * (1 - COST.exitSlipBps / 10_000);
            exitReason = "V17_MOMENTUM_STALE"; exitAt = b.closeMs + 1; break;
          }
        }
        if (heldMs >= maxHold) {
          exitPrice = b.c * (1 - COST.exitSlipBps / 10_000);
          exitReason = newExit ? "V24_MAX_HOLD" : "V17_MAX_HOLD"; exitAt = b.closeMs + 1; break;
        }
      }
      if (exitPrice === null) continue;   // still open at the window edge: not a completed trade

      const exitFee = qty * exitPrice * (COST.feeBpsPerSide / 10_000);
      const gross = qty * (exitPrice - E);
      const net = gross - entryFee - exitFee;
      out.push({
        arm, symbol, setup_id: decision.setupId, setup_type: decision.setupType,
        entry_at: entryAt, exit_at: exitAt, entry_price: E, exit_price: exitPrice,
        quantity: qty, initial_stop: decision.stop, r0_usdt: R0,
        gross_usdt: gross, fees_usdt: entryFee + exitFee, net_usdt: net,
        exit_reason: exitReason, peak_price: peak, mfe_usdt: qty * (peak - E),
        day_rank: N(rk.rank), day_return: N(rk.day_return),
        hold_ms: exitAt - entryAt, ambiguous_bar: ambiguous,
        fidelity: "PRICE_TAPE_ONLY_NO_BOOK",
      });
      lastSetupId = decision.setupId;
      cooldownUntil = exitAt + V24_POLICY.reentryCooldownMs;
      const k = byT.get(Math.floor((exitAt - 1) / MIN) * MIN);
      if (k !== undefined && k > i) i = k;
    }
  }
  return { symbol, trades: out };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return res(405, { ok: false, error: "POST_ONLY" });
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } });
  const tok = (req.headers.get("x-v24-token") || "").trim();
  const { data: t } = await db.from("edge_internal_tokens").select("token").eq("name", "v24-replay").maybeSingle();
  if (!tok || !t?.token || tok !== String(t.token)) return res(401, { ok: false, error: "UNAUTHORIZED" });

  const body = await req.json().catch(() => ({}));
  const symbols: string[] = Array.isArray(body.symbols) ? body.symbols : [];
  if (!symbols.length) return res(400, { ok: false, error: "NO_SYMBOLS" });

  const { data: cfgRow } = await db.from("v24_config").select("v").eq("k", "window").single();
  const { data: btcRaw } = await db.from("v24_k1").select("t,o,h,l,c,quote_vol,taker_buy_quote,close_ms")
    .eq("symbol", "BTCUSDT").order("t").limit(60000);
  const btc1 = (btcRaw || []).map((r: any) => ({ t: N(r.t), o: N(r.o), h: N(r.h), l: N(r.l),
    c: N(r.c), qv: N(r.quote_vol), tbq: N(r.taker_buy_quote), closeMs: N(r.close_ms) }));

  const cfg = {
    panelStart: N(cfgRow?.v?.panel_start_ms), panelEnd: N(cfgRow?.v?.panel_end_ms),
    arms: Array.isArray(body.arms) ? body.arms : ARMS,
    notional: N(body.notional, 120), leverage: N(body.leverage, 3),
    riskBudget: N(body.riskBudget, 3.0), tick: {},
    btc5: resample(btc1, 5),
  };

  let written = 0; const perSymbol: any[] = [];
  for (const s of symbols) {
    const r = await replaySymbol(db, s, cfg);
    if (r.trades?.length) {
      for (let k = 0; k < r.trades.length; k += 500) {
        const { error } = await db.from("v24_trades").insert(r.trades.slice(k, k + 500));
        if (error) return res(500, { ok: false, error: `INSERT:${error.message}`, symbol: s });
      }
      written += r.trades.length;
    }
    perSymbol.push({ symbol: s, trades: r.trades?.length ?? 0, skipped: r.skipped ?? null });
  }
  return res(200, { ok: true, version: V24_VERSION, written, perSymbol,
    fidelity: "PRICE_TAPE_ONLY_NO_BOOK", executionEnabled: false });
});
