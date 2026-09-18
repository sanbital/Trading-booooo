import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Deploy guard for the 2026-07-26 migration failure.
 *
 *   ERROR: column "scalp_resting_tp" does not exist (SQLSTATE 42703)
 *
 * scalp_resting_tp was added in v5.3 as an env/default SETTING and no column was ever
 * created for it. Nothing broke while the code only READ it — a missing column silently
 * falls back to the default — so the gap stayed invisible until v5.5's migration wrote to
 * it, at which point the whole deploy failed after the type checks and tests had passed.
 *
 * These tests read the repository directly, so they catch the class of bug rather than the
 * one instance: any settings column written or constrained in SQL must be created first,
 * and any setting the engine reads must exist as a column so the dashboard can change it.
 */

const ROOT = new URL("../../../../", import.meta.url); // repo root
const MIGRATIONS = new URL("supabase/migrations/", ROOT);
const AUTOTRADER = new URL("supabase/functions/market-autotrader/index.ts", ROOT);

async function migrationFiles(): Promise<Array<{ name: string; sql: string }>> {
  const out: Array<{ name: string; sql: string }> = [];
  for await (const entry of Deno.readDir(MIGRATIONS)) {
    if (entry.isFile && entry.name.endsWith(".sql")) {
      out.push({ name: entry.name, sql: await Deno.readTextFile(new URL(entry.name, MIGRATIONS)) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Columns created by `add column if not exists`, mapped to the migration that creates them. */
function createdColumns(files: Array<{ name: string; sql: string }>): Map<string, string> {
  const created = new Map<string, string>();
  for (const { name, sql } of files) {
    for (const m of sql.matchAll(/add column if not exists\s+([a-z_]+)/gi)) {
      if (!created.has(m[1])) created.set(m[1], name);
    }
  }
  return created;
}

Deno.test("every scalp and LOB settings column written in SQL is created first", async () => {
  const files = await migrationFiles();
  const created = createdColumns(files);
  const violations: string[] = [];

  for (const { name, sql } of files) {
    const referenced = new Set<string>();
    // UPDATE ... SET <col> =
    for (const m of sql.matchAll(/^\s*(?:set|,)\s+((?:scalp|lob)_[a-z_]+)\s*=/gim)) referenced.add(m[1]);
    // WHERE / CHECK / COALESCE against a settings column
    for (const m of sql.matchAll(/coalesce\(\s*((?:scalp|lob)_[a-z_]+)/gi)) referenced.add(m[1]);
    for (const m of sql.matchAll(/check\s*\(\s*((?:scalp|lob)_[a-z_]+)/gi)) referenced.add(m[1]);

    for (const column of referenced) {
      const source = created.get(column);
      if (!source) violations.push(`${name}: ${column} is never created by any migration`);
      else if (source > name) violations.push(`${name}: ${column} is created later, in ${source}`);
    }
  }
  assertEquals(violations, [], `migration ordering violations:\n  ${violations.join("\n  ")}`);
});

Deno.test("every scalp and LOB setting the engine reads exists as a column", async () => {
  const code = await Deno.readTextFile(AUTOTRADER);
  const read = new Set<string>([
    ...[...code.matchAll(/\(settings as any\)\.((?:scalp|lob)_[a-z_]+)/g)].map((m) => m[1]),
    ...[...code.matchAll(/settings\.((?:scalp|lob)_[a-z_]+)/g)].map((m) => m[1]),
    // v6.2: bracket access, e.g. settings["lob_trap_bid_spoof"]. Quoted identifiers on
    // their own are NOT included -- "scalp_max_single_loss" is an exit reason, not a
    // column, and treating every string literal as a settings read would fail the deploy
    // on a name that was never meant to be one.
    ...[...code.matchAll(/settings[^\n]{0,12}\[\s*["'`]((?:scalp|lob)_[a-z_]+)["'`]\s*\]/g)].map((m) => m[1]),
  ]);
  const created = createdColumns(await migrationFiles());
  // A setting that only ever lives in code cannot be changed from the dashboard, and the
  // first migration that touches it fails the deploy.
  const missing = [...read].filter((c) => !created.has(c)).sort();
  assertEquals(missing, [], `settings read by the engine but absent from the schema: ${missing.join(", ")}`);
});

Deno.test("constraint definitions are re-pushable after a failed migration", async () => {
  // A migration that errors partway can leave its constraints behind. Re-pushing then
  // fails on "constraint already exists" instead of recovering, so every add must be
  // preceded by a drop.
  for (const { name, sql } of await migrationFiles()) {
    if (!name.startsWith("2026072600")) continue; // the v5.3+ migrations added in this cycle
    const adds = [...sql.matchAll(/add constraint\s+([a-z_]+)/gi)].map((m) => m[1]);
    const drops = new Set([...sql.matchAll(/drop constraint if exists\s+([a-z_]+)/gi)].map((m) => m[1]));
    for (const c of adds) {
      assert(drops.has(c), `${name}: "add constraint ${c}" has no matching "drop constraint if exists"`);
    }
  }
});
