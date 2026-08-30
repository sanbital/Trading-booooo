import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyScanGate, summarizeScanStage } from "./scan-stage.ts";

Deno.test("a scan that refused every market reports the refusals instead of a zero", () => {
  const summary = summarizeScanStage(10, 0, [
    { failed_gates: ["lob_pattern", "lob_pressure"] },
    { failed_gates: ["lob_pattern"] },
    { failed_gates: ["m1_previous_candle_not_bullish"] },
  ]);

  assertEquals(summary.observed, 10);
  assertEquals(summary.buy, 0);
  // The count is the exact ledger count, not the size of the reason sample. This is the
  // regression: the dashboard used to show 0 because it only read the order-path ledger.
  assertEquals(summary.rejected, 10);
  assertEquals(summary.reason_sample_size, 3);
  assertEquals(summary.top_reasons[0], {
    reason: "호가창 패턴 미검출",
    count: 2,
    detail: "진입 근거가 되는 주 호가 패턴이 검출되지 않았습니다.",
  });
  assertEquals(summary.top_reasons.length, 3);
});

Deno.test("one market failing the same reason twice is counted once", () => {
  // `lob_pattern` and the lowercased `NO_PRIMARY_LOB_PATTERN` map to the same operator
  // reason. Counting both would inflate the histogram above the number of markets.
  const summary = summarizeScanStage(1, 0, [
    { failed_gates: ["lob_pattern", "no_primary_lob_pattern"] },
  ]);

  assertEquals(summary.top_reasons.length, 1);
  assertEquals(summary.top_reasons[0].count, 1);
});

Deno.test("a refused market with no recorded gates is still counted, not dropped", () => {
  const summary = summarizeScanStage(2, 0, [{ failed_gates: null }, { failed_gates: [] }]);

  assertEquals(summary.rejected, 2);
  assertEquals(summary.reason_sample_size, 2);
  assertEquals(summary.top_reasons[0].count, 2);
  assertEquals(summary.top_reasons[0].reason, "기타 스캔 조건 미달");
});

Deno.test("a missing reason sample degrades the breakdown but never the counts", () => {
  const summary = summarizeScanStage(12, 2, null);

  assertEquals(summary.observed, 12);
  assertEquals(summary.buy, 2);
  assertEquals(summary.rejected, 10);
  assertEquals(summary.reasons_available, false);
  assertEquals(summary.top_reasons, []);
});

Deno.test("a truncated sample is flagged so the histogram is never read as complete", () => {
  const sample = Array.from({ length: 600 }, () => ({ failed_gates: ["lob_spread"] }));
  const summary = summarizeScanStage(5000, 0, sample);

  assertEquals(summary.rejected, 5000);
  assertEquals(summary.reason_sample_size, 600);
  assertEquals(summary.reason_sample_truncated, true);
});

Deno.test("a scan where everything passed reports no scan-stage rejections", () => {
  const summary = summarizeScanStage(4, 4, []);

  assertEquals(summary.rejected, 0);
  assertEquals(summary.top_reasons, []);
  assertEquals(summary.reasons_available, true);
});

Deno.test("an unmapped gate key is shown verbatim rather than being swallowed", () => {
  const classified = classifyScanGate("SOME_FUTURE_GATE");

  assertEquals(classified.reason.includes("some future gate"), true);
});
