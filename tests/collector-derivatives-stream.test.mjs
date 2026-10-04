import test from "node:test";
import assert from "node:assert/strict";
import { streamURLs, VERSION } from "../collectors/doa-capture/core.mjs";

test("collector subscribes to public 1s mark-price stream for funding and basis context",()=>{
  const urls=streamURLs("GTCUSDT");
  assert.match(urls.market,/gtcusdt@markPrice@1s/);
  assert.match(VERSION,/DERIVATIVES-SQUEEZE/);
});
