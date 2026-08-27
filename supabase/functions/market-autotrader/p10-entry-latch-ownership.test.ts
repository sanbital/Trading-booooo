import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const canonicalSql = await Deno.readTextFile(
  new URL(
    "../../migrations/20260826094500_p10_entry_reconciliation_invariants.sql",
    import.meta.url,
  ),
);
const entryStart = source.indexOf("async function enterP10Signal(");
const scanStart = source.indexOf("async function p10ScanCycle(");
const scanEnd = source.indexOf("async function p10FetchJson(");

Deno.test("scan-level entry catch never owns post-submit reconciliation latch", () => {
  assert(entryStart >= 0 && scanStart > entryStart && scanEnd > scanStart);
  const scanSource = source.slice(scanStart, scanEnd);
  assertEquals(
    scanSource.includes('latchP10EntrySafety("P10_ENTRY_RECONCILIATION_REQUIRED")'),
    false,
  );
  assert(scanSource.includes("P10_ENTRY_PREORDER_ERROR"));
  assert(scanSource.includes("P10_ENTRY_POLICY_BLOCK"));
});

Deno.test("post-submit entry path retains reconciliation latch ownership", () => {
  const entrySource = source.slice(entryStart, scanStart);
  const needle = 'latchP10EntrySafety("P10_ENTRY_RECONCILIATION_REQUIRED")';
  const count = entrySource.split(needle).length - 1;
  assert(count >= 2, `expected at least two post-submit reconciliation latch paths, got ${count}`);
  assert(entrySource.includes("p10EntryFailureDisposition"));
  assert(entrySource.includes("p10EntryOrderDisposition"));
});

Deno.test("database latch ignores historical closed entry fills", () => {
  const guardStart = canonicalSql.indexOf(
    "-- Defense in depth: reconciliation means a current exchange submission",
  );
  const guardEnd = canonicalSql.indexOf("  v_next_lock := case", guardStart);
  assert(guardStart >= 0 && guardEnd > guardStart);
  const guard = canonicalSql.slice(guardStart, guardEnd);
  assert(guard.includes("p.state in ('CANCELLED', 'ERROR')"));
  assert(guard.includes("o.updated_at >= clock_timestamp() - interval '5 minutes'"));
  assert(guard.includes("f.created_at >= clock_timestamp() - interval '5 minutes'"));
  assert(guard.includes("f.executed_at >= clock_timestamp() - interval '5 minutes'"));
  assertEquals(guard.includes("p.state = 'CLOSED'"), false);
  assertEquals(
    guard.includes("or coalesce(o.executed_volume, 0) > 0\n           or exists"),
    false,
  );
});
