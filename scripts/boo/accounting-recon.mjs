#!/usr/bin/env node
/**
 * Accounting reconciliation for the audited window (brief section 3).
 *
 * Reproduces the prior audit from primary data, then localises every residual
 * instead of absorbing it.  Read-only: it issues SELECTs through PostgREST and
 * writes nothing.
 *
 * Usage:
 *   SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=<key> \
 *   node scripts/boo/accounting-recon.mjs \
 *     --from 2026-09-12T15:00:00Z --to 2026-09-16T11:00:00Z [--json out.json]
 *
 * The credentials are read from the environment and never logged, echoed or
 * written to the output file.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dec, sum, ZERO } from "../../supabase/functions/_shared/boo/decimal.mjs";
import {
  dedupeFills,
  MONEY_TOLERANCE_PER_POSITION,
  reconcilePosition,
  summarize,
} from "../../supabase/functions/_shared/boo/reconcile.mjs";

const args = parseArgs(process.argv.slice(2));
const FROM = args.from ?? "2026-09-12T15:00:00Z";
const TO = args.to ?? "2026-09-16T11:00:00Z";
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_KEY;

if (!URL || !KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.");
  process.exit(2);
}

/** PostgREST GET with cursor paging; PostgREST caps a page at db-max-rows. */
async function select(table, query, { pageSize = 1000 } = {}) {
  const rows = [];
  for (let offset = 0;; offset += pageSize) {
    const url = `${URL}/rest/v1/${table}?${query}&limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, {
      headers: {
        apikey: KEY,
        authorization: `Bearer ${KEY}`,
        accept: "application/json",
      },
    });
    if (!res.ok) {
      // The body may echo the query but never the key; still, only the status
      // and the table name are surfaced.
      throw new Error(`SELECT_FAILED ${table} HTTP ${res.status}`);
    }
    const page = await res.json();
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") ? true : argv[++i];
  }
  return out;
}

async function main() {
  const observedAt = new Date().toISOString();
  console.log(`# boo accounting reconciliation`);
  console.log(`observed_at_utc : ${observedAt}`);
  console.log(`window          : entry_at >= ${FROM}, closed_at < ${TO}, state = CLOSED`);
  console.log(`tolerance       : ${MONEY_TOLERANCE_PER_POSITION} USDT per position (absolute)`);
  console.log(`source          : public.v11_long_regime_positions + public.exchange_trade_fills`);
  console.log("");

  const positions = await select(
    "v11_long_regime_positions",
    [
      "select=id,symbol,state,entry_at,closed_at,exit_reason,original_quantity,remaining_quantity," +
      "realized_pnl_usdt,entry_fee_usdt",
      `state=eq.CLOSED`,
      `entry_at=gte.${FROM}`,
      `closed_at=lt.${TO}`,
      "order=closed_at.asc",
    ].join("&"),
  );

  // Fills are fetched by position link. Both link columns are used because the
  // ledger historically populated one or the other.
  const ids = positions.map((p) => p.id);
  const fills = [];
  for (const chunk of chunked(ids, 50)) {
    const inList = `(${chunk.join(",")})`;
    for (const col of ["v17_position_id", "position_id"]) {
      fills.push(
        ...await select(
          "exchange_trade_fills",
          `select=*&${col}=in.${inList}`,
        ),
      );
    }
  }

  const { fills: unique, conflicts, deduped } = dedupeFills(fills);
  console.log(`positions       : ${positions.length}`);
  console.log(`fill rows read  : ${fills.length}`);
  console.log(`unique fills    : ${unique.length} (deduped ${deduped})`);
  console.log(`content conflicts: ${conflicts.length}`);
  console.log("");

  const byPosition = new Map();
  for (const f of unique) {
    const key = f.v17_position_id ?? f.position_id;
    if (!key) continue;
    if (!byPosition.has(key)) byPosition.set(key, []);
    byPosition.get(key).push(f);
  }

  const results = positions.map((p) =>
    reconcilePosition({
      position: p,
      fills: byPosition.get(p.id) ?? [],
      // Exchange exposure is NOT asserted here: this script has no authenticated
      // exchange access. Every position is therefore reported with
      // EXCHANGE_EXPOSURE_UNVERIFIED, which is the honest state -- see
      // --exposure-file to supply an operator-captured snapshot.
      exchangeExposure: loadExposure(args["exposure-file"], p.symbol),
    })
  );

  const roll = summarize(results);

  // Headline figures, reproducing the prior audit's shape.
  const wins = positions.filter((p) => dec(p.realized_pnl_usdt ?? 0).isPos()).length;
  const losses = positions.length - wins;
  const fillRealized = sum(unique.map((f) => f.realized_pnl_quote ?? 0));
  const fillFees = sum(unique.map((f) => f.fee_quote_amount ?? 0));

  console.log("## headline");
  console.log(`closed positions        : ${positions.length} (win ${wins} / loss ${losses})`);
  console.log(`position settled pnl    : ${roll.storedPnlTotal}`);
  console.log(`linked fills            : ${unique.length}`);
  console.log(`fill realized pnl       : ${fillRealized}`);
  console.log(`fill fees               : ${fillFees}`);
  console.log(`fill net (realized-fee) : ${fillRealized.sub(fillFees)}`);
  console.log(`position - fill net     : ${roll.storedPnlTotal.sub(fillRealized.sub(fillFees))}`);
  console.log("");

  // Residual decomposition: the point of the exercise.
  const missing = results.filter((r) =>
    r.findings.some((f) => f.code === "EXIT_FILLS_MISSING" || f.code === "NO_FILLS_LINKED")
  );
  const missingResidual = sum(missing.map((r) => r.residualMoney ?? ZERO));
  const others = results.filter((r) => !missing.includes(r));
  const otherResidual = sum(others.map((r) => r.residualMoney ?? ZERO));
  let maxOther = ZERO;
  for (const r of others) {
    const a = (r.residualMoney ?? ZERO).abs();
    if (a.gt(maxOther)) maxOther = a;
  }

  console.log("## residual decomposition");
  console.log(`positions with missing fills : ${missing.length}`);
  for (const r of missing) {
    console.log(
      `  ${r.symbol.padEnd(14)} residual=${r.residualMoney} ` +
        `bought=${r.boughtQty} sold=${r.soldQty} fills=${r.fillCount} ` +
        `[${r.findings.map((f) => f.code).join(",")}]`,
    );
  }
  console.log(`  subtotal                   : ${missingResidual}`);
  console.log(`remaining positions          : ${others.length}`);
  console.log(`  subtotal                   : ${otherResidual}`);
  console.log(`  largest single residual    : ${maxOther}`);
  console.log(
    `  verdict                    : ${
      maxOther.lte(dec(MONEY_TOLERANCE_PER_POSITION))
        ? "within declared tolerance"
        : "ABOVE declared tolerance -- reported, not absorbed"
    }`,
  );
  console.log("");

  console.log("## verdict");
  console.log(`confirmed CLOSED : ${roll.confirmed}/${roll.positions}`);
  console.log(`unresolved       : ${roll.unresolved}`);
  console.log(`accounting_reconciled = ${roll.reconciled}`);
  if (!roll.reconciled) {
    console.log("");
    console.log("Unresolved items cannot be settled from the database: the individual");
    console.log("exit fills were never ingested, so no derived ledger can recover them.");
    console.log("Recovery requires re-fetching GET /fapi/v1/userTrades for the affected");
    console.log("symbol/time ranges through the authenticated gateway.");
  }

  if (args.json) {
    writeFileSync(
      args.json,
      JSON.stringify(
        {
          observedAt,
          window: { from: FROM, to: TO },
          tolerance: MONEY_TOLERANCE_PER_POSITION,
          headline: {
            positions: positions.length,
            wins,
            losses,
            positionPnl: roll.storedPnlTotal.toString(),
            fills: unique.length,
            fillRealized: fillRealized.toString(),
            fillFees: fillFees.toString(),
            fillNet: fillRealized.sub(fillFees).toString(),
            gap: roll.storedPnlTotal.sub(fillRealized.sub(fillFees)).toString(),
          },
          decomposition: {
            missingFillPositions: missing.map((r) => ({
              symbol: r.symbol,
              positionId: r.positionId,
              residual: r.residualMoney?.toString() ?? null,
              findings: r.findings,
            })),
            missingSubtotal: missingResidual.toString(),
            otherSubtotal: otherResidual.toString(),
            largestOtherResidual: maxOther.toString(),
          },
          conflicts,
          reconciled: roll.reconciled,
          unresolved: roll.unresolvedDetail,
        },
        null,
        2,
      ),
    );
    console.log(`\nwrote ${args.json}`);
  }

  // Non-zero exit when the ledger is not reconciled, so CI cannot report a
  // green run over an unreconciled ledger.
  process.exit(roll.reconciled ? 0 : 1);
}

function chunked(xs, n) {
  const out = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * Optional operator-captured exchange exposure, so the script can reach a
 * CLOSED_CONFIRMED verdict when someone with authenticated access supplies one.
 * Without it, exposure is reported as unverified rather than assumed flat.
 */
function loadExposure(path, symbol) {
  if (!path) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const row = (raw.positions ?? []).find((p) => String(p.symbol ?? p.market) === symbol);
    return row ? { quantity: row.quantity ?? row.positionAmt ?? 0 } : { quantity: "0" };
  } catch {
    return undefined;
  }
}

main().catch((e) => {
  console.error(`FAILED: ${e.message}`);
  process.exit(2);
});
