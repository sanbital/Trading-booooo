#!/usr/bin/env node
/**
 * Evaluate collected SHADOW trades against the section 8 promotion rule.
 *
 * Read-only. Prints the metrics, the day-block lower bound and the verdict, and
 * exits non-zero unless the verdict is PROMOTE -- so this cannot be wired into
 * anything that would treat "not enough data yet" as a green light.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   node scripts/boo/evaluate-shadow.mjs [--from 2026-09-16] [--json out.json]
 */

import { writeFileSync } from "node:fs";
import { evaluate } from "../../supabase/functions/_shared/boo/evaluation.mjs";

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_KEY;
const argv = process.argv.slice(2);
const val = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const FROM = val("--from");
const OUT = val("--json");

if (!URL_ || !KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(2);
}

const query = [
  "select=symbol,entry_at,exit_at,net_pnl,gross_pnl,fees,funding,r_multiple," +
  "strategy_exit_reason,execution_exit_route,strategy_version",
  "state=eq.CLOSED",
  FROM ? `exit_at=gte.${FROM}` : null,
  "order=exit_at.asc",
].filter(Boolean).join("&");

const res = await fetch(`${URL_}/rest/v1/boo_shadow_positions?${query}&limit=10000`, {
  headers: { apikey: KEY, authorization: `Bearer ${KEY}`, accept: "application/json" },
});
if (!res.ok) {
  console.error(`SELECT boo_shadow_positions -> HTTP ${res.status}`);
  process.exit(2);
}
const trades = await res.json();

const r = evaluate(trades);
console.log("BOO SHADOW evaluation");
console.log(`observed_at_utc : ${new Date().toISOString()}`);
console.log(`window          : ${FROM ? `exit_at >= ${FROM}` : "all collected"}`);
console.log(`strategy        : ${[...new Set(trades.map((t) => t.strategy_version))].join(", ") || "n/a"}`);
console.log("");
console.log(`trades             : ${r.trades}`);
console.log(`independent days   : ${r.independentPeriods}`);

if (r.metrics) {
  const m = r.metrics;
  const show = (k, v) => console.log(`${k.padEnd(19)}: ${v}`);
  show("win rate", `${(m.winRate * 100).toFixed(2)}% (${m.wins}W / ${m.losses}L)`);
  show("net total", m.netTotal);
  show("net per trade", m.netExpectancyPerTrade);
  show("avg win", m.avgWin);
  show("avg loss", m.avgLoss);
  show("profit factor", m.profitFactor ?? "n/a (no losses)");
  show("mean R", m.meanR ?? "n/a");
  show("max drawdown", m.maxDrawdown);
  show("worst day", `${m.worstDay} (${m.worstDayAt ?? "n/a"})`);
  show("worst loss streak", m.worstLosingStreak);
  show("gross / fees", `${m.grossTotal ?? "n/a"} / ${m.feeTotal ?? "n/a"}`);
  show("cost share", m.costShareOfGross ?? "n/a (gross unknown; never back-solved)");
  show("top symbol", m.topSymbol ? `${m.topSymbol.symbol} ${m.topSymbol.net}` : "n/a");
  show("profit concentration", m.profitConcentrationSymbol ?? "n/a");
  show("exit reasons", JSON.stringify(m.exitReasonMix));
  show("exit routes", JSON.stringify(m.executionRouteMix));
}

console.log("");
console.log(`day-block 95% lower bound : ${r.netExpectancyLowerBound ?? "n/a"}`);
console.log(`verdict                   : ${r.verdict}`);
console.log(`                            ${r.verdictDetail}`);

if (r.verdict === "INSUFFICIENT_SAMPLE") {
  console.log("");
  console.log("Insufficient sample is insufficient sample. It is not a pass, and a");
  console.log("strategy that took no trades has not demonstrated a loss-free improvement.");
}

if (OUT) {
  writeFileSync(OUT, JSON.stringify(r, null, 2));
  console.log(`\nwrote ${OUT}`);
}

process.exit(r.verdict === "PROMOTE" ? 0 : 1);
