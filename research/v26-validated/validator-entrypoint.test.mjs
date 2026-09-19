import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source=readFileSync(new URL("./binance-30d-validation.mjs",import.meta.url),"utf8");

test("validator entry point wires fail-closed integrity providers",()=>{
  assert.match(source,/createVerifiedVisionProvider/);
  assert.match(source,/collectMonthlyWithDailyFallback/);
  assert.match(source,/fundingHistoryFromCache/);
  assert.match(source,/fetchFundingHistory/);
  assert.match(source,/logicalDatasetHash/);
  assert.match(source,/blocked15mCutoffs:cutoffQuality\.blockedCutoffs/);
  assert.doesNotMatch(source,/fundingRate"\)return \[\]/);
  assert.doesNotMatch(source,/fundingFor\(symbol\)\.catch\(\(\)=>\[\]\)/);
});

test("new validation defaults to evidence-based strength loss while legacy replay is explicit",()=>{
  assert.match(source,/V26_EXIT_POLICY\|\|"STRENGTH_LOSS_V1"/);
  assert.match(source,/EXIT_POLICY==="LEGACY_C0_C12_REPRODUCTION"/);
  assert.match(source,/strengthLossDecision/);
  assert.match(source,/reason:"EVALUATION_MARK"/);
});
