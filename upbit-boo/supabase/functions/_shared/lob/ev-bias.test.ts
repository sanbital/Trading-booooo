import { boundedEvBiasPenalty, estimateEvBias } from "./ev-bias.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("EV bias remains silent until optimism is measured with enough samples", () => {
  const small = estimateEvBias(
    Array.from({ length: 20 }, () => ({ predictedEvBps: 5, realizedNetBps: -10 })),
  );
  assert(small.penaltyBps === 0);
  assert(!small.confirmedOptimism);
});

Deno.test("confirmed optimistic EV receives a shrunk bounded penalty", () => {
  const estimate = estimateEvBias(
    Array.from({ length: 100 }, (_, index) => ({
      predictedEvBps: 5,
      realizedNetBps: index % 5 === 0 ? 5 : -10,
    })),
  );
  assert(estimate.confirmedOptimism, JSON.stringify(estimate));
  assert(estimate.penaltyBps > 0);
  assert(estimate.penaltyBps <= 30);
});

Deno.test("policy multiplier can strengthen but never unbound the EV penalty", () => {
  assert(boundedEvBiasPenalty(20, 1.2, 30) === 24);
  assert(boundedEvBiasPenalty(100, 1.5, 35) === 35);
});
