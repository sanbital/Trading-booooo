import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const sql = await Deno.readTextFile(
  new URL("./20260907223920_futures_fill_ingestion_no_auto_adoption.sql", import.meta.url),
);

Deno.test("futures fill ingestion cannot invoke the spot auto-adopter", () => {
  assert(sql.includes("FUTURES_LEDGER_ONLY_20260908"));
  assert(sql.includes("= ''binance_futures'' then"));
  assert(sql.includes("return v_fill.position_id"));
  assert(sql.includes("ADOPTION_PATCH_ANCHOR_NOT_UNIQUE"));
});
