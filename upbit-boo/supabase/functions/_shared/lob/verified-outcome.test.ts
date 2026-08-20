import {
  verifiedOutcomeReason,
  verifiedOutcomeToSample,
} from "./verified-outcome.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

const base = {
  accounting_quality: "NO_RESIDUAL",
  fee_accounting_quality: "AGGREGATE_EXACT",
  prediction_basis: "FILL_CONDITIONAL",
  pattern: "ABSORPTION_REVERSAL",
  net_bps: -12.5,
  target_hit: false,
  held_seconds: 107,
  closed_at: "2026-07-28T03:00:00Z",
  entry_snapshot: {
    p_target: 0.55,
    target_bps: 40,
    stop_bps: 32,
    neutral_win_rate: 32 / 72,
    traps: ["QUOTE_FLICKER"],
  },
};

Deno.test("only fully verified live economic outcome becomes a learning sample", () => {
  const sample = verifiedOutcomeToSample(base);
  assert(sample);
  assert(sample.pattern === "ABSORPTION_REVERSAL");
  assert(sample.netBps === -12.5);
  assert(sample.outcome === 0);
  assert(sample.heldSeconds === 107);
  assert(sample.traps.includes("QUOTE_FLICKER"));
});

Deno.test("estimated fee outcome cannot vote", () => {
  const row = { ...base, fee_accounting_quality: "ESTIMATED" };
  assert(verifiedOutcomeReason(row) === "UNVERIFIED_FEE_ACCOUNTING");
  assert(verifiedOutcomeToSample(row) === null);
});

Deno.test("legacy attempt-EV outcome cannot vote", () => {
  const row = { ...base, prediction_basis: "LEGACY_ATTEMPT_EV" };
  assert(verifiedOutcomeReason(row) === "UNVERIFIED_PREDICTION_BASIS");
  assert(verifiedOutcomeToSample(row) === null);
});

Deno.test("unverified residual outcome cannot vote", () => {
  const row = { ...base, accounting_quality: "LEGACY_UNVERIFIED" };
  assert(verifiedOutcomeReason(row) === "UNVERIFIED_RESIDUAL_ACCOUNTING");
  assert(verifiedOutcomeToSample(row) === null);
});

Deno.test("target hit remains a target outcome even when final net is small", () => {
  const sample = verifiedOutcomeToSample({ ...base, target_hit: true, net_bps: 0.1 });
  assert(sample?.outcome === 1);
});
