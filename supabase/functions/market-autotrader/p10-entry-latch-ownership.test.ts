import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
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
